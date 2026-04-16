# Session Zero (SZ) Implementation Audit Report

## Executive Summary

The Session Zero system is in **Stage 2-3 of the 5-stage upgrade plan** outlined in `sz_upgrade_plan.md`:

- ✅ **COMPLETE**: Handoff Compiler infrastructure (4-pass pipeline, artifact persistence)
- ✅ **COMPLETE**: OpeningStatePackage schema and models
- ✅ **COMPLETE**: DatabaseModels (SessionZeroRun, SessionZeroArtifact)
- ✅ **COMPLETE**: run_director_startup() and generate_opening_scene() in Orchestrator
- ⚠️ **PARTIAL**: Frontend integration (basic handoff detection exists)
- ❌ **MISSING**: Session Zero Orchestrator rewrite (turn-by-turn extraction/gap-analysis)
- ❌ **MISSING**: Comprehensive test coverage for M2-M4 milestones

---

## 1. src/core/session_zero_compiler.py

**Status**: ✅ Fully Implemented

### Classes & Functions

```python
class HandoffCompiler:
    """Main entry point for the 4-pass compilation pipeline."""
    
    def __init__(
        self,
        session_id: str,
        messages: list[dict],
        character_draft: dict,
        campaign_id: int | None = None,
        profile_context: str = "",
        tone_composition: dict | None = None,
        run_type: str = CompilerRunType.HANDOFF_COMPILE,
    )
    
    async def run() -> HandoffCompilerResult
    
    # Static helpers:
    @staticmethod
    def load_active_package(session_id: str) -> OpeningStatePackage | None
    
    @staticmethod
    def load_active_gap_analysis(session_id: str) -> GapAnalysisOutput | None

class CompilerContext:
    """Working state accumulated across all 4 passes."""
    session_id: str
    campaign_id: int | None
    messages: list[dict]
    character_draft: dict
    profile_context: str
    tone_composition: dict
    
    extraction_passes: list[ExtractionPassOutput]
    entity_resolution: EntityResolutionOutput | None
    gap_analysis: GapAnalysisOutput | None
    opening_package: OpeningStatePackage | None
    checkpoints: list[CompilerCheckpoint]
    
    transcript_hash: str
    draft_hash: str
    
    def aggregate_opening_cues() -> list[OpeningSceneCue]
    def extraction_stats() -> dict
```

### What It Does

The compiler orchestrates a **4-pass pipeline** that transforms Session Zero transcript → production-ready opening-state briefing:

| Pass | Agent | Input | Output | Purpose |
|------|-------|-------|--------|---------|
| 1 | SZExtractorAgent | Transcript chunks (20 msg/chunk) | ExtractionPassOutput[] | Extract entities, relationships, facts, opening cues |
| 2 | SZEntityResolverAgent | Extraction passes + draft | EntityResolutionOutput | Deduplicate, merge, canonicalize entity graph |
| 3 | SZGapAnalyzerAgent | Entity graph + extractions | GapAnalysisOutput | Identify contradictions, unresolved items, handoff safety |
| 4 | SZHandoffAgent | Full context + gap analysis | OpeningStatePackage | Assemble final briefing for Director/KA |

### Key Artifacts Produced

**OpeningStatePackage** (primary):
- `package_metadata`: session_id, campaign_id, hashes, version, created_at
- `readiness`: handoff_status, blocking_issues, warnings
- `player_character`: name, concept, appearance, abilities, goals, relationships, backstory
- `opening_situation`: location, immediate_situation, scene_question, what_is_happening_now
- `opening_cast`: required_present, optional_present, portrait_priority
- `world_context`: location_description, setting_truths, local_dangers
- `faction_context`: relevant_factions, alignment_map
- `active_threads`: quests_or_hooks, foreshadowing_targets
- `canon_rules`: timeline_mode, canon_cast_mode, event_fidelity
- `tone_and_composition`: composition_name, tension_source, narrative_focus
- `director_inputs`: arc_seed_candidates, narrative_risks
- `animation_inputs`: scene_mode, required_beats, emotional_target
- `uncertainties`: known_unknowns, contradictions, safe_assumptions
- `hard_constraints`: list[str] - non-negotiable facts

