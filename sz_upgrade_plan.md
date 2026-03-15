# Session Zero Upgrade Plan

---

## Implementation Status

Last updated: 2026-03-15

| Phase | Title | Status | Notes |
|-------|-------|--------|-------|
| 0 | Foundation and Contracts | ✅ DONE | DB schemas, artifact persistence, feature flags, `OpeningStatePackage` contract |
| 1 | Handoff Compiler MVP | ✅ DONE | 4-pass compiler (extraction → entity resolution → gap analysis → assembly), Director contract, opening scene path |
| 2 | Handoff Compiler Enrichment | ✅ DONE | `relationship_graph`, `contradictions_summary`, `orphan_facts`, `lore_synthesis_notes` compiler-stamped into package |
| 3 | Session Zero Orchestrator MVP | ✅ DONE | Per-turn pipeline, memory integration (provisional + authoritative), handoff reorg, 24 new tests |
| 4 | Session Zero Orchestrator Hardening | ⬜ NOT STARTED | Resumability, specific error recovery, trace coverage |
| 5 | Frontend/Handoff Semantics Cleanup | ✅ DONE | `opening_scene_status` field, `opening_scene_failed` UI branch, no more conflation of phase-change with scene-ready |
| 6 | Cleanup and Migration | ⬜ NOT STARTED | Remove compat shims, deprecate `detected_info`, remove feature flags |

### What is deployed and tested

- `HandoffCompiler` with 4 passes: `sz_extractor`, `sz_entity_resolver`, `sz_gap_analyzer`, `sz_handoff`
- `OpeningStatePackage` briefing contract consumed by Director + Key Animator — including Phase 2 enrichment fields
- `SESSION_ZERO_COMPILER_ENABLED` and `SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED` feature flags
- Artifact versioning + content-hash dedup in `session_zero_artifacts` / `session_zero_runs` tables
- `HandoffStatus` enum with full state machine
- `opening_scene_status` field in `SessionZeroResponse` + frontend handling
- `MockLLMProvider` with separate queues, underflow errors, type validation, error simulation, auto-teardown (in `tests/mock_llm.py`)
- 642 offline tests, ~5.5s, zero live LLM calls
- Committed: `b3e9a3f` (Phase 3 complete)

---

## 1. Problem Statement

AIDM's current Session Zero flow is strong when the player answers guided questions narrowly, but it weakens when the player provides dense, freeform worldbuilding, backstory, multiple NPCs, factions, locations, alternate-timeline lore, hybrid-profile lore, or custom-setting detail in large narrative chunks.

Today, Session Zero relies primarily on a single top-level `SessionZeroAgent` conversation loop plus a thin layer of detected-info application and selective research/handoff plumbing. That creates several failure modes:

- dense transcript content is only partially extracted into durable state
- entity-rich answers are under-normalized (duplicates, aliases, orphan facts, split facts)
- handoff can occur once hard requirements are minimally satisfied even if richer world state has not been fully compiled
- the opening-scene generation stack depends on partial state being coherent enough for Director/Key Animator
- Session Zero and handoff do not have the same degree of orchestration, instrumentation, iterative extraction, validation, or recovery that gameplay already has

The requested direction is **both** of the following:

1. redesign Session Zero itself into a more robust orchestrated workflow
2. redesign handoff into a multi-pass compiler/finalizer that catches, merges, enriches, and organizes anything Session Zero missed or left fragmented

This plan treats those as **two related but distinct workstreams** that should share infrastructure.

---

## 2. Strategic Goal

Build a next-generation Session Zero system with two layers:

- **Session Zero Orchestrator**: the turn-by-turn runtime that manages live conversation, extraction, unresolved-item tracking, selective follow-up, and incremental state writes
- **Handoff Compiler**: a transcript-wide, multi-pass compilation/finalization pipeline that runs at gameplay transition and produces a complete opening-state briefing package for Director + Key Animator

The design should preserve current user-facing behavior where possible, while dramatically improving extraction depth, coherence, observability, configuration flexibility, and recovery.

---

## 3. Non-Negotiable Constraints

These are required by the requested scope and current architecture:

### 3.1 Model/provider configuration

Every new first-class agent or first-class configurable pass must:

- respect explicit per-agent model configuration first
- fall back to the 3-tier base-model configuration second
- support all four current providers:
  - Google
  - Anthropic
  - OpenAI
  - GitHub Copilot
- be exposed in backend settings validation and frontend settings UI if it is a first-class configurable agent

### 3.2 Robust agent architecture

New important Session Zero agents/passes should follow the robustness standard already used by important gameplay agents:

- structured outputs where appropriate
- tool use / iterative research when beneficial
- retry-safe LLM invocation through existing provider infrastructure
- validator / repair compatibility
- logging + Langfuse instrumentation
- resumability / idempotency where long-running

### 3.3 Opening scene ownership

Session Zero should **not** replace Director/Key Animator as the opening-scene generator.

Instead, Session Zero + handoff should produce a **fully normalized opening-state briefing package** so Director and Key Animator can generate the opening scene from coherent state.

### 3.4 Backward-compatibility posture

The upgrade is large enough that it should be introduced incrementally behind feature flags and compatibility shims rather than as a flag day rewrite.

---

## 4. Current-State Summary (Relevant Surfaces)

This section is here so another engineer can start from current reality without rediscovering it.

### 4.1 Session Zero core runtime

Primary files:

- `src/core/session.py`
- `src/agents/session_zero.py`
- `src/agents/_session_zero_research.py`
- `api/routes/game/session_zero.py`
- `api/routes/game/session_mgmt.py`

Current phase order in `src/core/session.py`:

- `MEDIA_DETECTION`
- `NARRATIVE_CALIBRATION`
- `MECHANICAL_LOADING`
- `CONCEPT`
- `IDENTITY`
- `MECHANICAL_BUILD`
- `WORLD_INTEGRATION`
- `OPENING_SCENE`
- `GAMEPLAY`

Current hard requirements for handoff in `src/core/session.py`:

- `media_reference`
- `concept`
- `name`
- `backstory`
- `attributes`
- `starting_location`

Current top-level Session Zero flow in `api/routes/game/session_zero.py`:

- session validation
- early campaign creation
- `SessionZeroAgent.process_turn()`
- `apply_detected_info()`
- profile research/disambiguation/custom-profile logic
- incremental Session Zero state processing / memory indexing
- gameplay handoff
- Director startup
- server-side synthetic opening turn (`[opening scene — the story begins]`)

### 4.2 Handoff/opening-scene behavior

Current handoff includes:

- profile resolution
- character persistence
- world-state initialization
- Session Zero transcript memory injection
- director startup
- opening scene generation via `orchestrator.process_turn()`

Important current coupling:

- frontend transitions to gameplay when `phase === gameplay` or `ready_for_gameplay == true`
- server-side opening scene can fail while frontend still transitions
- opening scene currently depends on a synthetic “player input” seed

### 4.3 Agent/provider/config surfaces

Primary files:

- `src/agents/base.py`
- `src/llm/manager.py`
- `src/settings/models.py`
- `src/settings/store.py`
- `api/routes/settings.py`
- `web/index.html`
- `web/js/app.js`
- `web/js/api.js`

Current model fallback chain:

1. explicit per-agent config
2. tier default (`base_fast`, `base_thinking`, `base_creative`)
3. hardcoded last resort (`google/gemini-3-flash-preview`)

Current relevant configurable agents already exposed in settings include:

- `session_zero`
- `world_builder`
- `research`
- `profile_merge`
- `intent_resolution`
- `validator`
- `compactor`
- `production`
- `director`
- `key_animator`
- others used in gameplay

### 4.4 Observability/logging

Primary files:

- `src/observability.py`
- `src/core/_turn_pipeline.py`
- provider implementations under `src/llm/`

Current observability primitives:

- `start_trace()`
- `log_span()`
- `log_generation()`
- `end_trace()`
- `set_current_agent()` in `BaseAgent.call()`

Langfuse is now correctly container-addressed via `http://langfuse:3000`.

### 4.5 Current extraction/persistence surfaces

Primary files:

- `src/agents/session_zero.py`
- `src/context/memory.py`
- `src/db/session_store.py`
- `src/db/models.py`
- `src/db/_core.py`
- `src/agents/extraction_schemas.py`
- `src/agents/profile_merge.py`
- `src/agents/context_selector.py`

Useful current mechanisms to reuse:

- `CharacterDraft`
- `Session.phase_state`
- Session transcript in `session.messages`
- Session Zero incremental memory indexing
- profile research and merge logic
- validator repair logic
- extraction schemas and context merge/dedup patterns

---

## 5. Desired End State

At the end of this project, the system should behave like this:

### 5.1 During Session Zero

- Session Zero behaves like a robust orchestrated interview rather than a single-prompt conversation loop
- every turn can update durable structured state, unresolved-item state, and entity graphs
- rich player answers are broken into character facts, world facts, entities, relationships, obligations, hooks, and canon-divergence signals
- Session Zero selectively asks follow-up questions for what matters most rather than only following rigid phase prompts
- the system can tolerate dense freeform input and still extract/organize it coherently

### 5.2 At gameplay transition

- handoff does not merely check hard requirements and leave
- handoff performs transcript-wide multi-pass compilation and normalization
- duplicate NPCs/locations/factions are merged
- orphan facts are attached to the right entities or stored as unresolved facts
- canonicality and divergence are compiled explicitly
- custom/hybrid profile lore is synthesized into gameplay-usable state
- the opening-state package is complete enough for Director + Key Animator to confidently generate the opening scene

### 5.3 In configuration and operations

- new first-class SZ components appear in settings UI and use the standard agent config hierarchy
- new components work across all four providers
- all critical passes are observable in logs and Langfuse
- long-running work can be retried or resumed safely

---

## 6. Recommended Implementation Strategy

This is too large for a single rewrite. Implement in staged layers.

### 6.1 High-level sequencing

1. **Shared foundation work**
2. **Handoff Compiler first**
3. **Session Zero Orchestrator second**
4. **Tighten frontend/gameplay transition semantics**
5. **Hardening, observability, rollout, cleanup**

### 6.2 Why this order

Implementing the Handoff Compiler first delivers immediate value with lower risk:

- it improves current handoff quality even before Session Zero runtime is overhauled
- it creates shared schemas, entity graphs, normalization rules, and briefing-package contracts that the future orchestrator can also use
- it produces the durable “compiler” layer that Session Zero runtime can eventually feed more cleanly

Then the Session Zero Orchestrator can be built on top of those contracts instead of inventing its own incompatible state model.

---

## 7. Target Architecture

## 7.1 Layer A: Session Zero Orchestrator

This is the live, turn-by-turn system.

### 7.1.1 Responsibility

The Session Zero Orchestrator should own:

- phase-aware conversation policy
- transcript-aware extraction on every turn
- unresolved-items tracking
- follow-up question prioritization
- profile/canonicality research coordination
- incremental entity/state writes
- handoff readiness evaluation
- invoking the Handoff Compiler when transition is requested

### 7.1.2 Proposed shape

Keep the existing API surface (`SessionZeroAgent` entry point and existing routes), but internally evolve it into an orchestrated runtime.

Recommended pattern:

- keep `SessionZeroAgent` as the **top-level owner** for compatibility
- internally split responsibilities into subcomponents and passes
- only promote components to first-class configurable agents where the cost/benefit justifies new settings/UI surface

### 7.1.3 Proposed orchestrator components

#### A. `SessionZeroConductor` (top-level; can remain `session_zero` config key)

Purpose:

- decide how to respond this turn
- determine what question/follow-up should happen next
- consume compiler/extraction/gap-analysis outputs
- manage phase progression policy

Tier recommendation:

- thinking tier

Provider/model config:

- continue using `session_zero` key initially

Pattern:

- `BaseAgent` or `AgenticAgent` depending on whether tool-based turn research is adopted

#### B. `SessionZeroExtractorAgent` (new first-class agent)

Purpose:

- extract structured facts from current turn + local transcript window
- emit character, NPC, location, faction, quest, relationship, item, lore, timeline-divergence, and unresolved-fact candidates

Tier recommendation:

- thinking tier (because dense freeform extraction quality matters)

Why first-class:

- extraction quality is central and will likely need separate tuning from dialogue quality

#### C. `SessionZeroGapAnalyzerAgent` (new first-class agent)

Purpose:

- examine current compiled state and unresolved issues
- decide what information is still missing, ambiguous, contradictory, or high-value
- prioritize next question(s) and whether to advance/hold phase

Tier recommendation:

- thinking tier

#### D. `SessionZeroEntityResolverAgent` (new first-class agent)

Purpose:

- dedupe and merge entities and aliases incrementally during Session Zero
- decide whether “Commander Vale”, “Vale”, and “Captain Vale” are same person
- merge partial fact shards without losing provenance

Tier recommendation:

- thinking tier

#### E. `SessionZeroHandoffCompilerAgent` (new first-class agent)

Purpose:

- run transcript-wide multipass compilation at handoff
- produce normalized world state + opening-state package

Tier recommendation:

- thinking tier

#### F. Reused configurable agents

Prefer reusing existing agents where possible rather than minting too many new knobs:

- `research`
- `profile_merge`
- `intent_resolution`
- `world_builder`
- `wiki_scout`
- `validator`
- `compactor`
- `director`
- `key_animator`

### 7.1.4 Proposed internal helpers (not initially first-class configurable)

These can begin as helper modules/functions and be promoted later if needed:

- transcript chunker
- provenance tracker
- entity graph builder
- alias normalizer
- contradiction detector
- uncertainty scorer
- ingestion planner
- opening-brief assembler

---

## 7.2 Layer B: Handoff Compiler

This is the transcript-wide multi-pass finalizer.

### 7.2.1 Responsibility

The Handoff Compiler should:

- run after Session Zero claims readiness (or when player explicitly requests start)
- analyze the full Session Zero transcript plus current draft, profile data, research outputs, and already-persisted partial state
- recover missed facts
- normalize and merge fragmented entities
- resolve or flag contradictions
- enrich state where enough evidence exists
- synthesize gameplay-facing state and an opening-scene briefing package

### 7.2.2 Required inputs

- full Session Zero transcript (`session.messages`)
- `CharacterDraft`
- `session.phase_state`
- profile data / hybrid/custom profile artifacts
- already-written SQL entities (character/NPC/faction/location/etc. if any)
- Session Zero memories already indexed into vector store
- canonicality choices and unresolved decisions

### 7.2.3 Required outputs

