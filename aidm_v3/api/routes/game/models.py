"""Pydantic request/response models for the Game API."""

from typing import Any

from pydantic import BaseModel

# === Core Models ===

class TurnRequest(BaseModel):
    """Request for processing a turn."""
    player_input: str
    session_id: str | None = None  # Optional session tracking


class TurnResponse(BaseModel):
    """Response from processing a turn."""
    narrative: str
    intent: dict[str, Any]
    outcome: dict[str, Any]
    latency_ms: int
    session_phase: str | None = None  # Current session phase
    portrait_map: dict[str, str] | None = None  # {"NPC Name": "/api/game/media/..."}
    turn_number: int | None = None
    campaign_id: int | None = None


class SessionZeroResponse(BaseModel):
    """Response from Session Zero processing."""
    response: str
    phase: str
    phase_complete: bool  # DEPRECATED: Use ready_for_gameplay
    character_draft: dict[str, Any]
    session_id: str
    # New goal-oriented fields
    missing_requirements: list = []  # Hard requirements still needed
    ready_for_gameplay: bool = False  # True when all requirements met
    # Progress tracking for long-running research
    research_task_id: str | None = None  # SSE stream ID for progress
    detected_info: dict[str, Any] | None = None  # Raw debug info from agent
    # Disambiguation fields
    disambiguation_options: list | None = None  # List of series options to choose from
    awaiting_disambiguation: bool = False  # True if user needs to choose
    # Server-side stitched opening scene (returned during handoff)
    opening_scene: str | None = None
    opening_portrait_map: dict[str, str] | None = None


class ContextResponse(BaseModel):
    """Current game context."""
    location: str
    situation: str
    character_name: str
    arc_phase: str
    tension_level: float
    profile_name: str
    session_phase: str | None = None  # Session Zero phase if active


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
    stats: dict[str, Any]  # STR, INT, etc.
    power_tier: str
    abilities: list
    character_class: str | None = None
    portrait_url: str | None = None
    model_sheet_url: str | None = None


class NPCInfo(BaseModel):
    """NPC information for relationship tracker."""
    id: int
    name: str
    role: str | None  # ally, enemy, neutral, rival
    affinity: int  # -100 to +100
    disposition: int  # calculated disposition
    faction: str | None
    last_appeared: int | None  # turn number
    portrait_url: str | None = None


class NPCListResponse(BaseModel):
    """List of known NPCs."""
    npcs: list  # List of NPCInfo


class FactionInfo(BaseModel):
    """Faction information for reputation tracker."""
    id: int
    name: str
    pc_reputation: int  # -1000 to +1000
    pc_rank: str | None
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
    current_arc: str | None = None


# === Phase 1: Inventory, Abilities, Journal Response Models ===

class InventoryItemInfo(BaseModel):
    """A single inventory item."""
    name: str
    type: str = "miscellaneous"
    description: str = ""
    quantity: int = 1
    properties: dict[str, Any] = {}
    source: str | None = None


class InventoryResponse(BaseModel):
    """Character inventory."""
    items: list[InventoryItemInfo]
    total_items: int


class AbilityInfo(BaseModel):
    """A single ability/skill."""
    name: str
    description: str = ""
    type: str = "passive"
    level_acquired: int | None = None


class AbilitiesResponse(BaseModel):
    """Character abilities."""
    abilities: list[AbilityInfo]
    total_abilities: int


class JournalEntry(BaseModel):
    """A single journal entry (compactor beat or full-text turn)."""
    turn: int | None = None
    content: str
    entry_type: str = "beat"  # "beat" or "full_text"
    heat: float | None = None


class JournalResponse(BaseModel):
    """Journal with compactor beats and optional full-text expansion."""
    entries: list[JournalEntry]
    total_entries: int
    page: int
    per_page: int
    expanded_turn: int | None = None  # If a specific turn was expanded


# === Phase 2: Quest and Location Response Models ===

class QuestObjectiveInfo(BaseModel):
    """A single objective within a quest."""
    description: str
    completed: bool = False
    turn_completed: int | None = None


class QuestDetailInfo(BaseModel):
    """A quest with full details."""
    id: int
    title: str
    description: str | None = None
    status: str = "active"
    quest_type: str = "main"
    source: str = "director"
    objectives: list[QuestObjectiveInfo] = []
    created_turn: int | None = None
    completed_turn: int | None = None
    related_npcs: list[str] = []
    related_locations: list[str] = []


class QuestTrackerResponse(BaseModel):
    """Full quest tracker with active quests and current arc."""
    quests: list[QuestDetailInfo]
    current_arc: str | None = None
    total_active: int = 0
    total_completed: int = 0


class LocationInfo(BaseModel):
    """A discovered location."""
    id: int
    name: str
    location_type: str | None = None
    description: str | None = None
    atmosphere: str | None = None
    current_state: str = "intact"
    is_current: bool = False
    times_visited: int = 0
    discovered_turn: int | None = None
    last_visited_turn: int | None = None
    visual_tags: list[str] = []
    known_npcs: list[str] = []
    connected_locations: list[dict] = []
    notable_events: list[str] = []


class LocationsResponse(BaseModel):
    """All discovered locations."""
    locations: list[LocationInfo]
    current_location: str | None = None
    total_locations: int = 0


class StartSessionRequest(BaseModel):
    """Request to start a new session."""
    session_id: str | None = None  # Optional custom ID


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
    character_draft: dict[str, Any] | None = None
    recap: str | None = None  # "Previously On..." recap for session continuity
    turn_number: int = 0  # Current turn count (0 = no gameplay turns yet)


# === Phase 5: Media Gallery & Cost Models ===

class MediaAssetResponse(BaseModel):
    """Response model for a single media asset."""
    id: int
    asset_type: str
    cutscene_type: str | None = None
    file_url: str
    thumbnail_url: str | None = None
    turn_number: int | None = None
    cost_usd: float = 0.0
    status: str = "complete"
    created_at: str | None = None


class GalleryResponse(BaseModel):
    """All media assets for a campaign."""
    assets: list = []
    total: int = 0
    total_cost_usd: float = 0.0


class MediaCostResponse(BaseModel):
    """Cost summary for media generation."""
    campaign_total_usd: float = 0.0
    budget_cap_usd: float | None = None
    budget_enabled: bool = False
    budget_remaining_usd: float | None = None
    asset_count: int = 0
