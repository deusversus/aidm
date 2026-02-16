"""Game API routes."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from pathlib import Path
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
from src.agents.session_zero import SessionZeroAgent, apply_detected_info, process_session_zero_state, research_and_apply_profile, get_disambiguation_options
from src.agents.progress import ProgressTracker, ProgressPhase
from src.settings import get_settings_store
from src.db.session import init_db
from src.db.session_store import get_session_store
from src.db.models import Character, NPC, Faction, WorldState

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
        # Use reload() to force fresh read from disk - crucial after Session Zero handoff
        store = get_settings_store()
        settings = store.reload()
        
        profile_id = settings.active_profile_id
        
        # DEBUG: Log what we loaded
        print(f"[get_orchestrator] Loaded settings: active_profile_id='{profile_id}', active_campaign_id='{settings.active_campaign_id}'", flush=True)
        
        # Handle missing profile - requires Session Zero to set it
        if not profile_id:  # Empty string means not configured
            print(f"[get_orchestrator] ERROR: No profile set! Settings file may not be synced.", flush=True)
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
            print(f"[reset_orchestrator] Warning: close() failed: {e}", flush=True)
    _orchestrator = None
    print("[reset_orchestrator] Orchestrator cleared - next call will create fresh instance", flush=True)



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
    portrait_map: Optional[Dict[str, str]] = None  # {"NPC Name": "/api/game/media/..."}


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
    detected_info: Optional[Dict[str, Any]] = None  # Raw debug info from agent
    # Disambiguation fields
    disambiguation_options: Optional[list] = None  # List of series options to choose from
    awaiting_disambiguation: bool = False  # True if user needs to choose


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
    portrait_url: Optional[str] = None
    model_sheet_url: Optional[str] = None


class NPCInfo(BaseModel):
    """NPC information for relationship tracker."""
    id: int
    name: str
    role: Optional[str]  # ally, enemy, neutral, rival
    affinity: int  # -100 to +100
    disposition: int  # calculated disposition
    faction: Optional[str]
    last_appeared: Optional[int]  # turn number
    portrait_url: Optional[str] = None


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


# === Phase 1: Inventory, Abilities, Journal Response Models ===

class InventoryItemInfo(BaseModel):
    """A single inventory item."""
    name: str
    type: str = "miscellaneous"
    description: str = ""
    quantity: int = 1
    properties: Dict[str, Any] = {}
    source: Optional[str] = None


class InventoryResponse(BaseModel):
    """Character inventory."""
    items: List[InventoryItemInfo]
    total_items: int


class AbilityInfo(BaseModel):
    """A single ability/skill."""
    name: str
    description: str = ""
    type: str = "unknown"
    level_acquired: Optional[int] = None


class AbilitiesResponse(BaseModel):
    """Character abilities."""
    abilities: List[AbilityInfo]
    total_abilities: int


class JournalEntry(BaseModel):
    """A single journal entry (compactor beat or full-text turn)."""
    turn: Optional[int] = None
    content: str
    entry_type: str = "beat"  # "beat" or "full_text"
    heat: Optional[float] = None


class JournalResponse(BaseModel):
    """Journal with compactor beats and optional full-text expansion."""
    entries: List[JournalEntry]
    total_entries: int
    page: int
    per_page: int
    expanded_turn: Optional[int] = None  # If a specific turn was expanded


# === Phase 2: Quest and Location Response Models ===

class QuestObjectiveInfo(BaseModel):
    """A single objective within a quest."""
    description: str
    completed: bool = False
    turn_completed: Optional[int] = None


class QuestDetailInfo(BaseModel):
    """A quest with full details."""
    id: int
    title: str
    description: Optional[str] = None
    status: str = "active"
    quest_type: str = "main"
    source: str = "director"
    objectives: List[QuestObjectiveInfo] = []
    created_turn: Optional[int] = None
    completed_turn: Optional[int] = None
    related_npcs: List[str] = []
    related_locations: List[str] = []


class QuestTrackerResponse(BaseModel):
    """Full quest tracker with active quests and current arc."""
    quests: List[QuestDetailInfo]
    current_arc: Optional[str] = None
    total_active: int = 0
    total_completed: int = 0


class LocationInfo(BaseModel):
    """A discovered location."""
    id: int
    name: str
    location_type: Optional[str] = None
    description: Optional[str] = None
    atmosphere: Optional[str] = None
    current_state: str = "intact"
    is_current: bool = False
    times_visited: int = 0
    discovered_turn: Optional[int] = None
    last_visited_turn: Optional[int] = None
    visual_tags: List[str] = []
    known_npcs: List[str] = []
    connected_locations: List[dict] = []
    notable_events: List[str] = []


class LocationsResponse(BaseModel):
    """All discovered locations."""
    locations: List[LocationInfo]
    current_location: Optional[str] = None
    total_locations: int = 0



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
    
    # FIX #4: Validate settings on new session - clear stale data
    # If there's a stale session_id that doesn't match, reset settings
    settings_store = get_settings_store()
    current_settings = settings_store.load()
    if current_settings.active_session_id and current_settings.active_session_id != session_id:
        print(f"[StartSession] Clearing stale settings: session_id was '{current_settings.active_session_id}'")
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


class ResumeSessionResponse(BaseModel):
    """Response from resuming a session."""
    session_id: str
    phase: str
    messages: list
    character_draft: Optional[Dict[str, Any]] = None
    recap: Optional[str] = None  # "Previously On..." recap for session continuity


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
            from ..src.agents.recap_agent import RecapAgent
            from ..src.db.state_manager import StateManager

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
                from ..src.context.memory import MemoryStore
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
                print(f"[Resume] Generated recap: {recap_text[:100]}...")
        except Exception as e:
            print(f"[Resume] Recap generation failed (non-fatal): {e}")

    return ResumeSessionResponse(
        session_id=session_id,
        phase=session.phase.value,
        messages=session.messages,
        character_draft=draft_dict,
        recap=recap_text
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
    from src.context.custom_profile_library import (
        get_custom_profile_library, 
        delete_custom_profile
    )
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
        print(f"[SessionZero] OP Mode enabled with preset: {session.character_draft.op_preset}")
    
    # Process through Session Zero agent
    agent = get_session_zero_agent()
    
    # DEBUG: Log session state before processing
    msg_count = len(session.messages) if session.messages else 0
    last_msg = session.messages[-1]['content'][:100] if session.messages else "None"
    try:
        safe_msg = last_msg.encode('ascii', 'replace').decode('ascii')
        print(f"[SessionZero] DEBUG: {msg_count} messages in session. Last: {safe_msg}...")
    except Exception:
        print(f"[SessionZero] DEBUG: {msg_count} messages in session.")
    
    try:
        result = await agent.process_turn(session, request.player_input)
        
        # Apply any detected information to the character draft

        print(f"[SessionZero] DEBUG: Raw result.detected_info = {result.detected_info}")
        if result.detected_info:
            # DEBUG: Log what the LLM returned
            try:
                safe_detected_info = {
                    k: str(v).encode('ascii', 'replace').decode('ascii')
                    for k, v in result.detected_info.items()
                }
                print(f"[SessionZero] DEBUG: Detected info (safe): {safe_detected_info}")
            except Exception as e:
                print(f"[SessionZero] DEBUG: Failed to safely encode detected_info: {e}")
                print(f"[SessionZero] DEBUG: Raw detected_info: {result.detected_info}")
            
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
                    print(f"[SessionZero] Fluid state: {state_stats['memories_added']} memories, {state_stats.get('npcs_created', 0)} NPCs")
            except Exception as state_err:
                print(f"[SessionZero] Fluid state processing failed (non-fatal): {state_err}")
            
            # TRIGGER RESEARCH: If media reference detected in Phase 0
            media_ref = result.detected_info.get("media_reference") or result.detected_info.get("anime")
            secondary_ref = result.detected_info.get("secondary_reference") or result.detected_info.get("secondary_media_reference") or result.detected_info.get("blend_with")
            
            print(f"[SessionZero] DEBUG: media_ref = {media_ref}, session.phase = {session.phase}")
            
            # Only trigger research/disambiguation in early phases (MEDIA_DETECTION, CONCEPT)
            # Later phases (IDENTITY, WRAP_UP, etc.) should not re-run disambiguation
            early_phases = [SessionPhase.MEDIA_DETECTION, SessionPhase.NARRATIVE_CALIBRATION, SessionPhase.OP_MODE_DETECTION, SessionPhase.CONCEPT]
            if media_ref and session.phase in early_phases:
                # Note: We include CONCEPT because hybrid flow may need to run research there
                print(f"[SessionZero] DEBUG: Triggering research logic for '{media_ref}' (Phase: {session.phase})")
                
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
                    print(f"[SessionZero] DEBUG: Disambiguation selection made - marking complete")
                
                # Check if disambiguation already completed OR was shown this session
                disambiguation_already_done = session.phase_state.get('disambiguation_complete', False)
                disambiguation_shown = session.phase_state.get('disambiguation_shown', False)
                
                # Also skip if user gave a SPECIFIC title that matches an existing profile
                # (e.g., "Naruto Shippuden" instead of just "Naruto")
                from src.agents.profile_generator import load_existing_profile
                specific_profile_exists = load_existing_profile(media_ref) is not None
                
                print(f"[Disambiguation] Flags: done={disambiguation_already_done}, shown={disambiguation_shown}, specific_exists={specific_profile_exists}")
                
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
                        print(f"[SessionZero] Disambiguation needed for '{media_ref}' - returning {len(disambiguation['options'])} options")
                        
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
                        print(f"[SessionZero] Custom profile generation failed: {custom_error}")
                
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
                            print(f"[Hybrid Debug] disambig_a options: {len(disambig_a.get('options', []))}")
                            print(f"[Hybrid Debug] disambig_b options: {len(disambig_b.get('options', []))}")
                            
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
                        print(f"[SessionZero] Hybrid detected: {media_ref} × {secondary_ref} - awaiting preferences")
                        
                        # OPTIMIZATION: Check if we even need to research
                        from src.agents.profile_generator import load_existing_profile
                        prof_a = load_existing_profile(media_ref)
                        prof_b = load_existing_profile(secondary_ref)
                        
                        if prof_a and prof_b:
                            print(f"[SessionZero] Both profiles cached: {media_ref} & {secondary_ref}. Skipping background preload.")
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
                            print(f"[SessionZero] Both profiles cached for Phase 2. Running fast merge.")
                            try:
                                from src.agents.session_zero import research_hybrid_profile_cached
                                import asyncio
                                
                                power_choice = result.detected_info.get("power_system_choice", "coexist")
                                
                                # Run without tracker since it will complete instantly
                                asyncio.create_task(research_hybrid_profile_cached(
                                    session, 
                                    media_ref, 
                                    secondary_ref,
                                    user_preferences={"power_system": power_choice},
                                    progress_tracker=None  # No tracker for instant operations
                                ))
                                
                                result.detected_info["research_status"] = "fast_merge"
                                result.detected_info["profile_type"] = "hybrid"
                            except Exception as fast_merge_error:
                                print(f"[SessionZero] Fast merge failed: {fast_merge_error}")
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
                    
                    if existing:
                        # Profile exists - just apply it, no progress bar needed
                        print(f"[SessionZero] Found existing profile for '{media_ref}'")
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
                            print(f"[SessionZero] Early sync: {current_settings.active_profile_id} -> {profile_id}")
                            current_settings.active_profile_id = profile_id
                            current_settings.active_session_id = session.session_id
                            settings_store.save(current_settings)
                    else:
                        print(f"[SessionZero] DEBUG: Entering Single Profile Logic for '{media_ref}'")
                        # No existing profile - run research as BACKGROUND TASK
                        try:
                            import asyncio
                            from src.agents.session_zero import research_and_apply_profile
                            
                            # Create progress tracker for SSE streaming
                            progress_tracker = ProgressTracker(total_steps=10)
                            print(f"[SessionZero] DEBUG: Outputting Task ID {progress_tracker.task_id}")
                            
                            # EMIT IMMEDIATE START to verify connection
                            import asyncio
                            asyncio.create_task(progress_tracker.emit(
                                ProgressPhase.INITIALIZING, 
                                f"Initializing research for {media_ref}...", 
                                1
                            ))
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
                
                # INDEX SESSION ZERO TO MEMORY (before creating orchestrator)
                # This stores character creation dialogue for RAG retrieval during gameplay
                from src.agents.session_zero import index_session_zero_to_memory
                try:
                    indexed_count = await index_session_zero_to_memory(session)
                    print(f"[Handoff] Indexed {indexed_count} Session Zero chunks to memory")
                except Exception as mem_err:
                    print(f"[Handoff] Memory indexing failed (non-fatal): {mem_err}")
                
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
                                print(f"[Handoff] Using hybrid profile from session storage: {profile_to_use}")
                
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
                print(f"[Handoff] Syncing settings: {current_settings.active_profile_id} -> {profile_to_use}", flush=True)
                current_settings.active_profile_id = profile_to_use
                current_settings.active_campaign_id = profile_to_use
                current_settings.active_session_id = session.session_id  # Session-based memory isolation
                settings_store.save(current_settings)
                
                # VERIFY file was written correctly
                import json
                from pathlib import Path
                settings_path = Path(__file__).parent.parent.parent / "settings.json"
                with open(settings_path, 'r') as f:
                    disk_data = json.load(f)
                print(f"[Handoff] VERIFY disk after save: active_profile_id='{disk_data.get('active_profile_id')}'", flush=True)
                
                reset_settings_store()  # Clear settings cache so next load picks up new values
                reset_orchestrator()  # Clear cached orchestrator to pick up new settings
                
                # Actually ready for gameplay - commit character
                session.skip_to_phase(SessionPhase.GAMEPLAY)
                
                print(f"[Handoff] About to call get_orchestrator()...", flush=True)
                orchestrator = get_orchestrator()
                print(f"[Handoff] Orchestrator created successfully with profile: {orchestrator.profile_id}", flush=True)

                
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
                    abilities=draft.skills
                )
                print(f"[Handoff] Power tier set to: {final_tier}")
                
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
                    print(f"[Handoff] OP Mode transferred: {draft.op_preset}")
                
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
                    print(f"[Handoff] Full transcript stored ({len(session.messages)} messages)")
                    
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
                        print(f"[Handoff] Session Zero context injected ({len(recent_summary)} chars)")
                    except Exception as mem_err:
                        print(f"[Handoff] Memory injection failed (non-critical): {mem_err}")
                    
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
                    print(f"[Handoff] Director startup complete — initial storyboard created")
                except Exception as dir_err:
                    print(f"[Handoff] Director startup failed (non-critical): {dir_err}")
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
                print(f"[SessionZero] Defensive sync: {current_settings.active_profile_id} -> {profile_to_sync}", flush=True)
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
            detected_info=result.detected_info
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
                            print(f"[Compaction] Evicted oldest entry (turn {evicted['turn']}, {evicted['tokens_est']} tokens)")
                        
                        print(f"[Compaction] Appended micro-summary ({tokens_est} tokens, buffer: {len(session.compaction_buffer)} entries, {total_tokens} total tokens)")
                except Exception as e:
                    print(f"[Compaction] Failed (non-fatal): {e}")
    
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
                    print(f"[GameAPI] Pinned {len(unique_pinned)} messages prepended to working memory")
        except Exception as e:
            print(f"[GameAPI] Pinned messages failed (non-fatal): {e}")
    
    if recent_messages:
        print(f"[GameAPI] Working memory: {len(recent_messages)} recent messages")
    
    orchestrator = get_orchestrator()
    
    try:
        try:
            safe_input = request.player_input[:50].encode('ascii', 'replace').decode('ascii')
            print(f"[GameAPI] Processing turn: '{safe_input}...'")
        except Exception:
            print(f"[GameAPI] Processing turn: (encoding failed)")
        result = await orchestrator.process_turn(player_input=request.player_input, recent_messages=recent_messages, compaction_text=compaction_text)
        
        # DEBUG: Log the actual narrative value
        print(f"[GameAPI] Result received:")
        print(f"[GameAPI]   - narrative type: {type(result.narrative)}")
        print(f"[GameAPI]   - narrative length: {len(result.narrative) if result.narrative else 0}")
        try:
            if result and result.narrative:
                safe_snippet = result.narrative[:100].encode('ascii', 'replace').decode('ascii')
                print(f"[GameAPI]   - narrative first 100: {safe_snippet}")
            else:
                print("[GameAPI]   - narrative first 100: EMPTY")
        except Exception:
            print("[GameAPI]   - narrative logging failed")
        try:
            safe_intent = str(result.intent.intent).encode('ascii', 'replace').decode('ascii')
            safe_outcome = str(result.outcome.success_level).encode('ascii', 'replace').decode('ascii')
            print(f"[GameAPI]   - intent: {safe_intent}")
            print(f"[GameAPI]   - outcome: {safe_outcome}")
        except Exception:
            print("[GameAPI]   - intent/outcome logging failed")
        
        # Add assistant response to session AFTER processing
        if session:
            session.add_message("assistant", result.narrative)
            store.save(session)
            print(f"[GameAPI] Session saved with {len(session.messages)} messages")
        
        response = TurnResponse(
            narrative=result.narrative,
            intent=result.intent.model_dump(),
            outcome=result.outcome.model_dump() if result.outcome else {},
            latency_ms=result.latency_ms,
            session_phase="gameplay",
            portrait_map=result.portrait_map,
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
    """Reset the game - clears all session data for fresh Session Zero.
    
    Deletes all campaigns, characters, world states, memories, and custom profiles.
    Preserves canonical profile lore and rules library.
    """
    from src.db.state_manager import StateManager
    from src.context.custom_profile_library import get_custom_profile_library
    from src.db.session_store import get_session_store
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
    from fastapi.responses import Response
    from src.core.session_export import export_session as do_export
    from datetime import datetime
    
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
    from fastapi import File, UploadFile
    from src.core.session_export import import_session as do_import
    
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


# === Status Tracker Endpoints ===

@router.get("/character-status", response_model=CharacterStatusResponse)
async def get_character_status():
    """Get character status for HP/MP/SP bars and stats display."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
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
        character_class=char.character_class,
        portrait_url=char.portrait_url,
        model_sheet_url=char.model_sheet_url,
    )