- normalized character state
- normalized entity graph
- compiled canonicality/divergence package
- unresolved ambiguity list (if any)
- ingestion plan / applied writes summary
- opening-state briefing package for Director + Key Animator
- handoff diagnostics and provenance summary

### 7.2.4 Concrete extraction schema backbone

Define the extraction backbone explicitly in M0.

The compiler/extractor family should not rely on vague `detected_info`-style blobs once this project begins. It should emit concrete structured records such as:

- `entity_records`
- `relationship_records`
- `fact_records`
- `correction_or_retraction_records`
- `contradiction_records`
- `unresolved_items`
- `canonicality_signals`
- `opening_scene_cues`
- `provenance_refs`

Important design rule:

- use focused per-pass schemas that compose cleanly
- do **not** collapse the entire compiler into one giant monolithic extraction schema

### 7.2.5 Transcript handling stance

The compiler should consume the **full Session Zero transcript as data**, not just a recent-message tail window or a tiny stitched summary.

This is justified by current architecture, not by abstract fear about context windows:

- live Session Zero currently feeds the agent a raw last-30-message window
- Director startup currently relies on a lossy summary built from `CharacterDraft` plus the last few truncated messages
- the opening scene currently receives a raw recent-message window via the synthetic opening turn
- gameplay's compaction/working-memory pipeline does **not** currently protect the handoff stack

Therefore, the Handoff Compiler needs:

- full-transcript provenance
- chunk-aware extraction / normalization support
- a global reconciliation pass across extracted outputs

Chunk-aware handling is not primarily because the average Session Zero immediately blows the context window. It is primarily because transcript-wide extraction, correction handling, alias resolution, and contradiction preservation are structurally easier and more reliable when the compiler can reconcile chunk-level outputs.

### 7.2.6 `detected_info` migration stance

The current `SessionZeroOutput.detected_info` is a `dict[str, Any]` grab-bag emitted by the live `SessionZeroAgent` on every turn. It feeds `apply_detected_info()` which writes character draft fields, queues NPCs, and updates phase state.

This mechanism will coexist with the new structured extraction schemas during the compiler-first phase of this project.

Migration rules:

- `detected_info` **remains the live-turn extraction format** until the Session Zero Orchestrator rewrite (M6)
- the Handoff Compiler should treat `detected_info` accumulated in `CharacterDraft` and `phase_state` as **one input** alongside the raw transcript — not as the sole or authoritative source
- the compiler's own extraction schemas (Section 7.2.4) are the authoritative output format for compiled state
- when the Orchestrator rewrite lands (M6), it should emit structured extraction records directly, and `detected_info` should be deprecated and eventually removed
- during the transition, `apply_detected_info()` continues to run on every live turn as before — the compiler simply does a second, deeper pass over the full transcript at handoff time

This avoids a premature rewrite of the live Session Zero turn loop while still ensuring the compiler does not inherit `detected_info`'s limitations.

---

## 8. Exhaustive Handoff Compiler Responsibilities

This list should be treated as the default scope for the compiler unless there is a deliberate decision to defer an item.

### 8.1 Character synthesis

Compile and normalize:

- core identity
  - name
  - aliases/nicknames/codenames/titles
  - age
  - pronouns if inferred/explicit
- concept and high-level pitch
- backstory chronology
- origin events
- formative traumas / burdens / vows
- goals
  - short-term
  - long-term
  - hidden goals
- personality
- values
- fears
- quirks
- appearance
- visual tags
- reputation / public perception
- social role in setting
- power identity
  - power tier
  - signature ability
  - constraints / costs / side effects
  - combat style
  - hidden/latent powers
- mechanical state
  - attributes
  - resources
  - skills
  - inventory
  - starting gold/resources
  - stat presentation
  - OP/composition fields
- affiliations and known contacts
- unresolved personal tensions

### 8.2 NPC compilation

For every mentioned or implied NPC, compile and normalize:

- canonical name
- aliases/titles/epithets
- whether duplicate mentions refer to same NPC
- role relative to player
- faction affiliation
- disposition / affinity hypothesis
- appearance / visual tags
- personality
- goals
- secrets
- knowledge topics
- power tier / threat estimate
- first-scene relevance
- relationship to other NPCs
- whether the NPC is:
  - already known to protagonist
  - currently present
  - offscreen but important
  - deceased / missing / historical
- provenance/confidence for each major fact

### 8.3 Faction compilation

Compile and normalize:

- faction names and aliases
- hierarchy / chain of command
- player standing / membership / rank
- allied vs hostile vs neutral relationships
- faction-to-faction relationships
- active agendas
- secrets / hidden agendas
- current conflicts
- territorial or institutional control
- faction-linked NPCs
- opening-scene relevance

### 8.4 Location compilation

Compile and normalize:

- current starting location
- broader geography
- institutions / settlements / districts / dungeons / schools / ships / planets / guild halls
- location aliases / shortened references
- ownership/control
- danger profile
- cultural meaning
- traversal / access constraints
- relevant factions/NPCs at location
- what is immediately present for the opening scene

### 8.5 Quest / hook / thread compilation

Compile and normalize:

- explicit quests
- implied quests
- obligations / debts / jobs / promises
- revenge arcs
- rescue missions
- mysteries
- political or faction hooks
- personal stakes
- foreshadowing seeds
- unresolved threats
- ticking clocks
- opening-scene hooks vs later hooks

### 8.6 Relationship graph compilation

Compile and normalize:

- player ↔ NPC relationships
- NPC ↔ NPC relationships
- player ↔ faction relationships
- faction ↔ faction relationships
- mentor/student links
- family links
- rivalries
- obligations / debts / betrayals / secrets
- trust asymmetries
- hidden vs public relationships

### 8.7 World lore compilation

Compile and normalize:

- power system rules
- social/economic conditions
- institutions
- major recent events
- historical background
- technology/magic/cosmology rules
- taboo rules / cultural norms
- unusual custom lore introduced by player
- setting-specific terminology/glossary

### 8.8 Canonicality and divergence compilation

Especially important for `alternate timeline`, `custom`, and `hybrid` profile paths.

Compile and normalize:

- `timeline_mode`
- `canon_cast_mode`
- `event_fidelity`
- known divergences from canon
- replaced protagonists or displaced roles
- preserved canon anchors
- altered history
- canon events that already did or did not happen
- “must remain true” lore anchors
- “may diverge freely” zones
- hybrid-lore synthesis rules
- custom-lore rules that supersede imported canon

### 8.9 Hybrid/custom-profile synthesis

For hybrid and custom worlds, compiler should:

- combine lore from multiple source profiles into a coherent gameplay briefing
- extract cross-setting points of contact and friction
- identify contradictory assumptions between source worlds
- decide what has been explicitly resolved by the player vs what remains inferred
- generate a concise but durable “world operating manual” for gameplay
- preserve provenance so later agents know which facts are player-authored vs imported from research

### 8.10 Orphan fact handling

The compiler must explicitly detect and do something with facts that do not naturally attach to current schema.

Examples:

- rumors
- myths
- unresolved titles
- unnamed but important entities
- historical incidents
- looming threats without specific quest framing
- world constraints
- vibes/tone promises
- symbolic motifs

These should be one of:

- attached to an existing entity
- attached to a new entity stub
- written as freeform world facts
- written as unresolved/open questions for later clarification

### 8.11 Contradiction handling

Compiler should distinguish:

- hard contradictions
- perspective differences
- timeline uncertainty
- public vs private truth
- possible alias collisions
- unresolved ambiguity

For each contradiction it should:

- resolve automatically if high confidence
- otherwise preserve both versions with provenance/confidence
- optionally generate a follow-up clarification prompt if the contradiction blocks safe handoff

### 8.12 Opening-state package generation

The compiler should produce the final opening-state package containing at minimum:

- finalized player character brief
- cast list for opening scene
- current location and immediate physical situation
- active tensions/conflicts
- immediate objective or inciting momentum
- major lore constraints
- canonicality/divergence constraints
- must-include details
- must-avoid details
- unresolved but important ambiguities
- provenance/confidence note for shaky facts
- narrative focus / tone / composition directives from Session Zero

This package is the handoff target for Director + Key Animator.

---

## 9. Detailed Design for Session Zero Orchestrator

## 9.1 Runtime loop per turn

Recommended turn pipeline:

1. load session + transcript + current compiled state snapshot
2. run incremental extraction on new user input plus recent window
3. merge extracted facts into working entity graph
4. run gap analysis against hard requirements + rich-state goals + unresolved ambiguities
5. decide:
   - ask follow-up
   - confirm inferred facts
   - advance phase
   - trigger research/disambiguation
   - allow handoff
6. persist:
   - draft updates
   - entity graph updates
   - unresolved item queue
   - memory/indexing updates
   - observability spans
7. produce player-facing response

## 9.2 Session Zero should no longer rely solely on phase prompts

Phases should remain for UX structure, but the orchestrator should support:

- multi-phase skipping when player already supplied downstream data
- backfilling earlier omitted details without forcing rewind
- asking clarification for high-value missing data even if phase nominally advanced
- staying in a phase when rich extraction suggests more consolidation is needed

## 9.3 Proposed state tracked during Session Zero

Extend `Session.phase_state` and/or new Session Zero artifacts with:

- `entity_graph`
- `alias_map`
- `unresolved_items`
- `contradictions`
- `compiler_snapshots`
- `followup_candidates`
- `ingestion_log`
- `opening_brief_draft`
- `handoff_diagnostics`
- `canonicality_divergences`
- `pending_entities` (superset of current `pending_npcs`)
- `confidence_map`

## 9.4 Proposed question-selection policy

Question selection should prioritize:

1. blockers to safe handoff
2. contradictions that affect world coherence
3. facts necessary for opening-scene quality
4. facts necessary for major gameplay systems (NPCs, factions, quests, starting situation)
5. optional richness only after critical items are stable

That keeps Session Zero from over-asking while still capturing dense input correctly.

---

## 10. Proposed First-Class Agents and Config Strategy

To avoid settings/UI explosion while still meeting configurability requirements, use this rule:

- **first-class agent** if it has materially distinct reasoning behavior and likely benefits from separate tuning
- **helper/internal pass** if it can be deterministic code or a thin wrapper around another agent’s output

## 10.1 New first-class agents to add

Recommended additions:

- `sz_extractor`
- `sz_gap_analyzer`
- `sz_entity_resolver`
- `sz_handoff`

Retain:

- `session_zero` (as conductor)

Reuse existing:

- `research`
- `profile_merge`
- `intent_resolution`
- `world_builder`
- `wiki_scout`
- `validator`
- `compactor`
- `director`
- `key_animator`

## 10.2 Tier recommendations

Suggested initial tier placement:

- `session_zero` → thinking
- `sz_extractor` → thinking
- `sz_gap_analyzer` → thinking
- `sz_entity_resolver` → thinking
- `sz_handoff` → thinking

Potential future optimization:

- move certain subpasses to fast tier if quality proves sufficient and tool/validator support closes the gap

## 10.3 Settings/backend/frontend changes required

### Backend settings model

Update `src/settings/models.py`:

- add fields for:
  - `sz_extractor`
  - `sz_gap_analyzer`
  - `sz_entity_resolver`
  - `sz_handoff`
- add these agents to `THINKING_TIER` initially
- update descriptions

### Settings store

Update `src/settings/store.py`:

- tier fallback logic already generic; mostly tier membership changes needed
- confirm new agent names route correctly through fallback chain

### Settings API

Update `api/routes/settings.py`:

- extend `valid_agents` list for `PUT /api/settings/agent/{agent_name}`
- ensure validation endpoint includes warnings for new agents if misconfigured

### Frontend settings UI

Update `web/index.html`:

- add cards/controls for new agents in per-agent overrides section
- likely group under a new “Session Zero Orchestration” subsection

Update `web/js/app.js`:

- `loadSettings()` populate new agents
- `saveAdvancedSettings()` save new agents
- any helper label text / grouping updates

Update any related CSS if layout becomes too crowded.

## 10.4 Focused second pass: agent roster and settings/UI surface area

This section is the authoritative design for **which Session Zero components become user-configurable agents**, which remain internal helpers, and how the settings UI/API should expose them without turning into an unmaintainable wall of knobs.

### 10.4.1 Design rule: not every pass should become a configurable agent

Promote a Session Zero component to a first-class configurable agent only if all of the following are true:

- it performs materially distinct reasoning from other agents
- users are likely to benefit from tuning it independently
- it is likely to be long-lived rather than experimental
- it has a stable prompt/contract surface
- it is expensive or quality-sensitive enough that model choice matters

Keep a component as an internal helper if any of the following are true:

- it can be deterministic code
- it is a thin transform over another agent’s output
- it is likely to change shape frequently during development
- exposing it in settings would confuse most users

### 10.4.2 Proposed Session Zero roster: first-class configurable agents

These are the recommended first-class Session Zero-specific agents.

#### 1. `session_zero`

Role:

- top-level live-conversation conductor
- phase-aware dialogue management
- player-facing response generation
- decides what the next conversational move should feel like

Why configurable:

- this is the main “voice + reasoning” surface for Session Zero
- players may want a different provider/model balance here than in extraction/cleanup passes

Recommended tier:

- thinking

Frontend label:

- `Session Zero Conductor`

#### 2. `sz_extractor`

Role:

- transcript/turn extraction of structured facts
- emits candidate entities, world facts, relationship edges, canonicality facts, unresolved facts

Why configurable:

- extraction quality under dense freeform input is central to the upgrade
- users may want a stronger reasoning model here even if they keep dialogue cheaper

Recommended tier:

- thinking

Frontend label:

- `SZ Extractor`

#### 3. `sz_gap_analyzer`

Role:

- checks what is missing, contradictory, ambiguous, or insufficiently grounded
- prioritizes follow-up questions and decides whether handoff is safe

Why configurable:

- this is the core of “ask the right next question” behavior
- likely benefits from independent tuning from raw extraction

Recommended tier:

- thinking

Frontend label:

- `SZ Gap Analyzer`

#### 4. `sz_entity_resolver`

Role:

- dedupes entities
- resolves aliases
- merges partial shards
- determines whether multiple mentions are one entity or several

Why configurable:

- dense worldbuilding will live or die on merge quality
- this is a qualitatively different reasoning task from both dialogue and extraction

Recommended tier:

- thinking

Frontend label:

- `SZ Entity Resolver`

#### 5. `sz_handoff`

Role:

- transcript-wide multipass handoff compiler/finalizer
- builds normalized gameplay-ready state
- produces opening-state package

