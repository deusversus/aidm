# Session Zero Test Implementation Checklist

This checklist maps what tests need to be written to reach M2, M3, M4 milestones per `sz_upgrade_plan.md §17.6`.

---

## Phase 1: Unit Tests (Fast, Offline)

### 1.1 HandoffCompiler Pipeline
- [ ] `test_compiler_instantiation()` - create compiler with valid inputs
- [ ] `test_compiler_run_success()` - full pipeline returns success=True
- [ ] `test_compiler_produces_opening_state_package()` - result.opening_state_package is not None
- [ ] `test_compiler_produces_artifact_version()` - result.artifact_version is populated
- [ ] `test_compiler_progress_tracking()` - ProgressTracker emits correct phases
- [ ] `test_compiler_error_handling()` - compiler returns success=False + error on exception

### 1.2 Compiler Passes (with MockLLMProvider)
- [ ] `test_extraction_pass_chunk_size()` - respects 20-message chunk limit
- [ ] `test_extraction_pass_output()` - produces ExtractionPassOutput with entities, relationships, facts
- [ ] `test_entity_resolution_pass()` - merges candidates, tracks merges_performed
- [ ] `test_gap_analysis_pass_safe()` - sets handoff_safe=True when no blockers
- [ ] `test_gap_analysis_pass_blocked()` - sets handoff_safe=False + blocking_issues when gaps critical
- [ ] `test_handoff_assembly_pass()` - produces complete OpeningStatePackage

### 1.3 OpeningStatePackage Validation
- [ ] `test_package_minimal_valid()` - session_id, campaign_id, player_character, opening_situation
- [ ] `test_package_full_roundtrip()` - serialization/deserialization preserves all fields
- [ ] `test_package_metadata_stamping()` - created_at, hashes, version are set by compiler
- [ ] `test_package_readiness_status()` - handoff_status in HandoffStatus enum
- [ ] `test_package_hard_constraints()` - preserved through roundtrip
- [ ] `test_package_uncertainties()` - safe_assumptions captured from gap_analysis

### 1.4 Artifact Persistence
- [ ] `test_artifact_versioning_increment()` - version goes 1→2→3 on successive writes
- [ ] `test_artifact_content_deduplication()` - same content hash returns existing artifact
- [ ] `test_artifact_supersede_on_change()` - old artifact marked superseded when new written
- [ ] `test_artifact_only_one_active_per_type()` - query for active returns exactly one
- [ ] `test_artifact_transactional_write()` - multiple artifacts written as unit
- [ ] `test_run_record_linked_to_artifact()` - SessionZeroRun.artifact_id populated correctly

### 1.5 Gap Analysis & Contradiction Logic
- [ ] `test_unresolved_item_creation()` - gaps detected and UnresolvedItem created
- [ ] `test_unresolved_item_priority()` - identity gaps marked critical, world_lore marked low
- [ ] `test_contradiction_detection()` - conflicting facts flagged as Contradiction
- [ ] `test_contradiction_types()` - hard_conflict vs alias_conflict vs timeline_conflict
- [ ] `test_gap_follow_up_prompt_generation()` - critical gaps produce candidate_followup
- [ ] `test_safe_assumptions_captured()` - inferred facts recorded in uncertainties

---

## Phase 2: Integration Tests (Offline with SQLite)

### 2.1 Full Handoff Compiler End-to-End
- [ ] `test_handoff_compiler_with_dense_transcript()` - F2 lore dump scenario
- [ ] `test_handoff_compiler_with_multi_npc()` - F3 multi-NPC scenario
- [ ] `test_handoff_compiler_artifact_persistence()` - artifacts actually written to DB
- [ ] `test_handoff_compiler_recovery()` - re-running same session reuses artifact if content unchanged
- [ ] `test_handoff_compiler_with_contradictions()` - F7 contradiction scenario
- [ ] `test_handoff_compiler_with_custom_profile()` - F6 custom world scenario

### 2.2 Orchestrator Integration
- [ ] `test_run_director_startup_with_package()` - director receives + processes OpeningStatePackage
- [ ] `test_run_director_startup_without_package()` - fallback to _build_session_zero_summary works
- [ ] `test_run_director_startup_persists_to_bible()` - Director output in planning_data
- [ ] `test_generate_opening_scene_with_package()` - generates narrative + portrait_map
- [ ] `test_generate_opening_scene_without_package()` - raises ValueError
- [ ] `test_generate_opening_scene_uses_director_output()` - director notes inform scene

### 2.3 Memory & State Synchronization
- [ ] `test_session_zero_memory_indexing()` - transcript chunks vectorized + stored
- [ ] `test_world_state_updated_from_package()` - location, situation, arc_phase set correctly
- [ ] `test_canonicality_fields_synced()` - timeline_mode, canon_cast_mode, event_fidelity copied
- [ ] `test_pending_npc_flush_on_handoff()` - NPCs queued before campaign created are replayed

