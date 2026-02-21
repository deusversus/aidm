"""Session management routes: start, resume, delete, latest, orchestrator cache."""

import logging
import uuid

from fastapi import APIRouter, HTTPException

from src.agents.session_zero import SessionZeroAgent
from src.core.orchestrator import Orchestrator
from src.core.session import (
    get_session_manager,
)
from src.db.session import init_db
from src.db.session_store import get_session_store
from src.settings import get_settings_store

from .models import (
    ResumeSessionResponse,
    StartSessionRequest,
    StartSessionResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Cache orchestrator instance
_orchestrator: Orchestrator | None = None
_session_zero_agent: SessionZeroAgent | None = None


def get_orchestrator() -> Orchestrator:
    """Get or create the orchestrator instance."""
    global _orchestrator

    if _orchestrator is None:
        # Initialize database
        init_db()

        # Get active profile from settings
        # Use reload() to force fresh read from disk - crucial after Session Zero handoff
        store = get_settings_store()
        settings = store.reload()

        profile_id = settings.active_profile_id

        # DEBUG: Log what we loaded
        logger.info(f"[get_orchestrator] Loaded settings: active_profile_id='{profile_id}', active_campaign_id='{settings.active_campaign_id}'")

        # Handle missing profile - requires Session Zero to set it
        if not profile_id:  # Empty string means not configured
            logger.error("[get_orchestrator] ERROR: No profile set! Settings file may not be synced.")
            raise HTTPException(
                status_code=400,
                detail="No active profile set. Please complete Session Zero first."
            )

        # Orchestrator now resolves profile_id -> campaign_id internally
        # Pass session_id for memory collection isolation
        session_id = settings.active_session_id or profile_id  # Fallback to profile_id for backward compatibility
        _orchestrator = Orchestrator(profile_id=profile_id, session_id=session_id)

    return _orchestrator


def reset_orchestrator():
    """Reset the orchestrator singleton.
    
    Call this after Session Zero handoff to ensure the next
    get_orchestrator() call creates a fresh instance with
    the newly set active_profile_id.
    """
    global _orchestrator
    if _orchestrator:
        try:
            _orchestrator.close()
        except Exception as e:
            logger.error(f"[reset_orchestrator] Warning: close() failed: {e}")
    _orchestrator = None
    logger.info("[reset_orchestrator] Orchestrator cleared - next call will create fresh instance")



def get_session_zero_agent() -> SessionZeroAgent:
    """Get or create the Session Zero agent."""
    global _session_zero_agent
    if _session_zero_agent is None:
        _session_zero_agent = SessionZeroAgent()
    return _session_zero_agent


def reset_session_zero_agent():
    """Reset the Session Zero agent (after settings change)."""
    global _session_zero_agent
    _session_zero_agent = None


@router.post("/start-session", response_model=StartSessionResponse)
async def start_session(request: StartSessionRequest = None):
    """Start a new Session Zero.
    
    This begins the character creation process.
    Returns the opening message from the AI Dungeon Master.
    """
    manager = get_session_manager()
    store = get_session_store()

    # Generate or use provided session ID
    session_id = (request.session_id if request else None) or str(uuid.uuid4())

    # FIX #4: Validate settings on new session - clear stale data
    # If there's a stale session_id that doesn't match, reset settings
    settings_store = get_settings_store()
    current_settings = settings_store.load()
    if current_settings.active_session_id and current_settings.active_session_id != session_id:
        logger.info(f"Clearing stale settings: session_id was '{current_settings.active_session_id}'")
        current_settings.active_profile_id = ""
        current_settings.active_session_id = ""
        current_settings.active_campaign_id = None
        settings_store.save(current_settings)

    # Create new session
    session = manager.create_session(session_id)

    # Get the Session Zero agent
    agent = get_session_zero_agent()

    # Generate opening message
    try:
        opening = await agent.get_opening_message(session)

        # Store the opening in message history
        session.add_message("assistant", opening)

        # Save to persistent store
        store.save(session)

        return StartSessionResponse(
            session_id=session_id,
            phase=session.phase.value,
            opening_message=opening
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start session: {str(e)}")


@router.get("/session/{session_id}/resume", response_model=ResumeSessionResponse)
async def resume_session(session_id: str):
    """Resume an existing session.
    
    Loads the session from persistent storage and returns its state.
    """
    store = get_session_store()
    manager = get_session_manager()

    # Try to load from persistent store
    session = store.load(session_id)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Put it back into the session manager
    manager._sessions[session_id] = session

    # Get character draft if exists
    draft_dict = None
    if session.character_draft:
        draft_dict = session.character_draft.to_dict()

    # Generate "Previously On..." recap for gameplay sessions with history
    recap_text = None
    if session.phase.value == "GAMEPLAY" and session.messages and len(session.messages) > 2:
        try:
            from src.agents.recap_agent import RecapAgent
            from src.db.state_manager import StateManager

            recap_agent = RecapAgent()
            state = StateManager(campaign_id=session.campaign_id)

            # Gather context for recap
            bible = state.get_campaign_bible()
            arc_history = (bible.planning_data or {}).get("arc_history", []) if bible else []
            world = state.get_world_state()
            situation = world.situation if world else "Unknown"
            arc_phase = world.arc_phase if world else "unknown"
            character = state.get_character()
            char_name = character.name if character else "Protagonist"

            # Get top narrative beat memories (if memory system available)
            narrative_beats = []
            try:
                from src.context.memory import MemoryStore
                memory = MemoryStore(campaign_id=session.campaign_id)
                beat_results = memory.search("recent emotional narrative moments", top_k=5, category="narrative_beat")
                narrative_beats = [r["content"] for r in beat_results] if beat_results else []
            except Exception:
                pass  # Memory not available, proceed without beats

            director_notes = (bible.planning_data or {}).get("director_notes", "") if bible else ""

            recap_output = await recap_agent.generate_recap(
                arc_history=arc_history,
                narrative_beats=narrative_beats,
                director_notes=director_notes,
                current_situation=situation,
                character_name=char_name,
                arc_phase=arc_phase,
            )
            if recap_output:
                recap_text = recap_output.recap_text
                logger.info(f"Generated recap: {recap_text[:100]}...")
        except Exception as e:
            logger.error(f"Recap generation failed (non-fatal): {e}")

    # Get current turn count from DB for gameplay detection
    current_turn = 0
    portrait_maps = {}
    if session.phase.value == "GAMEPLAY" and session.campaign_id:
        try:
            from src.db.models import Session as DBSession, Turn
            from src.db.session import create_session as create_db_session
            db = create_db_session()
            turns = db.query(Turn).filter(
                Turn.session_id.in_(
                    db.query(DBSession.id).filter(DBSession.campaign_id == session.campaign_id)
                )
            ).order_by(Turn.turn_number.asc()).all()

            if turns:
                current_turn = turns[-1].turn_number

            # Build portrait_maps from persisted Turn records
            for t in turns:
                if t.portrait_map:
                    portrait_maps[t.turn_number] = t.portrait_map

            # Fallback: re-resolve portraits for turns without saved maps
            if turns and not portrait_maps:
                try:
                    from src.media.resolver import resolve_portraits
                    # Build one combined map from current NPC/Character portraits
                    _, combined_map = resolve_portraits("", session.campaign_id)
                    if combined_map:
                        # Apply to all assistant messages
                        portrait_maps[-1] = combined_map  # -1 = "apply to all"
                except Exception:
                    pass

            db.close()
        except Exception as e:
            logger.warning(f"Resume portrait_maps failed (non-fatal): {e}")

    return ResumeSessionResponse(
        session_id=session_id,
        phase=session.phase.value,
        messages=session.messages,
        character_draft=draft_dict,
        recap=recap_text,
        turn_number=current_turn,
        portrait_maps=portrait_maps or None,
    )


@router.get("/session/latest")
async def get_latest_session():
    """Get the most recently active session.
    
    Used for frontend recovery after server restart.
    If the current session_id returns 404, frontend can use this
    to recover to the last active session.
    """
    store = get_session_store()
    session_id = store.get_latest_session_id()

    if not session_id:
        raise HTTPException(status_code=404, detail="No sessions found")

    # Load and return session info
    session = store.load(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session data corrupted")

    return {
        "session_id": session_id,
        "phase": session.phase.value,
        "is_session_zero": session.is_session_zero(),
        "profile": session.character_draft.narrative_profile if session.character_draft else None
    }

@router.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """Delete a session (for reset).
    
    Removes the session from both memory and persistent storage.
    Also cleans up any custom profile data for this session.
    """
    store = get_session_store()
    manager = get_session_manager()

    # Remove from memory
    if session_id in manager._sessions:
        del manager._sessions[session_id]

    # Remove from persistent store
    deleted = store.delete(session_id)

    # Clean up custom profile (if any)
    from src.context.custom_profile_library import delete_custom_profile, get_custom_profile_library
    custom_lib = get_custom_profile_library()
    lore_deleted = custom_lib.delete_session_lore(session_id)
    folder_deleted = delete_custom_profile(session_id)

    # Clear campaign memory (ChromaDB collection)
    # Now uses session_id for proper isolation
    memory_deleted = False
    try:
        import chromadb

        from src.settings import get_settings_store
        settings_store = get_settings_store()
        settings = settings_store.load()

        # Use active_session_id for session-based memory isolation
        # Fallback to active_profile_id for backward compatibility
        session_collection_id = settings.active_session_id or settings.active_profile_id

        if session_collection_id:
            client = chromadb.PersistentClient(path="./data/chroma")
            collection_name = f"campaign_{session_collection_id}"

            # Check if collection exists before deleting
            existing = [c.name for c in client.list_collections()]
            if collection_name in existing:
                client.delete_collection(collection_name)
                memory_deleted = True
                logger.info(f"Deleted memory collection: {collection_name}")
    except Exception as e:
        logger.error(f"Memory cleanup error: {e}")

    # Clean up generated media files (portraits, model sheets, cutscenes, locations)
    media_deleted = False
    try:
        from pathlib import Path

        from src.db._core import get_db
        from src.db.models import Campaign
        from src.settings import get_settings_store

        settings_for_media = get_settings_store().load()
        profile_id = settings_for_media.active_profile_id

        if profile_id:
            db = next(get_db())
            campaign = db.query(Campaign).filter(Campaign.profile_id == profile_id).first()
            if campaign:
                media_dir = Path(__file__).parent.parent.parent.parent / "data" / "media" / str(campaign.id)
                if media_dir.exists():
                    import shutil
                    shutil.rmtree(media_dir)
                    media_deleted = True
                    logger.info(f"Deleted media directory: {media_dir}")
    except Exception as e:
        logger.error(f"Media cleanup error: {e}")

    return {
        "deleted": deleted,
        "session_id": session_id,
        "custom_lore_deleted": lore_deleted,
        "custom_folder_deleted": folder_deleted,
        "memory_deleted": memory_deleted,
        "media_deleted": media_deleted
    }


def _build_session_zero_summary(session, draft) -> str:
    """Build a summary of Session Zero for the Director Startup Briefing.
    
    Extracts character identity, player preferences, and key conversation
    highlights from the Session Zero session and character draft.
    """
    parts = []

    # Character identity
    parts.append("### Character")
    if draft.name:
        parts.append(f"- Name: {draft.name}")
    if draft.concept:
        parts.append(f"- Concept: {draft.concept}")
    if draft.backstory:
        backstory = draft.backstory[:500] if len(str(draft.backstory)) > 500 else draft.backstory
        parts.append(f"- Backstory: {backstory}")
    if draft.personality_traits:
        parts.append(f"- Personality: {', '.join(draft.personality_traits)}")
    if draft.values:
        parts.append(f"- Values: {', '.join(draft.values)}")
    if draft.fears:
        parts.append(f"- Fears: {', '.join(draft.fears)}")
    if draft.quirks:
        parts.append(f"- Quirks: {', '.join(draft.quirks)}")
    if draft.goals:
        parts.append(f"- Goals: {draft.goals}")

    # World context
    parts.append("\n### World Context")
    if draft.media_reference:
        parts.append(f"- IP: {draft.media_reference}")
    if draft.starting_location:
        parts.append(f"- Starting Location: {draft.starting_location}")

    # Canonicality
    timeline = getattr(draft, 'timeline_mode', None)
    canon_cast = getattr(draft, 'canon_cast_mode', None)
    event_fidelity = getattr(draft, 'event_fidelity', None)
    if any([timeline, canon_cast, event_fidelity]):
        parts.append("\n### Canonicality")
        if timeline:
            parts.append(f"- Timeline: {timeline}")
        if canon_cast:
            parts.append(f"- Canon Cast: {canon_cast}")
        if event_fidelity:
            parts.append(f"- Event Fidelity: {event_fidelity}")

    # OP Mode
    if draft.op_protagonist_enabled:
        parts.append("\n### OP Mode: ACTIVE")
        if draft.op_preset:
            parts.append(f"- Configuration: {draft.op_preset}")
        if draft.op_tension_source:
            parts.append(f"- Tension Source: {draft.op_tension_source}")
        if draft.op_power_expression:
            parts.append(f"- Power Expression: {draft.op_power_expression}")
        if draft.op_narrative_focus:
            parts.append(f"- Narrative Focus: {draft.op_narrative_focus}")

    # Key conversation highlights (last few exchanges)
    if session.messages:
        parts.append("\n### Key Conversation Highlights")
        # Take last 6 messages to capture the character confirmation exchange
        recent = session.messages[-6:]
        for msg in recent:
            role = msg.get('role', 'unknown').upper()
            content = msg.get('content', '')
            if len(content) > 300:
                content = content[:300] + "..."
            parts.append(f"[{role}]: {content}")

    return "\n".join(parts)


async def prepare_working_memory(session, orchestrator) -> tuple[list, str]:
    """Prepare the working-memory window and compaction text for a gameplay turn.

    Encapsulates:
      - Sliding-window truncation (WINDOW_SIZE messages kept)
      - CompactorAgent micro-summary for messages that fell off the window
      - COMPACTION_MAX_TOKENS ceiling with FIFO eviction
      - Pinned-message prepend (always in working memory)

    Args:
        session:      The active Session object (may be None — safe).
        orchestrator: The live Orchestrator instance (used for pinned messages).

    Returns:
        (recent_messages, compaction_text) — both safe to pass directly to
        orchestrator.process_turn().
    """
    WINDOW_SIZE = 30
    COMPACTION_MAX_TOKENS = 10_000

    compaction_text = ""

    if session and hasattr(session, 'messages') and len(session.messages) > WINDOW_SIZE:
        dropped_start = max(0, len(session.messages) - WINDOW_SIZE - 2)
        dropped_end = len(session.messages) - WINDOW_SIZE

        if dropped_end > dropped_start and dropped_end > 0:
            dropped_messages = session.messages[dropped_start:dropped_end]

            if dropped_messages:
                try:
                    from src.agents.compactor import CompactorAgent
                    compactor = CompactorAgent()

                    prior_context = ""
                    if hasattr(session, 'compaction_buffer') and session.compaction_buffer:
                        recent_entries = session.compaction_buffer[-2:]
                        prior_context = "\n\n".join(e["summary"] for e in recent_entries)

                    micro_summary = await compactor.compact(
                        dropped_messages=dropped_messages,
                        prior_context=prior_context
                    )

                    if micro_summary:
                        tokens_est = int(len(micro_summary.split()) * 1.3)

                        if not hasattr(session, 'compaction_buffer'):
                            session.compaction_buffer = []
                        session.compaction_buffer.append({
                            "turn": len(session.messages) // 2,
                            "summary": micro_summary,
                            "tokens_est": tokens_est
                        })

                        # Enforce 10k token ceiling (FIFO eviction)
                        total_tokens = sum(e["tokens_est"] for e in session.compaction_buffer)
                        while total_tokens > COMPACTION_MAX_TOKENS and len(session.compaction_buffer) > 1:
                            evicted = session.compaction_buffer.pop(0)
                            total_tokens -= evicted["tokens_est"]
                            logger.info(f"Evicted oldest compaction entry (turn {evicted['turn']}, {evicted['tokens_est']} tokens)")

                        logger.info(
                            f"Appended micro-summary ({tokens_est} tokens, "
                            f"buffer: {len(session.compaction_buffer)} entries, {total_tokens} total tokens)"
                        )
                except Exception as e:
                    logger.error(f"Compaction failed (non-fatal): {e}")

    # Build compaction injection string from buffer
    if session and hasattr(session, 'compaction_buffer') and session.compaction_buffer:
        compaction_text = "\n\n".join(
            f"**[Beat {e['turn']}]** {e['summary']}" for e in session.compaction_buffer
        )

    # Sliding window
    recent_messages = session.messages[-WINDOW_SIZE:] if session and hasattr(session, 'messages') else []

    # Prepend pinned messages (always in working memory regardless of window position)
    if session and recent_messages:
        try:
            db_context = orchestrator.state.get_context()
            pinned = getattr(db_context, 'pinned_messages', []) or []
            if pinned:
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
        logger.info(f"Working memory: {len(recent_messages)} messages")

    return recent_messages, compaction_text


async def _generate_handoff_character_media(
    campaign_id: int,
    character_name: str,
    appearance: dict,
    visual_tags: list,
) -> None:
    """Fire-and-forget: generate player character model sheet + portrait during handoff.
    
    Non-blocking — runs as background task so it doesn't delay the handoff response.
    """
    try:
        from src.db.models import Character
        from src.db.session import create_session
        from src.media.generator import MediaGenerator
        from src.settings import get_settings_store

        settings = get_settings_store().load()
        if not settings.media_enabled:
            logger.warning("[Handoff→Media] Media disabled, skipping character media gen")
            return

        style_context = settings.active_profile_id or "anime"
        # Load rich visual_style from profile YAML if available
        try:
            import yaml
            from pathlib import Path
            profile_path = Path(__file__).parent.parent.parent / "src" / "profiles" / f"{settings.active_profile_id}.yaml"
            if profile_path.exists():
                with open(profile_path, 'r', encoding='utf-8') as f:
                    profile_data = yaml.safe_load(f)
                vs = profile_data.get('visual_style')
                if isinstance(vs, dict) and vs:
                    style_context = vs
        except Exception:
            pass  # Fall back to string style_context

        gen = MediaGenerator()
        result = await gen.generate_full_character_media(
            visual_tags=visual_tags or [],
            appearance=appearance or {},
            style_context=style_context,
            campaign_id=campaign_id,
            entity_name=character_name,
        )

        # Update Character record with generated URLs
        if result.get("portrait") or result.get("model_sheet"):
            db = create_session()
            char = (
                db.query(Character)
                .filter(Character.campaign_id == campaign_id)
                .first()
            )
            if char:
                if result.get("portrait"):
                    # Portrait is under portraits/ subdir, e.g. data/media/1/portraits/name_portrait.png
                    char.portrait_url = f"/api/game/media/{campaign_id}/portraits/{result['portrait'].name}"
                    logger.info(f"[Handoff→Media] Player portrait saved: {char.portrait_url}")
                if result.get("model_sheet"):
                    char.model_sheet_url = f"/api/game/media/{campaign_id}/models/{result['model_sheet'].name}"
                    logger.info(f"[Handoff→Media] Player model sheet saved: {char.model_sheet_url}")
                db.commit()
            db.close()

    except Exception as e:
        logger.error(f"[Handoff→Media] Character media gen failed (non-critical): {e}")