Why configurable:

- this is the final “world compiler” and will likely be high-value/high-cost
- users may want to spend more quality budget here than during normal turns

Recommended tier:

- thinking

Frontend label:

- `SZ Handoff Compiler`

### 10.4.3 Existing agents to keep reusable but not rename

These should remain first-class configurable, but should be **reused** by Session Zero rather than cloned into new Session Zero-specific variants unless proven necessary.

#### Keep and reuse as-is

- `research`
  - anime/IP research
  - custom/hybrid research support
- `profile_merge`
  - multi-profile merge logic
- `intent_resolution`
  - media/profile disambiguation and selection
- `world_builder`
  - validation/extraction precedent for world assertions
- `wiki_scout`
  - category/classification support for wiki-grounded retrieval
- `validator`
  - JSON repair / structural recovery
- `compactor`
  - transcript compaction / summary support
- `director`
  - opening-scene planning consumer
- `key_animator`
  - opening-scene prose consumer

#### Why not mint duplicates immediately

- duplicating these as `sz_research`, `sz_validator`, etc. would multiply settings/UI burden too early
- current architecture already supports reuse through existing provider/model plumbing
- initial implementation should bias toward a minimal number of new user-facing knobs

### 10.4.4 Components that should remain internal helpers initially

These should **not** be first-class settings/UI agents in the first implementation wave:

- transcript chunker
- provenance tracker
- contradiction scorer
- confidence scorer
- ingestion planner
- opening-brief assembler
- alias canonicalizer when deterministic rules suffice
- entity graph serializer/deserializer
- handoff diagnostics summarizer
- gameplay-export mapper

Rationale:

- these are implementation details
- they may evolve quickly
- exposing them now would increase UI sprawl without meaningful user benefit

### 10.4.5 Recommended rollout waves for agent exposure

#### Wave 1: minimum new surface area

Expose only:

- `session_zero` (existing)
- `sz_handoff`

Keep extractor/gap/entity resolver internal to the conductor/handoff implementation.

Use when:

- the team wants maximum flexibility with minimum settings/UI disruption

Tradeoff:

- fewer knobs, but less independent tuning

#### Wave 2: full explicit Session Zero surface (recommended default for this codebase)

Expose:

- `session_zero`
- `sz_extractor`
- `sz_gap_analyzer`
- `sz_entity_resolver`
- `sz_handoff`

Reuse existing:

- `research`
- `profile_merge`
- `intent_resolution`
- `validator`
- `world_builder`

This is the best balance of power and maintainability.

Because the existing settings UI already supports many agents behind tier defaults plus nested per-agent overrides, adding these distinct Session Zero components is consistent with current product patterns rather than a meaningful UX burden.

#### Wave 3: maximal exposure (not recommended initially)

Expose additional dedicated Session Zero variants of shared agents.

Not recommended unless profiling shows shared-agent reuse is materially insufficient.

### 10.4.6 Recommended tier placement matrix

Use this as the initial source of truth for tier assignment.

| Agent | Role | Recommended Tier | Why |
| --- | --- | --- | --- |
| `session_zero` | live conductor/dialogue | thinking | player-facing reasoning, broad context |
| `sz_extractor` | structured extraction | thinking | dense transcript extraction quality matters |
| `sz_gap_analyzer` | missing/ambiguity analysis | thinking | follow-up question quality is core |
| `sz_entity_resolver` | dedupe/merge/alias resolution | fast (overrideable) | structured merge/alias work is often pattern-heavy; promote to thinking when evaluations show quality need |
| `sz_handoff` | multipass handoff compiler | thinking | final world compilation should be high quality |
| `research` | source-profile research | thinking | already reasoning-heavy |
| `profile_merge` | hybrid merge | thinking | cross-profile synthesis |
| `intent_resolution` | disambiguation / profile resolution | thinking | multi-step decision logic |
| `world_builder` | validate/assert world facts | fast initially | can likely stay cheaper unless quality proves inadequate |
| `validator` | repair / validation | fast | reliability pass, not prose |
| `compactor` | transcript compression | fast | summarization utility |

### 10.4.7 Extended thinking policy for new Session Zero agents

Current `BaseAgent.call()` only enables extended thinking for a hardcoded list in `base.py`:

```python
EXTENDED_THINKING_AGENTS = ["director", "key_animator", "research", "combat"]
```

This is already inconsistent: `session_zero` is in `THINKING_TIER` but missing from the extended-thinking list.

This project should replace the hardcoded list with **tier-driven eligibility**.

Recommended change:

- remove the hardcoded `EXTENDED_THINKING_AGENTS` list from `BaseAgent.call()`
- replace it with: if the agent's `agent_name` is a member of `THINKING_TIER` or `CREATIVE_TIER`, it is eligible for extended thinking (when the global `settings.extended_thinking` toggle is enabled)
- this automatically covers all current and future thinking-tier agents without maintaining a second list

Implementation:

```python
# In BaseAgent.call():
if settings.extended_thinking:
    from src.settings.models import AgentSettings
    if self.agent_name in AgentSettings.THINKING_TIER or self.agent_name in AgentSettings.CREATIVE_TIER:
        use_extended_thinking = True
```

This gives correct behavior for all existing agents and automatically includes all new Session Zero agents placed in `THINKING_TIER`.

Retain the single global extended-thinking toggle. Do not add per-agent toggles unless there is a strong reason.

### 10.4.8 Backend settings model changes (detailed)

Update `src/settings/models.py`:

- add nullable `ModelConfig` fields:
  - `sz_extractor`
  - `sz_gap_analyzer`
  - `sz_entity_resolver`
  - `sz_handoff`
- add `sz_extractor`, `sz_gap_analyzer`, and `sz_handoff` to `THINKING_TIER`
- add `sz_entity_resolver` to `FAST_TIER` by default while preserving per-agent override support
- update docstrings/descriptions so they read clearly in the UI and API
- **fix stale docstring**: the `AgentSettings` class docstring currently lists `session_zero` under the FAST tier, but the actual `THINKING_TIER` frozenset already correctly includes it — update the docstring to match reality while making other changes

Recommended description text:

- `sz_extractor`: `Model for extracting rich structured facts from Session Zero transcript turns (thinking model preferred)`
- `sz_gap_analyzer`: `Model for identifying missing, ambiguous, or contradictory Session Zero state and selecting follow-up priorities (thinking model preferred)`
- `sz_entity_resolver`: `Model for deduplicating and merging Session Zero entities, aliases, and partial fact shards (fast model acceptable initially; thinking override supported)`
- `sz_handoff`: `Model for transcript-wide Session Zero handoff compilation and opening-state package generation (thinking model preferred)`

### 10.4.9 Settings store/fallback changes (detailed)

Update `src/settings/store.py`:

- existing `get_agent_model()` logic should work once tier membership is updated
- add tests proving new Session Zero agents:
  - respect explicit config first
  - fall back to `base_thinking`
  - fall back to hardcoded Google last resort if needed

Also add tests for:

- missing provider key → fallback to primary provider
- newly added Session Zero agents not silently treated as unknown agents

### 10.4.10 LLM manager/provider behavior requirements

No provider-specific custom path should be introduced for new Session Zero agents.

All new agents should call through the same stack:

- `BaseAgent` / `AgenticAgent`
- `LLMManager.get_provider_for_agent(agent_name)`
- provider-specific `complete_with_schema`, `complete`, or tool-calling loop

That guarantees:

- per-agent config
- tier fallback
- provider compatibility
- retry handling
- Langfuse generation logging

### 10.4.11 Settings API changes (detailed)

Update `api/routes/settings.py` in three places:

#### A. valid agent list

Add:

- `sz_extractor`
- `sz_gap_analyzer`
- `sz_entity_resolver`
- `sz_handoff`

#### B. validation warnings

Ensure `GET /api/settings/validate` produces the same provider-warning behavior for the new Session Zero agents.

#### C. settings save preservation behavior

Double-check that adding new `agent_models` fields does not interfere with preservation of:

- active profile id
- active session id
- active campaign id
- Copilot cached model list
- encrypted API keys

### 10.4.12 Frontend settings UI layout recommendation

The settings page should not add the new Session Zero agents as random loose cards.

Recommended layout:

#### Base Defaults

Keep as-is:

- Base Fast
- Base Thinking
- Base Creative

#### Per-Agent Overrides

Split into named subsections:

1. Core Gameplay
   - intent classifier
   - outcome judge
   - key animator
   - director
   - combat/progression/etc.

2. Research & Validation
   - research
   - scope
   - profile merge
   - validator
   - world builder
   - wiki scout
   - compactor

3. **Session Zero Orchestration**
   - session zero conductor
   - SZ extractor
   - SZ gap analyzer
   - SZ entity resolver
   - SZ handoff compiler
   - intent resolution

This keeps the SZ mental model grouped and discoverable.

### 10.4.13 Frontend settings UI control behavior

For each new Session Zero agent card, keep the same UX pattern as existing cards:

- provider dropdown
- model dropdown
- blank/“use base default” state for per-agent override

Do **not** add bespoke controls unless necessary.

Recommended labels/tooltips:

- `Session Zero Conductor`
  - `Live Session Zero conversation and phase guidance`
- `SZ Extractor`
  - `Extracts rich facts and entities from dense Session Zero answers`
- `SZ Gap Analyzer`
  - `Finds missing, contradictory, or ambiguous state and prioritizes follow-up`
- `SZ Entity Resolver`
  - `Merges duplicate NPCs, factions, locations, and aliases`
- `SZ Handoff Compiler`
  - `Final transcript-wide cleanup, enrichment, and opening-state compilation`

### 10.4.14 Frontend files that must be updated

#### `web/index.html`

Add:

- new cards/select elements for the new Session Zero agents
- new subsection heading/container for Session Zero orchestration

#### `web/js/app.js`

Update:

- `loadSettings()`
  - populate all new Session Zero agent controls
- `saveAdvancedSettings()`
  - include all new agent configs in `agent_models`
- any helper text / section toggles if new subgroups are introduced

#### `web/css/main.css`

Potential updates:

- settings grid spacing
- subsection heading spacing
- responsive layout for the larger per-agent section

### 10.4.15 Suggested DOM/control naming convention

To keep the UI implementation predictable, use the existing pattern.

Suggested IDs/data-agent values:

- provider select IDs:
  - `sz-extractor-provider`
  - `sz-gap-analyzer-provider`
  - `sz-entity-resolver-provider`
  - `sz-handoff-provider`
- model select IDs:
  - `sz-extractor-model`
  - `sz-gap-analyzer-model`
  - `sz-entity-resolver-model`
  - `sz-handoff-model`
- `data-agent` values should match backend agent names exactly:
  - `sz_extractor`
  - `sz_gap_analyzer`
  - `sz_entity_resolver`
  - `sz_handoff`

### 10.4.16 Avoiding UI/config sprawl

To keep the settings page sane:

- do not expose internal compiler helpers
- do not add per-agent extended-thinking toggles initially
- do not add separate Session Zero variants of reused agents until proven necessary
- do not create redundant “fast/thinking/creative” tiers specific to Session Zero

If the page still feels crowded, use one of these strategies:

1. collapsible “Session Zero Orchestration” subpanel
2. per-section descriptions instead of per-card long prose
3. advanced-only expander for the least commonly changed agents

### 10.4.17 API/UI compatibility checklist for each new first-class agent

For **every** newly exposed Session Zero agent, verify all of the following:

- field added to `AgentSettings`
- tier membership assigned
- settings store fallback covered by tests
- settings API `valid_agents` updated
- validation endpoint warning coverage confirmed
- frontend `loadSettings()` support added
- frontend `saveAdvancedSettings()` support added
- UI card exists in `web/index.html`
- provider/model dropdowns populate correctly
- provider fallback behavior still works if selected provider lacks API key
- Langfuse logs show the correct agent name

### 10.4.18 Recommended implementation order for roster/UI work

1. add new backend settings fields and tests
2. add settings API support and validation coverage
3. add UI cards and JS wiring
4. only then introduce new agent classes that consume those config keys

Reason:

- this prevents a half-integrated state where code references new agent names but settings/UI cannot configure them yet

### 10.4.19 Recommendation summary

If scope must be managed tightly, the recommended stance is:

- expose **five** Session Zero-specific first-class agents:
  - `session_zero`
  - `sz_extractor`
  - `sz_gap_analyzer`
  - `sz_entity_resolver`
  - `sz_handoff`
- reuse existing research/validator/world-building/profile/Director/KA agents
- keep internal compiler/plumbing helpers out of settings/UI

That gives enough precision to tune Session Zero meaningfully without turning settings into a science project.

---

## 11. Data Model and Persistence Plan

## 11.1 Keep using existing structures where possible

Preserve:

- `CharacterDraft` as primary live character accumulator
- `Session.messages` as canonical transcript
- `Session.phase_state` as short- to medium-lived orchestration state
- existing DB models for final gameplay state
- vector memory store for long-lived recall

## 11.2 Introduce durable compiler artifacts

Recommended new persistence surface: **Session Zero artifacts store**.

Implementation options:

### Option A (recommended first)

Add a new JSONB-backed SQL table for Session Zero artifacts, for example:

- `session_zero_artifacts`
  - `session_id`
  - `artifact_type`
  - `version`
  - `payload`
  - `created_at`
  - `updated_at`

Possible artifact types:

- `entity_graph`
- `compiler_snapshot`
- `opening_brief`
- `handoff_diagnostics`
- `canonicality_divergences`
- `unresolved_items`
- `ingestion_plan`

Why:

- survives server restart
- inspectable during debugging
- lets handoff compiler checkpoint multipass progress
- easier to diff and test than purely ephemeral `phase_state`

### Option B

Store everything inside `session_zero_states.data`

Why not ideal:

- becomes too monolithic
- hard to inspect and version
- harder to query selectively

## 11.3 Extend `CharacterDraft` only where it truly belongs

Use `CharacterDraft` for player-character-centered facts.

Do **not** overload it with the entire world graph.

Keep non-character world compilation in artifact/pipeline structures.

## 11.4 Entity graph model

Define explicit normalized schemas for:

- NPC node
- Faction node
- Location node
- Quest/thread node
- Item/resource node
- Relationship edge
- Canon-divergence record
- World-fact record
- Unresolved-fact record

Each should support:

- canonical ID
- aliases
- source transcript references
- confidence/provenance
- merge history
- gameplay export mapping

## 11.5 Focused third pass: persistence, artifact boundaries, and recovery semantics