**EntityResolutionOutput**:
- `canonical_entities`: dict[canonical_id -> CanonicalEntity]
- `merges_performed`: list[MergeHistoryEntry]
- `conflict_map`: tracks unresolved entity conflicts

**GapAnalysisOutput**:
- `handoff_safe`: bool - whether handoff is safe to proceed
- `unresolved_items`: list[UnresolvedItem] with category, priority, candidate_followup
- `contradictions`: list[Contradiction]
- `blocking_issues`: list[str] - facts that block safe handoff
- `warnings`: list[str] - non-blocking issues

### Pipeline Flow in run()

```
1. Initialize ProgressTracker (10 steps)
2. Pass 1: _run_extraction_pass()
   - Chunk transcript by 20 messages
   - Call extractor.extract_chunk() per chunk
   - Aggregate canonical IDs to avoid re-extraction
   - Create checkpoint
3. Pass 2: _run_entity_resolution_pass()
   - Merge extracted candidates into canonical entities
   - Track merges and deduplication
   - Create checkpoint
4. Pass 3: _run_gap_analysis_pass()
   - Identify missing critical fields
   - Detect contradictions
   - Set handoff_safe flag
   - Create checkpoint (note: if blocked, next_step="BLOCKED")
5. Pass 4: _run_handoff_assembly_pass()
   - Assemble OpeningStatePackage
   - Stamp metadata (session_id, campaign_id, created_at, hashes)
   - Create checkpoint
6. Persist all artifacts in single transaction via _persist_artifacts()
   - Write SessionZeroArtifacts (opening_state_package, entity_graph, gap_analysis)
   - Write SessionZeroRun with counters
   - Expunge from DB session to keep objects alive post-commit
7. Return HandoffCompilerResult
```

### Outputs Returned

```python
class HandoffCompilerResult(BaseModel):
    success: bool
    opening_state_package: OpeningStatePackage | None
    entity_graph: EntityResolutionOutput | None
    gap_analysis: GapAnalysisOutput | None
    checkpoints: list[CompilerCheckpoint]
    artifact_version: int | None
    run_id: int | None
    warnings: list[str] = []
    compiler_task_id: str | None  # SSE task ID for progress
    error: str | None = None
```

### Opening State Package Structure

**Minimal Valid Package** (from test):
- session_id, campaign_id
- player_character with name and concept
- opening_situation with starting_location
- readiness.handoff_status = "opening_package_ready"

**Full Structure** (ideal):
```
OpeningStatePackage
├── package_metadata (session_id, campaign_id, version, created_at, hashes)
├── readiness (handoff_status, blocking_issues, warnings)
├── player_character (full brief with appearance, goals, relationships)
├── opening_situation (WHERE, WHEN, WHAT, WHY - the opening scene contract)
├── opening_cast (NPCs, portrait priorities, entry constraints)
├── world_context (location_desc, setting_truths, dangers, opportunities)
├── faction_context (relevant factions, alignment, hidden/visible pressure)
├── active_threads (hooks to surface, foreshadowing targets, mysteries)
├── canon_rules (timeline_mode, canon_cast_mode, event_fidelity)
├── tone_and_composition (narrative style, tension, focus)
├── director_inputs (arc seeds, narrative risks, first-arc scope)
├── animation_inputs (scene mode, required beats, emotional target)
├── hard_constraints (non-negotiable facts Director/KA must preserve)
├── soft_targets (quality guidance without brittleness)
└── uncertainties (known unknowns, contradictions, safe assumptions)
```

---

## 2. src/core/orchestrator.py

**Status**: ✅ Mostly Complete for M2-M4

### Relevant Methods

```python
class Orchestrator(TurnPipelineMixin, BackgroundMixin):
    
    async def run_director_startup(
        self,
        session_zero_summary: str,
        character_name: str = "Unknown",
        character_concept: str = "",
        starting_location: str = "Unknown",
        power_tier: str | None = None,
        tension_source: str | None = None,
        power_expression: str | None = None,
        narrative_focus: str | None = None,
        composition_name: str | None = None,
        timeline_mode: str | None = None,
        canon_cast_mode: str | None = None,
        event_fidelity: str | None = None,
        opening_state_package=None,  # ← NEW (M2 requirement)
    ) -> None:
        """Run Director startup briefing.
        
        Called once when Session Zero completes, before first gameplay turn.
        Creates arc plan, foreshadowing, voice guidance.
        Persists to Campaign Bible planning_data.
        """
    
    async def generate_opening_scene(
        self,
        opening_state_package: "Any | None" = None,
        recent_messages: list | None = None,
    ) -> tuple[str, dict[str, str]]:
        """Generate pilot episode opening scene via dedicated KA pathway.
        
        Uses compiled OpeningStatePackage + Director output from bible.
        Returns (narrative, portrait_map).
        Raises ValueError if package is None.
        
        This is the M3 dedicated opening-scene pathway (not a gameplay turn).
        """
```

