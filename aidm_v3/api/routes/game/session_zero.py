"""Session Zero turn endpoint — the character creation conversation loop."""

import logging

from fastapi import APIRouter, HTTPException

from src.agents.progress import ProgressPhase, ProgressTracker
from src.agents.session_zero import (
    apply_detected_info,
    process_session_zero_state,
)
from src.agents.intent_resolution_handler import resolve_media_intent
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


async def _handle_gameplay_handoff(session, session_id: str, result, agent) -> tuple:
    """Execute the full gameplay handoff sequence.
    
    Handles: memory indexing, settings sync, profile validation,
    orchestrator init, character update, media gen, world state,
    OP mode transfer, context injection, director startup, opening scene.
    
    Returns:
        Tuple of (opening_narrative, opening_portrait_map).
        Both may be None if opening scene generation fails.
    """
    opening_narrative = None
    opening_portrait_map = None

    # INDEX SESSION ZERO TO MEMORY (before creating orchestrator)
    from src.agents.session_zero import index_session_zero_to_memory
    try:
        indexed_count = await index_session_zero_to_memory(session)
        logger.info(f"Indexed {indexed_count} Session Zero chunks to memory")
    except Exception as mem_err:
        logger.error(f"Memory indexing failed (non-fatal): {mem_err}")

    # --- Settings Sync & Profile Resolution ---
    draft = session.character_draft
    profile_to_use = draft.narrative_profile

    from src.profiles.loader import list_profiles
    available_profiles = list_profiles()

    if not profile_to_use and draft.media_reference:
        from src.agents.profile_generator import _sanitize_profile_id
        inferred_profile = _sanitize_profile_id(draft.media_reference)
        if inferred_profile in available_profiles:
            profile_to_use = inferred_profile
            logger.info(f"Inferred profile from media_reference: {profile_to_use}")

    if profile_to_use and profile_to_use not in available_profiles:
        logger.warning(f"Profile '{profile_to_use}' not found in: {available_profiles[:5]}...")
        profile_to_use = None

    if not profile_to_use:
        session_profile_type = session.phase_state.get("profile_type")
        if session_profile_type == "hybrid":
            hybrid_id = draft.narrative_profile
            if hybrid_id and hybrid_id.startswith("hybrid_"):
                from src.context.custom_profile_library import get_custom_profile_library
                custom_lib = get_custom_profile_library()
                if custom_lib.has_session_profile(session.session_id):
                    profile_to_use = hybrid_id
                    logger.info(f"Using hybrid profile from session storage: {profile_to_use}")

    if not profile_to_use:
        if available_profiles:
            profile_to_use = available_profiles[0]
            logger.warning(f"Using fallback profile: {profile_to_use}")
        else:
            profile_to_use = "default"
            logger.info("No profiles available, using 'default'")

    # Update global settings
    from src.settings import reset_settings_store
    settings_store = get_settings_store()
    current_settings = settings_store.load()
    logger.info(f"[Handoff] Syncing settings: {current_settings.active_profile_id} -> {profile_to_use}")
    current_settings.active_profile_id = profile_to_use
    current_settings.active_campaign_id = profile_to_use
    current_settings.active_session_id = session.session_id
    settings_store.save(current_settings)

    # Verify settings file
    import json
    from pathlib import Path
    settings_path = Path(__file__).parent.parent.parent.parent / "settings.json"
    with open(settings_path) as f:
        disk_data = json.load(f)
    logger.info(f"[Handoff] VERIFY disk after save: active_profile_id='{disk_data.get('active_profile_id')}'")

    reset_settings_store()
    reset_orchestrator()

    # --- Orchestrator Init ---
    session.skip_to_phase(SessionPhase.GAMEPLAY)
    logger.info("[Handoff] About to call get_orchestrator()...")
    orchestrator = get_orchestrator()
    logger.info(f"[Handoff] Orchestrator created successfully with profile: {orchestrator.profile_id}")

    # --- 1. Update Character ---
    if draft.power_tier:
        final_tier = draft.power_tier
    elif draft.op_protagonist_enabled:
        world_tier = session.phase_state.get("profile_data", {}).get("world_tier", "T10")
        tier_num = int(world_tier.replace("T", ""))
        final_tier = f"T{max(1, tier_num - 4)}"
    else:
        final_tier = session.phase_state.get("profile_data", {}).get("world_tier", "T10")

    orchestrator.state.update_character(
        name=draft.name or "Unnamed Protagonist",
        level=1,
        hp_current=draft.resources.get("HP", 100),
        hp_max=draft.resources.get("HP", 100),
        power_tier=final_tier,
        abilities=draft.skills,
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

    # 1b. Fire-and-forget: Generate player character media
    if draft.appearance or draft.visual_tags:
        try:
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

    # --- 2. Update World State ---
    if draft.starting_location:
        orchestrator.state.update_world_state(
            location=draft.starting_location,
            situation="The journey begins."
        )

    # --- 3. Transfer OP Mode ---
    if draft.op_protagonist_enabled:
        orchestrator.state.update_op_mode(
            enabled=True,
            tension_source=draft.op_tension_source or "consequence",
            power_expression=draft.op_power_expression or "derivative",
            narrative_focus=draft.op_narrative_focus or "faction",
            preset=draft.op_preset or "hidden_ruler"
        )
        logger.info(f"OP Mode transferred: {draft.op_preset}")

    # --- 4. Session Zero Context Transfer ---
    if session.messages:
        recent_messages = session.messages[-6:]
        context_parts = []
        for msg in recent_messages:
            role = msg.get('role', 'unknown').upper()
            content = msg.get('content', '')
            if len(content) > 800:
                content = content[:800] + "..."
            context_parts.append(f"[{role}]: {content}")

        recent_summary = "\n\n".join(context_parts)

        last_assistant_msg = None
        for msg in reversed(session.messages):
            if msg.get('role') == 'assistant':
                last_assistant_msg = msg.get('content', '')
                break

        session.phase_state["handoff_transcript"] = session.messages.copy()
        logger.info(f"Full transcript stored ({len(session.messages)} messages)")

        situation_text = "Continuing from Session Zero opening scene."
        if last_assistant_msg:
            situation_text = last_assistant_msg[:300]
            if len(last_assistant_msg) > 300:
                situation_text += "..."

        orchestrator.state.update_world_state(
            location=draft.starting_location or "Unknown Location",
            situation=situation_text,
            arc_phase="setup",
            tension_level=0.4
        )

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

        session_store = get_session_store()
        session_store.save(session)

    # --- 5. Director Startup ---
    try:
        s0_summary = _build_session_zero_summary(session, draft)
        await orchestrator.run_director_startup(
            session_zero_summary=s0_summary,
            character_name=draft.name or "Unknown",
            character_concept=draft.concept or "",
            starting_location=draft.starting_location or "Unknown",
            power_tier=draft.power_tier,
            tension_source=draft.tension_source or draft.op_tension_source,
            power_expression=draft.power_expression or draft.op_power_expression,
            narrative_focus=draft.narrative_focus or draft.op_narrative_focus,
            composition_name=draft.composition_name or draft.op_preset,
        )
        logger.info("Director startup complete — initial storyboard created")
    except Exception as dir_err:
        logger.error(f"Director startup failed (non-critical): {dir_err}")
        import traceback
        traceback.print_exc()

    # --- 6. Server-side Opening Scene ---
    try:
        logger.info("Generating opening scene server-side...")
        opening_result = await orchestrator.process_turn(
            player_input="[opening scene — the story begins]",
            recent_messages=session.messages[-30:],
            compaction_text=""
        )
        opening_narrative = opening_result.narrative
        opening_portrait_map = opening_result.portrait_map
        session.add_message("assistant", opening_narrative)
        session_store = get_session_store()
        session_store.save(session)
        logger.info(f"Opening scene generated ({len(opening_narrative)} chars)")
    except Exception as scene_err:
        logger.error(f"Opening scene generation failed (non-critical): {scene_err}")
        import traceback
        traceback.print_exc()

    return opening_narrative, opening_portrait_map


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

                # ======== INTENT RESOLUTION (replaces disambiguation + research routing) ========
                intent_result = await resolve_media_intent(
                    session=session,
                    media_ref=media_ref,
                    secondary_ref=secondary_ref,
                    detected_info=result.detected_info,
                )

                # Apply metadata updates to detected_info
                result.detected_info.update(intent_result.detected_info_updates)

                if intent_result.action == "custom":
                    # CUSTOM/ORIGINAL PROFILE
                    try:
                        from src.agents.session_zero import generate_custom_profile
                        await generate_custom_profile(session)
                    except Exception as custom_error:
                        logger.error(f"Custom profile generation failed: {custom_error}")

                elif intent_result.action == "disambiguation":
                    # Agent needs user clarification — return options
                    session.add_message("assistant", intent_result.response_text)
                    store = get_session_store()
                    store.save(session)

                    return SessionZeroResponse(
                        response=intent_result.response_text,
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
                        disambiguation_options=intent_result.disambiguation_options,
                        awaiting_disambiguation=True,
                    )

                elif intent_result.action == "ready":
                    # Profile(s) already exist — link and continue
                    profile_id = intent_result.profile_id
                    session.character_draft.narrative_profile = profile_id
                    if not session.character_draft.media_reference:
                        session.character_draft.media_reference = media_ref

                    # EARLY SETTINGS SYNC
                    settings_store = get_settings_store()
                    current_settings = settings_store.load()
                    if profile_id and current_settings.active_profile_id != profile_id:
                        logger.info(f"Early sync: {current_settings.active_profile_id} -> {profile_id}")
                        current_settings.active_profile_id = profile_id
                        current_settings.active_session_id = session.session_id
                        settings_store.save(current_settings)

                elif intent_result.action == "research":
                    # Needs background research — launch task
                    if intent_result.background_coro:
                        safe_create_task(
                            intent_result.background_coro(),
                            name="intent_research_bg",
                        )
                        logger.info(
                            f"Started intent research "
                            f"(task_id: {intent_result.progress_tracker.task_id if intent_result.progress_tracker else 'none'})"
                        )

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
                opening_narrative, opening_portrait_map = await _handle_gameplay_handoff(
                    session, session_id, result, agent
                )

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