This section is the authoritative design for **what data lives where**, how Session Zero artifacts should be versioned and checkpointed, and how the compiler/orchestrator should persist state without duplicating or corrupting gameplay tables.

### 11.5.1 Persistence design goals

The persistence design must satisfy all of these at once:

- survive server restarts cleanly
- support partial progress during Session Zero
- support transcript-wide compiler reruns without duplicate writes
- preserve provenance/debuggability
- allow handoff to be retried safely
- avoid overloading `CharacterDraft` into a giant world-state blob
- avoid prematurely mutating gameplay tables with low-confidence inferred data

### 11.5.2 Recommended storage layers and responsibilities

Use four distinct persistence layers, each with a clear boundary.

#### Layer 1: `Session` / `session_zero_states` blob

Current location:

- `src/core/session.py`
- `src/db/session_store.py`
- `session_zero_states` table

Recommended responsibility:

- canonical transcript (`messages`)
- current phase
- `CharacterDraft`
- lightweight phase/orchestration state needed for immediate continuation
- pointers/IDs to richer persisted artifacts

Should contain:

- `session_id`
- `phase`
- `character_draft`
- `messages`
- minimal `phase_state` for live flow
- artifact version pointers / last successful compiler run IDs

Should **not** become the long-term home for:

- full normalized entity graph
- repeated compiler snapshots
- large diagnostics histories
- replay logs for every pass

Reason:

- it is the live-resume blob, not the full data warehouse

#### Layer 2: Session Zero artifacts table(s)

Recommended new persistence layer.

Responsibility:

- durable, inspectable storage for compiled/intermediate Session Zero artifacts
- versioned snapshots and diagnostics
- handoff compiler checkpoints
- normalized entity graph storage

This should become the main home for rich Session Zero compilation products.

#### Layer 3: Vector memory / semantic memory

Current location:

- `src/context/memory.py`

Responsibility:

- long-lived recall for gameplay
- searchable summaries/facts/beats/session_zero memories

Should store:

- durable gameplay-relevant facts after they are sufficiently stable
- compact summaries of Session Zero outputs
- not every raw intermediate artifact

#### Layer 4: Final gameplay SQL tables

Current location:

- `src/db/models.py`

Responsibility:

- authoritative gameplay runtime state after handoff finalization
- character, NPCs, factions, quests, world state, etc.

These should only be populated/updated from Session Zero through explicit export/finalization rules, not through ad hoc partial writes everywhere.

### 11.5.3 What belongs in `CharacterDraft`

`CharacterDraft` should remain the live accumulator for **player-character-centric** facts gathered during Session Zero.

It should continue to own:

- media reference/profile choice
- canonicality choices at the player/world-setup level
- character concept
- character identity fields
- character backstory
- character mechanics
- starting location
- player-facing affiliations / known contacts
- composition/OP fields

It may be modestly extended for:

- stable player-character aliases
- structured backstory beats if needed
- confidence flags for key required fields

It should **not** become the primary home for:

- normalized NPC records
- faction graphs
- location graphs
- quest/thread graphs
- relationship edges
- contradiction sets
- compiler snapshots
- provenance maps for the whole transcript

### 11.5.4 What belongs in Session Zero artifacts

Session Zero artifacts should hold:

- normalized entity graph
- alias map
- contradiction records
- unresolved item queue
- compiler run reports
- opening brief draft/final
- canonicality divergence map
- ingestion/export plans
- provenance/confidence maps
- transcript chunk analysis summaries

This keeps the live session blob small enough to resume quickly while preserving rich inspection/debug state elsewhere.

### 11.5.5 Proposed SQL schema approach

Recommended first implementation:

#### Table: `session_zero_artifacts`

Purpose:

- generic versioned storage for Session Zero compilation outputs

Suggested columns:

- `id` integer PK
- `session_id` string/indexed
- `campaign_id` integer nullable/indexed
- `artifact_type` string/indexed
- `artifact_version` integer
- `status` string
  - `draft`
  - `active`
  - `superseded`
  - `failed`
- `producer` string
  - agent/pass/module name
- `schema_version` integer
- `payload` JSONB
- `summary` text nullable
- `created_at`
- `updated_at`

Uniqueness recommendation:

- unique on `(session_id, artifact_type, artifact_version)`

Common `artifact_type` values:

- `entity_graph`
- `entity_graph_delta`
- `alias_map`
- `contradictions`
- `unresolved_items`
- `opening_brief`
- `handoff_report`
- `compiler_checkpoint`
- `canonicality_map`
- `ingestion_plan`
- `ingestion_result`

#### Optional table: `session_zero_runs`

Purpose:

- minimal app-owned run ledger for orchestrator/compiler execution
- resume control and checkpoint lineage
- deterministic linkage between a run, its inputs, and the artifact versions it produced

Recommended initial posture:

- keep this table **small and boring**
- do not turn it into a second observability platform
- rely on Langfuse for trace detail, and use this table for application state / resumability

Suggested columns:

- `id` integer PK
- `session_id`
- `run_type`
  - `turn_orchestration`
  - `handoff_compile`
  - `recovery_compile`
- `status`
  - `running`
  - `completed`
  - `failed`
  - `cancelled`
- `started_at`
- `completed_at`
- `input_hash`
- `output_artifact_version`
- `error_summary`

This table should remain minimal until operational experience proves additional fields are necessary.

### 11.5.6 Artifact versioning rules

Every rich Session Zero artifact should support versioning.

Recommended rules:

- `artifact_version` increments monotonically per `(session_id, artifact_type)`
- exactly one version per type should be `active` at a time
- old versions should be retained at least during Session Zero for debugging/recovery
- final handoff should reference the exact active artifact versions used to build gameplay state

This enables:

- rerunning compiler passes without destructive overwrite
- diffing “before and after” entity graph changes
- reproducing bugs from a known artifact set

### 11.5.7 Schema versioning rules

Because this system will evolve rapidly, artifacts should include `schema_version`.

Why:

- prevents old artifacts from silently breaking new compiler/orchestrator code
- allows migration logic if payload structure changes

Recommended rule:

- every persisted artifact payload includes a top-level `schema_version`
- the DB row also stores `schema_version` for queryability

### 11.5.8 Compiler checkpointing design

The Handoff Compiler should checkpoint between major passes.

Recommended checkpoints:

1. transcript normalization complete
2. extraction complete
3. entity resolution complete
4. contradiction/unresolved analysis complete
5. opening brief draft complete
6. ingestion plan complete
7. final gameplay export complete

For each checkpoint:

- write or update a `compiler_checkpoint` artifact
- include pass name, counts, warnings, and next-step metadata

This enables resume/retry after failure without repeating all expensive work unnecessarily.

### 11.5.9 Idempotent write/export rules

This is critical.

The compiler must be safe to rerun.

#### Rule 1: compiler artifacts are append-versioned, not blindly overwritten

- create new versions
- mark prior version superseded when appropriate

#### Rule 2: export to gameplay tables must be deterministic and idempotent

When moving compiled Session Zero state into gameplay tables:

- use canonical IDs where available
- match existing rows by stable identity rules
- update instead of insert when entity already exported
- record export provenance so later reruns know what they previously wrote

#### Rule 3: never duplicate the same NPC/faction/location just because compiler reran

Recommended support field:

- export metadata in artifact or entity node like:
  - `exported_entity_type`
  - `exported_entity_id`
  - `exported_at_version`

#### Rule 4: export should be staged

Recommended flow:

1. compiler produces `ingestion_plan`
2. plan is validated
3. exporter applies plan to gameplay tables
4. exporter writes `ingestion_result`

This is safer than letting every pass mutate gameplay tables ad hoc.

#### Rule 5: export to gameplay tables must be transactional

The current `_handle_gameplay_handoff()` is a 12-step imperative sequence with no transactional safety. A failure at step N (e.g., Director startup crashes after character update) leaves the database in a half-written state.

The ingestion plan application (Rule 4, step 3) must wrap all gameplay-table mutations in a single database transaction:

- character creation/update
- NPC exports
- faction exports
- location exports
- quest/thread creation
- world-state finalization

If any write fails, the entire export rolls back, leaving gameplay tables clean and the compiler artifacts intact for retry.

This does **not** require making the entire handoff sequence transactional (memory indexing, media generation, etc. can remain fire-and-forget). It only requires that the final structured export from compiled artifacts to gameplay SQL tables is atomic.

### 11.5.10 Proposed normalized entity payload shape

Every normalized node/edge in Session Zero artifacts should support these common fields:

- `canonical_id`
- `entity_type`
- `display_name`
- `aliases`
- `description`
- `attributes` (entity-specific structured fields)
- `confidence`
- `provenance`
- `source_refs`
- `merge_history`
- `export_state`
- `status`
  - `candidate`
  - `resolved`
  - `exported`
  - `discarded`

#### `provenance` should include

- source kind
  - transcript
  - profile research
  - inferred
  - player confirmed
  - imported canon
- source references
  - message indices
  - transcript spans if available
- confidence rationale

#### `merge_history` should include

- which prior candidate IDs were merged
- why they were merged
- what facts were chosen/dropped

### 11.5.11 Contradiction and unresolved-item payload design

Persist contradictions/unresolved items as first-class records, not stray strings.

Suggested contradiction fields:

- `issue_id`
- `issue_type`
  - `hard_conflict`
  - `alias_conflict`
  - `timeline_conflict`
  - `ambiguity`
- `entities_involved`
- `statements`
- `confidence`
- `blocking`
- `suggested_resolution`
- `resolution_status`

Suggested unresolved-item fields:

- `item_id`
- `category`
  - `identity`
  - `npc`
  - `faction`
  - `location`
  - `quest`
  - `canonicality`
  - `mechanics`
- `description`
- `why_it_matters`
- `priority`
- `blocking`
- `candidate_followup`

### 11.5.12 Opening brief persistence design

The opening brief should be persisted as its own artifact type, not just regenerated ad hoc.

Reason:

- Director/KA debugging
- supports retrying opening-scene generation without recompiling everything
- lets future UI/debug tools show what handoff produced

Recommended payload sections:

- `character_brief`
- `scene_setup`
- `cast`
- `faction_context`
- `quest_context`
- `canon_context`
- `composition_context`
- `must_include`
- `must_avoid`
- `uncertain_facts`
- `artifact_dependencies`

### 11.5.13 Resume/recovery semantics

On server restart or resume:

- live `Session` loads from `session_zero_states`
- orchestrator checks for active latest artifacts/checkpoints
- if artifacts exist and are compatible, it reuses them
- if artifacts are stale/incompatible, it can schedule a recovery compile

Recommended resume policy:

- if last compiler run was `completed` and no new transcript messages exist, reuse active artifacts
- if new transcript messages exist, mark dependent artifacts stale and rerun only necessary passes
- if last run failed, resume from last successful checkpoint when possible

### 11.5.14 Staleness/invalidation rules

Artifacts must know when they are stale.

Recommended invalidation inputs:

- transcript hash changed
- `CharacterDraft` changed materially
- profile research artifacts changed
- canonicality choices changed
- merge logic/schema version changed

Recommended mechanism:

- store an `input_fingerprint` on every artifact/run
- compare against current session inputs before reuse

### 11.5.15 Relationship to vector memory

Do not dump every artifact wholesale into vector memory.

Recommended rule:

- vector memory stores distilled, gameplay-relevant stable facts
- Session Zero artifacts store rich compiler state

Example:

- good for vector memory:
  - “The protagonist grew up under Commander Vale and still owes her a debt.”
- not good for vector memory:
  - full unresolved contradiction payload with merge metadata

### 11.5.16 Export timing policy

Not all Session Zero discoveries should wait until final handoff to touch SQL state.

Recommended split:

#### Safe early writes during Session Zero

- plot-critical memory facts
- provisional NPC stubs if already supported
- profile/campaign initialization

#### Compiler-controlled final writes at handoff

- normalized NPC records
- faction graph exports
- location normalization exports
- quest/thread creation
- canonicality world-state finalization
- opening-state package generation

This balances responsiveness with safety.

### 11.5.17 Migration strategy

Recommended migration order:

1. add `session_zero_artifacts` table
2. optionally add `session_zero_runs` table
3. do not migrate legacy `session_zero_states` payloads immediately
4. let new sessions start writing artifacts
5. add compatibility logic for old sessions with no artifacts

Avoid an up-front bulk migration of existing Session Zero state blobs unless necessary.

### 11.5.18 Testing checklist for persistence layer

Tests should cover:

- saving/loading `Session` remains backward compatible
- artifact version increments correctly
- only one active artifact per type
- rerunning compiler does not duplicate exported gameplay rows
- stale artifacts are invalidated on transcript change
- recovery compile resumes from checkpoint where possible
- opening brief can be reused for scene-generation retry
- old sessions without artifacts still function

### 11.5.19 Recommendation summary

Use this boundary model:

- `CharacterDraft` = live player-character accumulator
- `session_zero_states` = lightweight resume blob
- `session_zero_artifacts` = rich versioned compilation state
- gameplay tables = final exported runtime state
- vector memory = stable searchable facts

That is the cleanest way to support a robust multi-pass Session Zero without collapsing everything into one giant JSON blob or polluting gameplay state too early.

---

## 12. Opening-State Briefing Package

This is the bridge between Session Zero/handoff and Director + Key Animator.

## 12.1 Required sections

- player character summary
- current scene setup
- immediate stakes
- opening cast roster
- faction context
- quest/thread context
- canon/divergence context
- tone/composition context
- must-include facts
- must-not-contradict facts
- uncertain facts / caution notes

## 12.2 Consumers

Primary consumers:

- Director startup
- Key Animator opening-scene generation
- possibly Production/Beat extraction afterward

## 12.3 Replace synthetic magic where possible

The current synthetic opening-scene trigger should remain a routing mechanism only if necessary. The important change is that Director/KA should receive a **briefing package**, not depend on ad hoc inference from a placeholder input.

Possible end state:

- Director startup takes `opening_state_package`
- Key Animator opening-scene call takes `opening_state_package`
- synthetic player input is reduced or removed

## 12.4 Focused fourth pass: opening-scene contract, ownership, and migration path

This section defines the exact handoff contract between Session Zero / Handoff Compiler and the opening-scene stack.

The user requirement here is important and should remain explicit:

- Session Zero should **wrap everything up with a bow for opening-scene generation**
- Director and Key Animator should remain the opening-scene owners
- Session Zero should not be doing freeform prose generation in place of them

### 12.4.1 Current-state diagnosis

Today, the system is split across three different ideas:

1. Session Zero / handoff populates initial state and transcript context
2. Director runs `run_startup_briefing()` to seed the initial campaign bible
3. the actual opening scene is generated by calling the normal gameplay `process_turn()` pipeline with a synthetic input:
   - `[opening scene — the story begins]`

That current design has several weaknesses:

- the opening scene depends on a fake player input rather than an explicit opening-scene contract
- `process_turn()` is designed for normal live play, not for one-time handoff initialization
- the frontend can transition to gameplay even when opening-scene generation fails
- the pipeline can accidentally route the synthetic input through logic meant for player-authored world building
- Director startup and opening-scene generation are logically related, but operationally only loosely coupled

The goal is not just to “fix” the synthetic turn. The goal is to replace hidden inference with an explicit, durable, inspectable **opening-state package**.

### 12.4.2 Ownership model

The clean ownership split should be:

#### Session Zero Orchestrator

Owns:

- gathering player/world/canon information
- asking follow-up questions
- building a reliable transcript and draft state
- identifying gaps before handoff

Does not own:

- final pilot-episode planning
- final opening-scene prose

#### Handoff Compiler

Owns:

- transcript-wide normalization
- entity extraction/resolution
- contradiction handling
- opening-state package assembly
- persistence of handoff artifacts
- deciding whether handoff is ready / blocked / degraded

Does not own:

- freeform scene prose

#### Director startup

Owns:

- converting opening-state package into a pilot-episode narrative plan
- choosing opening arc shape
- determining initial tension/arc phase
- planting foreshadowing and story pressure
- producing explicit creative guidance for the opening scene

Does not own:

- inventing unsupported world facts that contradict the opening-state package
- silently compensating for major missing handoff data

#### Key Animator opening-scene generator

Owns:

- writing the opening-scene prose
- turning the opening-state package + Director guidance into cinematic narrative
- obeying hard canon / continuity / cast constraints

Does not own:

- deciding foundational lore
- deciding handoff readiness
- inferring major missing setup from vague placeholder text

### 12.4.3 Required target artifact: `opening_state_package`

The Handoff Compiler should emit a first-class artifact called `opening_state_package`.

This is the authoritative source for opening-scene generation.

It should be:

- persisted
- versioned
- human-inspectable
- reusable for retries
- strict enough to constrain Director/KA
- flexible enough to support creative scene writing

### 12.4.4 Proposed top-level payload shape

Recommended top-level sections:

- `package_metadata`
- `readiness`
- `player_character`
- `opening_situation`
- `opening_cast`
- `world_context`
- `faction_context`
- `active_threads`
- `canon_rules`
- `tone_and_composition`
- `director_inputs`
- `animation_inputs`
- `hard_constraints`
- `soft_targets`
- `uncertainties`
- `artifact_dependencies`

Implementation note:

- the contract should distinguish **core required sections** from **optional enrichment sections**
- keep the full shape as the target contract so Director/KA assumptions stay explicit
- do not treat the absence of every enrichment section as equivalent to total package failure

### 12.4.5 `package_metadata`

Suggested fields:

- `session_id`
- `campaign_id`
- `package_version`
- `schema_version`
- `created_at`
- `source_run_id`
- `transcript_hash`
- `character_draft_hash`
- `profile_id`
- `effective_canonicality_mode`

This makes the package traceable and safe to reuse/debug.

### 12.4.6 `readiness`

This section should make handoff semantics explicit.

Suggested fields:

- `handoff_status`
  - `blocked`
  - `degraded`
  - `ready_for_director`
  - `ready_for_opening_scene`
- `blocking_issues`
- `warnings`
- `missing_but_nonblocking`
- `confidence_summary`

Rules:

- `blocked` means no opening scene should be generated
- `degraded` means the system may choose to proceed but should surface warnings
- `ready_for_director` means Director planning can begin
- `ready_for_opening_scene` means the full package is sufficient for scene generation

### 12.4.7 `player_character`

This section should include everything Director/KA need about the protagonist without rereading raw Session Zero transcript.

Suggested fields:

- `name`
- `aliases`
- `concept`
- `core_identity`
- `appearance`
- `visual_tags`
- `personality`
- `values`
- `fears`
- `goals`
- `abilities`
- `power_tier`
- `resource_snapshot`
- `social_position`
- `known_relationships`
- `backstory_beats`
- `starting_inventory`
- `voice_notes`

### 12.4.8 `opening_situation`

This should be the single most important section for opening-scene generation.

Suggested fields:

- `starting_location`
- `time_context`
- `immediate_situation`
- `what_is_happening_right_now`
- `why_this_moment_is_the_start`
- `immediate_pressure`
- `scene_objective`
- `scene_question`
- `expected_initial_motion`
- `forbidden_opening_moves`

This section should answer:

- where are we?
- who is here?
- what is already in motion?
- why does the story start **here**?
- what should the first scene be about?

### 12.4.9 `opening_cast`

Suggested fields:

- `required_present`
- `optional_present`
- `offscreen_but_relevant`
- `npc_relationship_notes`
- `entry_constraints`
- `portrait_priority`

For each cast member, include:

- `canonical_id`
- `display_name`
- `role_in_scene`
- `relationship_to_pc`
- `tone`
- `must_include`
- `must_not_imply`
- `visual_notes`

This prevents the first scene from forgetting important NPCs or fabricating the wrong ones.

### 12.4.10 `world_context`

Suggested fields:

- `location_description`
- `world_state_snapshot`
- `important_recent_facts`
- `local_dangers`
- `local_opportunities`
- `setting_truths`
- `taboo_or_impossible_elements`

This should contain only world facts that matter immediately to the opening scene, not the full lore dump.

### 12.4.11 `faction_context`

Suggested fields:

- `relevant_factions`
- `current_alignment_map`
- `visible_pressure`
- `hidden_pressure`
- `faction_conflicts_already_in_play`

The opening scene often needs faction pressure without needing the entire geopolitical encyclopedia.

### 12.4.12 `active_threads`

Suggested fields:

- `quests_or_hooks_to_surface`
- `threads_to_foreshadow`
- `threads_to_avoid_prematurely_revealing`
- `mysteries_already_known_to_player`
- `mysteries_hidden_from_player`

This is especially important for preventing the first scene from spending or spoiling future plot material.

### 12.4.13 `canon_rules`

Suggested fields:

- `timeline_mode`
- `canon_cast_mode`
- `event_fidelity`
- `accepted_divergences`
- `forbidden_contradictions`
- `hybrid_profile_rules`
- `alt_timeline_rules`

This is where “alternate timeline canonicality / custom profile / hybrid profile” concerns should become operational constraints rather than vague notes.

### 12.4.14 `tone_and_composition`

Suggested fields:

- `composition_name`
- `tension_source`
- `power_expression`
- `narrative_focus`
- `genre_pressure`
- `tone_floor`
- `tone_ceiling`
- `aesthetic_targets`
- `author_voice_constraints`

This lets the opening scene honor composition and profile DNA without overloading unrelated sections.

### 12.4.15 `director_inputs`

This section exists specifically so Director startup has an explicit interface instead of reconstructing intent from a summary blob.

Suggested fields:

- `arc_seed_candidates`
- `opening_antagonistic_pressure`
- `recommended_foreshadowing_targets`
- `spotlight_priorities`
- `recommended_first_arc_scope`
- `narrative_risks`
- `required_payoff_setup`

### 12.4.16 `animation_inputs`

This section exists specifically so the opening-scene prose generator has an explicit cinematic contract.

Suggested fields:

- `scene_mode`
  - quiet_intro
  - inciting_incident
  - social_hook
  - threat_hook
  - mystery_hook
  - motion_hook
- `required_beats`
- `beat_order_constraints`
- `visual_anchor_images`
- `emotional_target`
- `prose_pressure`
- `pacing_guidance`
- `must_land_on`
- `must_not_end_on`

### 12.4.17 `hard_constraints` vs `soft_targets`

This distinction is essential.

#### Hard constraints

Examples:

- protagonist name and identity facts
- starting location
- canon restrictions
- required present characters
- facts that must not be contradicted
- facts intentionally hidden from the opening scene

These should be treated as non-negotiable.

#### Soft targets

Examples:

- thematic flavor
- desired cinematic energy
- preferred spotlight balance
- suggested hooks to surface
- optional motifs to plant

These guide quality without turning the system brittle.

### 12.4.18 `uncertainties`

This section should explicitly preserve uncertainty instead of pretending missing facts are resolved.

Suggested fields:

- `known_unknowns`
- `contradiction_notes`
- `safe_assumptions`
- `unsafe_assumptions`
- `degraded_generation_guidance`

This is how the system avoids either hallucinating details or completely stalling when a small amount of ambiguity remains.

### 12.4.19 Director contract

Director startup should eventually take the full `opening_state_package`, not just a stitched summary + a handful of scalar fields.

Recommended input contract:

- `opening_state_package`
- `profile`
- optional `model_override`

Recommended Director outputs:

- `opening_arc_plan`
- `initial_tension`
- `foreshadowing_plan`
- `opening_scene_director_notes`
- `voice_and_composition_guidance`
- `opening_scene_guardrails`

This output should be persisted and attached back to the handoff artifact graph.

### 12.4.20 Key Animator contract

The opening-scene prose call should become a dedicated pathway rather than a normal player turn.

Recommended method shape:

- `generate_opening_scene(opening_state_package, director_opening_plan, profile, ...)`

Inputs should include:

- the full opening-state package
- Director notes for the first scene
- profile voice/composition context
- optional portrait / cast metadata

Outputs should include:

- `opening_scene_text`
- `scene_summary`
- `cast_used`
- `portrait_map`
- `continuity_flags`
- `scene_beats_emitted`

This should be logged as its own operation, not hidden inside a generic gameplay turn.

### 12.4.21 Should Production participate?

Recommended answer: **optionally, after KA**, not before.

Possible roles:

- beat extraction from opening prose
- continuity tagging
- initial production metadata

But Production should not be a prerequisite for scene generation in the first rollout.

### 12.4.22 Failure semantics

This needs to be explicit because the current system is too permissive.

Recommended staged status model:

1. `handoff_compiling`
2. `opening_package_ready`
3. `director_startup_ready`
4. `opening_scene_generating`
5. `opening_scene_ready`
6. `opening_scene_failed`
7. `handoff_blocked`

Recommended behavior:

- if package compilation fails in a blocking way, do not transition to gameplay
- if Director startup fails, do not pretend the opening-scene package is complete
- if Key Animator fails, keep the session in a handoff-error state rather than silently transitioning
- only treat the handoff as complete when `opening_scene_ready` is true

Recommended degraded / gap-fill policy:

- if missing information is player-authored, identity-critical, or opening-scene-critical, prompt explicitly:
  - `X is still underspecified. Do you want to provide more detail, or should I fill reasonable gaps for you?`
- if missing information is low-risk connective tissue, proceed using explicit `safe_assumptions`
- if the issue is a hard contradiction affecting canon, identity, or opening-scene coherence, block and require resolution

This matches the user expectation that Session Zero should finish by teeing up the actual opening scene properly.

### 12.4.23 Frontend/API implications

The API contract should evolve so the frontend does not infer too much from `phase`.

Recommended response fields:

- `handoff_status`
- `opening_package_status`
- `director_startup_status`
- `opening_scene_status`
- `opening_scene`
- `opening_scene_summary`
- `handoff_warnings`
- `retryable_failure`
- `progress_stage`
- `progress_message`
- `progress_percent`

Frontend rule:

- do not transition to “normal gameplay input loop” until opening-scene generation is complete or the system intentionally exposes a recovery UX
- reuse the existing profile-generation progress UI/progress bar pattern for handoff compilation, Director startup, and opening-scene generation states

### 12.4.24 Observability contract

Recommended trace/spans for this subflow:

- `session_zero.handoff.compile_opening_package`
- `session_zero.handoff.director_startup`
- `session_zero.handoff.opening_scene_generation`
- `session_zero.handoff.opening_scene_persist`

Recommended metadata:

- package version
- package readiness
- Director output version
- scene generation retries
- degraded vs non-degraded mode
- cast count
- unresolved issue count

### 12.4.25 Persistence contract for opening-scene subflow

Persist at least these artifacts:

- `opening_state_package`
- `director_startup_plan`
- `opening_scene_result`
- `opening_scene_failure_report` when applicable

This ensures the scene can be retried without rerunning every prior pass.

### 12.4.26 Dedicated opening-scene path stance

The dedicated opening-scene path should be treated as the **intended runtime design**, not as optional cleanup to be deferred indefinitely.

Recommended implementation stance:

- build `opening_state_package` and a dedicated opening-scene generation path in the same architectural stream
- Director startup should consume package data directly
- Key Animator opening-scene generation should run through an explicit opening-scene method/path rather than normal `process_turn()` semantics

Compatibility note:

- the current synthetic opening-turn path may remain temporarily as an emergency fallback during rollout
- it should not be treated as the primary or preferred architecture once this upgrade begins
- remove it after the dedicated path stabilizes

### 12.4.27 Orchestrator singleton lifecycle during handoff

The current handoff calls `reset_orchestrator()` (line 159 of `session_zero.py`) partway through the sequence, which destroys and recreates the global `Orchestrator` singleton. The compiler will run **after** this reset.

This matters because:

- the Orchestrator singleton owns the `MemoryStore`, `StateManager`, and all agent instances
- the compiler needs access to the memory store (to read indexed Session Zero memories) and the state manager (to read/write gameplay tables)
- if the compiler runs before `reset_orchestrator()`, it gets stale state; if it runs after, it works with the fresh singleton

Implementation rule:

- the Handoff Compiler should run **after** `reset_orchestrator()` so it operates on the same Orchestrator instance that will own gameplay
- the compiler should receive the Orchestrator's memory store and state manager as explicit dependencies (not by importing the singleton internally)
- this keeps the compiler testable with injected dependencies while avoiding lifecycle race conditions

The current handoff sequence should be reorganized roughly as:

1. settings sync, profile resolution, campaign ID resolution
2. `reset_orchestrator()` → fresh singleton with correct profile/campaign
3. memory indexing (Session Zero → vector store)
4. **Handoff Compiler** runs (reads transcript + draft + memory, produces artifacts + opening-state package)
5. compiler export applies to gameplay tables (transactional — see Rule 5 in 11.5.9)
6. Director startup (consumes opening-state package)
7. opening-scene generation (dedicated path)

### 12.4.28 Recommendation summary

The right long-term shape is:

- Session Zero + Handoff Compiler produce a **durable, explicit opening-state package**
- Director converts that package into a **pilot-episode plan**
- Key Animator converts both into the **opening-scene prose**
- the frontend transitions only when that scene is actually ready

That gives the opening-scene pipeline a real contract instead of a pile of side effects and placeholder magic.

---

## 13. Observability and Logging Plan

## 13.1 Add trace structure for Session Zero

Recommended top-level traces/spans:

- `session_zero.turn`
- `session_zero.extract`
- `session_zero.resolve_entities`
- `session_zero.gap_analysis`
- `session_zero.research`
- `session_zero.persist`
- `session_zero.handoff`
- `session_zero.handoff.pass.<name>`
- `session_zero.opening_brief`
- `session_zero.opening_scene_generation`

## 13.2 Generation labeling

Every new first-class agent should call through existing provider stack so Langfuse generations include:

- agent name
- model
- token usage
- optional metadata:
  - session id
  - phase
  - pass name
  - retry counts
  - artifact version

## 13.3 Structured diagnostics to log

For each compiler pass, log:

- number of entities created/merged
- number of contradictions detected/resolved
- number of unresolved items remaining
- whether handoff is blocked or allowed
- confidence summary
- persistence summary

## 13.4 Debug artifacts for supportability

Persist debug-friendly summaries such as:

- last extraction summary
- last resolver summary
- handoff compiler pass report
- final opening brief summary

This will make production debugging far easier than reading raw transcripts.

---

## 14. Frontend / UX Plan

## 14.1 Preserve main UX shape initially

Keep current Session Zero UI flow and endpoints initially:

- `/start-session`
- `/session/{id}/turn`
- handoff via `SessionZeroResponse`

## 14.2 Improve handoff semantics

Frontend should not treat `phase == gameplay` alone as proof that opening-state generation is complete.

Introduce clearer response semantics, for example:

- `ready_for_gameplay`
- `handoff_status`
  - `not_ready`
  - `compiling`
  - `compiled`
  - `opening_scene_ready`
  - `failed`
- `opening_scene`
- `opening_brief_summary`
- `handoff_warnings`

This reduces current coupling where gameplay UI can transition even if opening-scene generation failed.

Also reuse the existing profile-generation progress UX pattern so the handoff can surface staged progress such as:

- compiling Session Zero transcript
- resolving entities and contradictions
- assembling opening-state package
- running Director startup
- generating opening scene

## 14.3 Settings UI changes

Required UI additions:

- new model config cards for new SZ agents
- clearer grouping for Session Zero-specific agents
- maybe a label showing which agents are inherited from base thinking tier vs overridden

Optional but valuable:

- “show inherited tier” helper text
- “reset only Session Zero agents” button
- display of effective provider/model after fallback resolution

## 14.4 Optional Session Zero diagnostics UI

For debug mode only, consider exposing:

- unresolved-items count
- entities detected count
- contradictions count
- handoff compiler status
- opening brief readiness

---

## 15. Detailed Code-Surface Plan

## 15.1 Existing files likely to change

### Session Zero runtime

- `src/core/session.py`
- `src/agents/session_zero.py`
- `src/agents/_session_zero_research.py`
- `api/routes/game/session_zero.py`
- `api/routes/game/session_mgmt.py`

### Shared agent infrastructure

- `src/agents/base.py`
- `src/llm/manager.py`
- `src/settings/models.py`
- `src/settings/store.py`
- `api/routes/settings.py`

### Gameplay bridge / opening scene

- `src/core/_turn_pipeline.py`
- `src/core/orchestrator.py`
- `src/agents/director.py`
- `src/agents/key_animator.py`
- possibly `src/core/_background.py`

### Persistence

- `src/db/models.py`
- Alembic migration(s)
- `src/db/session_store.py`
- maybe new `src/db/session_zero_artifacts.py` or similar helper

### Observability

- `src/observability.py`
- providers under `src/llm/`

### Frontend/UI

- `web/index.html`
- `web/js/app.js`
- `web/js/api.js`
- `web/css/main.css` if layout expands

## 15.2 New files likely needed

Suggested modules:

- `src/agents/session_zero_extractor.py`
- `src/agents/session_zero_gap_analyzer.py`
- `src/agents/session_zero_entity_resolver.py`
- `src/agents/session_zero_handoff.py`
- `src/agents/session_zero_schemas.py`
- `src/core/session_zero_orchestrator.py` or `src/core/_session_zero_pipeline.py`
- `src/core/session_zero_compiler.py`
- `src/core/session_zero_entities.py`
- `src/core/session_zero_briefing.py`
- `src/db/session_zero_artifacts.py` (or equivalent)
- Alembic migration for new artifacts table(s)

---

## 16. Proposed Execution Phases

## Phase 0 — Foundation and Contracts

Deliverables:

- define normalized Session Zero entity schemas
- define opening-state briefing schema
- define handoff diagnostics schema
- define compiler artifact persistence approach
- add feature flags for new runtime/compiler

Implementation notes:

- no behavioral rewrite yet
- mostly schema/module groundwork

Definition of done:

- new schemas exist
- artifacts storage strategy is implemented or scaffolded
- no user-visible change yet

## Phase 1 — Handoff Compiler MVP

Deliverables:

- transcript-wide multi-pass handoff compiler
- compile character + NPC + faction + location + quest + canonicality basics
- dedupe aliases and duplicate entities
- emit opening-state briefing package
- integrate with existing handoff path before Director/KA opening-scene generation

Important rule:

- compiler should be additive and not require Session Zero runtime rewrite yet

Definition of done:

- current Session Zero sessions benefit from improved handoff quality
- opening-scene inputs come from compiled package rather than fragile ad hoc state alone

## Phase 2 — Handoff Compiler Enrichment

Deliverables:

- contradiction handling
- orphan fact capture
- hybrid/custom lore synthesis
- stronger relationship graph compilation
- unresolved ambiguity reporting
- improved opening brief quality

## Phase 3 — Session Zero Orchestrator MVP

### Overview

Convert `SessionZeroAgent` from a single conversation loop into a proper per-turn orchestrated pipeline, add live extraction and entity resolution during the session, wire memory integration, and reorganize the handoff sequence so the Handoff Compiler runs after `reset_orchestrator()` with clean injected dependencies.

### Deliverables

#### 3.1 Per-turn pipeline

- Convert `SessionZeroAgent` into a turn pipeline owner (analogous to `TurnPipelineMixin`)
- Each turn: run `SessionZeroExtractorAgent` → `SessionZeroEntityResolverAgent` → `SessionZeroGapAnalyzerAgent` → `SessionZeroConductor` response generation
- `SessionZeroConductor` consumes gap analyzer output to decide follow-up question and phase progression

#### 3.2 Settings config for new agents

Every new first-class agent requires a settings store entry following the same pattern as existing agents:

- `sz_extractor` — model + provider selection (thinking tier recommended; default: same provider as `session_zero`)
- `sz_gap_analyzer` — model + provider selection (thinking tier; separate entry so extraction quality can be tuned independently)
- `sz_entity_resolver` — model + provider selection (thinking tier)
- All three appear in `SettingsStore` under the `agent_models` section and are resolved by `LLMManager.get_provider_for_agent()`

#### 3.3 Incremental entity graph persistence

- Per-turn entity graph state persisted to `session_zero_artifacts` with `artifact_type='sz_entity_graph'`
- Each turn upserts the artifact (new version) so the incremental graph survives server restarts
- Entity resolver reads the prior artifact on startup rather than rebuilding from scratch each turn
- Reuses existing versioning/locking infrastructure — no new DB table needed

#### 3.4 Safe early memory writes during Session Zero

Per §11.5.16: certain facts should reach `MemoryStore` immediately during SZ, not waiting for handoff.

Write to `MemoryStore` after each turn when extractor finds:

- Characters with named relationships to the player character → `memory_type='character_state'`, `decay_rate='none'`
- Plot-critical facts flagged by extractor (`is_plot_critical=True` in `FactRecord`) → `memory_type='session_zero'`, flags `['plot_critical', 'session_zero_in_progress']`
- These are **provisional** — at handoff the compiler produces the authoritative overwrite (see 3.5)

#### 3.5 Memory integration at handoff

At handoff, after the Handoff Compiler produces the final `OpeningStatePackage`, write distilled stable facts to `MemoryStore` using existing `add_memory()` API:

| What | `memory_type` | `decay_rate` | Notes |
|------|---------------|--------------|-------|
| Canonical player character identity and backstory | `'core'` | `'none'` | Never decays; central to all gameplay |
| Canonical NPC entries (name, role, relationship) | `'character_state'` | `'none'` | Overwrites any provisional SZ writes |
| Canonical relationships from `relationship_graph` | `'relationship'` | `'none'` | e.g. “Spike owes Julia a debt” |
| Stable world/setting facts (non-canonical setting, custom lore) | `'session_zero'` | `'none'` | Already a defined category in `CATEGORY_DECAY` |
| Active quest/thread seeds from gap analyzer | `'quest'` | `'normal'` | |
| Location facts | `'location'` | `'slow'` | |

**Rule:** Do NOT dump raw compiler artifacts into `MemoryStore`. Only distilled, gameplay-relevant stable facts. Raw compiler output lives in `session_zero_artifacts`.

**Timing:** memory writes happen in step 3 of the 7-step handoff sequence (see 3.6), before Director startup.

#### 3.6 Handoff sequence reorganization

Reorganize `_handle_gameplay_handoff()` to follow the architecture-specified 7-step sequence (§12.4.27):

1. Settings sync, profile resolution, campaign ID resolution
2. `reset_orchestrator()` → fresh singleton with correct profile/campaign
3. Memory indexing: provisional SZ memories upgraded to permanent; orphan/unresolved items flagged
4. **Handoff Compiler** runs — receives `memory_store` and `state_manager` as explicit injected deps (not singleton import)
5. Compiler export applies to gameplay SQL tables (transactional)
6. Director startup (consumes `OpeningStatePackage`)
7. Opening-scene generation (dedicated path)

**Current problem:** `reset_orchestrator()` is called partway through with inconsistent dependency flow. This reorg is required before Phase 4 hardening is coherent.

### Definition of done

- Dense user input is captured before handoff, not only at compiler time
- Post-handoff: canonical entities appear in `MemoryStore` with correct `memory_type` (verifiable in tests via `MemoryStore.search()`)
- Handoff sequence follows the 7-step order; Handoff Compiler receives `memory_store`/`state_manager` as injected deps
- `sz_extractor`, `sz_gap_analyzer`, `sz_entity_resolver` all appear in settings store and resolve through `LLMManager`

---

## Phase 4 — Session Zero Orchestrator Hardening

### Overview

Harden the Phase 3 pipeline against real-world failure modes, add resumability so a crashed SZ can continue rather than restart, cover the new pipeline with Langfuse traces, and expose more granular status to the frontend.

### Deliverables

#### 4.1 Specific error recovery behaviors

| Failure | Recovery |
|---------|----------|
| `sz_extractor` fails on a turn | Log and continue — conductor responds without new extraction data |
| `sz_entity_resolver` fails on a turn | Log and continue — use prior entity graph unchanged |
| `sz_gap_analyzer` fails on a turn | Fall back to default phase progression (advance if minimum requirements met) |
| Handoff Compiler pass fails | Mark run as `failed`, surface `opening_scene_status='failed'` to frontend; do NOT silently fall back to uncompiled state |
| Compiler produces empty package | Retry with simplified prompt before failing hard |
| Memory indexing fails at handoff | Log warning, continue — memory is best-effort; gameplay proceeds without it |

#### 4.2 Resumability and checkpointing

- On turn start, check for existing `sz_entity_graph` artifact for this session — if found, restore state
- On server restart mid-SZ, `SessionZeroAgent` reconstructs internal state from artifact table
- Handoff Compiler run that fails mid-way reuses the existing `session_zero_runs` row to avoid duplicate artifact output

#### 4.3 Langfuse trace coverage

Add spans for:

- Per-turn: extractor output summary (entity count, fact count, new vs updated)
- Per-turn: entity resolver diff (merged count, conflict count)
- Per-turn: gap analyzer priority list (top 3 follow-up candidates)
- Per-turn: conductor decision (phase, follow-up question selected)
- At handoff: each compiler pass (name, duration, artifact version produced)
- At handoff: memory indexing (facts written by type, any failures)

#### 4.4 Tool-assisted research

- `SessionZeroConductor` or gap analyzer can invoke `wiki_scout` / `world_builder` for profile/setting research during SZ
- Gated behind `SESSION_ZERO_RESEARCH_ENABLED` feature flag (default False)

#### 4.5 Frontend status surface

- Per-turn `SessionZeroResponse` includes extraction summary counts (entity count, unresolved count)
- Expose current entity graph summary for optional debug/detail panel in frontend

### Definition of done

- Each failure in 4.1 has a test using `MockLLMProvider.queue_error()` demonstrating the specified behavior
- A simulated server-restart test shows state is restored from artifacts
- Langfuse spans exist for all items in 4.3

---

## Phase 5 — Frontend/Handoff Semantics Cleanup

**Status: ✅ DONE** (completed in `1625b8f`)

Deliverables completed:

- Frontend no longer conflates “phase changed” with “opening scene ready”
- `opening_scene_status` field in `SessionZeroResponse` with full state machine
- `opening_scene_failed` UI branch with user-facing fallback message

---

## Phase 6 — Cleanup and Migration

### Deliverables

#### 6.1 `detected_info` deprecation (§7.2.6)

- Audit all callers of `detected_info` in `SessionZeroAgent` and related routes
- Migrate surviving callers to read from `OpeningStatePackage` / compiler artifacts
- Remove `detected_info` field from `SessionZeroState` and related schemas
- DB migration to drop `detected_info` columns

#### 6.2 Feature flag removal

Once compiler and orchestrator pipeline are stable and on by default:

- Remove `SESSION_ZERO_COMPILER_ENABLED` — compiler always runs
- Remove `SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED` — dedicated path always used
- Remove all `if SESSION_ZERO_COMPILER_ENABLED:` conditional branches

#### 6.3 Compatibility shim removal

- Remove one-shot handoff assumptions from `_handle_gameplay_handoff()` once the 7-step sequence (3.6) is stable
- Remove any `session_zero_states` writes that duplicate compiler output

#### 6.4 Architecture documentation

- Update `README.md` with final SZ architecture summary
- Document the handoff sequence, memory integration policy, and artifact lifecycle

