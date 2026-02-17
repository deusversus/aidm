"""Pydantic request/response models for the Game API."""

from pydantic import BaseModel
from typing import Optional, Dict, Any, List


# === Core Models ===

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
    turn_number: Optional[int] = None
    campaign_id: Optional[int] = None


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
    # Server-side stitched opening scene (returned during handoff)
    opening_scene: Optional[str] = None
    opening_portrait_map: Optional[Dict[str, str]] = None


class ContextResponse(BaseModel):
    """Current game context."""
    location: str
    situation: str
    character_name: str
    arc_phase: str
    tension_level: float
    profile_name: str
    session_phase: Optional[str] = None  # Session Zero phase if active


# === Status Tracker Response Models ===

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


class ResumeSessionResponse(BaseModel):
    """Response from resuming a session."""
    session_id: str
    phase: str
    messages: list
    character_draft: Optional[Dict[str, Any]] = None
    recap: Optional[str] = None  # "Previously On..." recap for session continuity
    turn_number: int = 0  # Current turn count (0 = no gameplay turns yet)


# === Phase 5: Media Gallery & Cost Models ===

class MediaAssetResponse(BaseModel):
    """Response model for a single media asset."""
    id: int
    asset_type: str
    cutscene_type: Optional[str] = None
    file_url: str
    thumbnail_url: Optional[str] = None
    turn_number: Optional[int] = None
    cost_usd: float = 0.0
    status: str = "complete"
    created_at: Optional[str] = None


class GalleryResponse(BaseModel):
    """All media assets for a campaign."""
    assets: list = []
    total: int = 0
    total_cost_usd: float = 0.0


class MediaCostResponse(BaseModel):
    """Cost summary for media generation."""
    campaign_total_usd: float = 0.0
    budget_cap_usd: Optional[float] = None
    budget_enabled: bool = False
    budget_remaining_usd: Optional[float] = None
    asset_count: int = 0
