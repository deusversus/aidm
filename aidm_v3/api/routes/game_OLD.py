"""Game API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
import uuid

from src.core.orchestrator import Orchestrator
from src.core.session import (
    get_session_manager, 
    Session, 
    SessionPhase,
    SessionManager,
    get_missing_requirements,
    get_current_phase_for_draft,
    is_ready_for_gameplay,
)
from src.agents.session_zero import SessionZeroAgent, apply_detected_info, research_and_apply_profile
from src.agents.progress import ProgressTracker
from src.settings import get_settings_store
from src.db.session import init_db
from src.db.session_store import get_session_store

router = APIRouter()

# Cache orchestrator instance
_orchestrator: Optional[Orchestrator] = None
_session_zero_agent: Optional[SessionZeroAgent] = None


def get_orchestrator() -> Orchestrator:
    """Get or create the orchestrator instance."""
    global _orchestrator
    
    if _orchestrator is None:
        # Initialize database
        init_db()
        
        # Get active profile from settings
        store = get_settings_store()
        settings = store.load()
        
        profile_id = settings.active_profile_id
        
        # Handle missing profile - requires Session Zero to set it
        if not profile_id:  # Empty string means not configured
            raise HTTPException(
                status_code=400,
                detail="No active profile set. Please complete Session Zero first."
            )
        
        campaign_id = settings.active_campaign_id or profile_id
        
        _orchestrator = Orchestrator(
            campaign_id=campaign_id,
            profile_id=profile_id
        )
    
    return _orchestrator


def get_session_zero_agent() -> SessionZeroAgent:
    """Get or create the Session Zero agent."""
    global _session_zero_agent
    if _session_zero_agent is None:
        _session_zero_agent = SessionZeroAgent()
    return _session_zero_agent


def reset_orchestrator():
    """Reset the orchestrator (after settings change)."""
    global _orchestrator
    if _orchestrator:
        _orchestrator.close()
    _orchestrator = None


def reset_session_zero_agent():
    """Reset the Session Zero agent (after settings change)."""
    global _session_zero_agent
    _session_zero_agent = None


class TurnRequest(BaseModel):
    """Request for processing a turn."""
    player_input: str
    session_id: Optional[str] = None  # Optional session tracking


class TurnResponse(BaseModel):
    """Response from processing a turn."""
    narrative: str
    intent: Dict[str, Any]
    outcome: Dict[str, Any]
    latency_ms: int
    session_phase: Optional[str] = None  # Current session phase


class SessionZeroResponse(BaseModel):
    """Response from Session Zero processing."""
    response: str
    phase: str
    phase_complete: bool  # DEPRECATED: Use ready_for_gameplay
    character_draft: Dict[str, Any]
    session_id: str
    # New goal-oriented fields
    missing_requirements: list = []  # Hard requirements still needed
    ready_for_gameplay: bool = False  # True when all requirements met
    # Progress tracking for long-running research
    research_task_id: Optional[str] = None  # SSE stream ID for progress


class ContextResponse(BaseModel):
    """Current game context."""
    location: str
    situation: str
    character_name: str
    arc_phase: str
    tension_level: float
    profile_name: str
    session_phase: Optional[str] = None  # Session Zero phase if active


# === NEW: Status Tracker Response Models ===

class CharacterStatusResponse(BaseModel):
    """Character status for HP/MP/SP bars and stats."""
    name: str
    level: int
    xp_current: int
    xp_to_next: int
    hp_current: int
    hp_max: int
    mp_current: int
    mp_max: int
    sp_current: int
    sp_max: int
    stats: Dict[str, Any]  # STR, INT, etc.
    power_tier: str
    abilities: list
    character_class: Optional[str] = None


class NPCInfo(BaseModel):
    """NPC information for relationship tracker."""
    id: int
    name: str
    role: Optional[str]  # ally, enemy, neutral, rival
    affinity: int  # -100 to +100
    disposition: int  # calculated disposition
    faction: Optional[str]
    last_appeared: Optional[int]  # turn number


class NPCListResponse(BaseModel):
    """List of known NPCs."""
    npcs: list  # List of NPCInfo


class FactionInfo(BaseModel):
    """Faction information for reputation tracker."""
    id: int
    name: str
    pc_reputation: int  # -1000 to +1000
    pc_rank: Optional[str]
    pc_is_member: bool
    relationship_to_pc: str  # "allied", "friendly", "neutral", etc.


class FactionListResponse(BaseModel):
    """List of factions."""
    factions: list  # List of FactionInfo


class QuestInfo(BaseModel):
    """Quest/objective information."""
    name: str
    description: str
    status: str  # "active", "completed", "failed"


class QuestListResponse(BaseModel):
    """List of active quests."""
    quests: list  # List of QuestInfo
    current_arc: Optional[str] = None



class StartSessionRequest(BaseModel):
    """Request to start a new session."""
    session_id: Optional[str] = None  # Optional custom ID


class StartSessionResponse(BaseModel):
    """Response from starting a new session."""
    session_id: str
    phase: str
    opening_message: str


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


class ResumeSessionResponse(BaseModel):
    """Response from resuming a session."""
    session_id: str
    phase: str
    messages: list
    character_draft: Optional[Dict[str, Any]] = None


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
    
    return ResumeSessionResponse(
        session_id=session_id,
        phase=session.phase.value,
        messages=session.messages,
        character_draft=draft_dict
    )


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
    from src.context.custom_profile_library import (
        get_custom_profile_library, 
        delete_custom_profile
    )
    custom_lib = get_custom_profile_library()
    lore_deleted = custom_lib.delete_session_lore(session_id)
    folder_deleted = delete_custom_profile(session_id)
    
    # Clear campaign memory (ChromaDB collection)
    # Uses profile_id as campaign_id per current design
    memory_deleted = False
    try:
        import chromadb
        from src.settings import get_settings_store
        settings_store = get_settings_store()
        settings = settings_store.load()
        profile_id = settings.active_profile_id
        
        client = chromadb.PersistentClient(path="./data/chroma")
        collection_name = f"campaign_{profile_id}"
        
        # Check if collection exists before deleting
        existing = [c.name for c in client.list_collections()]
        if collection_name in existing:
            client.delete_collection(collection_name)
            memory_deleted = True
            print(f"[Session Reset] Deleted memory collection: {collection_name}")
    except Exception as e:
        print(f"[Session Reset] Memory cleanup error: {e}")
    
    return {
        "deleted": deleted, 
        "session_id": session_id,
        "custom_lore_deleted": lore_deleted,
        "custom_folder_deleted": folder_deleted,
        "memory_deleted": memory_deleted
    }


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
    
    # Process through Session Zero agent
    agent = get_session_zero_agent()
    
    try:
        result = await agent.process_turn(session, request.player_input)
        
        # Apply any detected information to the character draft
        if result.detected_info:
            # DEBUG: Log what the LLM returned
            print(f"[SessionZero] DEBUG: detected_info keys = {list(result.detected_info.keys())}")
            print(f"[SessionZero] DEBUG: detected_info = {result.detected_info}")
            
            apply_detected_info(session, result.detected_info)
            
            # TRIGGER RESEARCH: If media reference detected in Phase 0
            media_ref = result.detected_info.get("media_reference") or result.detected_info.get("anime")
            secondary_ref = result.detected_info.get("secondary_reference") or result.detected_info.get("blend_with")
            
            print(f"[SessionZero] DEBUG: media_ref = {media_ref}, session.phase = {session.phase}")
            
            if media_ref and session.phase == SessionPhase.MEDIA_DETECTION:
                # Check if this is "original" (custom world) vs canonical anime
                is_original = media_ref.lower().strip() in ["original", "custom", "new", "fresh"]
                
                # Check for hybrid/blend (multiple anime mentioned)
                is_hybrid = secondary_ref is not None or result.detected_info.get("is_blend", False)
                
                if is_original:
                    # CUSTOM/ORIGINAL PROFILE: Quick template for "Original" worlds
                    try:
                        from src.agents.session_zero import generate_custom_profile
                        custom_result = await generate_custom_profile(session)
                        result.detected_info["research_status"] = "custom_profile_created"
                        result.detected_info["profile_type"] = "custom"
                    except Exception as custom_error:
                        print(f"[SessionZero] Custom profile generation failed: {custom_error}")
                
                elif is_hybrid:
                    # HYBRID PROFILE: Two-phase flow
                    # Phase 1: Calibration dialogue (this turn) - agent proposes blend options
                    # Phase 2: Research triggers ONLY after player confirms preferences
                    
                    # Check if this is the confirmation turn (player gave preferences)
                    hybrid_confirmed = result.detected_info.get("hybrid_preferences_confirmed", False)
                    
                    if not hybrid_confirmed:
                        # PHASE 1: Just mark that we're awaiting preferences
                        # The agent will generate blend prompts in its response
                        print(f"[SessionZero] Hybrid detected: {media_ref} × {secondary_ref} - awaiting preferences")
                        
                        # OPTIMIZATION: Trigger background research NOW for prerequisites
                        # This ensures single-profile parity (immediate progress bar)
                        try:
                            import asyncio
                            from src.agents.session_zero import ensure_hybrid_prerequisites
                            from src.agents.progress import ProgressTracker
                            
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
                                    print(f"[SessionZero] Hybrid preload failed: {e}")
                                    await progress_tracker.complete() # Close stream on error
                            
                            # Start background task
                            asyncio.create_task(run_hybrid_preload())
                            print(f"[SessionZero] Started hybrid preload (task_id: {progress_tracker.task_id})")
                            
                        except Exception as preload_error:
                            print(f"[SessionZero] Preload setup failed: {preload_error}")
                        
                        result.detected_info["awaiting_hybrid_preferences"] = True
                        result.detected_info["profile_type"] = "hybrid"
                        result.detected_info["blend_sources"] = [media_ref, secondary_ref]
                    else:
                        # PHASE 2: User confirmed preferences - now research with caching
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
                                    print(f"[SessionZero] Hybrid research completed: {media_ref} × {secondary_ref}")
                                except Exception as bg_error:
                                    print(f"[SessionZero] Hybrid research failed: {bg_error}")
                                    import traceback
                                    traceback.print_exc()
                                    await progress_tracker.complete()
                            
                            # Start research in background - don't await!
                            asyncio.create_task(run_hybrid_research_background())
                            print(f"[SessionZero] Started cached hybrid research (task_id: {progress_tracker.task_id})")
                            
                        except Exception as hybrid_error:
                            print(f"[SessionZero] Hybrid research setup failed: {hybrid_error}")
                else:
                    # CANONICAL ANIME: Research and save to permanent storage
                    # First check if profile already exists
                    from src.agents.profile_generator import load_existing_profile
                    existing = load_existing_profile(media_ref)
                    
                    if existing and existing.get("source") != "v2_library":
                        # Profile exists - just apply it, no progress bar needed
                        print(f"[SessionZero] Found existing profile for '{media_ref}'")
                        session.character_draft.narrative_profile = existing.get("id")
                        session.character_draft.media_reference = media_ref
                        result.detected_info["research_status"] = "existing_profile"
                        result.detected_info["profile_type"] = "canonical"
                        result.detected_info["confidence"] = existing.get("confidence", 100)
                    else:
                        # No existing profile - run research as BACKGROUND TASK
                        try:
                            import asyncio
                            
                            # Create progress tracker for SSE streaming
                            progress_tracker = ProgressTracker(total_steps=10)
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
                                    print(f"[ProfileLink] narrative_profile set to: '{profile_id}'")
                                    
                                    # Save session with linked profile
                                    store = get_session_store()
                                    store.save(session)
                                    print(f"[ProfileLink] Session saved to DB with profile '{profile_id}'")
                                    
                                    # Also update the in-memory session manager to stay in sync
                                    manager = get_session_manager()
                                    manager._sessions[session.session_id] = session
                                    print(f"[ProfileLink] In-memory session updated")
                                    
                                except Exception as bg_error:
                                    print(f"[SessionZero] Background research failed: {bg_error}")
                                    import traceback
                                    traceback.print_exc()
                                    await progress_tracker.complete()
                            
                            # Start research in background - don't await!
                            asyncio.create_task(run_research_background())
                            print(f"[SessionZero] Started background research for '{media_ref}' (task_id: {progress_tracker.task_id})")
                            
                        except Exception as research_error:
                            print(f"[SessionZero] Research setup failed: {research_error}")
        
        # COMPLETENESS-DRIVEN PHASE TRACKING
        # Sync phase to actual data completeness (allows multi-phase skip)
        actual_phase = get_current_phase_for_draft(session.character_draft)
        if actual_phase != session.phase:
            print(f"[SessionZero] Phase sync: {session.phase.value} -> {actual_phase.value}")
            session.skip_to_phase(actual_phase)
        
        # Handle gameplay transition
        if result.ready_for_gameplay:
            print(f"[SessionZero] Agent set ready_for_gameplay=True")
            # Validate that we actually have all requirements
            missing = get_missing_requirements(session.character_draft)
            if missing:
                print(f"[SessionZero] BLOCKED: Agent claimed ready but missing: {missing}")
                # Override the agent's decision - don't transition
                result.ready_for_gameplay = False
            else:
                print(f"[SessionZero] All requirements met - proceeding with handoff")
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
                        print(f"[Handoff] Inferred profile from media_reference: {profile_to_use}")
                
                # If profile not found in available profiles, use fallback
                if profile_to_use and profile_to_use not in available_profiles:
                    print(f"[Handoff] Profile '{profile_to_use}' not found in: {available_profiles[:5]}...")
                    profile_to_use = None  # Force fallback
                
                # Final fallback: use first available or "default"
                if not profile_to_use:
                    if available_profiles:
                        profile_to_use = available_profiles[0]
                        print(f"[Handoff] Using fallback profile: {profile_to_use}")
                    else:
                        profile_to_use = "default"
                        print(f"[Handoff] No profiles available, using 'default'")
                
                # Update global settings with session's profile - ALWAYS do this
                from src.settings import reset_settings_store
                settings_store = get_settings_store()
                current_settings = settings_store.load()
                print(f"[Handoff] Syncing settings: {current_settings.active_profile_id} -> {profile_to_use}")
                current_settings.active_profile_id = profile_to_use
                current_settings.active_campaign_id = profile_to_use
                settings_store.save(current_settings)
                reset_settings_store()  # Clear settings cache so next load picks up new values
                reset_orchestrator()  # Clear cached orchestrator to pick up new settings
                
                # Actually ready for gameplay - commit character
                session.skip_to_phase(SessionPhase.GAMEPLAY)
                
                orchestrator = get_orchestrator()
                
                # 1. Update Character
                orchestrator.state.update_character(
                    name=draft.name or "Unnamed Protagonist",
                    level=1, # Default start
                    hp_current=draft.resources.get("HP", 100),
                    hp_max=draft.resources.get("HP", 100),
                    power_tier=draft.attributes.get("power_tier", "T10"),
                    abilities=draft.skills
                )
                
                # 2. Update World State (Location)
                if draft.starting_location:
                    orchestrator.state.update_world_state(
                        location=draft.starting_location,
                        situation="The journey begins."
                    )
                
                # 3. Initialize Campaign Bible (Director) if needed
                # (DirectorAgent will handle this on its first run)
        
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
                    abilities=draft.skills
                )
                
                if draft.starting_location:
                    orchestrator.state.update_world_state(
                        location=draft.starting_location,
                        situation="The journey begins."
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
        
        return SessionZeroResponse(
            response=result.response,
            phase=session.phase.value,
            phase_complete=result.phase_complete,
            character_draft=draft_dict,
            session_id=session_id,
            missing_requirements=result.missing_requirements,
            ready_for_gameplay=result.ready_for_gameplay,
            research_task_id=result.detected_info.get("research_task_id") if result.detected_info else None
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Session Zero error: {str(e)}")
    
    finally:
        # Always save session after processing
        store = get_session_store()
        store.save(session)


@router.get("/session/{session_id}/status")
async def get_session_status(session_id: str):
    """Get the current status of a session."""
    manager = get_session_manager()
    session = manager.get_session(session_id)
    
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    
    return {
        "session_id": session_id,
        "phase": session.phase.value,
        "is_session_zero": session.is_session_zero(),
        "message_count": len(session.messages),
        "character_name": session.character_draft.name,
        "created_at": session.created_at.isoformat(),
        "last_activity": session.last_activity.isoformat()
    }


@router.get("/research/status")
async def get_research_status():
    """Check research capabilities.
    
    Returns info about the configured research agent and available profiles.
    """
    from src.agents.profile_generator import list_available_profiles
    from src.settings import get_settings_store
    
    store = get_settings_store()
    settings = store.load()
    
    # Get configured research model
    research_config = settings.agent_models.research
    if research_config:
        provider_name = research_config.provider
        model_name = research_config.model
    else:
        provider_name = "google"
        model_name = "gemini-3-pro-preview"
    
    # Check if provider has API key configured
    configured = store.get_configured_providers()
    provider_ready = configured.get(provider_name, False)
    
    return {
        "native_search_available": True,  # All providers now support native search
        "configured_provider": provider_name,
        "configured_model": model_name,
        "provider_ready": provider_ready,
        "available_profiles": list_available_profiles(),
        "capabilities": {
            "google": "Google Search grounding",
            "anthropic": "Web Search API (May 2025)",
            "openai": "Web Search Tool (Responses API)"
        },
        "note": f"Research uses native {provider_name} web search grounding - no external API keys needed"
    }


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
    
    # Check if there's an active session in Session Zero
    if request.session_id:
        manager = get_session_manager()
        session = manager.get_session(request.session_id)
        if session and session.is_session_zero():
            raise HTTPException(
                status_code=400,
                detail="Session is still in Session Zero. Use /session/{id}/turn to complete character creation first."
            )
    
    orchestrator = get_orchestrator()
    
    try:
        print(f"[GameAPI] Processing turn: '{request.player_input[:50]}...'")
        result = await orchestrator.process_turn(request.player_input)
        
        # DEBUG: Log the actual narrative value
        print(f"[GameAPI] Result received:")
        print(f"[GameAPI]   - narrative type: {type(result.narrative)}")
        print(f"[GameAPI]   - narrative length: {len(result.narrative) if result.narrative else 0}")
        print(f"[GameAPI]   - narrative first 100: {result.narrative[:100] if result.narrative else 'EMPTY'}")
        print(f"[GameAPI]   - intent: {result.intent.intent}")
        print(f"[GameAPI]   - outcome: {result.outcome.success_level}")
        
        response = TurnResponse(
            narrative=result.narrative,
            intent=result.intent.model_dump(),
            outcome=result.outcome.model_dump(),
            latency_ms=result.latency_ms,
            session_phase="gameplay"
        )
        
        # DEBUG: Log what we're actually returning
        print(f"[GameAPI] Returning TurnResponse with narrative length: {len(response.narrative)}")
        
        return response
    except Exception as e:
        import traceback
        print(f"[GameAPI] ERROR in process_turn: {e}")
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
    """Reset the game (start fresh)."""
    reset_orchestrator()
    reset_session_zero_agent()
    return {"status": "ok", "message": "Game reset successfully"}


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


# === NEW: Status Tracker Endpoints ===

@router.get("/character-status", response_model=CharacterStatusResponse)
async def get_character_status():
    """Get character status for HP/MP/SP bars and stats display."""
    orchestrator = get_orchestrator()
    char = orchestrator.state.get_character()
    
    if not char:
        raise HTTPException(status_code=404, detail="No character found")
    
    return CharacterStatusResponse(
        name=char.name or "Unknown",
        level=char.level or 1,
        xp_current=char.xp_current or 0,
        xp_to_next=char.xp_to_next_level or 100,
        hp_current=char.hp_current or 100,
        hp_max=char.hp_max or 100,
        mp_current=char.mp_current or 50,
        mp_max=char.mp_max or 50,
        sp_current=char.sp_current or 50,
        sp_max=char.sp_max or 50,
        stats=char.stats or {},
        power_tier=char.power_tier or "T10",
        abilities=char.abilities or [],
        character_class=char.character_class
    )


@router.get("/npcs", response_model=NPCListResponse)
async def get_npcs():
    """Get list of known NPCs for relationship tracker."""
    orchestrator = get_orchestrator()
    db = orchestrator.state._get_db()
    
    from src.db.models import NPC
    npcs = db.query(NPC).filter(NPC.campaign_id == orchestrator.state.campaign_id).all()
    
    npc_list = []
    for npc in npcs:
        npc_list.append({
            "id": npc.id,
            "name": npc.name,
            "role": npc.role,
            "affinity": npc.affinity or 0,
            "disposition": npc.disposition or 0,
            "faction": npc.faction,
            "last_appeared": npc.last_appeared
        })
    
    return NPCListResponse(npcs=npc_list)


@router.get("/factions", response_model=FactionListResponse)
async def get_factions():
    """Get list of factions for reputation tracker."""
    orchestrator = get_orchestrator()
    db = orchestrator.state._get_db()
    
    from src.db.models import Faction
    factions = db.query(Faction).filter(Faction.campaign_id == orchestrator.state.campaign_id).all()
    
    faction_list = []
    for faction in factions:
        # Determine relationship label based on reputation
        rep = faction.pc_reputation or 0
        if rep >= 500:
            rel = "allied"
        elif rep >= 100:
            rel = "friendly"
        elif rep >= -100:
            rel = "neutral"
        elif rep >= -500:
            rel = "unfriendly"
        else:
            rel = "hostile"
        
        faction_list.append({
            "id": faction.id,
            "name": faction.name,
            "pc_reputation": rep,
            "pc_rank": faction.pc_rank,
            "pc_is_member": faction.pc_is_member or False,
            "relationship_to_pc": rel
        })
    
    return FactionListResponse(factions=faction_list)


@router.get("/quests", response_model=QuestListResponse)
async def get_quests():
    """Get active quests from campaign bible."""
    orchestrator = get_orchestrator()
    bible = orchestrator.state.get_campaign_bible()
    
    quests = []
    current_arc = None
    
    if bible and bible.planning_data:
        data = bible.planning_data
        
        # Extract arc info
        current_arc = data.get("current_arc", {}).get("name")
        
        # Extract goals/objectives as quests
        for goal in data.get("active_goals", []):
            quests.append({
                "name": goal.get("name", "Unknown Objective"),
                "description": goal.get("description", ""),
                "status": goal.get("status", "active")
            })
        
        # Also add arc objectives
        for obj in data.get("arc_objectives", []):
            quests.append({
                "name": obj.get("name", "Arc Objective"),
                "description": obj.get("description", ""),
                "status": obj.get("status", "active")
            })
    
    return QuestListResponse(quests=quests, current_arc=current_arc)
