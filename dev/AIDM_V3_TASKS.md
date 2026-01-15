# AIDM v3 Implementation Tasks

> **Philosophy:** Prove core loop first, add complexity only when needed.
> Each phase should produce a playable (if limited) system.

> **Last Audit:** January 3, 2026 (OP/Ensemble/NPC Audits)
> **Audit Source:** [op_ensemble_audit.md](../../../.gemini/antigravity/brain/a8297f15-e2f1-49ce-8449-cea0419a72c7/op_ensemble_audit.md)

---

## Phase 1: Core Loop MVP ✅ (95%)

**Goal:** Does Intent → Outcome → Key Animator → State feel like anime?

**Skip for now:** Sakuga, Memory, Director, multiple profiles

- [x] **Database Setup**
  - [x] Create SQLite schema for characters, NPCs, world_state
  - [x] Implement basic CRUD operations
  - [x] Session/campaign management (via SQLAlchemy models)

- [x] **Single Profile**
  - [x] Define YAML schema for narrative profiles
  - [x] Create HunterXHunter profile (tactical, well-defined)
  - [x] Implement profile loader

- [x] **Core Agents**
  - [x] Intent Classifier - parse player action
  - [x] Outcome Judge - should this succeed? how dramatically?
  - [x] Key Animator - generate narrative (with Vibe Keeper prompt)

- [x] **Multi-Provider LLM Support**
  - [x] Google Gemini (gemini-3-flash, gemini-3-pro)
  - [x] Anthropic Claude (haiku-4-5, sonnet-4-5, opus-4-5)
  - [x] OpenAI GPT (gpt-5.2-chat, gpt-5.2-pro)
  - [x] Per-agent model selection (settings system)
  - [x] Extended thinking support for all providers *(Fixed Jan 2026)*

- [x] **Code Layer**
  - [x] State read/write
  - [x] Turn commit
  - [x] **Dice engine** ✅ (Completed Jan 1, 2026)
    - [x] Basic d20, dice pools, modifiers
    - [x] Advantage/disadvantage rolls (`RollType` enum)
    - [x] Critical hit/miss handling (`CriticalEffect` model)
    - [x] Profile-specific modifiers (DNA-based bonuses)

- [x] **Interface**
  - [x] CLI chat loop
  - [x] Debug output (show agent decisions)
  - [x] Web UI with debug HUD

- [x] **Settings System**
  - [x] Per-agent model configuration
  - [x] Encrypted API key storage (Fernet)
  - [x] Web UI settings page

- [x] **Vibe Test**
  - [x] 5 manual test turns
  - [x] Does it feel like HxH? ✅ Nen concepts, tactical analysis, creature design

---

## Phase 2: Context Layer (95% Complete) ✅

**Goal:** Does it remember past events and adapt to profile style?

**Add:** Memory Store, Rule Library, Context Selector

- [x] **Memory Store** ✅
  - [x] ChromaDB setup (`src/context/memory.py`)
  - [x] Vector search retrieval (basic)
  - [x] **Heat decay system** ✅ (Implemented Jan 1, 2026)
    - [x] Configurable decay curves per memory type (none/slow/normal/fast)
    - [x] Heat boost on re-access (+20 per access)
    - [x] Threshold-based pruning (`min_heat` filter)
  - [ ] **Memory categories** - enforce 6-category structure per M02:
    - [x] Core (origins/abilities) - via `decay_rate="none"`
    - [x] Character State (HP/MP/SP/inventory) - via `decay_rate="fast"`
    - [x] Relationships (affinity/history) - via `decay_rate="slow"`
    - [x] Quests (objectives/consequences) - via `decay_rate="normal"`
    - [x] World State (time/politics/environment) - via `decay_rate="normal"`
    - [x] Consequences (moral choices/reputation) - via `decay_rate="slow"`
  - [x] **Memory compression** ✅ (Implemented Jan 1, 2026)
    - [x] `compress_cold_memories()` method in MemoryStore
    - [x] Groups cold memories by category
    - [x] LLM summarization via context_selector model
    - [x] Replaces originals with compressed summaries
    - [x] Integrated into Orchestrator (every 10 turns)
  - [x] **Memory threads** - group related memories (via ensemble archetypes)