### 2.4 _build_session_zero_summary()
- [ ] `test_build_summary_includes_character()` - name, concept, backstory present
- [ ] `test_build_summary_includes_world()` - media_reference, starting_location present
- [ ] `test_build_summary_includes_op_mode()` - OP mode fields if enabled
- [ ] `test_build_summary_recent_messages()` - last 6 messages captured
- [ ] `test_build_summary_truncation()` - long fields truncated to safe length

---

## Phase 3: API Contract Tests

### 3.1 SessionZeroResponse Fields
- [ ] `test_response_opening_scene_populated()` - opening_scene is str when available
- [ ] `test_response_opening_portrait_map_populated()` - portrait_map is dict[str, str]
- [ ] `test_response_handoff_status_field()` - one of complete/degraded/compiler_skipped/compiler_failed
- [ ] `test_response_handoff_warnings_list()` - list of non-blocking warnings
- [ ] `test_response_gap_follow_up_prompt()` - populated if critical gaps exist
- [ ] `test_response_compiler_task_id()` - SSE task ID when compiler ran
- [ ] `test_response_compiler_artifact_version()` - integer version or None

### 3.2 Handoff Endpoint Behavior
- [ ] `test_handoff_success_path()` - ready_for_gameplay=True, phase=gameplay
- [ ] `test_handoff_with_compiler()` - CONFIG.SESSION_ZERO_COMPILER_ENABLED=True
- [ ] `test_handoff_without_compiler()` - CONFIG.SESSION_ZERO_COMPILER_ENABLED=False
- [ ] `test_handoff_dedicated_opening_scene()` - CONFIG.SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED=True
- [ ] `test_handoff_fallback_opening_scene()` - fallback to synthetic turn when disabled
- [ ] `test_handoff_compiler_error_nonfatal()` - compiler failure doesn't block handoff

### 3.3 Config Flag Behavior
- [ ] `test_config_compiler_on_off()` - both paths tested
- [ ] `test_config_dedicated_scene_on_off()` - both paths tested
- [ ] `test_config_orchestrator_not_yet_on()` - verify flag exists but unused
- [ ] `test_config_env_var_loading()` - SESSION_ZERO_* read from environment

---

## Phase 4: Fixture-Driven Scenario Tests (F1-F8)

### 4.1 Minimal Baseline (F1)
- [ ] `test_f1_minimal_guided_flow()` - short answers, happy path succeeds
- [ ] `test_f1_extraction_modest()` - ~10-20 entities extracted
- [ ] `test_f1_no_major_gaps()` - handoff_safe=True
- [ ] `test_f1_regression_test()` - current system still works with upgrade

### 4.2 Dense Freeform (F2)
- [ ] `test_f2_single_long_message_extraction()` - single dense message parsed correctly
- [ ] `test_f2_orphan_fact_capture()` - facts not naturally attached are preserved
- [ ] `test_f2_multi_npc_in_narrative()` - NPCs within prose extracted
- [ ] `test_f2_unresolved_items_created()` - ambiguous references generate gaps

### 4.3 Multi-NPC Burst (F3)
- [ ] `test_f3_npc_deduplication()` - aliases recognized + merged
- [ ] `test_f3_relationship_extraction()` - NPC-NPC relationships captured
- [ ] `test_f3_cast_prioritization()` - most-important NPCs in portrait_priority
- [ ] `test_f3_contradictions_if_conflicting()` - conflicting descriptions flagged

### 4.4 Canon Divergence (F4)
- [ ] `test_f4_timeline_mode_captured()` - timeline_mode="alternate_timeline"
- [ ] `test_f4_divergence_rules_extracted()` - accepted_divergences populated
- [ ] `test_f4_forbidden_contradictions()` - canon constraints preserved
- [ ] `test_f4_package_canon_rules_complete()` - full CanonRules object

### 4.5 Hybrid Profile (F5)
- [ ] `test_f5_hybrid_lore_synthesis()` - multiple sources merged coherently
- [ ] `test_f5_conflicting_assumptions()` - contradictions between sources flagged
- [ ] `test_f5_explicit_resolution_honored()` - player choices respected over inferred
- [ ] `test_f5_hybrid_profile_rules_applied()` - hybrid_profile_rules populated

### 4.6 Custom Profile (F6)
- [ ] `test_f6_no_overplayed_canon()` - system doesn't assume imported canon structure
- [ ] `test_f6_world_building_complete()` - custom world details fully captured
- [ ] `test_f6_safe_assumptions_documented()` - system notes what it guessed
- [ ] `test_f6_opening_package_sufficient()` - Director can work without canon scaffolding

### 4.7 Contradiction with Correction (F7)
- [ ] `test_f7_contradiction_detected()` - conflicting statements flagged
- [ ] `test_f7_later_statement_preferred()` - most recent version chosen as canonical
- [ ] `test_f7_earlier_version_preserved()` - old version available in uncertainty
- [ ] `test_f7_audit_trail()` - merge history tracks which versions were chosen

