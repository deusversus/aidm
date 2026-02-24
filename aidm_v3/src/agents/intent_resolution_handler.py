"""
Intent Resolution Handler — Bridges IntentResolutionAgent with session_zero route.

Replaces the 400+ line if/elif ladder in session_zero.py with a single
callable coroutine. Returns structured results that the route can act on.

Usage in session_zero.py:

    from src.agents.intent_resolution_handler import resolve_media_intent
    
    intent_result = await resolve_media_intent(
        session=session,
        media_ref=media_ref,
        secondary_ref=secondary_ref,
        detected_info=result.detected_info,
    )
    
    if intent_result.action == "disambiguation":
        return SessionZeroResponse(
            response=intent_result.response_text,
            awaiting_disambiguation=True,
            ...
        )
    elif intent_result.action == "research":
        safe_create_task(intent_result.background_task(), ...)
    elif intent_result.action == "ready":
        # Profile already exists and is linked
        pass
"""

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine

from ..agents.intent_resolution import IntentResolutionAgent, IntentResolution
from ..agents.progress import ProgressPhase, ProgressTracker
from ..profiles.session_profile import ProfileBase, SessionLayer, SessionProfile, SessionProfileStore

logger = logging.getLogger(__name__)


@dataclass
class IntentResult:
    """Result from intent resolution — tells the route what to do."""

    # What action to take next
    action: str  # "disambiguation" | "research" | "ready" | "custom" | "error"

    # For "disambiguation": text to show user + options
    response_text: str = ""
    disambiguation_options: list[dict] = field(default_factory=list)

    # For "research": background task to run
    background_coro: Callable[[], Coroutine] | None = None
    progress_tracker: ProgressTracker | None = None

    # For "ready": the resolved profile ID + composition
    profile_id: str | None = None
    profile_ids: list[str] = field(default_factory=list)
    composition_type: str = "single"

    # For all: metadata to inject into detected_info
    detected_info_updates: dict = field(default_factory=dict)

    # The full resolution if available
    resolution: IntentResolution | None = None