@router.get("/npcs", response_model=NPCListResponse)
async def get_npcs():
    """Get list of known NPCs for relationship tracker."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    npcs = orchestrator.state.get_all_npcs()
    
    # Sort by last_appeared DESC (recent interactions first)
    npcs_sorted = sorted(npcs, key=lambda n: n.last_appeared or 0, reverse=True)
    
    return NPCListResponse(
        npcs=[
            NPCInfo(
                id=npc.id,
                name=npc.name,
                role=npc.role,
                affinity=npc.affinity or 0,
                disposition=npc.disposition or 0,
                faction=npc.faction,
                last_appeared=npc.last_appeared,
                portrait_url=npc.portrait_url,
            )
            for npc in npcs_sorted
        ]
    )


@router.get("/factions", response_model=FactionListResponse)
async def get_factions():
    """Get list of factions for reputation tracker."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    factions = orchestrator.state.get_all_factions()
    
    def get_relationship(rep):
        if rep >= 500: return "allied"
        if rep >= 100: return "friendly"
        if rep >= -100: return "neutral"
        if rep >= -500: return "unfriendly"
        return "hostile"
    
    return FactionListResponse(
        factions=[
            FactionInfo(
                id=f.id,
                name=f.name,
                pc_reputation=f.pc_reputation or 0,
                pc_rank=f.pc_rank,
                pc_is_member=f.pc_is_member or False,
                relationship_to_pc=get_relationship(f.pc_reputation or 0)
            )
            for f in factions
        ]
    )


