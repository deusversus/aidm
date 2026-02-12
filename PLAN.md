# AIDM v3: Comprehensive Gap Analysis & Remediation Plan

> **Goal:** IP-authentic, coherent long-form storytelling.
> Every item below is framed as Problem → Proposed Solution to seed dialectic.

### Status Legend
| Badge | Meaning |
|---|---|
| ✅ DONE | Completed in recent sessions |
| 🔧 PARTIAL | Partially implemented |
| 🔥 HIGH PRIORITY | Top 5 impact items |

---

## I. STRUCTURAL / ARCHITECTURAL (The Director Problem)

### 1. The Director is Retrospective, Not Proactive

**Problem:** The Director runs *after* narrative is returned to the player (`asyncio.create_task` in background, `orchestrator.py:728-740`). It fires every 3-8 turns based on accumulated epicness or elapsed time (`orchestrator.py:963-987`). This means it's perpetually one turn behind: if the player derails the arc at turn 3, the Director doesn't notice until turn 8+, leaving turns 3-8 narratively adrift. The KeyAnimator receives `director_notes` as raw text, not structured pacing directives.

**Proposed Solution:** Split the Director into two phases:
- **Pre-turn micro-check** (fast model, <500ms): Before KeyAnimator, evaluate whether the player's intent aligns with or disrupts the current arc. Produce a structured `PacingDirective` (not free text) with fields like `arc_beat: str`, `escalation_target: float`, `must_reference: List[str]`, `avoid: List[str]`. This is a lightweight classifier, not a full planning pass.
- **Post-turn full review** (current behavior): Keep the existing background planning for Campaign Bible updates, foreshadowing review, and spotlight rebalancing.

**Tension to resolve:** Does a pre-turn Director add unacceptable latency? Can the micro-check be parallelized with memory retrieval?

> **🔥 Engineer review:** Highest-impact item in the plan. Frame the micro-check as **structured extraction** (not generation) — it reads existing Bible + WorldState and outputs a decision tree via tool-use on Haiku/Flash, not prose. Can parallelize with memory retrieval (already ~300ms). Net critical path addition: **~200ms**. The latency question is answerable: current turn time 2-4s → 2.2-4.2s. Acceptable.

---

### 2. Campaign Bible is Unstructured and Overwritten

**Problem:** The Campaign Bible is a single JSON blob (`models.py: CampaignBible.planning_data = Column(JSON, default=dict)`) overwritten entirely on each Director pass (`orchestrator.py:1042-1046`). Previous plans are lost — no versioning, no diffing, no arc history. The schema is whatever `DirectorOutput.model_dump()` happens to produce.

**Proposed Solution:**
- Define a **versioned Bible schema** with explicit sections: `arc_history: List[Arc]`, `active_threads: List[Thread]`, `resolved_threads: List[Thread]`, `character_arcs: Dict[str, CharacterArc]`, `world_state_changelog: List[StateChange]`.
- Each Director pass **appends** to `arc_history` and **updates** `active_threads` rather than overwriting everything. Previous arc entries become immutable.
- Add a `bible_version: int` field that increments on each update.

**Tension to resolve:** Schema rigidity vs. the flexibility the Director needs to express novel narrative structures. Should the schema be partially open (fixed keys + freeform `notes` field)?

> **Engineer review:** Agree, but scope carefully. The full schema (`arc_history`, `active_threads`, `resolved_threads`, `character_arcs`, `world_state_changelog`) is a campaign management system. **Start with two changes only:** (1) Add `bible_version: int` to CampaignBible model, (2) Append to `arc_history` instead of overwriting — store last 5 Director outputs with turn numbers. Build the full thread schema only after #1 lands and the Director actually produces structured thread data.

---

### 3. Arc Pacing Has No Structural Gates

**Problem:** `arc_phase` is a string field on WorldState (`"setup"`, `"rising_action"`, `"climax"`, `"resolution"`) updated only by the Director asynchronously. There are no gates — nothing prevents the arc from sitting in `"rising_action"` for 50 turns, and nothing forces a climax. The KeyAnimator sees the phase but has no obligation to honor it.

**Proposed Solution:**
- Define **arc gate conditions** in the Campaign Bible: e.g., `climax_trigger: "When foreshadowing seed X resolves OR tension > 0.8 for 3+ turns"`.
- The pre-turn Director micro-check evaluates gate conditions each turn.
- When a gate fires, the `PacingDirective` includes `phase_transition: "rising_action" → "climax"` as a **hard constraint** that KeyAnimator must acknowledge in prose (e.g., "this is a turning point" beat).
- Add `turns_in_phase: int` to WorldState for the Director to track pacing drift.

**Tension to resolve:** Hard gates risk feeling mechanical. Should gates be "strong suggestions" or actual constraints? How does the player retain agency to delay or accelerate?

> **Engineer review:** Add `turns_in_phase: int` to WorldState. Design PacingDirective with a `strength` field (`suggestion | strong | override`) so the Director can escalate from nudge to hard constraint when stalls persist. All three strengths ship when PacingDirective ships — no incremental rollout. Gate evaluation logic lives in the pre-turn micro-check.