async def resolve_media_intent(
    session: Any,
    media_ref: str,
    secondary_ref: str | None = None,
    detected_info: dict | None = None,
    media_refs: list[str] | None = None,
) -> IntentResult:
    """Resolve a user's anime/manga reference into actionable intent.

    Replaces the disambiguation/research if/elif ladder in session_zero.py.

    Args:
        session: The Session object
        media_ref: Primary media reference (e.g., "Dragon Ball")
        secondary_ref: Optional secondary reference for hybrids
        detected_info: The detected_info dict from Session Zero agent

    Returns:
        IntentResult telling the route what to do next
    """
    detected_info = detected_info or {}

    # ── Handle media form choice response (user replying to our version prompt) ──
    media_form_options = session.phase_state.get('media_form_options')
    if media_form_options and not session.phase_state.get('media_form_chosen'):
        chosen = _parse_media_form_choice(media_ref, media_form_options)
        session.phase_state['media_form_chosen'] = True

        if chosen == "merge":
            logger.info(f"Media form choice: MERGE all ({media_form_options})")
            # Re-run resolution with franchise_link composition
            # Fall through to normal flow — override needs_research below
            session.phase_state['media_form_merge'] = True
        else:
            logger.info(f"Media form choice: {chosen}")
            session.phase_state['media_form_selected'] = chosen

    # ── Check for custom/original world ──
    if media_ref.lower().strip() in ["original", "custom", "new", "fresh"]:
        return IntentResult(
            action="custom",
            detected_info_updates={
                "research_status": "custom_profile_created",
                "profile_type": "custom",
            },
        )

    # ── Check if disambiguation was already completed ──
    disambiguation_done = session.phase_state.get('disambiguation_complete', False)
    profile_resolved = session.phase_state.get('profile_resolved', False)

    if profile_resolved:
        # Already resolved on a previous turn
        profile_ids = session.get_active_profile_ids()
        return IntentResult(
            action="ready",
            profile_id=profile_ids[0] if profile_ids else None,
            profile_ids=profile_ids,
            composition_type=session.phase_state.get('composition_type', 'single'),
        )

    # ── Resolve via Intent Agent ──
    agent = IntentResolutionAgent()

    if media_refs and len(media_refs) >= 2:
        # Multi-title array (franchise-entry detection)
        resolution = await agent.resolve_hybrid(media_refs)
    elif secondary_ref:
        # Hybrid/blend request (2 titles)
        resolution = await agent.resolve_hybrid([media_ref, secondary_ref])
    else:
        # Single title
        resolution = await agent.resolve(
            user_input=media_ref,
            context=f"Disambiguation response: {detected_info.get('disambiguation_selection')}"
            if detected_info.get('disambiguation_selection') else None,
        )

    logger.info(
        f"Intent resolution: confidence={resolution.confidence:.2f}, "
        f"type={resolution.composition_type}, "
        f"disambig={resolution.disambiguation_needed}, "
        f"needs_research={resolution.needs_research}"
    )

    # ── Handle disambiguation needed ──
    if resolution.disambiguation_needed:
        options_text = _format_disambiguation_options(resolution)

        session.phase_state['disambiguation_shown'] = True
        session.phase_state['disambiguation_for'] = media_ref

        return IntentResult(
            action="disambiguation",
            response_text=options_text,
            disambiguation_options=[
                {
                    "name": opt.title,
                    "anilist_id": opt.anilist_id,
                    "format": opt.format,
                    "year": opt.year,
                }
                for opt in resolution.disambiguation_options
            ],
            resolution=resolution,
        )

    # ── Handle profiles that already exist ──
    existing_profiles = [
        rt for rt in resolution.resolved_titles if rt.already_exists
    ]
    needs_research = resolution.needs_research

    # Safety net: if LLM resolved titles but none exist locally and
    # needs_research is empty, populate it from the non-existing titles
    if not needs_research and not existing_profiles and resolution.resolved_titles:
        needs_research = [rt.canonical_title for rt in resolution.resolved_titles]
        logger.info(f"Safety net: populating needs_research from resolved titles: {needs_research}")

    # AniList-down fallback: if resolution produced NOTHING (no titles, no research),
    # treat the raw user input as the resolved title and trigger research anyway.
    # The research pipeline has its own AniList→Fandom→web-search fallback chain.
    if not needs_research and not existing_profiles and not resolution.resolved_titles:
        needs_research = [media_ref]
        logger.warning(
            f"Intent resolution returned empty — AniList may be down. "
            f"Falling back to raw title for research: {needs_research}"
        )

    # ── Apply media form choice if user already picked ──
    if session.phase_state.get('media_form_merge'):
        resolution.composition_type = "franchise_link"
        needs_research = session.phase_state.get('media_form_options', needs_research)
        logger.info(f"Applying merge choice: {needs_research}, type=franchise_link")
    elif session.phase_state.get('media_form_selected'):
        selected = session.phase_state['media_form_selected']
        needs_research = [selected]
        resolution.composition_type = "single"
        # Filter resolved_titles to only the selected one
        resolution.resolved_titles = [
            rt for rt in resolution.resolved_titles
            if rt.canonical_title == selected
        ] or resolution.resolved_titles[:1]
        logger.info(f"Applying single choice: {selected}")

    # ── Prompt for media form choice if multiple versions of same IP ──
    if (
        not resolution.disambiguation_needed
        and len(needs_research) > 1
        and resolution.composition_type == "single"
        and not session.phase_state.get('media_form_chosen')
    ):
        options_text = _format_media_form_options(needs_research)
        session.phase_state['media_form_options'] = needs_research

        # Save session so choice persists
        from ..db.session_store import SessionStore
        SessionStore().save(session)

        return IntentResult(
            action="disambiguation",
            response_text=options_text,
            disambiguation_options=[
                {"name": t, "anilist_id": None, "format": None, "year": None}
                for t in needs_research
            ] + [{"name": "Merge all versions", "anilist_id": None, "format": None, "year": None}],
            resolution=resolution,
        )

    if not needs_research and existing_profiles:
        # All profiles exist — link them and mark ready
        profile_ids = [rt.profile_id for rt in resolution.resolved_titles]
        primary_id = profile_ids[0] if profile_ids else None

        # Build and save session composition
        _save_session_composition(
            session=session,
            resolution=resolution,
        )

        session.phase_state['profile_resolved'] = True
        session.phase_state['active_profile_ids'] = profile_ids
        session.phase_state['composition_type'] = resolution.composition_type
        session.character_draft.narrative_profile = primary_id
        session.character_draft.media_reference = (
            " × ".join(rt.canonical_title for rt in resolution.resolved_titles)
            if len(resolution.resolved_titles) > 1
            else resolution.resolved_titles[0].canonical_title
        )

        return IntentResult(
            action="ready",
            profile_id=primary_id,
            profile_ids=profile_ids,
            composition_type=resolution.composition_type,
            detected_info_updates={
                "research_status": "existing_profile",
                "profile_type": resolution.composition_type,
                "profile_id": primary_id,
            },
            resolution=resolution,
        )

    # ── Handle research needed ──
    # Some or all profiles need to be generated
    all_profile_ids = [rt.profile_id for rt in resolution.resolved_titles]

    # Create progress tracker
    progress_tracker = ProgressTracker(total_steps=10 * len(needs_research))

    async def do_research():
        """Background task: research all needed profiles, then save composition."""
        try:
            from ..agents._session_zero_research import research_and_apply_profile
            from ..agents.progress import WeightedProgressGroup, ProgressPhase

            if len(needs_research) > 1:
                # Multi-profile: use WeightedProgressGroup so each profile contributes
                # proportionally and "complete 100%" per-profile doesn't close the bar
                group = WeightedProgressGroup(progress_tracker)
                sub_trackers = []
                weight_per_profile = 1.0 / len(needs_research)

                for title in needs_research:
                    sub = group.create_sub_tracker(weight_per_profile, name=title)
                    sub_trackers.append((title, sub))

                for title, sub in sub_trackers:
                    # Emit title switch on parent so frontend updates the progress bar header
                    await progress_tracker.emit(
                        ProgressPhase.RESEARCH,
                        f"Researching {title}...",
                        detail={"current_title": title},
                    )
                    await research_and_apply_profile(
                        session, title, progress_tracker=sub,
                    )

                # All profiles done — fire the real complete on the parent
                await progress_tracker.emit(
                    ProgressPhase.COMPLETE,
                    f"All {len(needs_research)} profiles generated!",
                    100,
                    {"titles": needs_research},
                )
            else:
                # Single profile: use tracker directly (existing behavior)
                for title in needs_research:
                    await research_and_apply_profile(
                        session, title, progress_tracker=progress_tracker,
                    )

            # After all research, save the session composition
            _save_session_composition(session=session, resolution=resolution)
            session.phase_state['profile_resolved'] = True
            session.phase_state['active_profile_ids'] = all_profile_ids
            session.phase_state['composition_type'] = resolution.composition_type

            # Save session
            from ..db.session_store import SessionStore
            store = SessionStore()
            store.save(session)
            logger.info(f"Research complete for: {needs_research}")

        except Exception as e:
            logger.error(f"Intent resolution research failed: {e}", exc_info=True)
            import sys
            sys.stdout.flush()  # Force flush so traceback appears in server.log
            await progress_tracker.complete()

    # Set media reference immediately
    if len(resolution.resolved_titles) > 1:
        media_display = " × ".join(rt.canonical_title for rt in resolution.resolved_titles)
    elif resolution.resolved_titles:
        media_display = resolution.resolved_titles[0].canonical_title
    else:
        media_display = media_ref

    session.character_draft.media_reference = media_display

    return IntentResult(
        action="research",
        background_coro=do_research,
        progress_tracker=progress_tracker,
        profile_id=all_profile_ids[0] if all_profile_ids else None,
        profile_ids=all_profile_ids,
        composition_type=resolution.composition_type,
        detected_info_updates={
            "research_task_id": progress_tracker.task_id,
            "research_status": "in_progress",
            "profile_type": resolution.composition_type,
        },
        resolution=resolution,
    )