## 16.1 Focused fifth pass: milestone sequencing, dependency ordering, and first delivery slice

The phase list above is directionally correct, but a project this large also needs a **practical landing sequence**.

This section answers:

- what should be built first
- what should explicitly wait
- what dependencies must be in place before later work starts
- where rollback / feature-flag boundaries should exist
- what constitutes a safe first mergeable milestone

### 16.1.1 Sequencing principles

Use these principles to keep the rollout tractable:

#### Principle 1: land contracts before behavior

First define and persist:

- schemas
- status enums
- artifact boundaries
- opening-state package contract
- trace/event naming

Do this before introducing multi-agent orchestration behavior.

#### Principle 2: improve handoff before rewriting Session Zero runtime

The Handoff Compiler is the best first leverage point because:

- it improves outcomes for all existing Session Zero sessions
- it is easier to test on transcript fixtures
- it has a cleaner rollback path
- it does not require immediate frontend or live-turn orchestration changes

#### Principle 3: keep the first slice additive

The first meaningful implementation slice should:

- sit alongside the existing handoff path
- run under a feature flag
- produce inspectable artifacts
- avoid deleting current behavior immediately

#### Principle 4: separate “new internal logic” from “new user-configurable agent surface”

Not every internal pass must become a first-class UI-exposed agent on day one.

Recommended rollout:

- first expose only the minimum externally configurable new agent surfaces
- keep some helper passes internal initially if they are tightly coupled and not yet stable
- only promote helpers to first-class settings/UI entries once their contracts stabilize

This is the safest way to respect the model-config requirement without exploding the first milestone.

#### Principle 5: make every stage independently observable

Each milestone should leave behind:

- logs
- Langfuse spans/generations
- persisted artifacts
- explicit status reporting

If a stage cannot be observed, it will be painful to debug in production.

### 16.1.2 Dependency ordering

Build in roughly this order:

1. shared schemas and artifact persistence
2. status model / response semantics
3. handoff compiler core
4. opening-state package assembly
5. Director startup contract upgrade
6. dedicated opening-scene generation path
7. frontend semantic cleanup
8. Session Zero live orchestrator
9. helper-agent expansion / settings UI expansion / hardening

Do **not** invert this ordering.

In particular:

- do not start by rewriting Session Zero turn processing
- do not start by adding a large number of new UI settings cards
- do not start by removing the synthetic opening-turn compatibility path

### 16.1.3 Concrete milestone ladder

Below is the recommended milestone ladder, which is more specific than the broad phases.

#### Milestone M0 — Contracts and storage groundwork

Scope:

- add Session Zero artifact schema definitions
- add DB migration(s) for `session_zero_artifacts` (and optionally `session_zero_runs`)
- define handoff/opening status enums
- define `opening_state_package` payload schema
- define feature flags
- define observability names/metadata conventions

Must not include:

- major runtime behavior changes
- new frontend UX
- Session Zero orchestration rewrite

Acceptance criteria:

- schemas compile/validate
- migration applies cleanly
- artifact rows can be written/read in tests
- no behavior change when feature flags are off

Rollback boundary:

- easy rollback by disabling flags and ignoring unused tables/schemas

#### Milestone M1 — Handoff Compiler skeleton

Scope:

- create compiler entry point invoked from current handoff flow
- load transcript + `CharacterDraft`
- produce a minimal compiled artifact bundle
- emit structured diagnostics
- persist compiler outputs

Compiler outputs at this stage can be narrow:

- normalized protagonist summary
- initial entity candidates
- unresolved-item list
- opening-state package draft

Must not include:

- aggressive world mutation
- frontend semantic changes
- removal of current handoff fallback behavior

Acceptance criteria:

- compiler runs on handoff without breaking current flow
- artifacts are persisted and inspectable
- failures are surfaced explicitly
- when compiler is disabled, system behaves as before

Rollback boundary:

- turn off compiler feature flag and fall back to legacy handoff

#### Milestone M2 — Opening-state package becomes authoritative input

Scope:

- refine compiler so `opening_state_package` is sufficiently complete
- pass package output into Director startup path
- persist `director_startup_plan`
- attach package/dependency metadata to handoff logs/traces

At this milestone, the package is real and authoritative even if the opening-scene generation path is still partially compatibility-based.

Acceptance criteria:

- Director startup consumes package data instead of reconstructing most context from ad hoc summaries
- package version used for startup is logged and persisted
- tests show package completeness on representative fixtures

Rollback boundary:

- fallback to legacy Director startup input builder if package path misbehaves

#### Milestone M3 — Dedicated opening-scene generation path

Scope:

- add explicit orchestrator method for opening-scene generation
- call Key Animator through an opening-specific pathway
- persist `opening_scene_result` / failure report
- stop treating opening scene as a normal player turn internally

This is the milestone where the current fake input path should stop being primary.

Acceptance criteria:

- opening scene no longer depends on placeholder player input in the primary path
- opening-scene operation has its own traces/logging/artifacts
- retrying opening-scene generation can reuse existing package/startup artifacts

Rollback boundary:

- temporary compatibility fallback to synthetic-turn path remains available behind a flag

#### Milestone M4 — Frontend semantic cleanup

Scope:

- frontend waits for explicit opening-scene readiness
- API returns structured handoff/opening statuses
- user-visible failure/retry semantics become correct

Acceptance criteria:

- no gameplay transition when opening scene is unavailable unless explicitly intended
- frontend displays correct handoff state
- manual QA confirms no silent failed transition

Rollback boundary:

- frontend can temporarily tolerate both old and new response semantics

#### Milestone M5 — Handoff Compiler enrichment

Scope:

- better entity resolution
- contradiction handling
- canonicality divergence map
- richer faction/location/quest graph
- degraded-vs-blocked handoff policy

Acceptance criteria:

- dense transcript fixtures show materially better compiled outputs
- duplicate entity creation is reduced
- unresolved issues are surfaced in artifacts and logs

#### Milestone M6 — Session Zero Orchestrator MVP

Scope:

- live per-turn extractor/gap-analysis/resolution pipeline
- incremental graph updates persisted to artifact table
- improved follow-up question selection
- settings config for `sz_extractor`, `sz_gap_analyzer`, `sz_entity_resolver`
- handoff sequence reorganization (7-step order)
- memory integration: provisional writes per-turn + authoritative writes at handoff

Acceptance criteria:

- dense freeform user answers are captured earlier, not only at handoff
- phase progression quality improves on complex Session Zero transcripts
- post-handoff: canonical entities appear in `MemoryStore` with correct `memory_type` (tested with `MemoryStore.search()`)
- plot-critical facts from mid-SZ turns appear in `MemoryStore` before handoff
- Handoff Compiler receives `memory_store` and `state_manager` as injected dependencies (no singleton import inside compiler)

#### Milestone M7 — Full hardening and cleanup

Scope:

- broader settings/UI exposure for stabilized new agents
- resumability/checkpointing hardening
- specific error recovery behaviors per 4.1
- Langfuse trace coverage per 4.3
- compatibility-path removal and `detected_info` deprecation
- docs and final architecture cleanup

### 16.1.4 Recommended first real implementation slice

The recommended first coding milestone is:

**M0 + M1 + M2, with the dedicated opening-scene path included if the team is not intentionally optimizing for a thinner slice**

In practical terms, that means:

1. add concrete extraction schemas plus artifact persistence/schemas
2. add distinct Session Zero compiler-agent configuration plumbing
3. add a handoff compiler entry point behind a feature flag
4. compile an explicit `opening_state_package` with provenance
5. persist compiler diagnostics/artifacts
6. have Director startup consume package-derived inputs directly
7. prefer building the dedicated opening-scene path in the same implementation stream rather than treating it as optional cleanup

This is the best first slice because it:

- immediately improves the weak point the user identified: handoff quality
- preserves current Session Zero runtime while still delivering value
- creates the core artifacts everything else will depend on
- gives a strong debugging surface early
- keeps rollback simple

### 16.1.5 What should explicitly wait until later

These should **not** be in the first implementation slice:

- full Session Zero orchestrator rewrite
- broad frontend settings overhaul for every hypothetical helper agent
- heavy research/tool-use loops across multiple new agents
- fully automatic contradiction resolution policies
- major UX redesign of Session Zero screens

Those are important, but they are downstream work.

### 16.1.6 Suggested staffing / workstream decomposition

If multiple engineers are working in parallel, split like this:

#### Workstream A — contracts and persistence

- schemas
- migrations
- artifact repository/helpers
- status enums

#### Workstream B — handoff compiler

- compiler driver
- extraction/resolution passes
- opening-state package assembly
- diagnostics artifacts

#### Workstream C — opening bridge

- Director startup contract changes
- opening-scene generation path
- orchestrator bridge logic

#### Workstream D — frontend semantics

- response handling
- handoff status UI
- retry/error states

#### Workstream E — tests and fixtures

- transcript fixtures
- regression tests
- provider/config compatibility checks

This decomposition minimizes merge conflicts and makes dependencies clearer.

### 16.1.7 Acceptance gates by milestone

Before advancing from one milestone to the next, require these gates:

#### Gate A — artifact integrity

- artifacts persist correctly
- versioning behaves correctly
- stale/retry semantics are test-covered

#### Gate B — handoff correctness

- no duplicate export behavior
- opening-state package is complete enough for target fixtures
- errors are surfaced, not swallowed

#### Gate C — observability completeness

- Langfuse traces exist for new stages
- logs include version/status identifiers
- support engineers can inspect failure artifacts

#### Gate D — compatibility safety

- feature flags work
- old sessions still function
- rollback path is still available

### 16.1.8 Rollback and feature-flag strategy

Recommended flags:

- `sz_compiler_enabled`
- `sz_dedicated_opening_scene_enabled`
- `sz_orchestrator_enabled`

Rules:

- every flag should map to a genuine rollback boundary
- avoid combinatorial flag matrices that do not represent real deployment choices
- do not remove old code paths until at least one milestone later than the new path’s stabilization

### 16.1.9 Recommended first PR sequence

If executed as a series of PRs, use roughly this order:

1. PR 1: schemas, enums, flags, artifact tables, tests
2. PR 2: handoff compiler skeleton + persistence + traces
3. PR 3: opening-state package assembly + fixture tests
4. PR 4: Director startup integration with package
5. PR 5: dedicated opening-scene generation path
6. PR 6: frontend handoff semantics cleanup
7. PR 7+: compiler enrichment, orchestrator MVP, UI expansion

This is intentionally conservative.

### 16.1.10 Recommendation summary

Do **not** start with the sexy part.

Start with:

- schemas
- artifact persistence
- compiler skeleton
- opening-state package
- explicit status/trace surfaces

Then:

- upgrade Director input
- add dedicated opening-scene generation
- only after that, tackle the live Session Zero orchestrator

That sequence gives the project the highest chance of landing cleanly without context drift, half-integrated agents, or fragile frontend semantics.

---

## 17. Testing Strategy

This project needs a serious test matrix.

## 17.1 Unit tests

Add targeted unit tests for:

- schema validation for new Session Zero artifacts
- alias merge logic
- contradiction detection/resolution policy
- opening-brief assembly
- fallback model/provider resolution for new agents
- settings persistence for new agent config fields
- handoff status state machine

## 17.2 Integration tests (offline)

Use transcript fixtures covering:

- minimal guided Session Zero
- dense freeform worldbuilding
- multiple NPC introduction in one answer
- alternate-timeline canon divergence
- hybrid profile
- custom profile
- contradictory statements corrected later
- orphan facts / unnamed institutions / vague hooks

Validate:

- extracted state
- normalized entity graph
- compiler outputs
- opening-state package completeness
- no duplicate NPC/faction/location rows when rerun

## 17.3 Provider compatibility tests

For each new first-class configurable agent, ensure compatibility with:

- Google
- Anthropic
- OpenAI
- Copilot

This can be mostly contract tests around provider invocation patterns and schema handling, with live tests gated like existing `live` tests.

## 17.4 Frontend tests/manual QA checklist

Validate:

- settings UI shows new agents
- settings save/load round-trips correctly
- fallback behavior works when agent override unset
- gameplay transition waits for correct handoff state semantics
- opening scene appears correctly after compiled handoff

## 17.5 Regression tests

Must preserve:

- current simple guided Session Zero still works
- gameplay orchestrator unaffected
- settings save does not wipe active profile/session/campaign state
- provider changes still invalidate caches correctly

## 17.6 Focused sixth pass: fixture matrix, acceptance scenarios, and milestone test design

This section turns the testing strategy into a practical verification plan that matches the current repo test shape:

- offline pytest-first testing
- `MockLLMProvider` for deterministic agent behavior
- in-memory SQLite for most fast tests
- `live` marker for provider-backed validation
- `slow` marker for more expensive end-to-end flows

### 17.6.1 Test pyramid for this project

Use a deliberately uneven pyramid:

#### Layer A — fast unit tests

Purpose:

- validate schemas, transforms, merge rules, and status logic

Tools:

- pure pytest
- no real provider calls
- `MockLLMProvider` where agent invocation shape matters

#### Layer B — offline integration tests

Purpose:

- validate transcript-to-artifact behavior end to end
- validate handoff compiler and opening-package assembly
- validate persistence behavior using SQLite/in-memory test DB patterns already used in the repo

This should be the main workhorse layer.

#### Layer C — targeted contract tests

Purpose:

- verify provider/model/config compatibility boundaries
- verify new agent settings and fallback resolution
- verify API response semantics and frontend transition rules

#### Layer D — limited live tests

Purpose:

- catch provider-specific structured output quirks
- validate observability wiring and real invocation paths

These should remain gated with the existing `live` marker.

### 17.6.2 Required fixture taxonomy

Do not rely on only one or two transcript examples.

Create a named transcript-fixture library with stable IDs.

Recommended fixture families:

#### F1 — Minimal guided baseline

Shape:

- short, structured answers
- one protagonist
- no complex canon divergence

Purpose:

- preserve current “happy path”
- ensure new architecture does not regress the simplest flow

#### F2 — Dense freeform lore dump

Shape:

- player gives long answers with many facts in one message
- includes backstory, locations, organizations, rivalries, goals, and tone cues all together

Purpose:

- validate extraction breadth
- validate orphan-fact capture
- validate unresolved-item creation rather than silent dropping

#### F3 — Multi-NPC burst

Shape:

- several named NPCs introduced in one or two turns
- overlapping roles / relationships / aliases

Purpose:

- validate entity splitting vs merging
- validate duplicate prevention
- validate cast prioritization for opening package