@router.get("/quests", response_model=QuestTrackerResponse)
async def get_quests():
    """Get quests from Quest table, with legacy fallback.
    
    Primary source: Quest model (DB-backed, dual-agent managed).
    Fallback: Character goals + campaign bible (legacy ad-hoc approach).
    """
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    current_arc = None
    
    # Try DB-backed quests first
    db_quests = orchestrator.state.get_quests()
    
    if db_quests:
        quests = []
        active_count = 0
        completed_count = 0
        
        for q in db_quests:
            objectives = []
            for obj in (q.objectives or []):
                if isinstance(obj, dict):
                    objectives.append(QuestObjectiveInfo(
                        description=obj.get("description", ""),
                        completed=obj.get("completed", False),
                        turn_completed=obj.get("turn_completed"),
                    ))
            
            quests.append(QuestDetailInfo(
                id=q.id,
                title=q.title,
                description=q.description,
                status=q.status or "active",
                quest_type=q.quest_type or "main",
                source=q.source or "director",
                objectives=objectives,
                created_turn=q.created_turn,
                completed_turn=q.completed_turn,
                related_npcs=q.related_npcs or [],
                related_locations=q.related_locations or [],
            ))
            
            if q.status == "active":
                active_count += 1
            elif q.status in ("completed", "failed"):
                completed_count += 1
        
        # Get current arc from world state or bible
        bible = orchestrator.state.get_campaign_bible()
        if bible and bible.planning_data:
            current_arc = bible.planning_data.get("current_arc", {}).get("name")
        if not current_arc:
            world_state = orchestrator.state.get_world_state()
            if world_state:
                current_arc = world_state.arc_name
        
        return QuestTrackerResponse(
            quests=quests,
            current_arc=current_arc,
            total_active=active_count,
            total_completed=completed_count,
        )
    
    # Legacy fallback: character goals + campaign bible
    quests = []
    
    char = orchestrator.state.get_character()
    if char:
        if char.short_term_goal:
            quests.append(QuestDetailInfo(
                id=0,
                title="Current Objective",
                description=char.short_term_goal,
                quest_type="personal",
                source="player",
            ))
        if char.long_term_goal:
            quests.append(QuestDetailInfo(
                id=0,
                title="Ultimate Goal",
                description=char.long_term_goal,
                quest_type="personal",
                source="player",
            ))
        for goal in (char.narrative_goals or []):
            if isinstance(goal, dict):
                quests.append(QuestDetailInfo(
                    id=0,
                    title=goal.get("name", "Quest"),
                    description=goal.get("description", ""),
                    status=goal.get("status", "active"),
                    quest_type="main",
                    source="director",
                ))
    
    bible = orchestrator.state.get_campaign_bible()
    if bible and bible.planning_data:
        data = bible.planning_data
        current_arc = data.get("current_arc", {}).get("name") or current_arc
        
        for goal in data.get("active_goals", []):
            quests.append(QuestDetailInfo(
                id=0,
                title=goal.get("name", "Unknown Objective"),
                description=goal.get("description", ""),
                status=goal.get("status", "active"),
                quest_type="main",
                source="director",
            ))
        for obj in data.get("arc_objectives", []):
            quests.append(QuestDetailInfo(
                id=0,
                title=obj.get("name", "Arc Objective"),
                description=obj.get("description", ""),
                status=obj.get("status", "active"),
                quest_type="main",
                source="director",
            ))
    
    if not current_arc:
        world_state = orchestrator.state.get_world_state()
        if world_state:
            current_arc = world_state.arc_name
    
    active = sum(1 for q in quests if q.status == "active")
    completed = sum(1 for q in quests if q.status in ("completed", "failed"))
    
    return QuestTrackerResponse(
        quests=quests,
        current_arc=current_arc,
        total_active=active,
        total_completed=completed,
    )


