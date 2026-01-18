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
        _orchestrator = Orchestrator(profile_id=profile_id)
    
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


# === SIDEBAR API ENDPOINTS ===

@router.get("/character-status", response_model=CharacterStatusResponse)
async def get_character_status():
    """Get current character status for sidebar."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    campaign_id = orchestrator.campaign_id
    db = orchestrator.db
    
    character = db.query(Character).filter_by(campaign_id=campaign_id).first()
    
    if not character:
        raise HTTPException(status_code=404, detail="No character found")
    
    return CharacterStatusResponse(
        name=character.name,
        level=character.level,
        xp_current=character.xp_current,
        xp_to_next=character.xp_to_next_level,
        hp_current=character.hp_current,
        hp_max=character.hp_max,
        mp_current=character.mp_current,
        mp_max=character.mp_max,
        sp_current=character.sp_current,
        sp_max=character.sp_max,
        stats=character.stats or {},
        power_tier=character.power_tier or "T10",
        abilities=character.abilities or [],
        character_class=character.character_class
    )


@router.get("/npcs", response_model=NPCListResponse)
async def get_npcs():
    """Get NPC list for relationship tracker."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    campaign_id = orchestrator.campaign_id
    db = orchestrator.db
    
    npcs = db.query(NPC).filter_by(campaign_id=campaign_id).all()
    
    return NPCListResponse(
        npcs=[
            NPCInfo(
                id=npc.id,
                name=npc.name,
                role=npc.role,
                affinity=npc.affinity,
                disposition=npc.disposition,
                faction=npc.faction,
                last_appeared=npc.last_appeared
            )
            for npc in npcs
        ]
    )


@router.get("/factions", response_model=FactionListResponse)
async def get_factions():
    """Get faction list for reputation tracker."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    campaign_id = orchestrator.campaign_id
    db = orchestrator.db
    
    factions = db.query(Faction).filter_by(campaign_id=campaign_id).all()
    
    def get_relationship(f):
        if f.pc_reputation >= 500: return "allied"
        if f.pc_reputation >= 200: return "friendly"
        if f.pc_reputation >= -200: return "neutral"
        if f.pc_reputation >= -500: return "unfriendly"
        return "enemy"
    
    return FactionListResponse(
        factions=[
            FactionInfo(
                id=f.id,
                name=f.name,
                pc_reputation=f.pc_reputation,
                pc_rank=f.pc_rank,
                pc_is_member=f.pc_is_member,
                relationship_to_pc=get_relationship(f)
            )
            for f in factions
        ]
    )


@router.get("/quests", response_model=QuestListResponse)
async def get_quests():
    """Get active quests for objective tracker."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")
    
    campaign_id = orchestrator.campaign_id
    db = orchestrator.db
    
    character = db.query(Character).filter_by(campaign_id=campaign_id).first()
    world_state = db.query(WorldState).filter_by(campaign_id=campaign_id).first()
    
    quests = []
    if character:
        if character.short_term_goal:
            quests.append(QuestInfo(
                name="Current Objective",
                description=character.short_term_goal,
                status="active"
            ))
        if character.long_term_goal:
            quests.append(QuestInfo(
                name="Ultimate Goal",
                description=character.long_term_goal,
                status="active"
            ))
        for goal in (character.narrative_goals or []):
            quests.append(QuestInfo(
                name=goal.get("name", "Quest") if isinstance(goal, dict) else "Quest",
                description=goal.get("description", str(goal)) if isinstance(goal, dict) else str(goal),
                status=goal.get("status", "active") if isinstance(goal, dict) else "active"
            ))
    
    return QuestListResponse(
        quests=quests,
        current_arc=world_state.arc_name if world_state else None
    )


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
            campaign_id = session.character_draft.narrative_profile or session.session_id[:8]
            try:
                state_stats = await process_session_zero_state(
                    session=session,
                    detected_info=result.detected_info,
                    campaign_id=campaign_id
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
                        orchestrator.memory.add(
                            text=f"SESSION ZERO CONTEXT (Character creation and opening scene):\n\n{recent_summary}",
                            metadata={
                                "source": "session_zero_handoff",
                                "importance": 10,
                                "permanent": True,
                                "type": "session_zero_context"
                            }
                        )
                        print(f"[Handoff] Session Zero context injected ({len(recent_summary)} chars)")
                    except Exception as mem_err:
                        print(f"[Handoff] Memory injection failed (non-critical): {mem_err}")
                    
                    # Save session with handoff_scene
                    session_store = get_session_store()
                    session_store.save(session)
                
                # 5. Initialize Campaign Bible (Director) if needed
        
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
    
    # Check for handoff transcript (first gameplay turn after Session Zero)
    handoff_transcript = None
    if session and hasattr(session, 'phase_state'):
        if session.phase_state.get("handoff_transcript"):
            handoff_transcript = session.phase_state.pop("handoff_transcript")  # One-time use
            print(f"[GameAPI] First gameplay turn - handoff transcript found ({len(handoff_transcript)} messages)")
            store.save(session)  # Save session with handoff data removed
    
    orchestrator = get_orchestrator()
    
    try:
        try:
            safe_input = request.player_input[:50].encode('ascii', 'replace').decode('ascii')
            print(f"[GameAPI] Processing turn: '{safe_input}...'")
        except Exception:
            print(f"[GameAPI] Processing turn: (encoding failed)")
        result = await orchestrator.process_turn(request.player_input, handoff_transcript=handoff_transcript)
        
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
