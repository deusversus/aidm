"""Gameplay routes: process_turn, context, reset, export/import, profile change."""

import logging

from fastapi import APIRouter, HTTPException

from src.core.session import get_session_manager
from src.db.session_store import get_session_store
from src.settings import get_settings_store

from .models import ContextResponse, TurnRequest, TurnResponse
from .session_mgmt import (
    get_orchestrator,
    reset_orchestrator,
    reset_session_zero_agent,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/turn", response_model=TurnResponse)
async def process_turn(request: TurnRequest):
    """Process a game turn.
    
    This is for GAMEPLAY mode (after Session Zero is complete).
    For Session Zero, use /session/{id}/turn instead.
    
    Args:
        request: The player's input
        
    Returns:
        TurnResponse with narrative and agent decisions
    """
    if not request.player_input.strip():
        raise HTTPException(status_code=400, detail="Player input cannot be empty")

    # Get session for persistence
    store = get_session_store()
    session = None

    # Check if there's an active session in Session Zero
    if request.session_id:
        manager = get_session_manager()
        session = manager.get_session(request.session_id)
        if session and session.is_session_zero():
            raise HTTPException(
                status_code=400,
                detail="Session is still in Session Zero. Use /session/{id}/turn to complete character creation first."
            )
        # Load session from persistent store for gameplay
        if not session:
            session = store.load(request.session_id)

    # Add user message to session BEFORE processing
    if session:
        session.add_message("user", request.player_input)

    # =====================================================================
    # COMPACTION: Detect dropped messages and micro-summarize them
    # The sliding window is 15 messages. When total messages exceeds 15,
    # the oldest messages fall off. We compact them into narrative beats.
    # =====================================================================
    WINDOW_SIZE = 20  # #5: Increased from 15 → 20 (~10 exchanges)
    COMPACTION_MAX_TOKENS = 10_000

    compaction_text = ""
    if session and hasattr(session, 'messages') and len(session.messages) > WINDOW_SIZE:
        # Messages that just fell off the window
        dropped_start = max(0, len(session.messages) - WINDOW_SIZE - 2)  # -2 for user+assistant from last turn
        dropped_end = len(session.messages) - WINDOW_SIZE

        if dropped_end > dropped_start and dropped_end > 0:
            dropped_messages = session.messages[dropped_start:dropped_end]

            if dropped_messages:
                try:
                    from src.agents.compactor import CompactorAgent
                    compactor = CompactorAgent()

                    # Get last 2 compaction entries for continuity context
                    prior_context = ""
                    if hasattr(session, 'compaction_buffer') and session.compaction_buffer:
                        recent_entries = session.compaction_buffer[-2:]
                        prior_context = "\n\n".join(e["summary"] for e in recent_entries)

                    # Run micro-compaction (fast-tier model, ~500 tokens in, ~200 out)
                    micro_summary = await compactor.compact(
                        dropped_messages=dropped_messages,
                        prior_context=prior_context
                    )

                    if micro_summary:
                        # Estimate tokens
                        tokens_est = int(len(micro_summary.split()) * 1.3)

                        # Append to buffer
                        if not hasattr(session, 'compaction_buffer'):
                            session.compaction_buffer = []
                        session.compaction_buffer.append({
                            "turn": len(session.messages) // 2,  # approximate turn number
                            "summary": micro_summary,
                            "tokens_est": tokens_est
                        })

                        # Enforce 10k token ceiling (FIFO eviction)
                        total_tokens = sum(e["tokens_est"] for e in session.compaction_buffer)
                        while total_tokens > COMPACTION_MAX_TOKENS and len(session.compaction_buffer) > 1:
                            evicted = session.compaction_buffer.pop(0)
                            total_tokens -= evicted["tokens_est"]
                            logger.info(f"Evicted oldest entry (turn {evicted['turn']}, {evicted['tokens_est']} tokens)")

                        logger.info(f"Appended micro-summary ({tokens_est} tokens, buffer: {len(session.compaction_buffer)} entries, {total_tokens} total tokens)")
                except Exception as e:
                    logger.error(f"Failed (non-fatal): {e}")

    # Build compaction text from buffer for injection
    if session and hasattr(session, 'compaction_buffer') and session.compaction_buffer:
        compaction_text = "\n\n".join(
            f"**[Beat {e['turn']}]** {e['summary']}" for e in session.compaction_buffer
        )

    # Working Memory: Get last 15 messages from session (includes Session Zero + gameplay)
    # This replaces the one-time handoff_transcript mechanism
    recent_messages = session.messages[-WINDOW_SIZE:] if session and hasattr(session, 'messages') else []

    # #5: Prepend pinned messages (always in working memory regardless of window)
    if session and recent_messages:
        try:
            orchestrator_temp = get_orchestrator()
            db_context_temp = orchestrator_temp.state.get_context()
            pinned = getattr(db_context_temp, 'pinned_messages', []) or []
            if pinned:
                # Deduplicate: only prepend pinned messages not already in window
                window_contents = {msg.get('content', '')[:100] for msg in recent_messages}
                unique_pinned = [
                    p for p in pinned
                    if p.get('content', '')[:100] not in window_contents
                ]
                if unique_pinned:
                    recent_messages = unique_pinned + recent_messages
                    logger.info(f"Pinned {len(unique_pinned)} messages prepended to working memory")
        except Exception as e:
            logger.error(f"Pinned messages failed (non-fatal): {e}")

    if recent_messages:
        logger.info(f"Working memory: {len(recent_messages)} recent messages")

    orchestrator = get_orchestrator()

    try:
        try:
            safe_input = request.player_input[:50].encode('ascii', 'replace').decode('ascii')
            logger.info(f"Processing turn: '{safe_input}...'")
        except Exception:
            logger.error("Processing turn: (encoding failed)")
        result = await orchestrator.process_turn(player_input=request.player_input, recent_messages=recent_messages, compaction_text=compaction_text)

        # DEBUG: Log the actual narrative value
        logger.info("Result received:")
        logger.info(f"- narrative type: {type(result.narrative)}")
        logger.info(f"- narrative length: {len(result.narrative) if result.narrative else 0}")
        try:
            if result and result.narrative:
                safe_snippet = result.narrative[:100].encode('ascii', 'replace').decode('ascii')
                logger.info(f"- narrative first 100: {safe_snippet}")
            else:
                logger.info("- narrative first 100: EMPTY")
        except Exception:
            logger.error("- narrative logging failed")
        try:
            safe_intent = str(result.intent.intent).encode('ascii', 'replace').decode('ascii')
            safe_outcome = str(result.outcome.success_level).encode('ascii', 'replace').decode('ascii')
            logger.info(f"- intent: {safe_intent}")
            logger.info(f"- outcome: {safe_outcome}")
        except Exception:
            logger.error("- intent/outcome logging failed")

        # Add assistant response to session AFTER processing
        if session:
            session.add_message("assistant", result.narrative)
            store.save(session)
            logger.info(f"Session saved with {len(session.messages)} messages")

        # Determine session phase — meta conversation or normal gameplay
        current_phase = "meta_conversation" if orchestrator._in_meta_conversation else "gameplay"

        response = TurnResponse(
            narrative=result.narrative,
            intent=result.intent.model_dump(),
            outcome=result.outcome.model_dump() if result.outcome else {},
            latency_ms=result.latency_ms,
            session_phase=current_phase,
            portrait_map=result.portrait_map,
            turn_number=result.turn_number,
            campaign_id=result.campaign_id,
        )

        # DEBUG: Log what we're actually returning
        logger.info(f"Returning TurnResponse with narrative length: {len(response.narrative)}")

        return response
    except Exception as e:
        import traceback
        logger.error(f"ERROR in process_turn: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/context", response_model=ContextResponse)
async def get_context():
    """Get current game context."""
    orchestrator = get_orchestrator()
    context = orchestrator.state.get_context()

    return ContextResponse(
        location=context.location,
        situation=context.situation,
        character_name=context.character_name,
        arc_phase=context.arc_phase,
        tension_level=context.tension_level,
        profile_name=orchestrator.profile.name,
        session_phase="gameplay"
    )


@router.post("/reset")
async def reset_game():
    """Reset the game - clears all session data for fresh Session Zero.
    
    Deletes all campaigns, characters, world states, memories, and custom profiles.
    Preserves canonical profile lore and rules library.
    """
    from src.context.custom_profile_library import get_custom_profile_library
    from src.db.session_store import get_session_store
    from src.db.state_manager import StateManager
    from src.settings import reset_settings_store

    # 1. Clear all campaigns/characters/etc from DB + campaign memories
    StateManager.full_reset()

    # 2. Clear custom profile lore (hybrids/originals)
    custom_lib = get_custom_profile_library()
    custom_lib.clear_all()

    # 3. Clear Session Zero state
    session_store = get_session_store()
    session_store.clear_all()

    # 4. Clear settings
    store = get_settings_store()
    settings = store.load()
    settings.active_profile_id = ""
    settings.active_campaign_id = ""
    settings.active_session_id = ""
    store.save(settings)
    reset_settings_store()

    # 5. Reset singletons
    reset_orchestrator()
    reset_session_zero_agent()

    return {"status": "ok", "message": "Full reset complete - ready for new Session Zero"}


@router.get("/export")
async def export_session():
    """Export current session to downloadable .aidm file.
    
    Returns a ZIP file containing all campaign data that can be
    imported later to restore the exact session state.
    """
    from datetime import datetime

    from fastapi.responses import Response

    from src.core.session_export import export_session as do_export

    # Get current campaign ID
    orchestrator = get_orchestrator()
    campaign_id = orchestrator.campaign_id

    if not campaign_id:
        raise HTTPException(status_code=400, detail="No active campaign to export")

    # Export to ZIP bytes
    try:
        zip_bytes = do_export(campaign_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")

    # Generate filename
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    filename = f"session_export_{timestamp}.aidm"

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.post("/import")
async def import_session_endpoint(file: bytes = None):
    """Import session from uploaded .aidm file.
    
    This performs a FULL RESET first, then imports the session data.
    Use multipart/form-data to upload the file.
    """

    # This endpoint needs to be called differently - use a proper file upload
    # For now, return instructions
    raise HTTPException(
        status_code=400,
        detail="Use /game/import-file with multipart form data"
    )


@router.post("/import-file")
async def import_session_file():
    """Import session from uploaded .aidm file.
    
    Performs a FULL RESET first, then restores all session data.
    
    Note: This endpoint reads from the raw request body.
    For frontend, use the /import-bytes endpoint instead.
    """
    raise HTTPException(
        status_code=501,
        detail="Use /game/import-bytes with raw file bytes in request body"
    )


@router.post("/import-bytes")
async def import_session_bytes(request):
    """Import session from raw ZIP bytes in request body.
    
    Send the .aidm file contents directly as the request body.
    Frontend reads the file as ArrayBuffer and sends it.
    """
    from src.core.session_export import import_session as do_import

    # Get request body
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="No file data provided")

    try:
        new_campaign_id = do_import(body)

        # Reset singletons to load new campaign
        reset_orchestrator()
        reset_session_zero_agent()

        return {
            "status": "ok",
            "message": "Session imported successfully",
            "campaign_id": new_campaign_id
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")


@router.put("/profile/{profile_id}")
async def change_profile(profile_id: str):
    """Change the active narrative profile.
    
    Args:
        profile_id: The profile ID to switch to (e.g., 'hunterxhunter')
    """
    # Update settings
    store = get_settings_store()
    settings = store.load()
    settings.active_profile_id = profile_id
    store.save(settings)

    # Reset orchestrator and Session Zero agent to use new profile
    reset_orchestrator()
    reset_session_zero_agent()

    return {"status": "ok", "profile_id": profile_id}