#### F4 — Canon divergence / alternate timeline

Shape:

- explicit divergence from canon
- references to canon events that are changed, remixed, or prevented

Purpose:

- validate canonicality encoding
- validate “must not contradict” constraints
- validate opening package canon rules

#### F5 — Hybrid profile

Shape:

- multiple source influences
- mixed lore assumptions
- blended tone/composition constraints

Purpose:

- validate hybrid profile rules
- validate lore/faction normalization under mixed inputs

#### F6 — Custom profile / custom world

Shape:

- no dependable canon scaffolding
- world details come almost entirely from Session Zero

Purpose:

- ensure the system does not over-assume imported canon structure
- validate world-building capture in original settings

#### F7 — Contradiction with later correction

Shape:

- player says one thing early, later revises it

Purpose:

- validate contradiction detection
- validate preferred-latest vs explicit-merge policy
- validate artifact audit trail

#### F8 — Ambiguous/orphan hooks

Shape:

- unnamed institutions
- vague enemies
- partial memories
- implied relationships without stable names

Purpose:

- validate unresolved-item persistence
- ensure ambiguity is preserved rather than hallucinated away

#### F9 — Opening-scene-sensitive handoff

Shape:

- enough detail to make the opening scene highly constrained
- specific cast, location, tension, and forbidden contradictions

Purpose:

- validate `opening_state_package` completeness
- validate Director startup inputs
- validate opening-scene readiness semantics

#### F10 — Recovery / resume scenario

Shape:

- transcript plus partially completed artifacts/checkpoints

Purpose:

- validate staleness rules
- validate checkpoint resume behavior
- validate idempotent rerun behavior

#### F11 — OP Mode / power fantasy handoff

Shape:

- OP protagonist enabled with explicit composition preset
- tension source, power expression, and narrative focus all specified
- high power tier with signature abilities and explicit combat style
- faction-level scope (e.g., hidden ruler, political mover)

Purpose:

- validate OP mode state transfer through compiler and into gameplay tables
- validate composition/preset fields appear in opening-state package `tone_and_composition` section
- validate power tier calculation and transfer
- validate that OP-specific fields (`op_tension_source`, `op_power_expression`, `op_narrative_focus`, `op_preset`) propagate correctly through the compiler rather than being handled only by the legacy direct-write path

### 17.6.3 Artifact-level assertions per fixture

For each nontrivial fixture, do not only assert on prose.

Assert on persisted/structured outputs such as:

- `character_draft` updates
- normalized entity graph nodes
- normalized relationship edges
- contradiction records
- unresolved-item queue
- opening-state package sections
- handoff status
- artifact version increments
- export metadata

The whole point of this redesign is stronger structure; tests should prove structure, not merely text.

### 17.6.4 Golden artifact snapshots

Recommended approach:

- use golden JSON-style fixtures for selected compiled artifacts
- compare important structural subsets, not every incidental field

Good snapshot targets:

- opening-state package
- unresolved-items artifact
- alias/merge map
- ingestion plan

Avoid brittle full snapshots for:

- timestamps
- trace IDs
- verbose prose fields
- large freeform analysis strings

### 17.6.5 Milestone-to-test mapping

Tie tests directly to milestones so each milestone has a clear exit gate.

#### M0 test gates

- schema validation tests
- migration tests
- artifact repository read/write tests
- feature-flag default-behavior tests

#### M1 test gates

- handoff compiler runs on F1/F2/F3 fixtures
- artifacts persist correctly
- compiler failure surfaces explicit error state
- compiler-disabled mode preserves legacy behavior

#### M2 test gates

- F4/F5/F9 fixtures produce valid `opening_state_package`
- Director startup consumes package-derived inputs
- package completeness assertions pass

#### M3 test gates

- dedicated opening-scene generation path works on F1/F9
- retry path reuses existing package/startup artifacts
- no dependence on placeholder player input in primary flow

#### M4 test gates

- API status semantics tests
- frontend transition tests / manual QA
- no gameplay transition when opening scene is missing

#### M5+ test gates

- contradiction handling on F7
- unresolved preservation on F8
- resume/recovery behavior on F10
- denser entity graph quality checks on F2/F3/F5

### 17.6.6 Failure-injection scenarios

These are especially important given the recent streaming/provider issues.

Add tests for:

- provider call raises retryable connection error
- structured output parse fails
- compiler pass fails midway after writing earlier artifacts
- Director startup fails after package creation
- opening-scene generation fails after Director startup succeeds
- stale artifact detected after transcript mutation

Assert:

- correct status transitions
- retryability or failure classification
- persisted failure artifacts where applicable
- no silent gameplay transition

### 17.6.7 Idempotency and rerun tests

This redesign will fail in practice if reruns create duplicates.

Required rerun scenarios:

- rerun compiler unchanged input
- rerun compiler after small transcript append
- rerun export after prior successful export
- retry opening-scene generation without recompiling everything

Required assertions:

- no duplicate NPC/faction/location exports
- artifact versions advance as expected
- active artifact pointer updates correctly
- prior artifacts remain inspectable

### 17.6.8 Status-state machine tests

Add explicit tests for the new handoff/opening statuses.

Recommended state transitions to test:

- `not_ready -> compiling -> opening_package_ready`
- `opening_package_ready -> director_startup_ready -> opening_scene_generating -> opening_scene_ready`
- `compiling -> handoff_blocked`
- `opening_scene_generating -> opening_scene_failed`
- retry from `opening_scene_failed -> opening_scene_generating -> opening_scene_ready`

These should be tested independently of the frontend and again through API-level integration tests.

### 17.6.9 Provider/config compatibility matrix

Not every provider needs exhaustive scenario coverage for every fixture.

Recommended split:

#### Offline contract tests for all providers

Validate for each first-class new agent:

- model resolution order works
- per-agent override wins over tier default
- tier default wins over provider default
- structured schema invocation uses the correct provider path

#### Live smoke tests for representative paths

Run with `-m live` only:

- one handoff compiler structured-output smoke test per provider
- one Director startup smoke test on at least one non-default provider
- one opening-scene generation smoke test on at least one non-default provider

This keeps live cost contained while still protecting interoperability.

### 17.6.10 Frontend/API acceptance checklist

Manual or automated checks should validate:

- handoff response includes explicit statuses
- frontend does not advance to gameplay too early
- opening scene renders exactly once
- retry/recovery states are visible if scene generation fails
- settings UI does not lose existing agent config values
- new agent config controls respect fallback semantics

### 17.6.11 Observability acceptance checks

Tests/QA should verify not just behavior but supportability.

For selected milestone scenarios, confirm:

- expected Langfuse traces/spans exist
- spans carry session/package/version metadata
- failure paths log useful summaries
- persisted artifacts allow post-mortem debugging

This can be partly manual in early milestones, then automated where practical.

### 17.6.12 Recommended directory/fixture organization

Recommended shape:

- transcript fixtures in a dedicated Session Zero fixture directory
- artifact expectation helpers shared across compiler tests
- focused tests per milestone area rather than one giant end-to-end file

For example:

- `tests/session_zero/fixtures/...`
- `tests/session_zero/test_handoff_compiler.py`
- `tests/session_zero/test_opening_state_package.py`
- `tests/session_zero/test_status_state_machine.py`
- `tests/session_zero/test_resume_recovery.py`
- `tests/settings/test_session_zero_agent_models.py`

The exact filenames can vary, but the separation of concerns should remain.

### 17.6.13 Recommendation summary

The most important testing idea is this:

- **treat transcripts as fixtures**
- **treat compiled artifacts as the primary assertions**
- **treat live provider tests as narrow smoke tests**

That gives this project a realistic, maintainable test strategy aligned with the current repo’s pytest + mock-provider setup, while still being strong enough for a major architecture upgrade.

---

## 18. Risks and Mitigations

## 18.1 Scope explosion

Risk:

- too many new agents and surfaces at once

Mitigation:

- stage implementation
- reuse existing agents where possible
- only promote high-value components to first-class configurable agents

## 18.2 Settings/UI sprawl

Risk:

- too many Session Zero-specific agent dropdowns crowd settings UI

Mitigation:

- group under Session Zero subsection
- optionally collapse advanced SZ agents behind a subpanel
- keep distinct Session Zero agent config entries rather than hiding them behind shared `session_zero` config reuse
- rely on existing tier defaults plus nested advanced per-agent overrides to keep the UX manageable

## 18.3 Provider incompatibility / schema fragility

Risk:

- different providers behave differently under large structured extraction tasks

Mitigation:

- keep new first-class agents on `BaseAgent`/`AgenticAgent`
- use validator repair and retry infrastructure
- keep extraction schemas focused and bounded by pass
- avoid one giant schema for everything

## 18.4 Long-running handoff latency

Risk:

- multi-pass compiler slows handoff noticeably

Mitigation:

- checkpoint passes
- parallelize safe subpasses where possible
- surface `handoff_status=compiling`
- design the handoff runtime as async-capable/stateful from the start, even if the initial frontend waits on completion
- reuse the existing progress bar/status UI so the user sees real handoff stages rather than a frozen request

## 18.5 Duplicate/inconsistent persistence

Risk:

- compiler reruns create duplicate DB entities or conflicting memories

Mitigation:

- make writes idempotent
- use canonical IDs and merge history
- separate “proposed compiled state” from “applied gameplay state” until finalize step

## 18.6 Orchestrator/compiler mismatch

Risk:

- Session Zero runtime accumulates one shape of state while compiler expects another

Mitigation:

- define shared schemas first in Phase 0
- route both systems through same entity/briefing contracts

---

## 19. Recommended Feature Flags

Introduce flags/env settings to roll out safely:

- `SESSION_ZERO_COMPILER_ENABLED`
- `SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED`
- `SESSION_ZERO_ORCHESTRATOR_ENABLED`

Recommended interpretation:

- compiler flag covers transcript-wide compilation, opening package generation, and richer handoff status payloads
- dedicated opening-scene flag covers the explicit Director/KA opening-scene path
- orchestrator flag covers the live Session Zero turn-pipeline rewrite

Use them to ship incrementally without creating an unnecessary flag matrix.

---

## 20. Concrete First Implementation Slice

If a stranger picked this up tomorrow, the recommended first coding slice would be:

1. add concrete Session Zero extraction schemas plus artifact schemas and persistence scaffold
2. add distinct configurable agent plumbing end-to-end for:
   - `sz_extractor`
   - `sz_gap_analyzer`
   - `sz_entity_resolver`
   - `sz_handoff`
   - settings model
   - settings route validation
   - UI dropdowns
3. implement Handoff Compiler over the full transcript with provenance and chunk-aware extraction/reconciliation support
4. wire compiler into `api/routes/game/session_zero.py` before Director startup / opening scene
5. generate and pass opening-state briefing package into the handoff/opening-scene path
6. build the dedicated opening-scene generation path as the intended runtime contract
   - keep the synthetic opening turn only as temporary fallback during rollout
7. reuse the existing progress-bar/status UI pattern so handoff stages are visible to the player
8. add regression tests using dense freeform Session Zero transcripts

This yields immediate value and creates the substrate for the full orchestrator upgrade.

---

## 21. Definition of Done (Full Project)

This project is done when all of the following are true:

- Session Zero live runtime can robustly extract dense freeform player input across multiple turns
- handoff compiler performs transcript-wide recovery, deduplication, enrichment, and normalization
- opening-state package is the authoritative input to Director + Key Animator opening-scene generation
- new first-class Session Zero agents respect per-agent config, tier fallback, all four providers, and settings UI exposure
- observability/logging spans exist for critical Session Zero and handoff passes
- hybrid/custom/alternate-timeline cases are materially more coherent than current system
- frontend no longer transitions as if opening scene succeeded when handoff is incomplete or failed
- tests cover both sparse and dense Session Zero patterns

---

## 22. Post-Review Decisions to Treat as Locked Unless New Evidence Appears

The following decisions have effectively been made during architecture review and should be treated as defaults for implementation:

1. `sz_extractor`, `sz_gap_analyzer`, `sz_entity_resolver`, and `sz_handoff` remain distinct configurable Session Zero components rather than being collapsed for convenience.
2. The current settings architecture is already sufficient to expose these components cleanly via tier defaults plus nested advanced per-agent overrides.
3. Recommended default tiers:
   - `session_zero`: thinking
   - `sz_extractor`: thinking
   - `sz_gap_analyzer`: thinking
   - `sz_entity_resolver`: fast by default, overrideable upward
   - `sz_handoff`: thinking
4. Storage should use new `session_zero_artifacts` plus a minimal `session_zero_runs` ledger rather than overloading the live `session_zero_states` blob.
5. Handoff runtime should be async-capable/stateful from the start and should surface staged progress using the existing progress-bar UX pattern.
6. The dedicated opening-scene path is the intended architecture; the synthetic opening turn may remain only as a temporary fallback during rollout.
7. The compiler should consume the full Session Zero transcript with provenance and support chunk-aware reconciliation because current gameplay compaction does not directly protect the handoff stack.
8. Ambiguity policy should use three buckets:
   - trivial/high-confidence normalization → auto-resolve
   - moderate gaps → ask player whether to provide detail or allow reasonable gap-filling, with explicit `safe_assumptions`
   - canon/identity/opening-critical contradictions → block until resolved
9. Extended thinking eligibility should be tier-driven (THINKING_TIER and CREATIVE_TIER members are eligible), not maintained as a separate hardcoded list in `BaseAgent.call()`.
10. Export from compiled artifacts to gameplay SQL tables must be transactional — a single DB transaction wrapping all gameplay-table mutations, with full rollback on failure.
11. `detected_info` remains the live-turn extraction format until the Orchestrator rewrite (M6). The compiler treats it as one input alongside the raw transcript, not as the authoritative source. The compiler's own extraction schemas are the authoritative output format.
12. The Handoff Compiler runs after `reset_orchestrator()` and receives memory store and state manager as explicit injected dependencies to avoid singleton lifecycle race conditions.
13. Latency from multi-pass compiler pipeline is accepted as a tradeoff for quality. No hard latency ceiling. Progress UI surfaces staged status to the player. If latency becomes a problem in practice, it will be addressed operationally (parallelization, tier adjustment) rather than by cutting compiler passes.

---

## 23. Bottom-Line Recommendation

Build this in two stacked layers:

- **first**: a transcript-wide multi-pass Handoff Compiler
- **then**: a full Session Zero Orchestrator that uses the same schemas/contracts during live conversation

That gets the benefits of both requested directions without forcing an all-at-once rewrite.