---

## II. MEMORY & CONTINUITY (The Forgetting Problem)

### 4. Narrative Prose is Never Indexed to Long-Term Memory 🔥

**Problem:** KeyAnimator's output goes into the sliding window (15 messages) and `Turn.narrative` (SQL archive), but is **never stored in ChromaDB** as a retrievable memory (`memory.py` — no `add()` call for narrative content). The system can recall "Alice's affinity is +45" but cannot recall "the specific scene where Alice opened up about her past." Emotional texture — the basis of callbacks — is lost to compaction, reduced to ~200-word summaries.

**Proposed Solution:**
- After each turn, run a **lightweight extraction pass** (fast model) on KeyAnimator's output to identify:
  - Emotional beats (moments of vulnerability, humor, tension)
  - Dialogue highlights (distinctive lines worth recalling)
  - Sensory/atmospheric details tied to locations
  - Character-defining moments
- Store these as ChromaDB memories with category `"narrative_beat"`, decay rate `"slow"`, and tags linking to NPCs/locations involved.
- Budget: 2-3 extracted memories per turn, each 1-2 sentences.

**Tension to resolve:** This adds an LLM call per turn. Can it piggyback on existing background processing (entity extraction already runs)? Is there a risk of "memory pollution" where mundane narration gets indexed?

> **🔥 Engineer review:** Highest ROI item in the entire plan. **Zero additional LLM calls needed** — piggyback on the existing `_bg_extract_entities` pass (runs every turn). Expand the entity extraction prompt to also emit 2-3 "narrative beats" stored as ChromaDB memories tagged `narrative_beat` with slow decay and NPC/location tags. This alone probably delivers more narrative quality improvement than items 1-3 combined.

---

### 5. 15-Message Working Memory Window is Aggressively Short

**Problem:** `WINDOW_SIZE = 15` in `game.py:1317` means ~7-8 player+DM exchanges before compaction kicks in. At 5-minute turns, that's ~40 minutes of verbatim context. Compaction preserves emotional texture but loses specific dialogue, callbacks, and atmospheric details. By turn 50, turns 1-35 exist only as compacted beats (~200 words each) or decayed ChromaDB entries.

**Proposed Solution:**
- Increase `WINDOW_SIZE` to 20-25 (test for context budget impact).
- Introduce a **"pinned messages"** mechanism: the Director or player can flag specific exchanges as pinned — they stay in working memory regardless of window position (up to 5 pinned exchanges).
- Add a **"deep recall"** tool to KeyAnimator's GameplayTools: when generating narrative, KeyAnimator can explicitly search `Turn.narrative` in SQL for specific past scenes (currently this data exists but is inaccessible to agents).

**Tension to resolve:** Larger windows increase token cost per turn. Pinned messages add complexity. Is the real fix better compaction rather than a wider window?

