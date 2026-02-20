"""
Session State Management for AIDM v3.

Tracks whether we're in Session Zero (character creation) or Gameplay,
and manages the multi-phase Session Zero protocol from V2.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class SessionPhase(Enum):
    """
    Session Zero phases from V2's 06_session_zero.md.
    
    The player progresses through these phases during character creation,
    then transitions to GAMEPLAY for the actual adventure.
    """
    # Session Zero phases
    MEDIA_DETECTION = "media_detection"       # Phase 0: Detect anime references
    NARRATIVE_CALIBRATION = "calibration"     # Phase 0.5: Tone/style calibration
    MECHANICAL_LOADING = "mechanical"         # Phase 0.7: Load mechanical systems + tier selection
    CONCEPT = "concept"                       # Phase 1: The big idea
    IDENTITY = "identity"                     # Phase 2: Name, appearance, backstory
    MECHANICAL_BUILD = "build"                # Phase 3: Stats, skills, equipment
    WORLD_INTEGRATION = "integration"         # Phase 4: How they fit the world
    OPENING_SCENE = "opening"                 # Phase 5: First narrative moment

    # Post-Session Zero
    GAMEPLAY = "gameplay"                     # Normal gameplay loop
    META_CONVERSATION = "meta_conversation"   # Out-of-character dialogue with DM


# Phase progression order
PHASE_ORDER = [
    SessionPhase.MEDIA_DETECTION,
    SessionPhase.NARRATIVE_CALIBRATION,
    SessionPhase.MECHANICAL_LOADING,
    SessionPhase.CONCEPT,
    SessionPhase.IDENTITY,
    SessionPhase.MECHANICAL_BUILD,
    SessionPhase.WORLD_INTEGRATION,
    SessionPhase.OPENING_SCENE,
    SessionPhase.GAMEPLAY,
]


# Hard requirements for gameplay transition
# Session Zero MUST collect ALL of these before handoff
HARD_REQUIREMENTS = {
    # Phase 0: World
    "media_reference": "What anime/IP inspires this world",

    # Phase 1: Concept
    "concept": "1-2 sentence character summary",

    # Phase 2: Identity
    "name": "Player character's name",
    "backstory": "Character's backstory/history",

    # Phase 3: Mechanics
    "attributes": "Character stats (STR, DEX, etc.)",

    # Phase 4: World Integration
    "starting_location": "Where the story begins",
}


def get_missing_requirements(draft: "CharacterDraft") -> list[str]:
    """Return list of hard requirements that are still missing.
    
    Session Zero MUST NOT hand off until all of these are filled.
    """
    missing = []

    # World
    if draft.media_reference is None:
        missing.append("media_reference")

    # Concept
    if draft.concept is None:
        missing.append("concept")

    # Identity
    if draft.name is None:
        missing.append("name")
    if draft.backstory is None:
        missing.append("backstory")

    # Mechanics - need at least some attributes
    if not draft.attributes:
        missing.append("attributes")

    # World integration
    if draft.starting_location is None:
        missing.append("starting_location")

    return missing


def is_ready_for_gameplay(draft: "CharacterDraft") -> bool:
    """Check if all hard requirements are met."""
    return len(get_missing_requirements(draft)) == 0


def get_current_phase_for_draft(draft: "CharacterDraft") -> "SessionPhase":
    """Determine appropriate phase based on what data exists.
    
    This enables multi-phase skipping when player provides comprehensive data.
    """
    if draft.media_reference is None:
        return SessionPhase.MEDIA_DETECTION
    # Check if narrative calibration has been confirmed
    if draft.narrative_calibrated is None:
        return SessionPhase.NARRATIVE_CALIBRATION
    if draft.concept is None:
        return SessionPhase.CONCEPT
    if draft.name is None or draft.backstory is None:
        return SessionPhase.IDENTITY
    if not draft.skills and not draft.attributes:
        return SessionPhase.MECHANICAL_BUILD
    if draft.starting_location is None:
        return SessionPhase.WORLD_INTEGRATION
    return SessionPhase.OPENING_SCENE

@dataclass
class CharacterDraft:
    """
    Accumulates character data during Session Zero.
    Starts empty and fills in as the player answers questions.
    """
    # Phase 0: Media reference
    media_reference: str | None = None
    media_researched: bool = False

    # Phase 0.5: Narrative calibration (None = not asked, True = confirmed)
    narrative_calibrated: bool | None = None
    narrative_profile: str | None = None  # e.g., "hunter_x_hunter"
    tone_preferences: dict[str, Any] = field(default_factory=dict)

    # Phase 0.5: Canonicality (how the story relates to source material)
    timeline_mode: str | None = None       # "canon_adjacent", "alternate", "inspired"
    canon_cast_mode: str | None = None     # "full_cast", "replaced_protagonist", "npcs_only"
    event_fidelity: str | None = None      # "observable", "influenceable", "background"

    # Phase 0.6: OP mode — DEPRECATED (kept for migration; OP status now derived from power_tier vs world_tier)
    op_protagonist_enabled: bool | None = None
    op_tension_source: str | None = None
    op_power_expression: str | None = None
    op_narrative_focus: str | None = None
    op_preset: str | None = None

    # Power Tier (from OP mode or profile)
    power_tier: str | None = None             # e.g., "T3", "T6" - defaults based on OP mode/world

    # Phase 1: Concept
    concept: str | None = None  # The "big idea" tagline

    # Phase 2: Identity
    name: str | None = None
    age: int | None = None
    appearance: dict[str, str] = field(default_factory=dict)
    visual_tags: list[str] = field(default_factory=list)  # ["blue_hair", "scar_left_eye", "tall"]
    personality_traits: list[str] = field(default_factory=list)
    values: list[str] = field(default_factory=list)
    fears: list[str] = field(default_factory=list)
    backstory: str | None = None
    goals: dict[str, str] = field(default_factory=dict)  # short_term, long_term
    quirks: list[str] = field(default_factory=list)

    # Phase 3: Mechanical build
    attributes: dict[str, int] = field(default_factory=dict)  # STR, DEX, etc.
    resources: dict[str, int] = field(default_factory=dict)   # HP, MP, SP
    unique_ability: dict[str, Any] | None = None
    skills: list[str] = field(default_factory=list)
    inventory: list[dict[str, Any]] = field(default_factory=list)
    starting_gold: int = 0

    # Phase 4: World integration
    starting_location: str | None = None
    faction_affiliations: list[str] = field(default_factory=list)
    known_npcs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for persistence."""
        return {
            "media_reference": self.media_reference,
            "media_researched": self.media_researched,
            "narrative_profile": self.narrative_profile,
            "tone_preferences": self.tone_preferences,
            "timeline_mode": self.timeline_mode,
            "canon_cast_mode": self.canon_cast_mode,
            "event_fidelity": self.event_fidelity,
            "op_protagonist_enabled": self.op_protagonist_enabled,
            "op_tension_source": self.op_tension_source,
            "op_power_expression": self.op_power_expression,
            "op_narrative_focus": self.op_narrative_focus,
            "op_preset": self.op_preset,
            "power_tier": self.power_tier,
            "concept": self.concept,
            "name": self.name,
            "age": self.age,
            "appearance": self.appearance,
            "visual_tags": self.visual_tags,
            "personality_traits": self.personality_traits,
            "values": self.values,
            "fears": self.fears,
            "backstory": self.backstory,
            "goals": self.goals,
            "quirks": self.quirks,
            "attributes": self.attributes,
            "resources": self.resources,
            "unique_ability": self.unique_ability,
            "skills": self.skills,
            "inventory": self.inventory,
            "starting_gold": self.starting_gold,
            "starting_location": self.starting_location,
            "faction_affiliations": self.faction_affiliations,
            "known_npcs": self.known_npcs,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CharacterDraft":
        """Deserialize from dictionary."""
        return cls(
            media_reference=data.get("media_reference"),
            media_researched=data.get("media_researched", False),
            narrative_profile=data.get("narrative_profile"),
            tone_preferences=data.get("tone_preferences", {}),
            timeline_mode=data.get("timeline_mode"),
            canon_cast_mode=data.get("canon_cast_mode"),
            event_fidelity=data.get("event_fidelity"),
            op_protagonist_enabled=data.get("op_protagonist_enabled"),  # None = not asked yet
            op_tension_source=data.get("op_tension_source") or data.get("op_archetype"),  # Migration: fallback to old archetype
            op_power_expression=data.get("op_power_expression"),
            op_narrative_focus=data.get("op_narrative_focus"),
            op_preset=data.get("op_preset") or data.get("op_archetype"),  # Migration: use archetype as preset
            power_tier=data.get("power_tier"),
            concept=data.get("concept"),
            name=data.get("name"),
            age=data.get("age"),
            appearance=data.get("appearance", {}),
            visual_tags=data.get("visual_tags", []),
            personality_traits=data.get("personality_traits", []),
            values=data.get("values", []),
            fears=data.get("fears", []),
            backstory=data.get("backstory"),
            goals=data.get("goals", {}),
            quirks=data.get("quirks", []),
            attributes=data.get("attributes", {}),
            resources=data.get("resources", {}),
            unique_ability=data.get("unique_ability"),
            skills=data.get("skills", []),
            inventory=data.get("inventory", []),
            starting_gold=data.get("starting_gold", 0),
            starting_location=data.get("starting_location"),
            faction_affiliations=data.get("faction_affiliations", []),
            known_npcs=data.get("known_npcs", []),
        )


@dataclass
class Session:
    """
    Represents a game session, tracking Session Zero progress and state.
    """
    session_id: str
    phase: SessionPhase = SessionPhase.MEDIA_DETECTION
    character_draft: CharacterDraft = field(default_factory=CharacterDraft)

    # Conversation history for this session
    messages: list[dict[str, str]] = field(default_factory=list)

    # Compaction buffer: micro-summaries of messages that fell off the sliding window
    # Each entry: {"turn": int, "summary": str, "tokens_est": int}
    compaction_buffer: list[dict[str, Any]] = field(default_factory=list)

    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    last_activity: datetime = field(default_factory=datetime.now)

    # Phase-specific state (for multi-turn phases)
    phase_state: dict[str, Any] = field(default_factory=dict)

    # Meta conversation history (ephemeral out-of-character dialogue)
    # Each entry: {"role": "player"|"director"|"key_animator", "content": str}
    meta_conversation_history: list[dict[str, str]] = field(default_factory=list)

    # Arc-level narrative mode (Layer 2)
    current_arc_mode: str = "main_arc"                # main_arc | ensemble_arc | adversary_ensemble_arc | ally_ensemble_arc | investigator_arc | faction_arc
    arc_pov_protagonist: str | None = None             # NPC name/group when not main_arc
    arc_committed_at_turn: int | None = None            # turn number when Director committed
    arc_transition_signal: str | None = None            # narrative event that will close this arc

    def is_session_zero(self) -> bool:
        """Check if we're still in Session Zero."""
        return self.phase not in (SessionPhase.GAMEPLAY, SessionPhase.META_CONVERSATION)

    def advance_phase(self) -> bool:
        """
        Move to the next phase.
        Returns True if advanced, False if already at GAMEPLAY.
        """
        if self.phase == SessionPhase.GAMEPLAY:
            return False

        current_idx = PHASE_ORDER.index(self.phase)
        if current_idx < len(PHASE_ORDER) - 1:
            self.phase = PHASE_ORDER[current_idx + 1]
            self.phase_state = {}  # Reset phase-specific state
            self.last_activity = datetime.now()
            return True
        return False

    def skip_to_phase(self, target: SessionPhase) -> bool:
        """
        Skip directly to a target phase (for Spartan Mode or corrections).
        """
        if target in PHASE_ORDER:
            self.phase = target
            self.phase_state = {}
            self.last_activity = datetime.now()
            return True
        return False

    def add_message(self, role: str, content: str):
        """Add a message to the conversation history."""
        self.messages.append({
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
            "phase": self.phase.value
        })
        self.last_activity = datetime.now()

    def get_active_profile_ids(self) -> list[str]:
        """Get all profile IDs from the session composition.

        Used by gameplay tools for multi-profile lore search.
        Falls back to single profile_id for backward compatibility.
        """
        composition_ids = self.phase_state.get('active_profile_ids', [])
        if composition_ids:
            return composition_ids
        # Backward compat: single profile from character draft
        draft_profile = self.character_draft.narrative_profile
        if draft_profile:
            return [draft_profile]
        return []

    def get_primary_profile_id(self) -> str | None:
        """Get the primary (highest-weight) profile ID.

        Used where a single ID is still needed (e.g., media generation style lookup).
        """
        ids = self.get_active_profile_ids()
        return ids[0] if ids else None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for persistence."""
        return {
            "session_id": self.session_id,
            "phase": self.phase.value,
            "character_draft": self.character_draft.to_dict(),
            "messages": self.messages,
            "compaction_buffer": self.compaction_buffer,
            "created_at": self.created_at.isoformat(),
            "last_activity": self.last_activity.isoformat(),
            "phase_state": self.phase_state,
            # Arc-level narrative mode
            "current_arc_mode": self.current_arc_mode,
            "arc_pov_protagonist": self.arc_pov_protagonist,
            "arc_committed_at_turn": self.arc_committed_at_turn,
            "arc_transition_signal": self.arc_transition_signal,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Session":
        """Deserialize from dictionary."""
        # Handle legacy phase value "op_mode" → skip to next phase
        phase_val = data.get("phase", "media_detection")
        if phase_val == "op_mode":
            phase_val = "mechanical"
        session = cls(
            session_id=data["session_id"],
            phase=SessionPhase(phase_val),
            character_draft=CharacterDraft.from_dict(data.get("character_draft", {})),
            messages=data.get("messages", []),
            compaction_buffer=data.get("compaction_buffer", []),
            phase_state=data.get("phase_state", {}),
        )
        # Parse datetime strings
        if data.get("created_at"):
            session.created_at = datetime.fromisoformat(data["created_at"])
        if data.get("last_activity"):
            session.last_activity = datetime.fromisoformat(data["last_activity"])
        # Arc-level narrative mode
        session.current_arc_mode = data.get("current_arc_mode", "main_arc")
        session.arc_pov_protagonist = data.get("arc_pov_protagonist")
        session.arc_committed_at_turn = data.get("arc_committed_at_turn")
        session.arc_transition_signal = data.get("arc_transition_signal")
        return session


class SessionManager:
    """
    Manages active sessions.
    In a real deployment, this would be backed by a database.
    For now, we use in-memory storage.
    """

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def create_session(self, session_id: str) -> Session:
        """Create a new session starting at Session Zero."""
        session = Session(session_id=session_id)
        self._sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> Session | None:
        """Get an existing session."""
        return self._sessions.get(session_id)

    def get_or_create_session(self, session_id: str) -> Session:
        """Get existing session or create new one."""
        if session_id not in self._sessions:
            return self.create_session(session_id)
        return self._sessions[session_id]


# Singleton instance
_session_manager: SessionManager | None = None


def get_session_manager() -> SessionManager:
    """Get the global session manager instance."""
    global _session_manager
    if _session_manager is None:
        _session_manager = SessionManager()
    return _session_manager