# === Phase 1: Inventory, Abilities, Journal Endpoints ===

@router.get("/inventory", response_model=InventoryResponse)
async def get_inventory():
    """Get character inventory items."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    char = orchestrator.state.get_character()
    if not char:
        raise HTTPException(status_code=404, detail="No character found")
    
    raw_inventory = char.inventory or []
    items = []
    for item in raw_inventory:
        if isinstance(item, dict):
            items.append(InventoryItemInfo(
                name=item.get("name", "Unknown"),
                type=item.get("type", "miscellaneous"),
                description=item.get("description", ""),
                quantity=item.get("quantity", 1),
                properties=item.get("properties", {}),
                source=item.get("source"),
            ))
        elif isinstance(item, str):
            items.append(InventoryItemInfo(name=item))
    
    return InventoryResponse(items=items, total_items=len(items))


@router.get("/abilities", response_model=AbilitiesResponse)
async def get_abilities():
    """Get character abilities and skills."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    char = orchestrator.state.get_character()
    if not char:
        raise HTTPException(status_code=404, detail="No character found")
    
    raw_abilities = char.abilities or []
    abilities = []
    for ability in raw_abilities:
        if isinstance(ability, dict):
            abilities.append(AbilityInfo(
                name=ability.get("name", "Unknown"),
                description=ability.get("description", ""),
                type=ability.get("type", "unknown"),
                level_acquired=ability.get("level_acquired"),
            ))
        elif isinstance(ability, str):
            abilities.append(AbilityInfo(name=ability))
    
    return AbilitiesResponse(abilities=abilities, total_abilities=len(abilities))


