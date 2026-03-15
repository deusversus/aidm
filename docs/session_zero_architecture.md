# Session Zero Architecture

## Overview

Session Zero (SZ) is the character creation phase that precedes gameplay. The player
describes their character through conversation with the SZ agent, which guides them
through media selection, character identity, backstory, and mechanical setup.

At handoff, all accumulated SZ data is compiled into an `OpeningStatePackage` and
transferred to the gameplay systems (Director, Key Animator, MemoryStore).

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (web/js/app.js)                               │
│  POST /session/{id}/turn → SessionZeroResponse          │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│  Route Handler (api/routes/game/session_zero.py)        │
│  • Feature flag routing                                 │
│  • Pipeline singleton management                        │
│  • Handoff orchestration                                │
└──────────┬──────────────────────────┬───────────────────┘
           │ ORCHESTRATOR_ENABLED     │ Legacy
           │                          │
┌──────────▼──────────┐    ┌──────────▼──────────┐
│  SessionZeroPipeline│    │  SessionZeroAgent   │
│  (per-turn orch.)   │    │  (monolithic)       │
│                     │    │                     │
│  1. SZExtractor     │    │  Single LLM call    │
│  2. SZEntityResolver│    │  → detected_info    │
│  3. SZGapAnalyzer   │    │  → apply to draft   │
│  4. Conductor (SZA) │    │                     │
└──────────┬──────────┘    └─────────────────────┘
           │
┌──────────▼──────────┐
│  Memory Integration │
│  • write_provisional│  ← mid-SZ (per turn)
│  • write_authoritat.│  ← handoff (once)
└─────────────────────┘
```

## Per-Turn Pipeline (when `SESSION_ZERO_ORCHESTRATOR_ENABLED`)

Each player turn triggers:

1. **Extraction** — `SZExtractorAgent.extract_chunk()` on latest messages + context window.
   Produces `ExtractionPassOutput` with entities, facts, relationships.

2. **Entity Resolution** — `SZEntityResolverAgent.resolve()` merging all extraction passes
   into a canonical entity graph (`EntityResolutionOutput`).

3. **Gap Analysis** — `SZGapAnalyzerAgent.analyze()` identifying missing info, contradictions,
   and recommending follow-up questions (`GapAnalysisOutput`).

4. **Conductor** — `SessionZeroAgent.process_turn(gap_context=...)` with gap analysis
   injected into the prompt so it picks smarter follow-ups.

5. **Persistence** — Entity graph + pipeline metadata saved to `session_zero_artifacts`
   for crash recovery.

Each step is try/excepted so individual failures don't crash the turn:
- Extraction failure → conductor responds without new data
- Resolver failure → prior entity graph preserved
- Gap analyzer failure → conductor runs without gap context
- Conductor failure → exception propagates (user sees error)

## Handoff Sequence

When the player confirms readiness (`ready_for_gameplay=True`), the handoff runs:

1. **Settings sync** — Profile resolution, campaign ID creation
2. **Memory indexing** — SZ transcript indexed to MemoryStore
3. **Reset orchestrator** — Fresh gameplay singleton
4. **Flush pending NPCs** — NPCs stashed before campaign existed
5. **Handoff Compiler** — 4-pass compilation:
   - Extract → Resolve → Gap Analyze → Assemble `OpeningStatePackage`
6. **Authoritative memory write** — `write_authoritative()` maps package to typed memories
7. **Pipeline cleanup** — `_clear_pipeline()` removes SZ pipeline singleton
8. **Character update** — Draft fields → gameplay character state
9. **World state** — Location, canonicality settings → orchestrator
10. **Director startup** — Consumes `OpeningStatePackage`
11. **Opening scene** — Generated via dedicated path or synthetic turn

## Memory Integration

### Provisional writes (mid-SZ)

Called per turn when the pipeline is active. Writes:
- High-confidence facts (≥0.9 or backstory_beat/world_rule) → `memory_type="session_zero"`
- PC relationships (≥0.7 confidence, `startswith("pc_")`) → `memory_type="character_state"`

All provisional writes flagged `['session_zero_in_progress']`.

### Authoritative writes (at handoff)

Called once after the compiler produces the `OpeningStatePackage`. Overwrites provisional
memories with canonical, distilled data:

| Source                    | memory_type      | decay_rate |
|---------------------------|------------------|------------|
| PC identity/backstory     | `core`           | `none`     |
| NPC cast members          | `character_state`| `none`     |
| Canonical relationships   | `relationship`   | `none`     |
| World/setting facts       | `session_zero`   | `none`     |
| Quest/thread seeds        | `quest`          | `normal`   |
| Location facts            | `location`       | `slow`     |

## Artifact Lifecycle

Artifacts are versioned, immutable records in `session_zero_artifacts`:

- **`sz_entity_graph`** — Persisted after each pipeline turn. Used for crash recovery.
- **`sz_pipeline_meta`** — Turn count and extraction pass count. Restored on restart.
- **`opening_state_package`** — Final handoff contract. Consumed by Director/KA.
- **`gap_analysis`** — Unresolved items at handoff time.

Artifacts are deduped by content hash — if content hasn't changed, no new version is
created.

## Feature Flags

| Flag | Purpose | Default | Removal Condition |
|------|---------|---------|-------------------|
| `SESSION_ZERO_COMPILER_ENABLED` | Handoff compiler runs at SZ→gameplay | False | Stable in production (>50 handoffs) |
| `SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED` | Dedicated opening scene path | False | Default for 2+ weeks, zero failures |
| `SESSION_ZERO_ORCHESTRATOR_ENABLED` | Per-turn extraction pipeline | False | Stable in production; gates detected_info removal |
| `SESSION_ZERO_RESEARCH_ENABLED` | Wiki/world research during SZ | False | Opt-in; remove when research is always beneficial |

## Observability

Langfuse spans are logged for each pipeline step when Langfuse is configured:
- `sz_pipeline.extraction` — entity/fact/relationship counts
- `sz_pipeline.entity_resolution` — canonical entity count, merges, aliases
- `sz_pipeline.gap_analysis` — handoff_safe, unresolved count, top follow-ups
- `sz_pipeline.conductor` — phase, readiness
- `sz_handoff.authoritative_memory` — memories written count

## Key Files

| File | Purpose |
|------|---------|
| `src/core/session_zero_pipeline.py` | Per-turn orchestration pipeline |
| `src/core/session_zero_memory.py` | Provisional + authoritative memory writes |
| `src/core/session_zero_compiler.py` | Handoff compiler (4-pass) |
| `src/agents/session_zero.py` | Conductor agent (monolithic SZ agent) |
| `src/agents/sz_extractor.py` | Extraction agent |
| `src/agents/sz_entity_resolver.py` | Entity resolution agent |
| `src/agents/sz_gap_analyzer.py` | Gap analysis agent |
| `src/agents/sz_handoff.py` | Handoff assembly agent |
| `src/agents/session_zero_schemas.py` | All structured schemas |
| `src/db/session_zero_artifacts.py` | Artifact persistence |
| `api/routes/game/session_zero.py` | Route handler + handoff |
| `src/config.py` | Feature flags |
