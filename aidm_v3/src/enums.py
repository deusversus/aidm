"""
Canonical string enumerations for AIDM v3.

StrEnum values serialize as plain strings, so they're
drop-in replacements for raw string literals — no migration
needed for database columns, JSON payloads, or LLM schemas.
"""

from enum import StrEnum


# ── Intent Classification ──────────────────────────────────────────────

class IntentType(StrEnum):
    """Player intent categories (uppercase — matches LLM output schema)."""
    COMBAT = "COMBAT"
    SOCIAL = "SOCIAL"
    EXPLORATION = "EXPLORATION"
    ABILITY = "ABILITY"
    INVENTORY = "INVENTORY"
    WORLD_BUILDING = "WORLD_BUILDING"
    META_FEEDBACK = "META_FEEDBACK"
    OVERRIDE_COMMAND = "OVERRIDE_COMMAND"
    OP_COMMAND = "OP_COMMAND"
    OTHER = "OTHER"


# ── Outcome Judgment ───────────────────────────────────────────────────

class SuccessLevel(StrEnum):
    """Degree of success from the Outcome Judge."""
    FAILURE = "failure"
    PARTIAL = "partial"
    SUCCESS = "success"
    CRITICAL = "critical"


class NarrativeWeight(StrEnum):
    """How much narrative attention a turn deserves."""
    MINOR = "minor"
    STANDARD = "standard"        # Used by CombatResult only
    SIGNIFICANT = "significant"
    CLIMACTIC = "climactic"


class ConsequenceCategory(StrEnum):
    """Category of narrative consequence."""
    POLITICAL = "political"
    ENVIRONMENTAL = "environmental"
    RELATIONAL = "relational"
    ECONOMIC = "economic"
    MAGICAL = "magical"


# ── Arc / Pacing ───────────────────────────────────────────────────────

class ArcPhase(StrEnum):
    """Story arc phases stored in WorldState.arc_phase."""
    EXPOSITION = "exposition"
    RISING_ACTION = "rising_action"
    CLIMAX = "climax"
    FALLING_ACTION = "falling_action"
    RESOLUTION = "resolution"


class PacingBeat(StrEnum):
    """Per-turn pacing beats from the PacingAgent."""
    SETUP = "setup"
    RISING = "rising"
    ESCALATION = "escalation"
    CLIMAX = "climax"
    FALLING = "falling"
    RESOLUTION = "resolution"
    TRANSITION = "transition"


class PacingStrength(StrEnum):
    """How strongly a pacing directive should be followed."""
    SUGGESTION = "suggestion"
    STRONG = "strong"
    OVERRIDE = "override"


# ── OP Mode ────────────────────────────────────────────────────────────

class OPArchetype(StrEnum):
    """OP protagonist archetypes."""
    SAITAMA = "saitama"
    MOB = "mob"
    OVERLORD = "overlord"
    RIMURU = "rimuru"
    MASHLE = "mashle"


class OPTensionSource(StrEnum):
    """Where dramatic tension comes from in OP mode."""
    EXISTENTIAL = "existential"
    SOCIAL = "social"
    STRUCTURAL = "structural"
    ENSEMBLE = "ensemble"


class OPPowerExpression(StrEnum):
    """How OP power manifests."""
    INSTANTANEOUS = "instantaneous"
    DELAYED = "delayed"
    CONDITIONAL = "conditional"


class OPNarrativeFocus(StrEnum):
    """Where the narrative camera points in OP mode."""
    PERSONAL = "personal"
    FACTION = "faction"
    ENSEMBLE = "ensemble"


# ── Story Scale ────────────────────────────────────────────────────────

class StoryScale(StrEnum):
    """Narrative scope scale."""
    PERSONAL = "personal"
    LOCAL = "local"
    CONTINENTAL = "continental"
    PLANETARY = "planetary"
    COSMIC = "cosmic"
    MYTHIC = "mythic"


# ── NPC Intelligence ──────────────────────────────────────────────────

class NPCIntelligenceStage(StrEnum):
    """NPC behavior complexity stages (scene-count gated)."""
    REACTIVE = "reactive"
    CONTEXTUAL = "contextual"
    ANTICIPATORY = "anticipatory"
    AUTONOMOUS = "autonomous"


# ── Memory ─────────────────────────────────────────────────────────────

class MemoryCategory(StrEnum):
    """ChromaDB memory categories."""
    DIALOGUE = "dialogue"
    ACTION = "action"
    PLOT_CRITICAL = "plot_critical"
    RELATIONSHIP = "relationship"
    COMBAT = "combat"
    LORE = "lore"
    EPISODIC = "episodic"


# ── Session Phase ──────────────────────────────────────────────────────
# SessionPhase already exists as Enum in src/core/session.py.
# We re-export here for convenience but do NOT duplicate it.

from .core.session import SessionPhase  # noqa: E402, F401