@router.get("/journal", response_model=JournalResponse)
async def get_journal(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    expand_turn: Optional[int] = Query(None, description="Expand full narrative for a specific turn"),
):
    """Get journal entries from compactor narrative beats.
    
    Timeline mode (default): Returns compactor episode beats from ChromaDB,
    ordered chronologically. These are ~100-200 word narrative summaries.
    
    Full text mode (expand_turn=N): Returns the full Turn.narrative for a 
    specific turn number, alongside the regular timeline.
    """
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    entries = []
    expanded_turn_content = None
    
    # Timeline mode: Get episode beats from memory store
    try:
        # Search for all episode memories (compactor-generated summaries)
        episode_results = orchestrator.memory.search(
            query="narrative events story moments",
            limit=200,  # Get all available
            min_heat=0.0,
            boost_on_access=False,
            memory_type="episode",
        )
        
        # Also get narrative_beat type memories
        beat_results = orchestrator.memory.search(
            query="narrative events story moments",
            limit=200,
            min_heat=0.0,
            boost_on_access=False,
            memory_type="narrative_beat",
        )
        
        # Combine and deduplicate
        seen_ids = set()
        all_beats = []
        for result in episode_results + beat_results:
            if result["id"] not in seen_ids:
                seen_ids.add(result["id"])
                turn_num = int(result["metadata"].get("turn", 0))
                all_beats.append(JournalEntry(
                    turn=turn_num,
                    content=result["content"],
                    entry_type="beat",
                    heat=result.get("heat", 0),
                ))
        
        # Sort chronologically by turn
        all_beats.sort(key=lambda e: e.turn or 0)
        
        # Paginate
        total = len(all_beats)
        start = (page - 1) * per_page
        end = start + per_page
        entries = all_beats[start:end]
        
    except Exception as e:
        print(f"[Journal] Error fetching episode memories: {e}")
        total = 0
    
    # Full text expansion: Get the full narrative for a specific turn
    if expand_turn is not None:
        try:
            turn_narrative = orchestrator.state.get_turn_narrative(expand_turn)
            if turn_narrative:
                expanded_turn_content = expand_turn
                entries.append(JournalEntry(
                    turn=expand_turn,
                    content=turn_narrative,
                    entry_type="full_text",
                ))
        except Exception as e:
            print(f"[Journal] Error expanding turn {expand_turn}: {e}")
    
    return JournalResponse(
        entries=entries,
        total_entries=total,
        page=page,
        per_page=per_page,
        expanded_turn=expanded_turn_content,
    )


