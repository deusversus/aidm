"""
Session Zero extraction and artifact schemas.

Defines the canonical structured data contracts for the Session Zero
Handoff Compiler and Orchestrator. These schemas replace the vague
detected_info dict-of-any that the current SessionZeroAgent uses
internally.

Design principles (from sz_upgrade_plan.md §7.2.4):
- Focused per-pass schemas that compose cleanly
- No single monolithic extraction blob
- Every node carries provenance and confidence
- Status lifecycle: candidate → resolved → exported → discarded
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


# ─────────────────────────────────────────────
# Enums
# ─────────────────────────────────────────────

class ArtifactStatus(str, Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    SUPERSEDED = "superseded"
    FAILED = "failed"


class CompilerRunType(str, Enum):
    TURN_ORCHESTRATION = "turn_orchestration"
    HANDOFF_COMPILE = "handoff_compile"
    RECOVERY_COMPILE = "recovery_compile"


class CompilerRunStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class HandoffStatus(str, Enum):
    """Staged status for the full handoff → opening-scene pipeline."""
    NOT_READY = "not_ready"
    HANDOFF_COMPILING = "handoff_compiling"
    OPENING_PACKAGE_READY = "opening_package_ready"
    DIRECTOR_STARTUP_READY = "director_startup_ready"
    OPENING_SCENE_GENERATING = "opening_scene_generating"
    OPENING_SCENE_READY = "opening_scene_ready"
    OPENING_SCENE_FAILED = "opening_scene_failed"
    HANDOFF_BLOCKED = "handoff_blocked"


class EntityStatus(str, Enum):
    CANDIDATE = "candidate"
    RESOLVED = "resolved"
    EXPORTED = "exported"
    DISCARDED = "discarded"


class EntityType(str, Enum):
    CHARACTER = "character"
    NPC = "npc"
    FACTION = "faction"
    LOCATION = "location"
    QUEST = "quest"
    ITEM = "item"
    RELATIONSHIP = "relationship"
    WORLD_FACT = "world_fact"
    LORE = "lore"
    ABILITY = "ability"
    EVENT = "event"


class ProvenanceKind(str, Enum):
    TRANSCRIPT = "transcript"
    PROFILE_RESEARCH = "profile_research"
    INFERRED = "inferred"
    PLAYER_CONFIRMED = "player_confirmed"
    IMPORTED_CANON = "imported_canon"


class ContradictionType(str, Enum):
    HARD_CONFLICT = "hard_conflict"
    ALIAS_CONFLICT = "alias_conflict"
    TIMELINE_CONFLICT = "timeline_conflict"
    AMBIGUITY = "ambiguity"
    PERSPECTIVE_DIFFERENCE = "perspective_difference"


class UnresolvedCategory(str, Enum):
    IDENTITY = "identity"
    NPC = "npc"
    FACTION = "faction"
    LOCATION = "location"
    QUEST = "quest"
    CANONICALITY = "canonicality"
    MECHANICS = "mechanics"
    WORLD_LORE = "world_lore"
    RELATIONSHIP = "relationship"
    OTHER = "other"


class SceneMode(str, Enum):
    QUIET_INTRO = "quiet_intro"
    INCITING_INCIDENT = "inciting_incident"
    SOCIAL_HOOK = "social_hook"
    THREAT_HOOK = "threat_hook"
    MYSTERY_HOOK = "mystery_hook"
    MOTION_HOOK = "motion_hook"


# ─────────────────────────────────────────────
# Provenance and confidence
# ─────────────────────────────────────────────

class SourceRef(BaseModel):
    """Reference to a specific location in the transcript or other source."""
    message_index: int | None = Field(default=None, description="Index in session.messages (0-based)")
    message_role: str | None = Field(default=None, description="'user' or 'assistant'")
    span: str | None = Field(default=None, description="Verbatim excerpt from the source, if available")


class ProvenanceRef(BaseModel):
    """Provenance record for a fact or entity attribute."""
    kind: ProvenanceKind = Field(description="Source type")
    source_refs: list[SourceRef] = Field(default_factory=list, description="Specific references in transcript or profile data")
    confidence: float = Field(default=0.7, ge=0.0, le=1.0, description="0=total guess, 1=explicitly stated by player")
    confidence_rationale: str = Field(default="", description="Why this confidence level was assigned")
    inferred_from: str | None = Field(default=None, description="If inferred, what evidence led to this inference")


class MergeHistoryEntry(BaseModel):
    """Record of a merge operation that produced or altered a canonical entity."""
    merged_candidate_ids: list[str] = Field(description="IDs of candidates that were merged")
    merge_reason: str = Field(description="Why these candidates were determined to be the same entity")
    facts_chosen: list[str] = Field(default_factory=list, description="Which conflicting facts were kept")
    facts_dropped: list[str] = Field(default_factory=list, description="Which conflicting facts were dropped and why")


class ExportState(BaseModel):
    """Tracks whether and how this entity has been written to gameplay SQL tables."""
    exported: bool = Field(default=False)
    exported_entity_type: str | None = Field(default=None, description="SQL table / entity type (e.g. 'npc', 'faction')")
    exported_entity_id: int | None = Field(default=None, description="PK in the gameplay table")
    exported_at_version: int | None = Field(default=None, description="Artifact version at time of export")
    export_idempotency_key: str | None = Field(default=None, description="Stable key to prevent duplicate exports")


# ─────────────────────────────────────────────
# Core extraction records (per-pass outputs)
# ─────────────────────────────────────────────

class EntityRecord(BaseModel):
    """A normalized, deduplicated entity candidate from the transcript."""
    canonical_id: str = Field(description="Stable ID for this entity, e.g. 'npc_commander_vale'")
    entity_type: EntityType
    display_name: str = Field(description="Primary canonical name")
    aliases: list[str] = Field(default_factory=list, description="All known aliases, titles, epithets, codenames")
    description: str = Field(default="", description="Short factual description")
    attributes: dict[str, Any] = Field(default_factory=dict, description="Entity-type-specific structured fields")
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    provenance: list[ProvenanceRef] = Field(default_factory=list)
    source_refs: list[SourceRef] = Field(default_factory=list)
    merge_history: list[MergeHistoryEntry] = Field(default_factory=list)
    export_state: ExportState = Field(default_factory=ExportState)
    status: EntityStatus = Field(default=EntityStatus.CANDIDATE)


class RelationshipRecord(BaseModel):
    """A directional relationship between two entities."""
    relationship_id: str = Field(description="Stable ID, e.g. 'rel_pc_vale_mentor'")
    from_entity_id: str = Field(description="canonical_id of the source entity")
    to_entity_id: str = Field(description="canonical_id of the target entity")
    relationship_type: str = Field(description="e.g. 'mentor', 'rival', 'owes_debt_to', 'member_of', 'commands'")
    description: str = Field(default="")
    is_mutual: bool = Field(default=False)
    is_hidden: bool = Field(default=False, description="True if this relationship is a secret")
    affinity_score: float | None = Field(default=None, ge=-1.0, le=1.0, description="-1=hostile, 0=neutral, 1=devoted")
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    provenance: list[ProvenanceRef] = Field(default_factory=list)
    status: EntityStatus = Field(default=EntityStatus.CANDIDATE)


class FactRecord(BaseModel):
    """A structured world or character fact extracted from the transcript."""
    fact_id: str = Field(description="Stable ID, e.g. 'fact_001_vale_debt'")
    subject_entity_id: str | None = Field(default=None, description="canonical_id of the primary entity this fact is about")
    fact_type: str = Field(description="e.g. 'backstory_beat', 'world_rule', 'power_constraint', 'social_norm', 'historical_event'")
    content: str = Field(description="The fact itself, stated plainly")
    is_player_authored: bool = Field(default=True, description="False if this is imported canon or inferred lore")
    is_confidential: bool = Field(default=False, description="True if this should not be surfaced in the opening scene")
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    provenance: list[ProvenanceRef] = Field(default_factory=list)
    status: EntityStatus = Field(default=EntityStatus.CANDIDATE)


class CorrectionRecord(BaseModel):
    """A player retraction or correction of a previously stated fact."""
    correction_id: str
    original_fact_id: str | None = Field(default=None, description="fact_id or entity attribute being corrected")
    original_statement: str = Field(description="What was originally said")
    corrected_statement: str = Field(description="What the player later said instead")
    correction_message_index: int = Field(description="Index in session.messages where correction appeared")
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)


class ContradictionRecord(BaseModel):
    """A detected contradiction or conflict between two statements or entities."""
    issue_id: str
    issue_type: ContradictionType
    entities_involved: list[str] = Field(default_factory=list, description="canonical_ids of entities involved")
    statements: list[str] = Field(description="The two (or more) conflicting statements")
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    is_blocking: bool = Field(default=False, description="True if this must be resolved before safe handoff")
    suggested_resolution: str | None = Field(default=None)
    resolution_status: Literal["unresolved", "auto_resolved", "player_resolved", "deferred"] = Field(default="unresolved")
    resolution_notes: str | None = Field(default=None)


class UnresolvedItem(BaseModel):
    """Something the compiler could not fully resolve — requires follow-up or safe assumption."""
    item_id: str
    category: UnresolvedCategory
    description: str = Field(description="What is missing or ambiguous")
    why_it_matters: str = Field(description="Why this gap affects gameplay quality")
    priority: Literal["critical", "high", "medium", "low"] = Field(default="medium")
    is_blocking: bool = Field(default=False, description="True if this must be resolved before opening scene")
    candidate_followup: str | None = Field(default=None, description="Suggested follow-up question for the player")
    safe_assumption: str | None = Field(default=None, description="Reasonable default the system could use if player declines to answer")


class CanonicalitySignal(BaseModel):
    """A signal about timeline mode, canon divergence, or custom lore rules."""
    signal_id: str
    signal_type: str = Field(description="e.g. 'timeline_mode', 'divergence', 'canon_anchor', 'custom_rule'")
    content: str = Field(description="The signal itself")
    timeline_mode: str | None = Field(default=None, description="e.g. 'canon', 'alternate', 'custom', 'hybrid'")
    is_player_authored_divergence: bool = Field(default=False)
    is_forbidden_contradiction: bool = Field(default=False, description="True if this is a hard 'must not contradict' constraint")
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    provenance: list[ProvenanceRef] = Field(default_factory=list)


class OpeningSceneCue(BaseModel):
    """A specific cue that should influence the opening scene."""
    cue_id: str
    cue_type: str = Field(description="e.g. 'required_npc', 'forbidden_element', 'tone_anchor', 'first_beat', 'location_detail'")
    content: str
    priority: Literal["must_include", "should_include", "nice_to_have"] = Field(default="should_include")
    applies_to: Literal["director", "key_animator", "both"] = Field(default="both")
    provenance: list[ProvenanceRef] = Field(default_factory=list)


# ─────────────────────────────────────────────
# Compiler pass output bundles
# ─────────────────────────────────────────────

class ExtractionPassOutput(BaseModel):
    """Output from a single sz_extractor pass over a transcript chunk."""
    chunk_start_index: int = Field(description="Start message index for this chunk")
    chunk_end_index: int = Field(description="End message index for this chunk (exclusive)")
    entity_records: list[EntityRecord] = Field(default_factory=list)
    relationship_records: list[RelationshipRecord] = Field(default_factory=list)
    fact_records: list[FactRecord] = Field(default_factory=list)
    correction_records: list[CorrectionRecord] = Field(default_factory=list)
    canonicality_signals: list[CanonicalitySignal] = Field(default_factory=list)
    opening_scene_cues: list[OpeningSceneCue] = Field(default_factory=list)
    unresolved_items: list[UnresolvedItem] = Field(default_factory=list)
    schema_version: int = Field(default=1)


class EntityResolutionOutput(BaseModel):
    """Output from the sz_entity_resolver pass."""
    canonical_entities: list[EntityRecord] = Field(
        default_factory=list,
        description="Merged, deduplicated entity list — each entity is fully resolved"
    )
    canonical_relationships: list[RelationshipRecord] = Field(default_factory=list)
    merges_performed: list[MergeHistoryEntry] = Field(default_factory=list)
    alias_map: dict[str, str] = Field(
        default_factory=dict,
        description="Maps every alias/variant name -> canonical_id for quick lookup"
    )
    schema_version: int = Field(default=1)


class GapAnalysisOutput(BaseModel):
    """Output from the sz_gap_analyzer pass."""
    unresolved_items: list[UnresolvedItem] = Field(default_factory=list)
    contradictions: list[ContradictionRecord] = Field(default_factory=list)
    handoff_safe: bool = Field(
        description="True if handoff can proceed without player intervention"
    )
    blocking_issues: list[str] = Field(
        default_factory=list,
        description="Summary of blocking issues that prevent handoff"
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Non-blocking concerns worth surfacing"
    )
    recommended_player_followups: list[str] = Field(
        default_factory=list,
        description="Ordered list of most valuable questions to ask the player"
    )
    schema_version: int = Field(default=1)


# ─────────────────────────────────────────────
# Opening-state package (full contract)
# ─────────────────────────────────────────────

class PackageMetadata(BaseModel):
    session_id: str
    campaign_id: int | None = None
    package_version: int = Field(default=1)
    schema_version: int = Field(default=1)
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    source_run_id: int | None = None
    transcript_hash: str | None = None
    character_draft_hash: str | None = None
    profile_id: str | None = None
    effective_canonicality_mode: str | None = None


class PackageReadiness(BaseModel):
    handoff_status: HandoffStatus = Field(default=HandoffStatus.OPENING_PACKAGE_READY)
    blocking_issues: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    missing_but_nonblocking: list[str] = Field(default_factory=list)
    confidence_summary: str = Field(default="")


class PlayerCharacterBrief(BaseModel):
    name: str = Field(default="")
    aliases: list[str] = Field(default_factory=list)
    concept: str = Field(default="")
    core_identity: str = Field(default="")
    appearance: str = Field(default="")
    visual_tags: list[str] = Field(default_factory=list)
    personality: str = Field(default="")
    values: list[str] = Field(default_factory=list)
    fears: list[str] = Field(default_factory=list)
    goals: dict[str, Any] = Field(default_factory=dict, description="short_term, long_term, hidden")
    abilities: list[str] = Field(default_factory=list)
    power_tier: str = Field(default="T10")
    resource_snapshot: dict[str, Any] = Field(default_factory=dict, description="HP, MP, SP, special resources")
    social_position: str = Field(default="")
    known_relationships: list[str] = Field(default_factory=list, description="Canonical IDs of key relationships")
    backstory_beats: list[str] = Field(default_factory=list)
    starting_inventory: list[str] = Field(default_factory=list)
    voice_notes: str = Field(default="", description="Notes on character voice, speech patterns, mannerisms")


class OpeningSituation(BaseModel):
    """The single most important section for opening-scene generation."""
    starting_location: str = Field(default="")
    time_context: str = Field(default="")
    immediate_situation: str = Field(default="")
    what_is_happening_right_now: str = Field(default="")
    why_this_moment_is_the_start: str = Field(default="")
    immediate_pressure: str = Field(default="")
    scene_objective: str = Field(default="")
    scene_question: str = Field(default="", description="The central dramatic question the opening scene poses")
    expected_initial_motion: str = Field(default="")
    forbidden_opening_moves: list[str] = Field(default_factory=list)


class CastMember(BaseModel):
    canonical_id: str
    display_name: str
    role_in_scene: str = Field(default="")
    relationship_to_pc: str = Field(default="")
    tone: str = Field(default="")
    must_include: bool = Field(default=False)
    must_not_imply: list[str] = Field(default_factory=list)
    visual_notes: str = Field(default="")


class OpeningCast(BaseModel):
    required_present: list[CastMember] = Field(default_factory=list)
    optional_present: list[CastMember] = Field(default_factory=list)
    offscreen_but_relevant: list[CastMember] = Field(default_factory=list)
    npc_relationship_notes: str = Field(default="")
    entry_constraints: list[str] = Field(default_factory=list)
    portrait_priority: list[str] = Field(default_factory=list, description="Ordered list of canonical_ids for portrait gen")


class WorldContextBrief(BaseModel):
    location_description: str = Field(default="")
    world_state_snapshot: str = Field(default="")
    important_recent_facts: list[str] = Field(default_factory=list)
    local_dangers: list[str] = Field(default_factory=list)
    local_opportunities: list[str] = Field(default_factory=list)
    setting_truths: list[str] = Field(default_factory=list)
    taboo_or_impossible_elements: list[str] = Field(default_factory=list)


class FactionContextBrief(BaseModel):
    relevant_factions: list[str] = Field(default_factory=list, description="Names/IDs of factions relevant to opening scene")
    current_alignment_map: dict[str, str] = Field(default_factory=dict, description="faction_id -> 'allied|hostile|neutral|unknown'")
    visible_pressure: str = Field(default="")
    hidden_pressure: str = Field(default="")
    faction_conflicts_already_in_play: list[str] = Field(default_factory=list)


class ActiveThreadsBrief(BaseModel):
    quests_or_hooks_to_surface: list[str] = Field(default_factory=list)
    threads_to_foreshadow: list[str] = Field(default_factory=list)
    threads_to_avoid_prematurely_revealing: list[str] = Field(default_factory=list)
    mysteries_already_known_to_player: list[str] = Field(default_factory=list)
    mysteries_hidden_from_player: list[str] = Field(default_factory=list)


class CanonRules(BaseModel):
    timeline_mode: str = Field(default="canon")
    canon_cast_mode: str = Field(default="full")
    event_fidelity: str = Field(default="faithful")
    accepted_divergences: list[str] = Field(default_factory=list)
    forbidden_contradictions: list[str] = Field(default_factory=list)
    hybrid_profile_rules: list[str] = Field(default_factory=list)
    alt_timeline_rules: list[str] = Field(default_factory=list)


class ToneAndComposition(BaseModel):
    composition_name: str | None = Field(default=None)
    tension_source: str | None = Field(default=None)
    power_expression: str | None = Field(default=None)
    narrative_focus: str | None = Field(default=None)
    genre_pressure: str = Field(default="")
    tone_floor: str = Field(default="")
    tone_ceiling: str = Field(default="")
    aesthetic_targets: list[str] = Field(default_factory=list)
    author_voice_constraints: list[str] = Field(default_factory=list)


class DirectorInputs(BaseModel):
    arc_seed_candidates: list[str] = Field(default_factory=list)
    opening_antagonistic_pressure: str = Field(default="")
    recommended_foreshadowing_targets: list[str] = Field(default_factory=list)
    spotlight_priorities: list[str] = Field(default_factory=list)
    recommended_first_arc_scope: str = Field(default="")
    narrative_risks: list[str] = Field(default_factory=list)
    required_payoff_setup: list[str] = Field(default_factory=list)


class AnimationInputs(BaseModel):
    scene_mode: SceneMode = Field(default=SceneMode.INCITING_INCIDENT)
    required_beats: list[str] = Field(default_factory=list)
    beat_order_constraints: list[str] = Field(default_factory=list)
    visual_anchor_images: list[str] = Field(default_factory=list)
    emotional_target: str = Field(default="")
    prose_pressure: str = Field(default="")
    pacing_guidance: str = Field(default="")
    must_land_on: str = Field(default="")
    must_not_end_on: str = Field(default="")


class PackageUncertainties(BaseModel):
    known_unknowns: list[str] = Field(default_factory=list)
    contradiction_notes: list[str] = Field(default_factory=list)
    safe_assumptions: list[str] = Field(default_factory=list, description="Inferences the system made when player didn't specify")
    unsafe_assumptions: list[str] = Field(default_factory=list, description="Guesses that should be treated with caution")
    degraded_generation_guidance: str = Field(default="", description="How Director/KA should proceed if package quality is degraded")


class OpeningStatePackage(BaseModel):
    """
    The authoritative handoff contract from Session Zero / Handoff Compiler
    to Director and Key Animator.

    This package replaces the lossy _build_session_zero_summary() string
    currently fed to Director startup. It is persisted as a versioned artifact
    and consumed directly by run_director_startup() and generate_opening_scene().

    Required sections: package_metadata, readiness, player_character, opening_situation
    Enrichment sections: all others (should be present but absence is non-blocking)
    """
    package_metadata: PackageMetadata
    readiness: PackageReadiness = Field(default_factory=PackageReadiness)

    # Core required sections
    player_character: PlayerCharacterBrief = Field(default_factory=PlayerCharacterBrief)
    opening_situation: OpeningSituation = Field(default_factory=OpeningSituation)

    # Enrichment sections
    opening_cast: OpeningCast = Field(default_factory=OpeningCast)
    world_context: WorldContextBrief = Field(default_factory=WorldContextBrief)
    faction_context: FactionContextBrief = Field(default_factory=FactionContextBrief)
    active_threads: ActiveThreadsBrief = Field(default_factory=ActiveThreadsBrief)
    canon_rules: CanonRules = Field(default_factory=CanonRules)
    tone_and_composition: ToneAndComposition = Field(default_factory=ToneAndComposition)

    # Consumer-specific inputs
    director_inputs: DirectorInputs = Field(default_factory=DirectorInputs)
    animation_inputs: AnimationInputs = Field(default_factory=AnimationInputs)

    # Constraint tiers
    hard_constraints: list[str] = Field(
        default_factory=list,
        description="Non-negotiable facts Director/KA must not contradict"
    )
    soft_targets: list[str] = Field(
        default_factory=list,
        description="Guidance that should inform quality without making the system brittle"
    )
    uncertainties: PackageUncertainties = Field(default_factory=PackageUncertainties)

    # Lineage
    artifact_dependencies: dict[str, int] = Field(
        default_factory=dict,
        description="Maps artifact_type -> artifact_version used to build this package"
    )


# ─────────────────────────────────────────────
# Compiler checkpoint and run records
# ─────────────────────────────────────────────

class CompilerCheckpoint(BaseModel):
    """Persisted checkpoint after a major compiler pass."""
    checkpoint_id: str
    run_id: int | None = None
    pass_name: str = Field(description="e.g. 'extraction', 'entity_resolution', 'gap_analysis', 'opening_brief'")
    pass_sequence: int = Field(description="Ordinal position in the compiler pipeline")
    entities_created: int = Field(default=0)
    entities_merged: int = Field(default=0)
    contradictions_detected: int = Field(default=0)
    contradictions_resolved: int = Field(default=0)
    unresolved_items_count: int = Field(default=0)
    handoff_blocked: bool = Field(default=False)
    warnings: list[str] = Field(default_factory=list)
    next_step: str = Field(default="")
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    schema_version: int = Field(default=1)


class HandoffCompilerResult(BaseModel):
    """Top-level result returned from HandoffCompiler.run()."""
    success: bool
    opening_state_package: OpeningStatePackage | None = None
    entity_graph: EntityResolutionOutput | None = None
    gap_analysis: GapAnalysisOutput | None = None
    checkpoints: list[CompilerCheckpoint] = Field(default_factory=list)
    artifact_version: int | None = None
    run_id: int | None = None
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    compiler_task_id: str | None = None  # ProgressTracker task ID for SSE


# ─────────────────────────────────────────────
# Opening scene generation result
# ─────────────────────────────────────────────

class OpeningSceneResult(BaseModel):
    """Persisted output from the dedicated opening-scene generation path."""
    opening_scene_text: str = Field(description="The generated prose")
    scene_summary: str = Field(default="", description="Short summary for memory/recap use")
    cast_used: list[str] = Field(default_factory=list, description="canonical_ids of NPCs that appeared")
    portrait_map: dict[str, str] = Field(default_factory=dict, description="display_name -> media URL")
    continuity_flags: list[str] = Field(default_factory=list, description="Continuity notes for the gameplay pipeline")
    scene_beats_emitted: list[str] = Field(default_factory=list)
    scene_mode_used: SceneMode | None = None
    schema_version: int = Field(default=1)