- [x] **Rule Library (RAG)** ✅ (Implemented Jan 1, 2026)
  - [x] Create `rule_library/` directory structure per Tech Spec
  - [x] YAML chunk files created:
    - [x] `scales.yaml` - 9 narrative scale chunks
    - [x] `archetypes.yaml` - 9 OP archetype technique chunks
    - [x] `ceremonies.yaml` - 11 tier transition ceremony chunks
    - [x] `dna_scales.yaml` - 14 DNA narration guidance chunks
  - [x] Implement `rule_library.py`:
    - [x] YAML loader for chunks
    - [x] Vector indexing with ChromaDB
    - [x] Category-based retrieval

- [x] **Memory Ranker Agent** ✅ (Enhanced Jan 2026)
  - [x] LLM-based relevance scoring (0.0-1.0)
  - [x] Score validation and clamping
  - [x] Reason tracking for rankings
  - [ ] Explicit heat-weighted scoring (heat visible in prompt, not in sort)

- [x] **Context Selector Agent** ✅ (Enhanced Jan 2026)
  - [x] Base context assembly
  - [x] Rule Library integration (`get_relevant_rules()`)
  - [x] **Dynamic memory tiering** (3/6/9 candidates based on intent)
  - [x] Intent-aware tier boosting (combat, special conditions)
  - [ ] Token budget enforcement
  - [ ] Explicit DNA injection (done via profile loading)

- [ ] **Vibe Test**
  - [ ] Same 5 turns as Phase 1
  - [ ] Does retrieved context improve feel?
  - [ ] Create 5+ golden set entries

---

## Phase 3: Full Agent Layer (95% Complete) ✅

**Goal:** Does it make good decisions across all situations?

**Add:** Sakuga, Validation, judgment agents, more profiles

> **Philosophy (Dec 2025):** Fast models with 100% schema compliance. 
> Use structured LLM calls for all judgment, not Python plugins.

- [x] **Sakuga Interceptor** ✅ (Integrated Jan 1, 2026)
  - [x] `SakugaAgent` class with prompts/sakuga.md
  - [x] "Is this moment epic?" detection (climactic, combat, nat 20)
  - [x] Routing in Orchestrator (sakuga vs key_animator)
  - [x] XP bonus for sakuga moments in ProgressionAgent

- [x] **Validation Agent** ✅ (Enhanced Jan 1, 2026 with M10)
  - [x] Resource checks, target existence
  - [x] Research validation
  - [x] JSON repair capability
  - [x] Coherence checking
  - [x] **Error severity classification** (CRITICAL/MAJOR/VALIDATION/MINOR/TRIVIAL)
  - [x] **Pre-action validation** (resource costs, skill ownership, NPC state)
  - [x] **Post-action validation** (bounds checking, state integrity)
  - [x] **Confidence-based auto-recovery**
  - [x] **Session health check**

- [x] **Scale Selector Agent** ✅ (Implemented Jan 1, 2026)
  - [x] 9 narrative scales (tactical, ensemble, spectacle, etc.)
  - [x] Power imbalance calculation
  - [x] Narration technique guidance per scale

- [x] **NPC Reaction Agent** ✅ (Implemented Jan 1, 2026)
  - [x] Disposition system (-100 to +100)
  - [x] Dialogue style guidance per disposition level
  - [x] Secret reveal thresholds (60+)
  - [x] Quick change calculator

- [x] **Combat Agent** ✅ (Implemented Jan 1, 2026)
  > Per M08: Full JRPG combat with LLM judgment
  - [x] `CombatAction`/`CombatResult` schemas
  - [x] Action parsing (attack/spell/skill/defend/flee)
  - [x] LLM-based outcome judgment
  - [x] Damage calculation with profile modifiers
  - [x] Sakuga moment detection
  - [x] Named attack detection
  - [x] Integrated with Orchestrator

