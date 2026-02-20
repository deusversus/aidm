"""Gameplay routes: process_turn, context, reset, export/import, profile change."""

import logging

from fastapi import APIRouter, HTTPException

from src.core.session import get_session_manager
from src.db.session_store import get_session_store
from src.settings import get_settings_store

from .models import ContextResponse, TurnRequest, TurnResponse
from .session_mgmt import (
    get_orchestrator,
    prepare_working_memory,
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

    orchestrator = get_orchestrator()
    recent_messages, compaction_text = await prepare_working_memory(session, orchestrator)

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