def _format_disambiguation_options(resolution: IntentResolution) -> str:
    """Format disambiguation options as a styled markdown response."""
    if resolution.disambiguation_options:
        options_text = "\n".join([
            f"**{i+1}.** {opt.title}"
            + (f" ({opt.format}, {opt.year})" if opt.year else "")
            for i, opt in enumerate(resolution.disambiguation_options)
        ])

        return f"""## 🔍 Multiple Series Found

{resolution.disambiguation_question or "Which series did you mean?"}

{options_text}

---

**Just tell me the number or name!**"""

    return resolution.disambiguation_question or "Could you be more specific about the title?"


def _format_media_form_options(titles: list[str]) -> str:
    """Format media form options (manga vs anime vs etc) for the player."""
    options = "\n".join(f"**{i+1}.** {t}" for i, t in enumerate(titles))
    merge_n = len(titles) + 1
    return f"""## 🎬 Multiple Versions Found

This series has multiple media forms available:

{options}
**{merge_n}.** Merge all versions (combines canon from each)

---

**Which version should your campaign be based on? Pick a number or tell me!**"""


def _parse_media_form_choice(user_input: str, options: list[str]) -> str:
    """Parse the user's media form choice. Returns a title from options or 'merge'."""
    text = user_input.strip().lower()

    # Check for merge keywords
    merge_keywords = ["merge", "all", "both", "combine", str(len(options) + 1)]
    if any(kw in text for kw in merge_keywords):
        return "merge"

    # Check for number selection ("1", "2", etc.)
    num_match = re.search(r'\b(\d+)\b', text)
    if num_match:
        idx = int(num_match.group(1)) - 1
        if 0 <= idx < len(options):
            return options[idx]
        if idx == len(options):  # merge option
            return "merge"

    # Check for media type keywords
    type_keywords = {
        "manga": "MANGA", "manhwa": "MANHWA", "manhua": "MANHUA",
        "anime": "ANIME", "light novel": "LIGHT_NOVEL", "novel": "LIGHT_NOVEL",
        "donghua": "DONGHUA", "movie": "MOVIE", "film": "MOVIE",
    }
    for keyword, _ in type_keywords.items():
        if keyword in text:
            # Find the option that matches this media type
            for opt in options:
                if keyword in opt.lower():
                    return opt

    # Check for name fragment match
    for opt in options:
        # Check if any significant word from user input appears in the option
        for word in text.split():
            if len(word) > 3 and word in opt.lower():
                return opt

    # Default: first option
    logger.warning(f"Could not parse media form choice '{user_input}', defaulting to first option")
    return options[0]


def _save_session_composition(
    session: Any,
    resolution: IntentResolution,
) -> None:
    """Build and persist a SessionProfile from the resolution."""
    try:
        bases = [
            ProfileBase(
                profile_id=rt.profile_id,
                anilist_id=rt.anilist_id,
                mal_id=rt.mal_id,
                canonical_title=rt.canonical_title,
                role=rt.role,
            )
            for rt in resolution.resolved_titles
        ]

        composition = SessionProfile(
            session_id=session.session_id,
            composition_type=resolution.composition_type,
            bases=bases,
            session_layer=SessionLayer(),
        )

        store = SessionProfileStore()
        store.save_composition(composition)
        logger.info(
            f"Saved session composition: {session.session_id} "
            f"({len(bases)} bases, type={resolution.composition_type})"
        )
    except Exception as e:
        logger.error(f"Failed to save session composition: {e}")