- [x] **Progression Agent** ✅ (Implemented Jan 1, 2026)
  > Per M09: XP curves, leveling, skill acquisition
  - [x] XP curves (fast/moderate/slow)
  - [x] XP source multipliers (combat/boss/quest/roleplay/sakuga)
  - [x] Level-up detection and handling
  - [x] Tier shift detection (every 5 levels)
  - [x] LLM-generated ability unlocks
  - [x] Profile-specific growth models
  - [x] Integrated with Orchestrator

- [x] **Additional Profiles** ✅ (Enhanced Jan 2, 2026)
  - [x] AttackOnTitan (dark, tactical) - 10 lore chunks
  - [x] GurrenLagann (hype, spirit) - 9 lore chunks, 11 DNA scales
  - [x] DeathNote (psychological, mystery) - lore chunks
  - [x] Naruto (shonen, ninja) - lore chunks
  - [x] **Dynamic Profile Generation** - users can say any anime name → auto-research + save!
  - [x] **Custom/Original Profiles** - session-scoped storage for original worlds
  - [x] **Hybrid Profile Support** - blending multiple anime treated as custom

- [ ] **Golden Set Testing**
  - [ ] 20+ entries per profile
  - [ ] LLM-as-judge scoring
  - [ ] Target: 7+ average

---

## Phase 4: The Showrunner (Director Layer) ✅ (100% Complete)

**Goal:** Does it plan long-term and manage campaign arcs?

**Note:** Could ship v3.0 without this. Only needed for multi-session campaigns.

- [x] **Director Agent** ✅ (Wired Jan 2, 2026)
  - [x] System prompt (swappable per profile)
  - [x] Dynamic persona injection (`system_prompt_override`)
  - [x] Session-end review trigger (`SessionManager.run_session_end_review()`)
  - [x] Every-5-turn check-in (Orchestrator, with WorldState + spotlight debt)

- [x] **Campaign Bible** ✅ (Wired Jan 2, 2026)
  - [x] `CampaignBible` model in database
  - [x] `planning_data` JSON field
  - [x] Arc tracking (phase persisted to WorldState)
  - [x] Spotlight debt injection from NPC scene counts
  - [x] Persistence of Director output

- [x] **Foreshadowing Ledger** ✅ (Implemented Jan 1, 2026)
  - [x] `ForeshadowingSeed` model with status tracking
  - [x] Seed planting (`plant_seed()`)
  - [x] Callback detection (`check_callback_ready()`, `get_callback_opportunities()`)
  - [x] Overdue alerts (`get_overdue_seeds()`)
  - [x] Director context generation (`generate_director_context()`)
  - [x] Narrative detection (`detect_seed_in_narrative()`)
  - [x] Integrated with Orchestrator

- [x] **Spotlight Tracker** ✅ (Wired Jan 2, 2026)
  - [x] `scene_count` and `last_appeared` in NPC model
  - [x] `spotlight_debt` in DirectorOutput
  - [x] Aggregation logic (`StateManager.compute_spotlight_debt()`)
  - [x] `increment_npc_scene_count()` for tracking

- [x] **Player Calibration** ✅
  - [x] Feedback signal collection (via `CalibrationResult`)
  - [x] DNA adjustment recommendations (via `CalibrationAgent`)
  - [x] Tone Gatekeeping (Accept/Reject based on Profile)
  - [x] Style Guide Generation (Instructional Prompting)

---

## Phase 4.5: Profile Generation & Research ✅ (Complete)

**Goal:** Create new profiles from Anime Research (Validation & Calibration).

- [x] **Research Agent**
  - [x] Web Search integration (Google Search / Anthropic)
  - [x] Training Data fallback
  - [x] Recursive scraping strategy

- [x] **Profile Generator**
  - [x] Extract DNA Scales, Tropes, Power Systems
  - [x] Generate compact YAML (compatible with v3 Loader)
  - [x] Generate Mechanics/Stats scaffolding