> **Engineer review:** Increase `WINDOW_SIZE` to 20. Build **both** pinned messages and deep recall (#30) — they solve different problems. Deep recall is reactive (agent must decide to search). Pinned messages are proactive (critical exchanges always present regardless of whether the agent thinks to look). The failure mode of reactive-only: KeyAnimator generates a scene without callbacks because it didn't know to search for the emotionally significant moment. Both ship in Phase 3.

---

### 6. No Automatic Plot-Critical Detection

**Problem:** `mark_plot_critical()` in `memory.py:466-484` requires **explicit marking**. If a memory isn't flagged, it decays normally. Session Zero memories auto-get the flag, but gameplay-discovered plot points (twists, revelations, betrayals) rely on someone calling `mark_plot_critical()` — which nothing in the turn loop does.

**Proposed Solution:**
- Add plot-critical detection to the **existing background entity extraction** pass. When extracting entities from narrative, also classify whether the turn contains a plot-critical revelation (simple binary classifier on the fast model).
- If detected, auto-flag the turn's event memory and any related memories as `plot_critical`.
- The Director should also be able to retroactively flag memories during its review pass via a `mark_memory_critical` tool.

**Tension to resolve:** False positives (flagging mundane events as critical) waste the immortality budget. False negatives defeat the purpose. What's the right threshold?

---

### 7. Heat Decay is Too Aggressive for Secondary Characters

**Problem:** An NPC introduced at turn 1 with `decay_rate="slow"` (0.95/turn) drops to ~38% heat by turn 20 if never re-accessed. The boost-on-access mechanism (+20 heat, `memory.py:374`) only fires if the memory is already retrieved — creating a death spiral where low-heat memories stop surfacing.

**Proposed Solution:**
- Tie memory heat refresh to **NPC interaction tracking** in the DB: when `npc.last_appeared` is within 10 turns, all memories tagged with that NPC get a +10 heat refresh during the background pass.
- Add a **minimum heat floor** for memories tagged to NPCs who have emotional milestones recorded (any `first_*` milestone = floor of 40 heat).
- Consider a gentler decay curve for `relationship` category: 0.97/turn instead of 0.95.

**Tension to resolve:** Higher heat floors mean more memories compete for limited retrieval slots. Is the fix better decay curves or smarter retrieval that weights NPC importance?

---

### 8. Memory Compression is Dead Code ✅ DONE

**Problem:** `compress_cold_memories()` exists in `memory.py:490-588` but is **never called anywhere in the codebase**. Long sessions accumulate ChromaDB records indefinitely without culling.

**Proposed Solution:**
- Wire `compress_cold_memories()` into the background processing pass, triggered every N turns (e.g., every 20 turns) or when ChromaDB record count exceeds a threshold.
- Alternatively, if compression is deemed unnecessary (disk is cheap), remove the dead code to reduce cognitive load.

**Tension to resolve:** Is this actually a problem at expected session lengths (50-100 turns)? Or only at 500+ turn mega-campaigns?

> **✅ Engineer review: ALREADY DONE.** `compress_cold_memories()` was wired into `_post_narrative_processing` step 8, triggered every 10 turns. This was completed during the pipeline optimization session. **No action needed.**
>
> ```python
> # Step 8: MEMORY COMPRESSION (every 10 turns)
> if db_context.turn_number > 0 and db_context.turn_number % 10 == 0:
>     compression_result = await self.memory.compress_cold_memories()
> ```

---

## III. FORESHADOWING & NARRATIVE THREADING (The Chekhov Problem)

### 9. Foreshadowing System is Fully Built but Never Called During Gameplay 🔧 PARTIAL

**Problem:** `ForeshadowingLedger` in `core/foreshadowing.py` has complete plant/mention/callback/resolve logic with 6 seed types, urgency scoring, and overdue detection. But during gameplay: `plant_seed()` is never called by any agent, `detect_seed_in_narrative()` is never called by the turn loop, and `resolve_seed()` is never called by any agent. The system is inert.

**Proposed Solution:**
- **Planting:** The Director should plant seeds during its review pass based on arc planning. Add a `plant_foreshadowing` tool to DirectorTools. Seeds should be planted with explicit `expected_payoff` descriptions.
- **Detection:** Add `detect_seed_in_narrative(narrative, turn)` to the post-narrative background pass (after entity extraction). Use keyword/NPC matching against active seeds' tags and `related_npcs`.
- **Injection:** Before KeyAnimator generates narrative, include a `callback_opportunities` section in the PacingDirective listing seeds that are ready for payoff (from `get_callback_opportunities()`).
- **Resolution:** When KeyAnimator references a seed's expected payoff, the detection pass should auto-resolve it.

**Tension to resolve:** Seeds planted by the Director may conflict with player agency. Should seed planting be transparent to the player? Should players be able to /override seeds?

> **🔧 Engineer review: PARTIALLY DONE.** `detect_seed_in_narrative()` and `get_overdue_seeds()` are already wired into `_post_narrative_processing` step 6. What's still missing: `plant_seed()` (needs a Director tool), seed injection into KeyAnimator context (callback opportunities in PacingDirective), and `resolve_seed()` (detection-to-resolution piping). **#10 (persistence) must come first**, then finish this wiring.

---

### 10. ForeshadowingLedger is In-Memory Only 🔥

**Problem:** The ledger lives only in Python runtime memory. Server restart = all seeds lost. This is catastrophic for multi-session campaigns.

**Proposed Solution:**
- Add a `ForeshadowingSeed` SQLAlchemy model mirroring the existing Pydantic schema. Store seeds in the campaign database alongside NPCs, factions, and world state.
- `ForeshadowingLedger` becomes a thin cache layer over DB queries.
- Seeds persist across sessions and server restarts.

**Tension to resolve:** Minimal — this is a clear bug/omission, not a design tradeoff.

> **🔥 Engineer review:** Clear bug. Small effort — mirror the existing Pydantic schema as a SQLAlchemy model, add CRUD methods to StateManager. Unblocks #9 and #12. This + #9 together activate the best piece of dead code in the project.

---

### 11. Seeds Are Isolated — No Causal Chains

**Problem:** Each `ForeshadowingSeed` is independent. There's no way to express "when seed A resolves, plant seed B" or "seeds A and B must both be active for seed C's payoff to make sense." Complex multi-arc narratives require interdependent plot threads.

**Proposed Solution:**
- Add optional fields to ForeshadowingSeed: `depends_on: List[str]` (seed IDs that must be resolved first), `triggers: List[str]` (seed IDs to plant on resolution), `conflicts_with: List[str]` (seeds that can't coexist).
- The Director evaluates these during its review pass to identify convergence points ("seeds A and B are both approaching payoff — this is a natural climax trigger").

**Tension to resolve:** Dependency graphs add complexity. Should the Director manage this implicitly through arc planning rather than explicit seed dependencies?

---

### 12. Overdue Seeds Don't Escalate Tension

**Problem:** Seeds past `max_turns_to_payoff` get status `OVERDUE` but nothing happens. Overdue seeds should be narrative pressure — the longer a Chekhov's gun sits on the mantle, the more the audience expects it to fire.

**Proposed Solution:**
- Overdue seeds contribute +0.05 tension per turn per overdue seed to the world state's `tension_level`.
- The Director's micro-check flags overdue seeds as `urgent_callback` in the PacingDirective.
- After 2x `max_turns_to_payoff`, the Director must either resolve or explicitly abandon the seed (with a narrative justification stored in `resolution_narrative`).

**Tension to resolve:** Forced resolution can feel contrived. Is the better approach to let some seeds die naturally (not every setup needs a payoff)?

> **Engineer review:** Elegant and trivial — 5 lines of code once foreshadowing is wired. Should arguably be Phase 2 alongside #9, not Phase 3. `+0.05 tension per overdue seed per turn` is a clean mechanic. Adding forced resolution at 2x max_turns is smart narratively.

---

## IV. RULE LIBRARY & IP AUTHENTICITY (The Dead Wiring Problem)

### 13. Rule Library is ~50% Dead Code

**Problem:** The RuleLibrary (`context/rule_library.py`) has 7+ specific retrieval methods (`get_op_axis_guidance()`, `get_dna_guidance()`, `get_power_tier_guidance()`, `get_ceremony_text()`, `get_compatibility_guidance()`) that are **never called** by any agent. Instead, only the generic `get_relevant_rules(query)` semantic search is used. The beautiful YAML rule files are a museum — carefully curated but rarely visited.

**Proposed Solution:**
- Wire axis-aware retrieval into the turn loop:
  - **OP axis guidance:** When OP mode is enabled, the ContextSelector should call `get_op_axis_guidance()` for the character's specific tension/expression/focus axes and inject the results as dedicated context (not semantic search).
  - **DNA narration guidance:** `get_dna_guidance(scale, value)` should be called for the 2-3 most extreme DNA scales (furthest from 5) and injected into KeyAnimator's profile block. Currently, scales are shown as "Introspection: 8/10" but the actual narration guidance ("Extended internal monologue, philosophy mid-action...") is never injected.
  - **Ceremony text:** Wire `get_ceremony_text()` into the Progression agent — when a tier transition occurs, the ceremony text becomes part of the narrative directive.
  - **Compatibility guidance:** Wire `get_compatibility_guidance()` into the ScaleSelector's output, so the Director knows when tier/scale mismatches need special handling.

**Tension to resolve:** More injected context = more tokens = higher cost + risk of diluting the signal. Should these inject only when specifically relevant (e.g., ceremony only at tier-up), or should they be always-on?

> **Engineer review:** These should inject into the **cache-stable prefix** (Block 1) of prompts, not per-turn dynamic context. OP axis guidance, DNA narration guidance, etc. don't change turn-to-turn — they're structural. This means **zero marginal token cost after the first turn** (cache hit). The plan's token budget concern is resolved by caching.

---

### 14. OP Axis Guidance is Retrieved by Accident, Not by Design

**Problem:** When a character has `tension_source: "existential"`, `power_expression: "instantaneous"`, and `narrative_focus: "internal"`, the system should retrieve the specific existential/instantaneous/internal guidance chunks. Instead, it runs `get_relevant_rules(f"{player_input} {situation}")` — semantic search that might accidentally match "existential" if the player's input happens to mention boredom or meaninglessness. Most turns, the OP rules simply don't surface.

**Proposed Solution:**
- On OP-enabled campaigns, **always inject** the character's three axis guidance chunks as static context (cached, Block 1) alongside profile DNA. These don't change turn-to-turn, so they're perfect for prefix caching.
- Remove OP guidance from semantic search — it's not situational, it's structural.

**Tension to resolve:** Three guidance chunks add ~500-800 tokens of static context. Is this worth the cost for every turn? Or should they only inject when power imbalance is detected?

---

### 15. Composition Mode Not Recalculated Per-Turn

**Problem:** `get_effective_composition()` in `loader.py:224-303` calculates the narrative composition mode (standard/blended/op_dominant) once at profile load time based on a static power differential. But the threat tier changes per encounter — a T7 character fighting a T3 mob vs. a T7 boss should trigger different composition modes. The current system doesn't recalculate.

**Proposed Solution:**
- Move composition calculation from profile load to per-turn evaluation in the Orchestrator (or ScaleSelector).
- Pass the current `threat_tier` from OutcomeJudge's context to `get_effective_composition()`.
- If the mode changes from last turn, flag it in the PacingDirective so KeyAnimator adjusts its approach.

**Tension to resolve:** Does per-turn recalculation cause narrative whiplash? (One turn is "standard" dialogue, next is "OP dominant" combat, then back.) Maybe composition should be per-scene, not per-turn.

> **Engineer review:** Ships with #13-14 in Phase 4 — composition recalculation is part of the rule library wiring, not separate. Recalculate per-scene (Director phase transitions), not per-turn, to avoid whiplash.

---

### 16. Voice Cards Are One-Dimensional 🔥

**Problem:** Voice cards in profiles only contain `speech_patterns`, optionally `humor_type` and `dialogue_rhythm`. They lack: disposition history, current emotional state, relationship to protagonist, memory of past interactions, secrets/hidden agendas. NPCs are essentially one-dimensional speech generators — they sound right but don't *know* anything.

**Proposed Solution:**
- Extend voice card injection in `key_animator.py:330-372` to include data from the DB:
  - Current disposition label (HOSTILE → DEVOTED)
  - Emotional milestones achieved (which "firsts" have occurred)
  - Intelligence stage (reactive → autonomous)
  - Last interaction summary (from NPC's `last_appeared` turn)
- This data already exists in `state_manager.py` — it just needs to be piped into the voice card block.

**Tension to resolve:** More NPC context per card = fewer NPCs can fit in context. Cap at 3 enriched cards? Or 5 lightweight + 2 enriched for the most important NPCs in the scene?

> **🔥 Engineer review:** High-impact, low-cost. All this data already exists in the DB (disposition, milestones, intelligence stage, last interaction). Just needs piping into `key_animator.py:330-372`. ~40 lines of code. **Cap at 3 enriched cards** — present NPCs sorted by interaction count, top 3 get full enrichment. NPCs become *people*, not speech generators.

---

## V. CONSEQUENCES & WORLD STATE (The Accumulation Problem)

### 17. Consequences Are Unstructured Text Appended to Situation

**Problem:** `apply_consequence()` in `state_manager.py:502-518` just appends free text to `world_state.situation`. By turn 50, the situation field is an unstructured string of accumulated consequences, unqueryable and increasingly noisy. Earlier consequences get buried by later ones.

**Proposed Solution:**
- Add a `Consequence` model to the DB: `{id, turn, source_action, description, category: str, severity: str, active: bool, expires_turn: Optional[int]}`.
- Categories: `political`, `environmental`, `relational`, `economic`, `magical`.
- Active consequences are queried and summarized for KeyAnimator context. Expired consequences are archived.
- The `situation` field remains as a human-readable summary, regenerated from active consequences by the Director during its review pass.

**Tension to resolve:** Structured consequences require classification (another LLM call or heuristic). Is the juice worth the squeeze for typical session lengths?

> **Engineer review:** Build the proper `Consequence` SQLAlchemy model with `turn`, `description`, `category`, `severity`, `active`, `expires_turn`. No JSON stopgap — do it right the first time. Ships in Phase 5 with the full model, not a lightweight placeholder.

---

### 18. No "Previously On" Recap System

**Problem:** When a player resumes a session, they see raw message history. There's no LLM-generated recap, no "three-arc summary," no formal session summary stored in the DB. The `/session/{id}/resume` endpoint (game.py:276-305) just loads the session object.

**Proposed Solution:**
- At session end (or on demand), generate a **session recap** using the Director or a lightweight recap agent:
  - "Previously on [IP]..." format
  - Character state summary
  - Active relationships (top 3 NPCs by recent interaction)
  - Current arc and tension
  - Active foreshadowing seeds (without spoiling)
  - Cliffhanger/hook from last scene
- Store as `Session.recap: str` in the DB.
- On resume, inject the recap as a priming block before the first turn.

**Tension to resolve:** Recap generation needs to happen either at session close (user may disconnect abruptly) or at session open (adds latency to first turn). Background generation at close with fallback generation at open?

---

## VI. AGENT ARCHITECTURE (The Sprawl Problem)

### 19. 3+ Agents Are Dead Code

**Problem:**
- `CalibrationAgent` (`agents/calibration.py`): Never imported or called. Character validation logic either abandoned from v2 or distributed elsewhere.
- `NPCReactionAgent` (`agents/npc_reaction.py`): Redundant with `RelationshipAnalyzer` (actively used). Nearly identical functionality.
- `ScopeAgent` (`agents/scope.py`): No clear call site. Possibly replaced by inline logic in AnimeResearch.

**Proposed Solution:**
- **Delete** `npc_reaction.py` — RelationshipAnalyzer covers its functionality.
- **Delete or activate** `calibration.py` — if character validation is needed, integrate it into SessionZero; otherwise remove.
- **Investigate** `scope.py` — if used indirectly in research flow, document it; otherwise remove.
- Clean up `EXTENDED_THINKING_AGENTS` list in `base.py:95-99` which references dead agents ("npc_reaction", "calibration").

**Tension to resolve:** Minimal — this is technical debt cleanup, not a design decision.

---

### 20. Validator Has Identity Crisis: Blocking vs. Advisory 🔧 PARTIAL

**Problem:** The Validator (`agents/validator.py`, 1,177 lines) serves two contradictory roles:
- **Blocking (pre-action):** Resource validation, skill ownership checks hard-stop actions.
- **Advisory (outcome):** Outcome sensibility checks trigger soft retries.

For a system whose philosophy is "story > simulation," having a hard mechanical gate on resource costs contradicts the design intent. The Validator also duplicates work done elsewhere (NPC state checking overlaps with entity extraction, outcome validation overlaps with OutcomeJudge).

**Proposed Solution:**
- Split into two focused components:
  - **ResourceGuard** (pure Python, no LLM): Hard checks on HP/MP/SP costs. Blocking. Fast. ~200 lines.
  - **NarrativeValidator** (LLM-based): Advisory checks on outcome sensibility, NPC behavior consistency, world state coherence. Soft retry. ~400 lines.
- Remove the overlap: NPC state validation should live in one place (either here or entity extraction, not both).
- Consider making ResourceGuard **advisory** for narrative override situations (player attempts something "impossible" — should the system block or let the story decide?).

**Tension to resolve:** Some players want mechanical consistency (resources matter). Others want pure narrative. Should this be a campaign-level setting?

> **🔧 Engineer review:** `StateTransaction` (with `begin_transaction()` / `validate()`) already serves as the ResourceGuard for MP/SP costs. When this ships in Phase 5: **full split** — extract NarrativeValidator into a standalone component, remove overlap with entity extraction, and delete the monolithic Validator.

---

### 21. Prompt Management is Inconsistent

**Problem:** Some agents use external markdown prompt files (`prompts/` directory): IntentClassifier, OutcomeJudge, KeyAnimator, SessionZero, Director. Others use inline hardcoded prompts: Validator, Compactor, MemoryRanker, WorldBuilder, RelationshipAnalyzer, Combat, Progression, ScaleSelector. This makes prompt iteration difficult — inline prompts require code changes.

**Proposed Solution:**
- Extract all inline prompts to `prompts/` directory.
- Establish a convention: every agent that makes an LLM call has a corresponding `prompts/{agent_name}.md` file.
- Prompts loaded at agent init, not hardcoded in methods.

**Tension to resolve:** Minimal — this is a developer experience improvement. Only question is whether prompt files should be hot-reloadable (useful for iteration) or loaded once at startup (simpler).

---

### 22. Agent Naming Inconsistencies Break Model Selection

**Problem:** Many agents reference `get_provider_for_agent(self.agent_name)` but `agent_name` values are inconsistent — some use snake_case, some use class names. `EXTENDED_THINKING_AGENTS` in `base.py:95-99` lists `"research"` which doesn't match any agent's `agent_name` (should be `"anime_research"`).

**Proposed Solution:**
- Audit all `agent_name` values against `settings.json` configuration.
- Establish convention: `agent_name` = snake_case file name without `.py` (e.g., `"intent_classifier"`, `"key_animator"`).
- Add a startup validation check that warns if an agent's `agent_name` doesn't match any settings.json entry.
- Update `EXTENDED_THINKING_AGENTS` to match actual agent names.

**Tension to resolve:** None — pure cleanup.

---

## VII. COMBAT & MECHANICAL SYSTEMS (The Background Problem)

### 23. Combat Resolution Happens After Narrative 🔥

**Problem:** Combat is resolved in the background *after* KeyAnimator generates the narrative (`orchestrator.py:788-835`). This means the narrative is written before damage is calculated, HP is deducted, or death is confirmed. The narrative might describe a "devastating blow" while the combat system calculates a miss.

**Proposed Solution:**
- Move **critical combat resolution** (hit/miss, damage, death) to *before* narrative generation, as input to KeyAnimator.
- Keep **bookkeeping** (XP, progression, relationship updates) in background.
- Pass `CombatResult` to KeyAnimator so it can narrate the actual mechanical outcome, not a guess.

**Tension to resolve:** This adds latency to combat turns (CombatAgent must run before KeyAnimator). Acceptable if CombatAgent is fast (<500ms on fast model). Could also pre-resolve in parallel with memory ranking.

> **🔥 Engineer review:** This is a **correctness bug**, not a feature gap. The narrative describes outcomes that haven't been computed. Straightforward fix: run `CombatAgent.resolve_action()` before KeyAnimator, pass `CombatResult` as context. CombatAgent uses fast model (~300ms), can parallelize with memory ranking. The `deferred_commit()` infrastructure we just built directly supports this refactoring.

---

### 24. NPC Intelligence Evolution Lacks Narrative Expression

**Problem:** NPCs evolve through intelligence stages (reactive → contextual → anticipatory → autonomous) based on interaction count and milestones (`state_manager.py:1022-1050`). But this evolution is tracked only in the DB — **no narrative event marks the transition**. The player never sees "Alice seems to anticipate your moves now" unless the KeyAnimator happens to infer it from context.

**Proposed Solution:**
- When an NPC transitions intelligence stages, generate a **micro-narrative beat** (1-2 sentences) stored as a memory and flagged for injection in the next scene featuring that NPC.
- The transition itself becomes a narrative event, not just a database field change.

**Tension to resolve:** Not all intelligence transitions are narratively interesting (reactive → contextual is subtle). Should only major transitions (to anticipatory or autonomous) get narrative treatment?

---

## VIII. SESSION ZERO & PROFILE SYSTEMS (The Foundation Problem)

### 25. Profile Research Quality is Opaque ⚠️ DEFER

**Problem:** AnimeResearch does a two-pass research (web search → parse to structured schema) but there's no quality gate. If the research returns sparse or inaccurate data (obscure anime, incorrect power system), the profile propagates errors into every subsequent turn. No human review step, no confidence scoring, no fallback.

**Proposed Solution:**
- Add a **confidence score** to `AnimeResearchOutput`: `confidence: float` (0-1) based on source count, consistency of facts, and coverage of required fields.
- Below a threshold (e.g., 0.6), flag the profile for player review: "I found limited information about [X]. Here's what I have — please correct anything that looks wrong."
- Store the raw research output alongside the parsed profile for debugging.

**Tension to resolve:** Player review adds friction to the onboarding flow. Is a confidence-gated review better than always showing the profile for confirmation?

> **⚠️ Engineer review:** Low priority. Current system works well for popular anime. Obscure anime is an edge case. Adding confidence scoring is nice but doesn't fix a burning problem. Defer until single-profile quality is perfect.

---

### 26. Hybrid Profile Merging is Underspecified ⚠️ DEFER

**Problem:** `ProfileMerge` blends two anime profiles with a ratio, but the merge logic for contradictory elements is delegated entirely to the LLM. If Anime A has "magic system" and Anime B has "ki system," the merge might produce incoherent results. No post-merge validation exists.

**Proposed Solution:**
- Define **merge rules** for each profile field:
  - `dna_scales`: Weighted average by blend ratio (pure math, no LLM needed).
  - `power_system`: LLM merges with explicit instruction: "Create a unified system that respects both sources. If contradictions exist, favor the primary (higher-ratio) source."
  - `voice_cards`: Union of both sets, tagged by source.
  - `tropes`: Boolean OR (if either source has it, merged profile has it).
- Post-merge, run a **coherence check** (fast model): "Does this merged profile have internal contradictions?"

**Tension to resolve:** Strict merge rules may produce bland results. Should creative merging be encouraged even at the cost of occasional incoherence?

> **⚠️ Engineer review:** Hybrid profiles are an advanced feature most users won't use immediately. Defer until single-profile quality is perfect.

---

## IX. IMPLEMENTATION SEQUENCING

### Phase 1: Critical Path (Foundation)
*These unblock everything else.*

| # | Item | Effort | Deps | Status |
|---|------|--------|------|--------|
| 10 | Persist ForeshadowingLedger to DB | S | None | 🔥 |
| 19 | Delete dead agents, clean up imports | S | None | |
| 22 | Fix agent naming inconsistencies | S | None | |
| 21 | Extract inline prompts to files | M | None | |
| 4 | Index narrative prose to memory | M | None | 🔥 |
| 6 | Auto-detect plot-critical memories | S | #4 | |
| 29 | ChromaDB error recovery | S | #4 | |
| 30 | Deep recall GameplayTool | S | None | |

### Phase 2: Director Overhaul
*Makes the system proactive instead of reactive.*

| # | Item | Effort | Deps | Status |
|---|------|--------|------|--------|
| 1 | Pre-turn Director micro-check | L | None | 🔥 |
| 2 | Versioned Campaign Bible schema | M | #1 | |
| 3 | Arc pacing gates | M | #1, #2 | |
| 9 | Wire foreshadowing into turn loop | M | #10 | 🔧 |
| 12 | Overdue seeds escalate tension | S | #9 | *Moved from Phase 3* |

### Phase 3: Memory & Continuity
*Enables coherent long-form storytelling.*

| # | Item | Effort | Deps | Status |
|---|------|--------|------|--------|
| 5 | Expand working memory + pinned messages + deep recall | M | None | |
| 7 | Fix heat decay for secondary characters | S | None | |
| ~~8~~ | ~~Wire or remove memory compression~~ | ~~S~~ | ~~None~~ | ✅ DONE |
| 18 | "Previously On" recap system | M | #2 | |

### Phase 4: Rule Library & IP Authenticity
*Activates the dead wiring.*

| # | Item | Effort | Deps | Status |
|---|------|--------|------|--------|
| 13 | Wire rule library retrieval methods | M | None | |
| 14 | Static OP axis guidance injection | S | #13 | |
| 15 | Per-turn composition recalculation | M | #14 | |
| 16 | Enrich voice cards with DB data | M | None | 🔥 |

### Phase 5: Structural Refinement
*Polish and coherence.*

| # | Item | Effort | Deps | Status |
|---|------|--------|------|--------|
| 17 | Structured consequences model (full `Consequence` SQLAlchemy model) | M | None | |
| 20 | Full Validator split: ResourceGuard + NarrativeValidator | M | None | 🔧 |
| 23 | Move combat resolution before narrative | M | None | 🔥 |
| 24 | NPC intelligence transition narratives | S | #16 | |
| 11 | Foreshadowing causal chains | M | #9 | |

### Phase 6: Session Zero Hardening
*Foundation quality.*

| # | Item | Effort | Deps | Status |
|---|------|--------|------|--------|
| 25 | Profile research confidence scoring | M | None | |
| 26 | Hybrid merge rules + coherence check | M | None | |

---

## X. WHAT NOT TO TOUCH

These systems are working well and should be preserved:

1. **KeyAnimator's narrative diversity** (style drift, vocabulary freshness, sakuga modes) — sophisticated and functional.
2. **OP narrative framework** (3-axis tension/expression/focus system) — excellent design, just needs wiring.
3. **Per-agent model selection** — cost-conscious, architecturally sound.
4. **Cache-aware prompt blocks** — real optimization, well-implemented.
5. **NPC emotional milestones** — beautiful "firsts" tracking system.
6. **Session Zero → Gameplay handoff** — clean, comprehensive data transfer.
7. **Heat-based memory decay concept** — the curves may need tuning but the architecture is right.
8. **Compactor's "subtext over events" philosophy** — exactly right for narrative preservation.

---

## XI. OPEN QUESTIONS FOR DIALECTIC

1. **Latency budget:** The pre-turn Director micro-check, combat pre-resolution, and narrative extraction all add latency. What's the acceptable turn time? Currently ~2-4s. How much can we add?

2. **Token budget:** More context (OP guidance, enriched voice cards, active consequences, foreshadowing seeds) means more tokens per turn. What's the ceiling before cost becomes prohibitive?

3. **Player agency vs. narrative structure:** Arc gates and foreshadowing seeds are storytelling tools that constrain the narrative. How do we prevent the Director from railroading the player? Should the player see the Director's plan?

4. **Mechanical consistency vs. narrative freedom:** The Validator's blocking behavior on resource costs enforces game mechanics. But "you don't have enough MP" is anti-narrative. Where's the line?

5. **Memory fidelity vs. noise:** Indexing narrative prose to memory risks polluting the retrieval space with mundane descriptions. How do we ensure only *meaningful* beats are stored?

6. **Complexity ceiling:** 26 items in this plan is itself a form of overreach. Which items deliver 80% of the value? If we could only do 5, which 5?

> **Engineer answer to #6 — The Top 5:**
>
> | Rank | Item | Why |
> |---|---|---|
> | **1** | #4 — Index narrative to memory | Highest ROI. Near-zero cost (piggyback on entity extraction), transforms narrative quality |
> | **2** | #1 — Pre-turn Director micro-check | Single most impactful architectural change. Makes the system proactive |
> | **3** | #16 — Enrich voice cards with DB data | NPCs become *people*, not speech generators. ~40 lines of code |
> | **4** | #10+9 — Persist + wire foreshadowing | Activates the best piece of dead code in the project |
> | **5** | #23 — Combat before narrative | Correctness bug. Narratives should reflect actual computed outcomes |
>
> Close runner-ups: #19 (delete dead agents, trivial effort), #7 (heat decay fix, 20 lines), #12 (overdue seeds → tension, 5 lines).

---

## XII. WHAT THE PLAN MISSES

*Items not in the original gap analysis but identified during implementation.*

### 27. State Transactional Integrity ✅ DONE

**Problem:** Multiple `StateManager` mutation methods called `db.commit()` independently. An error mid-turn left earlier mutations persisted — partial state corruption.

**Solution (implemented):**
- `deferred_commit()` context manager batches all SQL commits into a single atomic operation per turn
- `_maybe_commit()` replaces 15 individual `db.commit()` calls
- `StateTransaction` provides before-value verification and constraint checking for resource costs
- `_post_narrative_processing` steps 2-7 wrapped in `deferred_commit()` block
- 12 new tests verify atomicity, rollback, reentrancy, and transaction composition

---

### 28. Prompt Caching Economics

**Problem:** The plan repeatedly raises token budget concerns when adding context (OP guidance, enriched voice cards, rule library chunks). But it doesn't account for the existing **cache-aware prompt block** architecture.

**Key insight:** Static additions (OP axis guidance, DNA narration guidance, voice card enrichment, rule library chunks) go in **Block 1** of the prompt — the cache-stable prefix. After the first turn of a session, these are cache hits with **zero marginal token cost**. The plan's token anxiety is largely unfounded for static context additions.

**Action needed:** When implementing #13, #14, and #16, ensure all new context is injected into Block 1 (cache-stable prefix), not Block 3 (per-turn dynamic context).

---

### 29. ChromaDB Error Recovery

**Problem:** The `deferred_commit()` infrastructure handles SQL transaction integrity, but steps 8-9 of `_post_narrative_processing` (memory compression and episodic memory) write to ChromaDB, which has **no rollback mechanism**. A ChromaDB failure after SQL commit creates an inconsistent state.

**Proposed Solution:**
- Add try/except around ChromaDB operations with logging (don't propagate failures to the user)
- ChromaDB writes are already idempotent (upsert semantics), so retrying on next turn is safe
- Implement a "pending memory" queue in SQL that's drained by background processing, ensuring SQL stays the source of truth

> **Engineer review:** Ships with Phase 1 alongside #4 — we're touching memory writes anyway, add the resilience layer at the same time. Known gap, not speculative.

---

### 30. Deep Recall GameplayTool

**Problem (extends #5):** `Turn.narrative` in SQL contains the complete verbatim record of every turn, but no agent can query it. This is a goldmine of narrative context locked behind an inaccessible API.

**Proposed Solution:**
- Add a `recall_scene` tool to GameplayTools that queries `Turn.narrative` by NPC name, location, turn range, or keyword
- Returns 2-3 matching turn excerpts for KeyAnimator to reference in callbacks
- Trivially implementable as a SQL query + result formatting

---

*S = Small (hours), M = Medium (days), L = Large (week+)*
*This document is a starting point, not a mandate. Every "Proposed Solution" is debatable.*