### 4.8 Ambiguous/Orphan Hooks (F8)
- [ ] `test_f8_unnamed_entity_stub()` - vague reference creates entity stub
- [ ] `test_f8_implicit_relationship_captured()` - unspoken obligation flagged
- [ ] `test_f8_unresolved_item_followup()` - candidate_followup suggests clarification
- [ ] `test_f8_safe_assumptions_for_orphans()` - system documents reasonable guesses

---

## Phase 5: Live Provider Tests (Marked with `@pytest.mark.live`)

### 5.1 Real LLM Integration
- [ ] `test_live_extractor_real_provider()` - actual extraction with real model
- [ ] `test_live_resolver_real_provider()` - real entity merging behavior
- [ ] `test_live_gap_analyzer_real_provider()` - real gap detection
- [ ] `test_live_handoff_assembly_real_provider()` - real package assembly
- [ ] `test_live_director_startup_real_provider()` - real arc planning
- [ ] `test_live_opening_scene_real_provider()` - real prose generation

### 5.2 Structured Output Behavior
- [ ] `test_live_extractor_structured_output()` - validates Pydantic schema
- [ ] `test_live_resolver_structured_output()` - validates merged entity structure
- [ ] `test_live_gap_analyzer_structured_output()` - validates gap analysis schema
- [ ] `test_live_handoff_structured_output()` - validates final package schema

### 5.3 Observability Wiring
- [ ] `test_live_langfuse_traces()` - compiler passes generate traces
- [ ] `test_live_langfuse_generations()` - LLM calls logged with token usage
- [ ] `test_live_langfuse_metadata()` - session_id, phase, pass_name in spans
- [ ] `test_live_langfuse_end_to_end()` - full trace tree visible in Langfuse

---

## Milestone Gates

### ✅ M2: Director Contract (Handoff Compiler Complete)
**When all these pass**:
- [x] All Phase 1 unit tests
- [x] Phase 2.1 (Handoff compiler E2E)
- [x] Phase 3.1-3.3 (API response + endpoint)
- Compiler produces valid opening_state_package
- Director receives + uses package
- run_director_startup() works with package input

### ✅ M3: Opening Scene (Dedicated Pathway Complete)
**When M2 + these pass**:
- [x] Phase 2.2 (Orchestrator with package)
- [x] Phase 2.4 (_build_session_zero_summary)
- Orchestrator.generate_opening_scene() works with package
- Fallback synthetic turn still available
- Proper lifecycle (post reset_orchestrator)

### ✅ M4: Integration & Testing (Comprehensive Test Coverage)
**When M2+M3 + these pass**:
- [x] All Phase 4 fixture tests (F1-F8)
- [x] Phase 5 live tests
- Degraded-mode behavior tested
- Retry logic tested
- All config flags tested

### Future: M5 (Session Zero Orchestrator)
- [ ] Per-turn extraction/gap-analysis
- [ ] Iterative entity-graph building
- [ ] Follow-up question prioritization
- [ ] (Not required for M2-M4)

---

## Quick Start

To get started writing tests today:

1. **Fastest way to unblock**: Write Phase 1.1-1.3 (compiler pipeline tests)
   - Use existing MockLLMProvider
   - Use in-memory SQLite
   - No live provider calls needed
   - ~100-150 lines per test file

2. **Next**: Phase 2.1-2.4 (full E2E integration)
   - Reuse Phase 1 mocks
   - Test database persistence
   - Test orchestrator integration
   - ~200-300 lines per test file

3. **Parallel**: Phase 3 (API contract)
   - Test endpoint response structure
   - Test config flags
   - ~50-100 lines per test file

4. **Later**: Phase 4 (fixture matrix)
   - Each F1-F8 scenario ~50-80 lines
   - Significant value for regression coverage

5. **Final**: Phase 5 (live provider)
   - Requires real API keys
   - Lower priority (covered by Phase 1-4)
   - ~30-50 lines per test file

---

## Running Tests

```bash
# All tests
pytest tests/test_sz_compiler.py -v

# Only fast tests (skip slow/live)
pytest tests/test_sz_compiler.py -v -m "not slow and not live"

# Only unit tests (Phase 1)
pytest tests/test_sz_compiler.py::TestSessionZeroSchemas -v

# Only fixture tests (Phase 4)
pytest tests/test_sz_compiler.py -k "test_f" -v

# Only live tests (Phase 5)
pytest tests/test_sz_compiler.py -v -m live
```

---

## Notes

- All tests should be in `tests/test_sz_compiler.py` (543 lines baseline exists)
- Use `MockLLMProvider` for determinism (see existing gameplay tests)
- Use in-memory SQLite for fast DB tests
- Preserve existing schema roundtrip tests
- Add `@pytest.mark.slow` for long-running tests
- Add `@pytest.mark.live` for provider-dependent tests