- [x] **RAG Integration**
  - [x] `ProfileLibrary` (ChromaDB) for raw lore storage
  - [x] Ingestion of research text (`_lore.txt`)

- [x] **Validator System**
  - [x] JSON Repair (Self-healing mechanism)
  - [x] Research completeness check

---

## Phase 5: Polish & Production (90% Complete)

**Goal:** Production-ready for external users.

- [x] **Web UI**
  - [x] Chat interface
  - [x] Debug HUD (state, decisions, costs)
  - [ ] Profile selector + campaign management
  - [ ] Campaign creation wizard
  - [ ] Character sheet viewer

- [x] **Session Management** ✅ (Implemented Jan 1, 2026)
  - [x] Save/load campaigns (export/import JSON via `SessionManager`)
  - [x] `CampaignExport` schema with full state
  - [x] "Previously on..." generation (`generate_previously_on()`)
  - [x] Session end with summary (`end_session()`)

- [x] **Session Persistence** ✅ (Implemented Jan 2, 2026)
  - [x] SQLite backend for session storage (`SessionStore`)
  - [x] Browser localStorage for session ID
  - [x] Auto-resume on page load
  - [x] Session reset button with confirmation
  - [x] Custom profile cleanup on reset

- [x] **Error Recovery** ✅ (Implemented Jan 1, 2026 - M10 Spec)
  - [x] Error severity classification (CRITICAL/MAJOR/VALIDATION/MINOR/TRIVIAL)
  - [x] Pre-action validation (resource costs, skill ownership)
  - [x] Post-action validation (state integrity)
  - [x] Confidence-based auto-recovery (≥0.8 = auto-fix)
  - [x] Session health check summary
  - [x] Integrated with Orchestrator combat loop

- [x] **State Transaction Layer** ✅ (Implemented Jan 1, 2026)
  > Per M03: All state modifications use Change Log format
  - [x] Implement `StateTransaction` class (state_transaction.py)
  - [x] Change Log format: `operation`, `before`, `after`, `delta`, `reason`, `validated`
  - [x] Before-value verification (detect desyncs)
  - [x] Atomic transactions (all succeed or rollback)
  - [x] Constraint validation pre-commit
  - [x] StateManager integration (`begin_transaction`, `get_value`, `set_value`)
  - [x] **Narrative Override System** ("narrative defines the rules")
    - [x] `NarrativeOverrideResult` model (allow_override, narrative_cost, trope_match)
    - [x] `ValidatorAgent.judge_narrative_override()` - LLM judgment for 'push beyond limits'
    - [x] `override_candidates` in ValidationResult for constraint violations

- [x] **Optimization** ✅ (Verified Jan 2, 2026)
  - [x] Prompt caching - **Handled by providers!**
    - Google, Anthropic, OpenAI all have built-in prompt caching
    - No manual implementation needed
  - [x] Parallel agent execution - **Already working!**
    - Using `asyncio.gather()` in Orchestrator
    - Intent + Base Context run in parallel
    - Memory Ranking + Outcome Judge run in parallel
  - [ ] Token/cost monitoring:
    - [ ] Per-turn cost tracking
    - [ ] Session cost summary
    - [ ] Budget alerts

- [ ] **Human Testing**
  - [ ] 5 testers × 5 profiles × 1 session
  - [ ] Post-session survey
  - [ ] Iterate on failures

---

## Phase 6: Multimodal & Voice (Future)

**Goal:** Rich media input/output for immersive storytelling experience.

> **Note:** Planned for future versions. Requires multimodal LLM capabilities.

- [ ] **Multimodal Input**
  - [ ] Image uploads (scene reference, character art)
  - [ ] Image analysis for world-building context
  - [ ] Vision integration with scene descriptions

- [ ] **Multimodal Output**
  - [ ] AI-generated scene illustrations
  - [ ] Character portrait generation
  - [ ] Key moment visualizations (manga-style panels)
  - [ ] Map/location imagery

