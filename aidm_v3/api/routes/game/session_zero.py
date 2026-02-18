"""Session Zero turn endpoint — the character creation conversation loop."""

import logging

from fastapi import APIRouter, HTTPException

from src.agents.progress import ProgressPhase, ProgressTracker
from src.agents.session_zero import (
    apply_detected_info,
    get_disambiguation_options,
    process_session_zero_state,
)
from src.core.session import (
    SessionPhase,
    get_current_phase_for_draft,
    get_missing_requirements,
    get_session_manager,
)
from src.db.session_store import get_session_store
from src.settings import get_settings_store
from src.utils.tasks import safe_create_task

from .models import SessionZeroResponse, TurnRequest
from .session_mgmt import (
    _build_session_zero_summary,
    _generate_handoff_character_media,
    get_orchestrator,
    get_session_zero_agent,
    reset_orchestrator,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/session/{session_id}/turn", response_model=SessionZeroResponse)
async def session_zero_turn(session_id: str, request: TurnRequest):
    """Process a turn during Session Zero.
    
    Routes the player's input through the Session Zero agent,
    which guides character creation.
    """
    manager = get_session_manager()
    session = manager.get_session(session_id)

    if session is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")

    if not session.is_session_zero():
        raise HTTPException(
            status_code=400,
            detail="Session Zero is complete. Use /turn for gameplay."
        )

    # Record player input
    session.add_message("user", request.player_input)

    # Check for OP Mode activation command
    input_lower = request.player_input.lower().strip()
    if "enable op mode" in input_lower or "activate op mode" in input_lower:
        session.character_draft.op_protagonist_enabled = True
        # Default to hidden_ruler preset if not already set
        if not session.character_draft.op_preset:
            session.character_draft.op_preset = "hidden_ruler"
            session.character_draft.op_tension_source = "consequence"
            session.character_draft.op_power_expression = "derivative"
            session.character_draft.op_narrative_focus = "faction"
        logger.info(f"OP Mode enabled with preset: {session.character_draft.op_preset}")

    # Process through Session Zero agent
    agent = get_session_zero_agent()

    # DEBUG: Log session state before processing
    msg_count = len(session.messages) if session.messages else 0
    last_msg = session.messages[-1]['content'][:100] if session.messages else "None"
    try:
        safe_msg = last_msg.encode('ascii', 'replace').decode('ascii')
        logger.debug(f"DEBUG: {msg_count} messages in session. Last: {safe_msg}...")
    except Exception:
        logger.debug(f"DEBUG: {msg_count} messages in session.")

    try:
        result = await agent.process_turn(session, request.player_input)

        # Initialize opening scene vars (only populated during handoff)
        opening_narrative = None
        opening_portrait_map = None

        # Apply any detected information to the character draft

        logger.debug(f"DEBUG: Raw result.detected_info = {result.detected_info}")
        if result.detected_info:
            # DEBUG: Log what the LLM returned
            try:
                safe_detected_info = {
                    k: str(v).encode('ascii', 'replace').decode('ascii')
                    for k, v in result.detected_info.items()
                }
                logger.debug(f"DEBUG: Detected info (safe): {safe_detected_info}")
            except Exception as e:
                logger.error(f"DEBUG: Failed to safely encode detected_info: {e}")
                logger.debug(f"DEBUG: Raw detected_info: {result.detected_info}")

            apply_detected_info(session, result.detected_info)

            # FLUID STATE INTEGRATION: Process detected_info for memory/NPC updates
            # This calls add_memory() for character facts, creates NPCs, stores canonicality
            # Use session_id for memory isolation (not profile_id)
            try:
                state_stats = await process_session_zero_state(
                    session=session,
                    detected_info=result.detected_info,
                    session_id=session.session_id
                )
                if state_stats.get("memories_added", 0) > 0:
                    logger.info(f"Fluid state: {state_stats['memories_added']} memories, {state_stats.get('npcs_created', 0)} NPCs")
            except Exception as state_err:
                logger.error(f"Fluid state processing failed (non-fatal): {state_err}")

            # TRIGGER RESEARCH: If media reference detected in Phase 0
            media_ref = result.detected_info.get("media_reference") or result.detected_info.get("anime")
            secondary_ref = result.detected_info.get("secondary_reference") or result.detected_info.get("secondary_media_reference") or result.detected_info.get("blend_with")

            # STABILITY GUARD: If we already resolved a media reference on a previous turn,
            # prefer it over the LLM's potentially truncated version.
            # e.g. LLM might return "I Was Reincarnated as the 7th Prince" on turn 3
            # when turn 1 correctly returned the full title. Without this guard,
            # the short title triggers a duplicate profile generation.
            if media_ref and session.character_draft.media_reference and session.character_draft.narrative_profile:
                established = session.character_draft.media_reference
                if media_ref != established:
                    logger.info(f"Stability guard: LLM returned '{media_ref}' but we already have '{established}' — using established")
                    media_ref = established

            logger.debug(f"DEBUG: media_ref = {media_ref}, session.phase = {session.phase}")

            # Only trigger research/disambiguation in early phases (MEDIA_DETECTION, CONCEPT)
            # Later phases (IDENTITY, WRAP_UP, etc.) should not re-run disambiguation
            early_phases = [SessionPhase.MEDIA_DETECTION, SessionPhase.NARRATIVE_CALIBRATION, SessionPhase.OP_MODE_DETECTION, SessionPhase.CONCEPT]
            if media_ref and session.phase in early_phases:
                # Note: We include CONCEPT because hybrid flow may need to run research there
                logger.debug(f"DEBUG: Triggering research logic for '{media_ref}' (Phase: {session.phase})")

                # Check if this is "original" (custom world) vs canonical anime
                is_original = media_ref.lower().strip() in ["original", "custom", "new", "fresh"]

                # Check for hybrid/blend (multiple anime mentioned)
                # STRICTER CHECK: Must have a secondary reference to be a hybrid
                is_hybrid = (secondary_ref is not None and str(secondary_ref).strip() != "")

                # ======== DISAMBIGUATION CHECK ========
                # Before loading/generating, check if this anime needs disambiguation
                # FIX: Check multiple conditions to prevent re-triggering
                is_disambiguation_response = result.detected_info.get("disambiguation_selection", False)

                # If user just made a disambiguation selection, mark it complete
                if is_disambiguation_response:
                    session.phase_state['disambiguation_complete'] = True
                    logger.debug("DEBUG: Disambiguation selection made - marking complete")

                # Check if disambiguation already completed OR was shown this session
                disambiguation_already_done = session.phase_state.get('disambiguation_complete', False)
                disambiguation_shown = session.phase_state.get('disambiguation_shown', False)

                # Also skip if user gave a SPECIFIC title that matches an existing profile
                # (e.g., "Naruto Shippuden" instead of just "Naruto")
                from src.agents.profile_generator import load_existing_profile
                specific_profile_exists = load_existing_profile(media_ref) is not None

                logger.info(f"Flags: done={disambiguation_already_done}, shown={disambiguation_shown}, specific_exists={specific_profile_exists}")

                # Only run single-title disambiguation if:
                # - NOT a hybrid (hybrids have their own disambiguation)
                # - NOT already completed or shown
                # - NOT a specific profile that already exists
                should_disambiguate = (
                    not is_disambiguation_response and
                    not is_hybrid and
                    not disambiguation_already_done and
                    not disambiguation_shown and
                    not specific_profile_exists
                )

                if should_disambiguate:
                    # This is NOT a disambiguation selection - check if we need to offer options
                    disambiguation = await get_disambiguation_options(media_ref)

                    if disambiguation.get('needs_disambiguation'):
                        # Mark that we SHOWED disambiguation (prevents re-trigger)
                        session.phase_state['disambiguation_shown'] = True
                        session.phase_state['disambiguation_for'] = media_ref

                        # Return disambiguation options to user
                        logger.info(f"Disambiguation needed for '{media_ref}' - returning {len(disambiguation['options'])} options")

                        # Build a styled response matching Session Zero formatting
                        options_text = "\n".join([
                            f"**{i+1}.** {opt.get('name', opt)}"
                            for i, opt in enumerate(disambiguation['options'])  # Show all
                        ])

                        disambiguation_response = f"""## 🔍 Multiple Series Found

I found several entries in the **{media_ref}** franchise:

{options_text}

---

**Which one would you like to explore?** Just tell me the number or name!"""

                        # Store original and return with disambiguation
                        session.add_message("assistant", disambiguation_response)
                        store = get_session_store()
                        store.save(session)

                        return SessionZeroResponse(
                            response=disambiguation_response,
                            phase=session.phase.value,
                            phase_complete=False,
                            character_draft={
                                "name": session.character_draft.name,
                                "concept": session.character_draft.concept,
                                "media_reference": media_ref,
                                "narrative_profile": session.character_draft.narrative_profile,
                            },
                            session_id=session_id,
                            missing_requirements=["media_reference"],
                            ready_for_gameplay=False,
                            disambiguation_options=disambiguation['options'],
                            awaiting_disambiguation=True
                        )

                if is_original:
                    # CUSTOM/ORIGINAL PROFILE: Quick template for "Original" worlds
                    try:
                        from src.agents.session_zero import generate_custom_profile
                        custom_result = await generate_custom_profile(session)
                        result.detected_info["research_status"] = "custom_profile_created"
                        result.detected_info["profile_type"] = "custom"
                    except Exception as custom_error:
                        logger.error(f"Custom profile generation failed: {custom_error}")

                elif is_hybrid:
                    # HYBRID PROFILE: Two-phase flow
                    # Phase 1: Calibration dialogue (this turn) - agent proposes blend options
                    # Phase 2: Research triggers ONLY after player confirms preferences

                    # Check if preferences already confirmed (skip disambiguation)
                    hybrid_confirmed = result.detected_info.get("hybrid_preferences_confirmed", False)

                    # ======== HYBRID DISAMBIGUATION ========
                    # Check if either title needs disambiguation before proceeding
                    # Skip if preferences already confirmed OR this is a disambiguation selection
                    # OR disambiguation has already been completed/shown
                    # OR both specific profiles already exist
                    prof_a_exists = load_existing_profile(media_ref) is not None
                    prof_b_exists = load_existing_profile(secondary_ref) is not None
                    both_specific = prof_a_exists and prof_b_exists

                    should_hybrid_disambiguate = (
                        not is_disambiguation_response and
                        not hybrid_confirmed and
                        not disambiguation_already_done and
                        not disambiguation_shown and
                        not both_specific
                    )

                    if should_hybrid_disambiguate:
                        import asyncio  # Local import to avoid scope conflicts
                        disambig_a, disambig_b = await asyncio.gather(
                            get_disambiguation_options(media_ref),
                            get_disambiguation_options(secondary_ref)
                        )

                        needs_any = disambig_a.get('needs_disambiguation') or disambig_b.get('needs_disambiguation')

                        if needs_any:
                            # Mark that we SHOWED disambiguation (prevents re-trigger)
                            session.phase_state['disambiguation_shown'] = True
                            session.phase_state['disambiguation_for'] = f"{media_ref} × {secondary_ref}"

                            # DEBUG: Log actual option counts
                            logger.debug(f"disambig_a options: {len(disambig_a.get('options', []))}")
                            logger.debug(f"disambig_b options: {len(disambig_b.get('options', []))}")

                            # Build a combined disambiguation response for both titles
                            response_parts = ["## 🔍 Multiple Series Found\n"]
                            all_options = []

                            if disambig_a.get('needs_disambiguation'):
                                response_parts.append(f"### {media_ref} Franchise:\n")
                                for i, opt in enumerate(disambig_a['options']):
                                    response_parts.append(f"**{i+1}.** {opt.get('name', opt)}\n")
                                    all_options.append({'name': opt.get('name', opt), 'source': 'primary', 'index': i+1})
                                response_parts.append("\n")

                            if disambig_b.get('needs_disambiguation'):
                                response_parts.append(f"### {secondary_ref} Franchise:\n")
                                for i, opt in enumerate(disambig_b['options']):
                                    response_parts.append(f"**{i+1}.** {opt.get('name', opt)}\n")
                                    all_options.append({'name': opt.get('name', opt), 'source': 'secondary', 'index': i+1})
                                response_parts.append("\n")

                            response_parts.append("---\n\n")
                            response_parts.append("**Which specific titles would you like to blend?** Tell me the numbers (e.g., '2 and 7') or names!")

                            disambiguation_response = "".join(response_parts)

                            session.add_message("assistant", disambiguation_response)
                            store = get_session_store()
                            store.save(session)

                            return SessionZeroResponse(
                                response=disambiguation_response,
                                phase=session.phase.value,
                                phase_complete=False,
                                character_draft={
                                    "name": session.character_draft.name,
                                    "concept": session.character_draft.concept,
                                    "media_reference": media_ref,
                                    "narrative_profile": session.character_draft.narrative_profile,
                                },
                                session_id=session_id,
                                missing_requirements=["media_reference"],
                                ready_for_gameplay=False,
                                disambiguation_options=all_options,
                                awaiting_disambiguation=True
                            )

                    # Check if this is the confirmation turn (player gave preferences)
                    # (hybrid_confirmed is already defined at the start of the hybrid block)

                    if not hybrid_confirmed:
                        # PHASE 1: Just mark that we're awaiting preferences
                        # The agent will generate blend prompts in its response
                        logger.info(f"Hybrid detected: {media_ref} × {secondary_ref} - awaiting preferences")

                        # OPTIMIZATION: Check if we even need to research
                        from src.agents.profile_generator import load_existing_profile
                        prof_a = load_existing_profile(media_ref)
                        prof_b = load_existing_profile(secondary_ref)

                        if prof_a and prof_b:
                            logger.warning(f"Both profiles cached: {media_ref} & {secondary_ref}. Skipping background preload.")
                            # Mark that sources are ready - no tracker needed
                            result.detected_info["research_status"] = "sources_cached"
                            result.detected_info["profile_id"] = f"{media_ref} × {secondary_ref}"
                            # Also update session so frontend sees combined name
                            session.character_draft.media_reference = f"{media_ref} × {secondary_ref}"
                        else:
                            # OPTIMIZATION: Trigger background research NOW for prerequisites
                            # This ensures single-profile parity (immediate progress bar)
                            try:
                                import asyncio

                                from src.agents.session_zero import ensure_hybrid_prerequisites

                                # Create tracker for immediate feedback
                                progress_tracker = ProgressTracker(total_steps=10)
                                result.detected_info["research_task_id"] = progress_tracker.task_id

                                # Define background task
                                async def run_hybrid_preload():
                                    try:
                                        await ensure_hybrid_prerequisites(
                                            session,
                                            media_ref,
                                            secondary_ref,
                                            progress_tracker=progress_tracker
                                        )
                                    except Exception as e:
                                        logger.error(f"Hybrid preload failed: {e}")
                                        await progress_tracker.complete() # Close stream on error

                                # Start background task
                                safe_create_task(run_hybrid_preload(), name="hybrid_preload")
                                logger.info(f"Started hybrid preload (task_id: {progress_tracker.task_id})")

                            except Exception as preload_error:
                                logger.error(f"Preload setup failed: {preload_error}")

                        result.detected_info["awaiting_hybrid_preferences"] = True
                        result.detected_info["profile_type"] = "hybrid"
                        result.detected_info["blend_sources"] = [media_ref, secondary_ref]

                        # CRITICAL: Set media_reference synchronously so frontend sees correct label
                        # This must happen before response returns, not in background task
                        session.character_draft.media_reference = f"{media_ref} × {secondary_ref}"
                    else:
                        # PHASE 2: User confirmed preferences - now research with caching
                        # First check if both profiles are already cached (fast path)
                        from src.agents.profile_generator import load_existing_profile
                        prof_a = load_existing_profile(media_ref)
                        prof_b = load_existing_profile(secondary_ref)

                        if prof_a and prof_b:
                            # Both cached - run merge synchronously (no tracker needed)
                            logger.info("Both profiles cached for Phase 2. Running fast merge.")
                            try:
                                import asyncio

                                from src.agents.session_zero import research_hybrid_profile_cached

                                power_choice = result.detected_info.get("power_system_choice", "coexist")

                                # Run without tracker since it will complete instantly
                                safe_create_task(research_hybrid_profile_cached(
                                    session,
                                    media_ref,
                                    secondary_ref,
                                    user_preferences={"power_system": power_choice},
                                    progress_tracker=None  # No tracker for instant operations
                                ), name="hybrid_profile_cached")

                                result.detected_info["research_status"] = "fast_merge"
                                result.detected_info["profile_type"] = "hybrid"
                            except Exception as fast_merge_error:
                                logger.error(f"Fast merge failed: {fast_merge_error}")
                        else:
                            # Need to research - use progress tracker
                            try:
                                import asyncio

                                from src.agents.session_zero import research_hybrid_profile_cached

                                # Get user's power system preference
                                power_choice = result.detected_info.get("power_system_choice", "coexist")

                                # Create progress tracker for SSE streaming
                                progress_tracker = ProgressTracker(total_steps=10)
                                result.detected_info["research_task_id"] = progress_tracker.task_id
                                result.detected_info["research_status"] = "in_progress"

                                # Define background task
                                async def run_hybrid_research_background():
                                    try:
                                        hybrid_result = await research_hybrid_profile_cached(
                                            session,
                                            media_ref,
                                            secondary_ref,
                                            user_preferences={"power_system": power_choice},
                                            progress_tracker=progress_tracker
                                        )
                                        # Save session with updated profile
                                        store = get_session_store()
                                        store.save(session)
                                        logger.info(f"Hybrid research completed: {media_ref} × {secondary_ref}")
                                    except Exception as bg_error:
                                        logger.error(f"Hybrid research failed: {bg_error}")
                                        import traceback
                                        traceback.print_exc()
                                        await progress_tracker.complete()

                                # Start research in background - don't await!
                                safe_create_task(run_hybrid_research_background(), name="hybrid_research_bg")
                                logger.info(f"Started cached hybrid research (task_id: {progress_tracker.task_id})")

                            except Exception as hybrid_error:
                                logger.error(f"Hybrid research setup failed: {hybrid_error}")
                else:
                    # CANONICAL ANIME: Research and save to permanent storage
                    # First check if profile already exists
                    from src.agents.profile_generator import load_existing_profile
                    existing = load_existing_profile(media_ref)

                    if existing:
                        # Profile exists - just apply it, no progress bar needed
                        logger.info(f"Found existing profile for '{media_ref}'")
                        profile_id = existing.get("id")
                        session.character_draft.narrative_profile = profile_id
                        session.character_draft.media_reference = media_ref
                        result.detected_info["research_status"] = "existing_profile"
                        result.detected_info["profile_type"] = "canonical"
                        result.detected_info["profile_id"] = profile_id
                        result.detected_info["confidence"] = existing.get("confidence", 100)

                        # EARLY SETTINGS SYNC: Update settings immediately on profile selection
                        # This prevents wrong profile loading if server restarts before handoff
                        settings_store = get_settings_store()
                        current_settings = settings_store.load()
                        if current_settings.active_profile_id != profile_id:
                            logger.info(f"Early sync: {current_settings.active_profile_id} -> {profile_id}")
                            current_settings.active_profile_id = profile_id
                            current_settings.active_session_id = session.session_id
                            settings_store.save(current_settings)
                    else:
                        logger.debug(f"DEBUG: Entering Single Profile Logic for '{media_ref}'")
                        # No existing profile - run research as BACKGROUND TASK
                        try:
                            import asyncio

                            from src.agents.session_zero import research_and_apply_profile

                            # Create progress tracker for SSE streaming
                            progress_tracker = ProgressTracker(total_steps=10)
                            logger.debug(f"DEBUG: Outputting Task ID {progress_tracker.task_id}")

                            # EMIT IMMEDIATE START to verify connection
                            import asyncio
                            safe_create_task(progress_tracker.emit(
                                ProgressPhase.INITIALIZING,
                                f"Initializing research for {media_ref}...",
                                1
                            ), name="progress_emit_init")
                            result.detected_info["research_task_id"] = progress_tracker.task_id
                            result.detected_info["research_status"] = "in_progress"
                            result.detected_info["profile_type"] = "canonical"

                            # Define background task
                            async def run_research_background():
                                try:
                                    # research_and_apply_profile sets:
                                    # - session.character_draft.narrative_profile
                                    # - session.character_draft.media_reference
                                    # - session.phase_state["profile_data"]
                                    research_result = await research_and_apply_profile(
                                        session, media_ref, progress_tracker=progress_tracker
                                    )

                                    # Store additional metadata
                                    session.character_draft.attributes["research_status"] = research_result.get("status", "completed")
                                    session.character_draft.attributes["research_confidence"] = research_result.get("confidence")

                                    profile_id = session.character_draft.narrative_profile
                                    logger.info(f"narrative_profile set to: '{profile_id}'")

                                    # Save session with linked profile
                                    store = get_session_store()
                                    store.save(session)
                                    logger.info(f"Session saved to DB with profile '{profile_id}'")

                                    # Also update the in-memory session manager to stay in sync
                                    manager = get_session_manager()
                                    manager._sessions[session.session_id] = session
                                    logger.info("In-memory session updated")

                                except Exception as bg_error:
                                    logger.error(f"Background research failed: {bg_error}")
                                    import traceback
                                    traceback.print_exc()
                                    await progress_tracker.complete()

                            # Start research in background - don't await!
                            safe_create_task(run_research_background(), name="research_bg")
                            logger.info(f"Started background research for '{media_ref}' (task_id: {progress_tracker.task_id})")

                        except Exception as research_error:
                            logger.error(f"Research setup failed: {research_error}")

        # COMPLETENESS-DRIVEN PHASE TRACKING
        # Sync phase to actual data completeness (allows multi-phase skip)
        actual_phase = get_current_phase_for_draft(session.character_draft)
        if actual_phase != session.phase:
            logger.info(f"Phase sync: {session.phase.value} -> {actual_phase.value}")
            session.skip_to_phase(actual_phase)

        # Handle gameplay transition
        if result.ready_for_gameplay:
            logger.info("Agent set ready_for_gameplay=True")
            # Validate that we actually have all requirements
            missing = get_missing_requirements(session.character_draft)
            if missing:
                logger.warning(f"BLOCKED: Agent claimed ready but missing: {missing}")
                # Override the agent's decision - don't transition
                result.ready_for_gameplay = False
            else:
                logger.info("All requirements met - proceeding with handoff")

                # INDEX SESSION ZERO TO MEMORY (before creating orchestrator)
                # This stores character creation dialogue for RAG retrieval during gameplay
                from src.agents.session_zero import index_session_zero_to_memory
                try:
                    indexed_count = await index_session_zero_to_memory(session)
                    logger.info(f"Indexed {indexed_count} Session Zero chunks to memory")
                except Exception as mem_err:
                    logger.error(f"Memory indexing failed (non-fatal): {mem_err}")

                # HANDOFF HARDENING: Sync settings before initializing orchestrator
                draft = session.character_draft
                profile_to_use = draft.narrative_profile

                # Validate profile exists, fallback if needed
                from src.profiles.loader import list_profiles
                available_profiles = list_profiles()

                # If no profile set, derive from media_reference
                if not profile_to_use and draft.media_reference:
                    # Sanitize media reference to profile ID format
                    from src.agents.profile_generator import _sanitize_profile_id
                    inferred_profile = _sanitize_profile_id(draft.media_reference)
                    if inferred_profile in available_profiles:
                        profile_to_use = inferred_profile
                        logger.info(f"Inferred profile from media_reference: {profile_to_use}")

                # If profile not found in available profiles, use fallback
                if profile_to_use and profile_to_use not in available_profiles:
                    logger.warning(f"Profile '{profile_to_use}' not found in: {available_profiles[:5]}...")
                    profile_to_use = None  # Force fallback

                # CHECK FOR HYBRID PROFILES IN SESSION STORAGE
                # Hybrid profiles are stored separately from permanent profiles
                if not profile_to_use:
                    session_profile_type = session.phase_state.get("profile_type")
                    if session_profile_type == "hybrid":
                        # Hybrid profiles are in session storage, not permanent profiles
                        hybrid_id = draft.narrative_profile
                        if hybrid_id and hybrid_id.startswith("hybrid_"):
                            from src.context.custom_profile_library import get_custom_profile_library
                            custom_lib = get_custom_profile_library()
                            if custom_lib.has_session_profile(session.session_id):
                                profile_to_use = hybrid_id
                                logger.info(f"Using hybrid profile from session storage: {profile_to_use}")

                # Final fallback: use first available or "default"
                if not profile_to_use:
                    if available_profiles:
                        profile_to_use = available_profiles[0]
                        logger.warning(f"Using fallback profile: {profile_to_use}")
                    else:
                        profile_to_use = "default"
                        logger.info("No profiles available, using 'default'")

                # Update global settings with session's profile - ALWAYS do this
                from src.settings import reset_settings_store
                settings_store = get_settings_store()
                current_settings = settings_store.load()
                logger.info(f"[Handoff] Syncing settings: {current_settings.active_profile_id} -> {profile_to_use}")
                current_settings.active_profile_id = profile_to_use
                current_settings.active_campaign_id = profile_to_use
                current_settings.active_session_id = session.session_id  # Session-based memory isolation
                settings_store.save(current_settings)

                # VERIFY file was written correctly
                import json
                from pathlib import Path
                settings_path = Path(__file__).parent.parent.parent.parent / "settings.json"
                with open(settings_path) as f:
                    disk_data = json.load(f)
                logger.info(f"[Handoff] VERIFY disk after save: active_profile_id='{disk_data.get('active_profile_id')}'")

                reset_settings_store()  # Clear settings cache so next load picks up new values
                reset_orchestrator()  # Clear cached orchestrator to pick up new settings

                # Actually ready for gameplay - commit character
                session.skip_to_phase(SessionPhase.GAMEPLAY)

                logger.info("[Handoff] About to call get_orchestrator()...")
                orchestrator = get_orchestrator()
                logger.info(f"[Handoff] Orchestrator created successfully with profile: {orchestrator.profile_id}")


                # 1. Update Character
                # Determine power tier from Session Zero
                # Priority: explicit power_tier > OP inference > world_tier > T10
                if draft.power_tier:
                    final_tier = draft.power_tier
                elif draft.op_protagonist_enabled:
                    # OP mode but no explicit tier - use world tier - 4 (significant above baseline)
                    world_tier = session.phase_state.get("profile_data", {}).get("world_tier", "T10")
                    tier_num = int(world_tier.replace("T", ""))
                    final_tier = f"T{max(1, tier_num - 4)}"
                else:
                    final_tier = session.phase_state.get("profile_data", {}).get("world_tier", "T10")

                orchestrator.state.update_character(
                    name=draft.name or "Unnamed Protagonist",
                    level=1, # Default start
                    hp_current=draft.resources.get("HP", 100),
                    hp_max=draft.resources.get("HP", 100),
                    power_tier=final_tier,
                    abilities=draft.skills,
                    # Identity sync from Session Zero
                    concept=draft.concept,
                    age=draft.age,
                    backstory=draft.backstory,
                    appearance=draft.appearance,
                    visual_tags=draft.visual_tags,
                    personality_traits=draft.personality_traits,
                    values=draft.values,
                    fears=draft.fears,
                    quirks=draft.quirks,
                    short_term_goal=draft.goals.get("short_term") if draft.goals else None,
                    long_term_goal=draft.goals.get("long_term") if draft.goals else None,
                    inventory=draft.inventory,
                )
                logger.info(f"Power tier set to: {final_tier}")

                # 1b. Fire-and-forget: Generate player character media (portrait + model sheet)
                if draft.appearance or draft.visual_tags:
                    try:
                        import asyncio
                        safe_create_task(
                            _generate_handoff_character_media(
                                campaign_id=orchestrator.state.campaign_id,
                                character_name=draft.name or "protagonist",
                                appearance=draft.appearance,
                                visual_tags=draft.visual_tags,
                            ),
                            name="handoff_character_media",
                        )
                        logger.info("Queued player character media generation")
                    except Exception as media_err:
                        logger.error(f"Character media queue failed (non-fatal): {media_err}")

                # 2. Update World State (Location)
                if draft.starting_location:
                    orchestrator.state.update_world_state(
                        location=draft.starting_location,
                        situation="The journey begins."
                    )

                # 3. Transfer OP Mode from Session Zero to Gameplay
                if draft.op_protagonist_enabled:
                    orchestrator.state.update_op_mode(
                        enabled=True,
                        tension_source=draft.op_tension_source or "consequence",
                        power_expression=draft.op_power_expression or "derivative",
                        narrative_focus=draft.op_narrative_focus or "faction",
                        preset=draft.op_preset or "hidden_ruler"
                    )
                    logger.info(f"OP Mode transferred: {draft.op_preset}")

                # 4. SESSION ZERO CONTEXT TRANSFER
                # Inject recent Session Zero messages so Orchestrator knows the scene
                if session.messages:
                    # Get last 6 messages (3 exchanges) - captures opening scene + player actions
                    recent_messages = session.messages[-6:]

                    # Build context summary for memory injection
                    context_parts = []
                    for msg in recent_messages:
                        role = msg.get('role', 'unknown').upper()
                        content = msg.get('content', '')
                        # Truncate very long messages
                        if len(content) > 800:
                            content = content[:800] + "..."
                        context_parts.append(f"[{role}]: {content}")

                    recent_summary = "\n\n".join(context_parts)

                    # Extract last assistant message for situation summary
                    last_assistant_msg = None
                    for msg in reversed(session.messages):
                        if msg.get('role') == 'assistant':
                            last_assistant_msg = msg.get('content', '')
                            break

                    # Store FULL transcript for voice/tone continuity on first gameplay turn
                    # (Contains Phase 5 as the last assistant message - no need for separate handoff_scene)
                    session.phase_state["handoff_transcript"] = session.messages.copy()
                    logger.info(f"Full transcript stored ({len(session.messages)} messages)")

                    # Update world state with brief situation summary
                    situation_text = "Continuing from Session Zero opening scene."
                    if last_assistant_msg:
                        # Brief summary for other agents (300 chars)
                        situation_text = last_assistant_msg[:300]
                        if len(last_assistant_msg) > 300:
                            situation_text += "..."

                    # Update world state (overrides generic "The journey begins")
                    orchestrator.state.update_world_state(
                        location=draft.starting_location or "Unknown Location",
                        situation=situation_text,
                        arc_phase="setup",
                        tension_level=0.4
                    )

                    # Inject Session Zero context as high-priority memory
                    try:
                        orchestrator.memory.add_memory(
                            content=f"SESSION ZERO CONTEXT (Character creation and opening scene):\n\n{recent_summary}",
                            memory_type="session_zero",
                            turn_number=0,
                            metadata={"source": "session_zero_handoff"},
                            flags=["plot_critical", "session_zero"]
                        )
                        logger.info(f"Session Zero context injected ({len(recent_summary)} chars)")
                    except Exception as mem_err:
                        logger.error(f"Memory injection failed (non-critical): {mem_err}")

                    # Save session with handoff_scene
                    session_store = get_session_store()
                    session_store.save(session)

                # 5. Director Startup Briefing — create initial storyboard
                try:
                    s0_summary = _build_session_zero_summary(session, draft)
                    await orchestrator.run_director_startup(
                        session_zero_summary=s0_summary,
                        character_name=draft.name or "Unknown",
                        character_concept=draft.concept or "",
                        starting_location=draft.starting_location or "Unknown",
                        op_mode=draft.op_protagonist_enabled,
                        op_preset=draft.op_preset,
                        op_tension_source=draft.op_tension_source,
                        op_power_expression=draft.op_power_expression,
                        op_narrative_focus=draft.op_narrative_focus,
                    )
                    logger.info("Director startup complete — initial storyboard created")
                except Exception as dir_err:
                    logger.error(f"Director startup failed (non-critical): {dir_err}")
                    import traceback
                    traceback.print_exc()

                # 6. SERVER-SIDE OPENING SCENE GENERATION
                # Generate the opening scene inline so the frontend gets farewell + scene
                # in a single response. No [BEGIN] auto-send needed.
                opening_narrative = None
                opening_portrait_map = None
                try:
                    logger.info("Generating opening scene server-side...")
                    opening_result = await orchestrator.process_turn(
                        player_input="[opening scene — the story begins]",
                        recent_messages=session.messages[-30:],
                        compaction_text=""
                    )
                    opening_narrative = opening_result.narrative
                    opening_portrait_map = opening_result.portrait_map
                    # Save opening to session history
                    session.add_message("assistant", opening_narrative)
                    session_store = get_session_store()
                    session_store.save(session)
                    logger.info(f"Opening scene generated ({len(opening_narrative)} chars)")
                except Exception as scene_err:
                    logger.error(f"Opening scene generation failed (non-critical): {scene_err}")
                    import traceback
                    traceback.print_exc()

        # DEPRECATED: Legacy phase_complete handling (for backward compatibility)
        elif result.phase_complete and not result.ready_for_gameplay:
            # Old-style phase advancement - still works but deprecated
            session.advance_phase()

            if session.phase == SessionPhase.GAMEPLAY:
                # Legacy transition path
                draft = session.character_draft
                orchestrator = get_orchestrator()

                orchestrator.state.update_character(
                    name=draft.name or "Unnamed Protagonist",
                    level=1,
                    hp_current=draft.resources.get("HP", 100),
                    hp_max=draft.resources.get("HP", 100),
                    power_tier=draft.attributes.get("power_tier", "T10"),
                    abilities=draft.skills,
                    # Identity sync from Session Zero
                    concept=draft.concept,
                    age=draft.age,
                    backstory=draft.backstory,
                    appearance=draft.appearance,
                    personality_traits=draft.personality_traits,
                    values=draft.values,
                    fears=draft.fears,
                    quirks=draft.quirks,
                    short_term_goal=draft.goals.get("short_term") if draft.goals else None,
                    long_term_goal=draft.goals.get("long_term") if draft.goals else None,
                    inventory=draft.inventory,
                )

                if draft.starting_location:
                    orchestrator.state.update_world_state(
                        location=draft.starting_location,
                        situation="The journey begins.",
                        # Sync canonicality from Session Zero
                        timeline_mode=draft.timeline_mode,
                        canon_cast_mode=draft.canon_cast_mode,
                        event_fidelity=draft.event_fidelity
                    )

                # Transfer OP Mode (legacy path)
                if draft.op_protagonist_enabled:
                    orchestrator.state.update_op_mode(
                        enabled=True,
                        tension_source=draft.op_tension_source or "consequence",
                        power_expression=draft.op_power_expression or "derivative",
                        narrative_focus=draft.op_narrative_focus or "faction",
                        preset=draft.op_preset or "hidden_ruler"
                    )

        # Handle explicit phase skip requests (kept for manual override)
        if result.suggested_next_phase:
            try:
                target = SessionPhase(result.suggested_next_phase)
                session.skip_to_phase(target)
            except ValueError:
                pass  # Invalid phase, ignore


        # Record AI response
        session.add_message("assistant", result.response)

        # Build character draft summary for response
        draft_dict = {
            "name": session.character_draft.name,
            "concept": session.character_draft.concept,
            "media_reference": session.character_draft.media_reference,
            "narrative_profile": session.character_draft.narrative_profile,
            "op_mode": session.character_draft.op_protagonist_enabled,
            "attributes": session.character_draft.attributes,
        }

        # DEFENSIVE PROFILE SYNC: Ensure settings always have the profile set
        # This prevents "No active profile" errors when handoff logic is bypassed
        profile_to_sync = session.character_draft.narrative_profile
        if not profile_to_sync and session.character_draft.media_reference:
            # Infer from media_reference
            from src.agents.profile_generator import _sanitize_profile_id
            profile_to_sync = _sanitize_profile_id(session.character_draft.media_reference)

        if profile_to_sync:
            # get_settings_store is already imported at module level
            settings_store = get_settings_store()
            current_settings = settings_store.load()
            if current_settings.active_profile_id != profile_to_sync:
                logger.info(f"[SessionZero] Defensive sync: {current_settings.active_profile_id} -> {profile_to_sync}")
                current_settings.active_profile_id = profile_to_sync
                current_settings.active_campaign_id = profile_to_sync
                settings_store.save(current_settings)
                # Reset orchestrator so next /turn call creates fresh instance with new profile
                reset_orchestrator()

        return SessionZeroResponse(
            response=result.response,
            phase=session.phase.value,
            phase_complete=result.phase_complete,
            character_draft=draft_dict,
            session_id=session_id,
            missing_requirements=result.missing_requirements,
            ready_for_gameplay=result.ready_for_gameplay,
            research_task_id=result.detected_info.get("research_task_id") if result.detected_info else None,
            detected_info=result.detected_info,
            opening_scene=opening_narrative if result.ready_for_gameplay else None,
            opening_portrait_map=opening_portrait_map if result.ready_for_gameplay else None,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Session Zero error: {str(e)}")

    finally:
        # Always save session after processing
        store = get_session_store()
        store.save(session)