### Handoff Sequence Flow

Current flow in `api/routes/game/session_zero.py:_handle_gameplay_handoff()`:

```
1. SETTINGS & PROFILE RESOLUTION
   - Resolve profile_to_use (infer from media_reference if needed)
   - Update global settings (active_profile_id, active_session_id, active_campaign_id)
   - Sync to disk (settings.json)

2. MEMORY INDEXING
   - Call index_session_zero_to_memory(session, campaign_id)
   - Chunks transcript into vector store

3. RESET ORCHESTRATOR
   - reset_settings_store() — force reload from disk
   - reset_orchestrator() — destroy old singleton, will create fresh
   - get_orchestrator() — creates new Orchestrator with fresh profile + campaign_id
   - Initialize MemoryStore, StateManager, all agents

4. FLUSH PENDING NPCs
   - Replay NPCs queued during Session Zero (before campaign existed)
   - Trigger portrait generation if enabled

5. HANDOFF COMPILER (if Config.SESSION_ZERO_COMPILER_ENABLED)
   - Build profile_context string
   - Build tone_composition dict from draft
   - Create HandoffCompiler with session_id, messages, character_draft, campaign_id
   - Run compiler.run() → HandoffCompilerResult
   - Extract _compiler_package (OpeningStatePackage)
   - Build _handoff_status ("complete" or "degraded" based on gap.handoff_safe)
   - Extract _compiler_warnings and build _gap_follow_up_prompt if gaps exist

6. WORLD STATE & MEMORY
   - Update world_state: location, situation, arc_phase, tension_level
   - Sync canonicality fields (timeline_mode, canon_cast_mode, event_fidelity)
   - Inject Session Zero context into memory store

7. DIRECTOR STARTUP (unconditional)
   - Build _build_session_zero_summary(session, draft) → string
   - Call orchestrator.run_director_startup(
       session_zero_summary=s0_summary,
       [scalar fields: name, concept, location, etc.],
       opening_state_package=_compiler_package  # ← M2 requirement now met
   )
   - Director creates arc plan, foreshadowing plan, voice guidance
   - Persists to Campaign Bible planning_data

8. OPENING SCENE GENERATION
   If Config.SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED and _compiler_package is not None:
     - Call orchestrator.generate_opening_scene(
         opening_state_package=_compiler_package,
         recent_messages=session.messages[-10:]
       )
   Else (fallback):
     - Call orchestrator.process_turn(
         player_input="[opening scene — the story begins]",
         recent_messages=session.messages[-30:]
       )
   Save opening_narrative and portrait_map
   Add to session messages and persist

Return tuple:
  (opening_narrative, opening_portrait_map, _handoff_status, 
   _handoff_warnings, _gap_follow_up_prompt, _compiler_task_id,
   _compiler_artifact_version)
```

### What's Present vs Missing

**Present**:
- ✅ run_director_startup() accepts opening_state_package parameter
- ✅ generate_opening_scene() dedicated pathway exists
- ✅ Properly called AFTER reset_orchestrator() (lifecycle correct per 12.4.27)
- ✅ Returns proper tuple for API response