- [ ] **Voice Input**
  - [ ] Speech-to-text for player actions
  - [ ] Voice command parsing
  - [ ] Natural language voice controls

- [ ] **Voice Output (TTS)**
  - [ ] Narrative read-aloud
  - [ ] NPC voice differentiation
  - [ ] Ambient scene descriptions
  - [ ] Support for multiple TTS providers (ElevenLabs, OpenAI TTS, etc.)

- [ ] **Audio & Ambiance**
  - [ ] Background music selection per scene mood
  - [ ] Sound effect triggers for actions
  - [ ] Voice-acted NPC dialogue

---

## Gaps Summary (Priority Order)

> **Updated:** January 3, 2026 - All Module 12 systems (OP Mode, Ensemble, Scaling) verified 100% complete!

### ✅ Completed This Session (Jan 1-3, 2026)

| Item | Phase | Description |
|------|-------|-------------|
| Session Persistence | 5 | SQLite + localStorage, auto-resume, reset button |
| Profile Persistence | 4.5 | Auto-save + RAG indexing for researched anime |
| Custom/Hybrid Profiles | 4.5 | Session-scoped storage for original/blended worlds |
| Dynamic Memory Tiering | 2 | 3/6/9 candidates based on intent complexity |
| Optimization (Caching/Parallel) | 5 | Provider-handled caching, asyncio parallel exec |
| **Director Wiring** | 4 | ✅ Session-end review, every-5-turn check, arc persistence |
| **Spotlight Aggregation** | 4 | ✅ `compute_spotlight_debt()`, NPC scene tracking |
| **Party Detection** | 4 | ✅ `has_party`, `party_tier_delta` in GameContext |
| **OP Protagonist Mode** | 4 | ✅ 9 archetypes, Progressive OP Mode, all wired |
| **Ensemble Mode** | 4 | ✅ 100% complete with party detection |
| **Ceremony RAG Wiring** | 2 | ✅ `get_by_id()` for exact lookup in RuleLibrary |

### 🔸 High (Completes Core Experience)

| Gap | Phase | Description | Estimated Effort |
|-----|-------|-------------|------------------|
| Token/Cost Monitoring | 5 | Per-turn tracking, session summary, budget alerts | 0.5 day |
| Golden Set Testing | 3 | 20+ entries per profile, LLM-as-judge scoring | 2 days |

### 🟢 Medium (Nice to Have)

| Gap | Phase | Description | Estimated Effort |
|-----|-------|-------------|------------------|
| Session Zero Animation Polish | 5 | Manga-style reveals, floating questions, comic cuts | 1-2 days |
| Character Sheet Viewer | 5 | Web UI for viewing character state | 0.5 day |
| Vibe Test Suite | 2 | 5+ golden set entries for context testing | 1 day |
| ~~Profile Selector UI~~ | 5 | *Not needed - users say anime name in Session Zero* | - |
| ~~Campaign Creation Wizard~~ | 5 | *Session Zero IS the wizard!* | - |

---

## Recommended Next Sprint

**Focus: Polish & Testing**

1. [x] ~~Director Session-End Review~~ ✅ Done
2. [x] ~~Arc Tracking in Campaign Bible~~ ✅ Done
3. [x] ~~Spotlight Aggregation~~ ✅ Done
4. [ ] Token/Cost Monitoring - Per-turn tracking for budget awareness
5. [ ] Golden Set Testing - Human verification of agent outputs
6. [ ] Session Zero Animation Polish - Manga-style reveals

---

## Reference Links
- [AIDM v3 Project Plan](./AIDM_V3_PROJECT_PLAN.md)
- [AIDM v3 Tech Spec](./AIDM_V3_TECH_SPEC.md)
- [AIDM v2 Instructions Summary](../docs/aidm_instructions_summary.md)
- [Original v2 Instructions](../aidm/instructions/)
- [v3 Implementation Audit](../../../.gemini/antigravity/brain/a8297f15-e2f1-49ce-8449-cea0419a72c7/v3_implementation_audit.md)
