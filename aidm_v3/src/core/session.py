"""
Session State Management for AIDM v3.

Tracks whether we're in Session Zero (character creation) or Gameplay,
and manages the multi-phase Session Zero protocol from V2.
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List
from datetime import datetime


class SessionPhase(Enum):
    """
    Session Zero phases from V2's 06_session_zero.md.
    
    The player progresses through these phases during character creation,
    then transitions to GAMEPLAY for the actual adventure.
    """
    # Session Zero phases
    MEDIA_DETECTION = "media_detection"       # Phase 0: Detect anime references
    NARRATIVE_CALIBRATION = "calibration"     # Phase 0.5: Tone/style calibration
    OP_MODE_DETECTION = "op_mode"             # Phase 0.6: OP protagonist check
    MECHANICAL_LOADING = "mechanical"         # Phase 0.7: Load mechanical systems
    CONCEPT = "concept"                       # Phase 1: The big idea
    IDENTITY = "identity"                     # Phase 2: Name, appearance, backstory
    MECHANICAL_BUILD = "build"                # Phase 3: Stats, skills, equipment
    WORLD_INTEGRATION = "integration"         # Phase 4: How they fit the world
    OPENING_SCENE = "opening"                 # Phase 5: First narrative moment
    
    # Post-Session Zero
    GAMEPLAY = "gameplay"                     # Normal gameplay loop


# Phase progression order
PHASE_ORDER = [
    SessionPhase.MEDIA_DETECTION,
    SessionPhase.NARRATIVE_CALIBRATION,
    SessionPhase.OP_MODE_DETECTION,
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


def get_missing_requirements(draft: "CharacterDraft") -> List[str]:
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
    # Check if OP mode has been explicitly addressed
    if draft.op_protagonist_enabled is None:
        return SessionPhase.OP_MODE_DETECTION
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
    media_reference: Optional[str] = None
    media_researched: bool = False
    
    # Phase 0.5: Narrative calibration (None = not asked, True = confirmed)
    narrative_calibrated: Optional[bool] = None
    narrative_profile: Optional[str] = None  # e.g., "hunter_x_hunter"
    tone_preferences: Dict[str, Any] = field(default_factory=dict)
    
    # Phase 0.5: Canonicality (how the story relates to source material)
    timeline_mode: Optional[str] = None       # "canon_adjacent", "alternate", "inspired"
    canon_cast_mode: Optional[str] = None     # "full_cast", "replaced_protagonist", "npcs_only"
    event_fidelity: Optional[str] = None      # "observable", "influenceable", "background"
    
    # Phase 0.6: OP mode (None = not yet asked, False = declined, True = enabled)
    op_protagonist_enabled: Optional[bool] = None
    op_tension_source: Optional[str] = None      # existential, relational, moral, burden, information, consequence, control
    op_power_expression: Optional[str] = None    # instantaneous, overwhelming, sealed, hidden, conditional, derivative, passive
    op_narrative_focus: Optional[str] = None     # internal, ensemble, reverse_ensemble, episodic, faction, mundane, competition, legacy
    op_preset: Optional[str] = None              # Optional preset name (bored_god, hidden_ruler, etc.)
    
    # Power Tier (from OP mode or profile)
    power_tier: Optional[str] = None             # e.g., "T3", "T6" - defaults based on OP mode/world
    
    # Phase 1: Concept
    concept: Optional[str] = None  # The "big idea" tagline
    
    # Phase 2: Identity
    name: Optional[str] = None
    age: Optional[int] = None
    appearance: Dict[str, str] = field(default_factory=dict)
    visual_tags: List[str] = field(default_factory=list)  # ["blue_hair", "scar_left_eye", "tall"]
    personality_traits: List[str] = field(default_factory=list)
    values: List[str] = field(default_factory=list)
    fears: List[str] = field(default_factory=list)
    backstory: Optional[str] = None
    goals: Dict[str, str] = field(default_factory=dict)  # short_term, long_term
    quirks: List[str] = field(default_factory=list)
    
    # Phase 3: Mechanical build
    attributes: Dict[str, int] = field(default_factory=dict)  # STR, DEX, etc.
    resources: Dict[str, int] = field(default_factory=dict)   # HP, MP, SP
    unique_ability: Optional[Dict[str, Any]] = None
    skills: List[str] = field(default_factory=list)
    inventory: List[Dict[str, Any]] = field(default_factory=list)
    starting_gold: int = 0
    
    # Phase 4: World integration
    starting_location: Optional[str] = None
    faction_affiliations: List[str] = field(default_factory=list)
    known_npcs: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
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
    def from_dict(cls, data: Dict[str, Any]) -> "CharacterDraft":
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
    messages: List[Dict[str, str]] = field(default_factory=list)
    
    # Compaction buffer: micro-summaries of messages that fell off the sliding window
    # Each entry: {"turn": int, "summary": str, "tokens_est": int}
    compaction_buffer: List[Dict[str, Any]] = field(default_factory=list)
    
    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    last_activity: datetime = field(default_factory=datetime.now)
    
    # Phase-specific state (for multi-turn phases)
    phase_state: Dict[str, Any] = field(default_factory=dict)
    
    def is_session_zero(self) -> bool:
        """Check if we're still in Session Zero."""
        return self.phase != SessionPhase.GAMEPLAY
    
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
    
    def to_dict(self) -> Dict[str, Any]:
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
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Session":
        """Deserialize from dictionary."""
        session = cls(
            session_id=data["session_id"],
            phase=SessionPhase(data.get("phase", "media_detection")),
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
        return session


class SessionManager:
    """
    Manages active sessions.
    In a real deployment, this would be backed by a database.
    For now, we use in-memory storage.
    """
    
    def __init__(self):
        self._sessions: Dict[str, Session] = {}
    
    def create_session(self, session_id: str) -> Session:
        """Create a new session starting at Session Zero."""
        session = Session(session_id=session_id)
        self._sessions[session_id] = session
        return session
    
    def get_session(self, session_id: str) -> Optional[Session]:
        """Get an existing session."""
        return self._sessions.get(session_id)
    
    def get_or_create_session(self, session_id: str) -> Session:
        """Get existing session or create new one."""
        if session_id not in self._sessions:
            return self.create_session(session_id)
        return self._sessions[session_id]


# Singleton instance
_session_manager: Optional[SessionManager] = None


def get_session_manager() -> SessionManager:
    """Get the global session manager instance."""
    global _session_manager
    if _session_manager is None:
        _session_manager = SessionManager()
    return _session_manager