**Missing**:
- ❌ _build_session_zero_summary() is NOT in orchestrator.py (it's in session_mgmt.py)
- ❌ No explicit stage tracking (handoff_compiling → opening_package_ready → director_startup_ready → opening_scene_ready)
- ❌ No retry logic if opening-scene generation fails
- ⚠️ Fallback path still uses synthetic player input for opening scene (should eventually be deprecated)

---

## 3. src/db/models.py

**Status**: ✅ Complete

### SessionZeroRun Model

```python
class SessionZeroRun(Base):
    """Tracks a single HandoffCompiler execution (turn-level or handoff-level)."""
    
    __tablename__ = "session_zero_runs"
    
    id: Integer (PK)
    session_id: String(64) indexed
    run_type: String(30)  # 'turn_orchestration'|'handoff_compile'|'recovery_compile'
    status: String(20)    # 'running'|'completed'|'failed'|'cancelled'
    
    started_at: DateTime (default: utcnow)
    completed_at: DateTime | None
    error_message: Text | None
    
    # Pass-level counters (updated as passes complete)
    entities_extracted: Integer (default: 0)
    entities_resolved: Integer (default: 0)
    contradictions_found: Integer (default: 0)
    contradictions_resolved: Integer (default: 0)
    unresolved_items: Integer (default: 0)
    handoff_blocked: Boolean (default: False)
    
    # JSON checkpoints from each pass
    checkpoints_json: Text | None  # JSON array of CompilerCheckpoint
    
    # FK to primary artifact
    artifact_id: FK to SessionZeroArtifact | None
    
    artifact: relationship("SessionZeroArtifact", foreign_keys=[artifact_id])
    
    # Index: idx_sz_runs_session_status on (session_id, status)
```

### SessionZeroArtifact Model

```python
class SessionZeroArtifact(Base):
    """Versioned, immutable artifact produced by HandoffCompiler."""
    
    __tablename__ = "session_zero_artifacts"
    
    id: Integer (PK)
    session_id: String(64) indexed
    artifact_type: String(50)  # 'opening_state_package'|'entity_graph'|'gap_analysis'
    version: Integer (default: 1)
    status: String(20)  # 'draft'|'active'|'superseded'|'failed'
    
    # Content stored as JSON (Pydantic model .model_dump_json())
    content_json: Text
    
    # Provenance
    source_run_id: FK to SessionZeroRun | None
    transcript_hash: String(64) | None  # SHA-256 hash of messages list
    character_draft_hash: String(64) | None  # SHA-256 hash of draft dict
    
    # Timestamps
    created_at: DateTime (default: utcnow)
    superseded_at: DateTime | None
    
    source_run: relationship("SessionZeroRun", foreign_keys=[source_run_id])
    
    # Indexes:
    # idx_sz_artifact_session_type on (session_id, artifact_type)
    # idx_sz_artifact_session_status on (session_id, status)
    # Unique: (session_id, artifact_type, version)
```

### Transactional Behavior

**Locking Rule** (from 11.5.9 Rule 5):
All artifact writes for a single handoff must be done inside the **same DB transaction**. 
Caller is responsible for using `save_artifacts_transactional()` helper.

**Versioning**:
- If no active artifact exists for (session, type), writes version=1
- If content_hash matches existing active artifact exactly, returns unchanged (deduplication)
- Otherwise, marks old active as 'superseded', writes new active with version += 1
- Only one 'active' per (session, artifact_type) at any time

---

## 4. api/routes/game/session_zero.py & api/routes/game/models.py

**Status**: ✅ Partial to Complete

### SessionZeroResponse Model

```python
class SessionZeroResponse(BaseModel):
    """Response from Session Zero processing."""
    
    # Legacy fields (deprecated but kept for compatibility)
    response: str
    phase: str
    phase_complete: bool
    character_draft: dict[str, Any]
    session_id: str
    missing_requirements: list = []
    ready_for_gameplay: bool = False
    
    # Research progress (for long-running ops)
    research_task_id: str | None = None
    detected_info: dict[str, Any] | None = None
    
    # Disambiguation (for profile selection)
    disambiguation_options: list | None = None
    awaiting_disambiguation: bool = False
    
    # === HANDOFF FIELDS (M3-M4) ===
    opening_scene: str | None = None  # Server-side generated opening prose
    opening_portrait_map: dict[str, str] | None = None  # {"NPC Name": "/api/game/media/..."}
    
    # Compiler status fields
    handoff_status: str | None = None  # "complete"|"degraded"|"compiler_skipped"|"compiler_failed"
    handoff_warnings: list[str] = []  # Non-blocking gap warnings
    gap_follow_up_prompt: str | None = None  # Player follow-up if gaps need attention
    compiler_task_id: str | None = None  # SSE task ID for compiler progress
    compiler_artifact_version: int | None = None  # Version of persisted artifact
```

### Handoff Handler: _handle_gameplay_handoff()

**Location**: `api/routes/game/session_zero.py:66`

**Signature**:
```python
async def _handle_gameplay_handoff(session, session_id: str, result, agent) -> tuple:
```

**Returns**:
```python
(opening_narrative, opening_portrait_map, handoff_status, 
 handoff_warnings, gap_follow_up_prompt, compiler_task_id,
 compiler_artifact_version)
```

**Full sequence** (as documented above in Orchestrator section).

### Key Flags

- `Config.SESSION_ZERO_COMPILER_ENABLED` (default: False)
  - If True, runs HandoffCompiler during handoff
  - Produces opening_state_package artifact
  
- `Config.SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED` (default: False)
  - If True, uses dedicated orchestrator.generate_opening_scene() pathway
  - Falls back to synthetic player-input turn if False or if compiler disabled

---

## 5. tests/test_sz_compiler.py

**Status**: ⚠️ Partial (543 lines, basic scaffold)

### What's Tested

```python
class TestSessionZeroSchemas:
    def test_opening_state_package_defaults()  # ✅ Roundtrip serialization
    def test_handoff_compiler_result_fields()  # ✅ Result structure
    def test_gap_analysis_output()  # ✅ Gap analysis structure
    # ... more schema tests
```

### What's NOT Tested

- ❌ HandoffCompiler.run() end-to-end pipeline
- ❌ Each of the 4 passes (extraction, entity_resolution, gap_analysis, handoff_assembly)
- ❌ Artifact persistence and versioning
- ❌ Transactional behavior
- ❌ ProgressTracker integration
- ❌ MockLLMProvider scenarios
- ❌ _build_session_zero_summary() function
- ❌ orchestrator.run_director_startup() with opening_state_package
- ❌ orchestrator.generate_opening_scene() dedicated pathway
- ❌ SessionZeroResponse fields
- ❌ Handoff API endpoint behavior
- ❌ Frontend transition logic
- ❌ Config flag behavior

### Test Infrastructure Already Available

- MockLLMProvider (used in gameplay tests)
- In-memory SQLite fixtures
- pytest markers: `live`, `slow`, `skip`
- Session/CharacterDraft test helpers

---

## 6. web/js/app.js

**Status**: ⚠️ Partial (basic handoff detection)

### Handoff Handling in Frontend

**Transition Detection** (line ~309):
```javascript
const isHandoff = (result.phase || '').toLowerCase() === 'gameplay' || result.ready_for_gameplay;
```

**When Transitioning to Gameplay**:
1. Check `result.phase === 'gameplay'` OR `result.ready_for_gameplay === true`
2. If handoff:
   - Display opening_scene inline if available (line 339)
   - Show gap_follow_up_prompt if present (line 346)
   - Show handoff_warnings if degraded status (line 349)
   - Log compiler_task_id for SSE progress polling (line 358)
   - Suppress closing message from assistant

**Agent Settings**:
```javascript
sz_handoff: getAgentConfig('sz_handoff')  // line 721, 1111
```

### What's NOT Implemented

- ❌ Explicit staged progress display (compiling → opening_package_ready → director_startup_ready → opening_scene_ready)
- ❌ Polling for compiler progress via SSE (compiler_task_id is logged but not consumed)
- ❌ Retry UI for opening-scene failures
- ❌ Distinction between "package complete" and "opening scene ready"
- ⚠️ Still relies on phase check as primary gate (should check explicit status fields)

### Recommended Frontend Changes (per 12.4.23)

From upgrade plan:
- Don't transition to "normal gameplay input loop" until opening-scene generation is complete
- Use existing profile-generation progress UI pattern for handoff stages
- Frontend should monitor `handoff_status` field, not just `phase`

---

## 7. sz_upgrade_plan.md (Relevant Sections)

**Status**: ✅ Complete specification document

### Sections 12.4.19-12.4.28 (Director Startup & Opening Scene)

**12.4.19 Director Contract**:
- Expected input: `opening_state_package` + `profile` + optional model_override
- Expected outputs: arc_plan, initial_tension, foreshadowing_plan, scene_notes, voice guidance
- Output should be persisted and attached to artifact graph

**12.4.20 Key Animator Contract**:
- Dedicated method: `generate_opening_scene(opening_state_package, director_opening_plan, profile, ...)`
- Should be logged as separate operation, not hidden in generic turn
- Returns: scene_text, scene_summary, cast_used, portrait_map, continuity_flags, scene_beats

**12.4.22 Failure Semantics**:
- Staged status model: not_ready → handoff_compiling → opening_package_ready → director_startup_ready → opening_scene_generating → opening_scene_ready (or failed/blocked)
- If package compilation blocks, don't transition to gameplay
- If Director startup fails, don't pretend package is complete
- If KA fails, keep session in handoff-error state, don't silently transition

**12.4.23 Frontend/API Implications**:
- Required response fields: handoff_status, opening_package_status, director_startup_status, opening_scene_status, opening_scene, handoff_warnings, retryable_failure, progress_stage/message/percent
- Frontend rule: do not transition until opening-scene generation complete

**12.4.24 Observability Contract**:
- Traces: session_zero.handoff.compile_opening_package, .director_startup, .opening_scene_generation, .opening_scene_persist
- Metadata: package_version, package_readiness, Director_output_version, scene_gen_retries, degraded_vs_non_degraded, cast_count, unresolved_issue_count

**12.4.25 Persistence Contract**:
- Persist: opening_state_package, director_startup_plan, opening_scene_result, opening_scene_failure_report (when applicable)
- Ensures scene can be retried without rerunning prior passes

**12.4.26 Dedicated Opening-Scene Path Stance**:
- Should be treated as **intended runtime design**, not optional cleanup
- Current synthetic opening-turn path may remain as emergency fallback during rollout
- Remove after dedicated path stabilizes

**12.4.27 Orchestrator Singleton Lifecycle During Handoff**:
- Compiler should run **AFTER** reset_orchestrator() so it operates on same singleton that owns gameplay
- Compiler receives MemoryStore + StateManager as explicit dependencies
- Sequence:
  1. Settings sync, profile resolution, campaign ID resolution
  2. reset_orchestrator() → fresh singleton
  3. Memory indexing
  4. **Handoff Compiler** runs (reads transcript, produces artifacts)
  5. Compiler export to gameplay tables (transactional)
  6. Director startup
  7. Opening-scene generation

### Section 17.6 (Test Gates)

**Test Pyramid**:
- Layer A: fast unit tests (schemas, transforms, merge rules, status logic)
- Layer B: offline integration tests (transcript-to-artifact, persistence)
- Layer C: targeted contract tests (provider/model/config compatibility)
- Layer D: limited live tests (provider quirks, observability wiring)

**Required Fixture Taxonomy** (8 families):
1. F1 Minimal guided baseline (short structured answers, one protagonist)
2. F2 Dense freeform lore dump (many facts in one message)
3. F3 Multi-NPC burst (several NPCs introduced, overlapping roles)
4. F4 Canon divergence / alternate timeline
5. F5 Hybrid profile (multiple source influences)
6. F6 Custom profile / custom world
7. F7 Contradiction with later correction
8. F8 Ambiguous/orphan hooks

---

## 8. Summary: What's Implemented vs Missing

### IMPLEMENTED (M1-M2)

✅ **HandoffCompiler (4-pass pipeline)**
- SZExtractorAgent (chunked extraction)
- SZEntityResolverAgent (deduplication)
- SZGapAnalyzerAgent (contradiction detection, handoff safety)
- SZHandoffAgent (package assembly)
- ProgressTracker integration

✅ **OpeningStatePackage schema** (comprehensive)
- All sections defined
- Metadata, readiness, player_character, opening_situation (core)
- Cast, world_context, faction_context, active_threads, canon_rules, tone_and_composition (enrichment)
- Director/animation inputs, hard constraints, uncertainties

✅ **Database models & persistence**
- SessionZeroRun (tracks compilation execution)
- SessionZeroArtifact (versioned, immutable artifacts)
- Transactional batch-write helpers
- Content-hash deduplication
- Proper indexing and unique constraints

✅ **Orchestrator methods**
- run_director_startup(opening_state_package=...) ← accepts package
- generate_opening_scene(opening_state_package=...) ← dedicated pathway
- Proper lifecycle (post reset_orchestrator)

✅ **API response structure**
- SessionZeroResponse with handoff_status, handoff_warnings, gap_follow_up_prompt, compiler_task_id, compiler_artifact_version

✅ **Handoff sequence**
- Memory indexing
- Reset orchestrator
- Compiler invocation
- Director startup
- Opening scene generation (dedicated + fallback)
- Proper return tuple

### PARTIALLY IMPLEMENTED (M2-M3)

⚠️ **Frontend integration**
- Detects handoff transition (ready_for_gameplay)
- Displays opening_scene if provided
- Shows warnings and gap prompts
- Missing: staged progress display, SSE polling, explicit status gates

⚠️ **Config flags**
- SESSION_ZERO_COMPILER_ENABLED (exists, default False)
- SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED (exists, default False)
- Missing: MM2/M3/M4 feature gates for finer granularity

⚠️ **Observability**
- Compiler has ProgressTracker
- Missing: Langfuse traces per 12.4.24 spec

### MISSING (M3-M5)

❌ **Session Zero Orchestrator**
- Current SessionZeroAgent still top-level, not orchestrated
- No per-turn extraction/gap-analysis/follow-up logic
- No unresolved-items tracking during gameplay
- No iterative entity-graph building

❌ **Comprehensive Test Coverage**
- No tests for HandoffCompiler.run() end-to-end
- No tests for each 4-pass (only schemas tested)
- No artifact persistence/versioning tests
- No orchestrator.run_director_startup() + package tests
- No orchestrator.generate_opening_scene() tests
- No API endpoint handoff tests
- No fixture matrix (F1-F8)

❌ **Staged Status Pipeline**
- No explicit not_ready → compiling → package_ready → director_ready → scene_generating → scene_ready states
- No transition guards (e.g., don't start director if package failed)
- No retry logic if a stage fails

❌ **Enhanced Frontend**
- No progress-bar display for handoff stages
- No SSE polling for compiler progress
- No retry UI for failures
- Still relies on phase gate instead of explicit handoff_status

❌ **Production Readiness**
- No retry logic for transient failures
- No degraded-mode recovery strategies
- Limited observability (Langfuse wiring incomplete)
- No settings UI for new SZ agents (sz_handoff exposed but others not)

---

## 9. Ready-to-Test Checklist

Before writing comprehensive tests, you can verify:

1. ✅ HandoffCompiler instantiation and basic run()
   ```python
   compiler = HandoffCompiler(session_id, messages, character_draft, campaign_id)
   result = await compiler.run()
   assert result.success
   assert result.opening_state_package is not None
   assert result.artifact_version is not None
   ```

2. ✅ OpeningStatePackage serialization roundtrip (already has basic test)

3. ✅ Database persistence (SessionZeroRun + SessionZeroArtifact CRUD)

4. ⚠️ Orchestrator.run_director_startup() with package (no dedicated test yet)

5. ⚠️ Orchestrator.generate_opening_scene() with package (no dedicated test yet)

6. ❌ Full handoff endpoint integration test (missing)

7. ❌ Fixture matrix scenarios (F1-F8) (completely missing)

---

## 10. Recommended Implementation Order for Tests

1. **Unit tests** (fast, offline):
   - HandoffCompiler 4-pass pipeline with MockLLMProvider
   - Artifact versioning and deduplication logic
   - Gap analysis status logic
   - OpeningStatePackage constraint validation

2. **Integration tests** (offline with SQLite):
   - HandoffCompiler.run() end-to-end → artifact persistence
   - _build_session_zero_summary() function
   - orchestrator.run_director_startup() with + without package
   - orchestrator.generate_opening_scene() with package

3. **API contract tests**:
   - SessionZeroResponse field population
   - Handoff endpoint return values
   - Config flag behavior (compiler on/off, dedicated pathway on/off)

4. **Fixture-driven tests** (F1-F8 transcript scenarios):
   - Each fixture type through compiler pipeline
   - Validation of extraction, merging, gap detection per scenario

5. **Live provider tests** (marked with `live` tag):
   - Real provider behavior with structured outputs
   - Actual opening-scene generation
   - Observability wiring (Langfuse)