# === Phase 2: Locations Endpoint ===

@router.get("/locations", response_model=LocationsResponse)
async def get_locations():
    """Get all discovered locations."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    db_locations = orchestrator.state.get_locations()
    current_location_name = None
    
    locations = []
    for loc in db_locations:
        locations.append(LocationInfo(
            id=loc.id,
            name=loc.name,
            location_type=loc.location_type,
            description=loc.description,
            atmosphere=loc.atmosphere,
            current_state=loc.current_state or "intact",
            is_current=loc.is_current or False,
            times_visited=loc.times_visited or 0,
            discovered_turn=loc.discovered_turn,
            last_visited_turn=loc.last_visited_turn,
            visual_tags=loc.visual_tags or [],
            known_npcs=loc.known_npcs or [],
            connected_locations=loc.connected_locations or [],
            notable_events=loc.notable_events or [],
        ))
        if loc.is_current:
            current_location_name = loc.name
    
    # Fallback: use world state location if no DB locations marked as current
    if not current_location_name:
        world_state = orchestrator.state.get_world_state()
        if world_state:
            current_location_name = world_state.location
    
    return LocationsResponse(
        locations=locations,
        current_location=current_location_name,
        total_locations=len(locations),
    )


# === Phase 4: Media Serving Endpoint ===

@router.get("/media/{file_path:path}")
async def serve_media(file_path: str):
    """Serve generated media files (model sheets, portraits, cutscenes).
    
    Files are stored under data/media/ with the structure:
        {campaign_id}/models/{name}_model.png
        {campaign_id}/portraits/{name}_portrait.png
        {campaign_id}/cutscenes/{name}.mp4
    """
    from src.media.generator import MEDIA_BASE_DIR
    
    # Resolve and validate path (prevent directory traversal)
    full_path = (MEDIA_BASE_DIR / file_path).resolve()
    if not str(full_path).startswith(str(MEDIA_BASE_DIR.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    
    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="Media not found")
    
    # Determine MIME type
    suffix = full_path.suffix.lower()
    mime_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
    }
    media_type = mime_types.get(suffix, "application/octet-stream")
    
    return FileResponse(full_path, media_type=media_type)

