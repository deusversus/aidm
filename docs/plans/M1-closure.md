# M1 — closure plan

**Drafted 2026-04-20** after the M1 completion audit against the ROADMAP. Three Commits from the original M1-turn-pipeline plan never shipped (7, 8, 9), and one roadmap deliverable (prompt fingerprint persistence) was left half-done. This plan covers the work to honestly close M1.

The user chose the thorough path: **include Chronicler in M1** (don't rescope to M2). That means M1's post-turn subgraph ships before acceptance, built against the three-phase architecture locked in 2026-04-20 (see `project_three_phase_architecture.md` in memory + ROADMAP §5).

---

## Status — 2026-04-21

**Shipped + pushed (all audit-clean after follow-up fix commits):**

| Commit | Scope | Base SHA | Fix SHA |
|---|---|---|---|
| 7.0 | Prompt fingerprint persistence — per-agent map in `turns.prompt_fingerprints` | `ba7a114` | — |
| 7.1 | Chronicler schema — 10 new tables (npcs, locations, factions, relationship_events, semantic_memories, foreshadowing_seeds, voice_patterns, director_notes, spotlight_debt, arc_plan_history) | `d10276d` | — |
| 7.2 | Chronicler tools — 15 write tools w/ authz + Zod + NPC FK guard | `64b465f` | `deaac89` |
| 7.3 | Chronicler orchestrator + prompt + RelationshipAnalyzer consultant | `85a27f0` | `40d9c04` |
| 7.4 | Wire Chronicler via Next `after()` w/ FIFO-per-campaign lock + idempotency | `3841668` | `d74abfe` |

**Three-phase turn architecture is live end-to-end on prod.** Scenewright pre-pass → KeyAnimator streaming → `after()` → Chronicler cataloguing. Schema migration `0003_gigantic_wolf_cub.sql` applied to prod. Test suite: 305/305 passing.

**Remaining to close M1:**

1. **Commit 9** — rate limiter + cost cap + budget UI (§9 below). Lands BEFORE Commit 8 so the eval harness can bypass.
2. **Commit 8** — eval harness + 5 golden turns + Haiku judge + CI gate (§8 below).
3. **Acceptance ritual** — 10 prod turns w/ Langfuse metrics + `docs/retros/M1.md`.

**Known debt (not blocking M1 ship, surfaces before M2 scope freezes):**

- **v3 parity audit** (2026-04-21, 4 parallel subagents): six BLOCKER-tagged gaps where v4 has a piece wired but no call site — override persistence never fires, WB-accepted entities evaporate, composition mode-shift hardcoded to "standard", semantic retrieval stubbed, rule library missing, context blocks missing. Plus eight MAJORs + ten MINORs. Full audit with findings + citations + synthesis at `docs/audits/v3-parity-2026-04-21.md`. Fix plan with explicit paths for every finding at `docs/plans/v3-audit-closure.md` (7 phases, ~10 working days). Five cheap BLOCKERs (~1 day of work, closure plan Phase 1) are candidates for a "v3 audit debt" cleanup commit before Commit 9.
- **ROADMAP §5 sub-sections** (per-turn shape, agent roster, per-agent specs) pre-date the three-phase consolidation and over-enumerate after-turn agents. Rewrite pending. Treat §5 top-matter and `project_three_phase_architecture.md` as authoritative.

**Resume here when returning to this plan:** jump to §9 below for the next commit.

---

## Principles carried in

- **Build the whole shape.** Chronicler ships as the full orchestrator-with-tools shape — not a stub. Empty sets from DB queries are valid M1 state; missing tools are not.
- **Audit cadence per commit.** Every commit below runs `implement → subagent audit → fix findings → push`.
- **Three-phase architecture is authoritative.** Chronicler = after-turn orchestrator; subsumes the originally-planned five parallel post-turn agents (memory writer + ProductionAgent + standalone Director + standalone RelationshipAnalyzer + ForeshadowingLedger) into one agent with tools + one consultant (RelationshipAnalyzer).

---

## Commit sequence

### 7.0 — Prompt fingerprint persistence (small; leftover from Commit 6)

**Why:** `turns.promptFingerprints` column exists but is written as `{}` everywhere. ROADMAP §M1 deliverable says "every composed prompt gets a SHA-256 fingerprint and every turn row persists the fingerprints of the agents it invoked." Trivially done; should've landed in Commit 6.

**Deliverables:**
- `src/lib/prompts/registry.ts` already exposes `getPrompt(id).fingerprint`. Confirm the API surface.
- Per-turn fingerprint collector: a small accumulator that each agent call adds its prompt fingerprint to. Threaded through deps alongside `trace` + `logger`.
- Router pre-pass collects fingerprints for IntentClassifier / OverrideHandler / WorldBuilder.
- OJ+Validator pre-pass collects fingerprints.
- KA collects its four block fingerprints + each consultant definition's fingerprint.
- Chronicler (7.3+) collects its own + consultant fingerprints.
- turn.ts writes the accumulated map as `promptFingerprints` on the turn row.
- Tests: fingerprints are populated on a mocked turn.

**Scope:** ~2 hours.

**Audit focus:** fingerprints actually change when a prompt file changes; map keys are agent names (not paths); no agent silently skipped.

### 7.1 — Chronicler schema + entity tables

**Why:** Chronicler's tools write durable state to DB. Before the tools exist, the tables have to.

**Deliverables:**
- New Drizzle tables (migration):
  - `npcs` — id, campaignId, name, role, personality, goals, secrets, faction, visual_tags, knowledge_topics, power_tier, ensemble_archetype, first_seen_turn, last_seen_turn, createdAt, updatedAt. Unique on (campaignId, name).
  - `locations` — id, campaignId, name, details (jsonb), first_seen_turn, last_seen_turn, createdAt.
  - `factions` — id, campaignId, name, details (jsonb), createdAt.
  - `relationship_events` — id, campaignId, npc_id, milestone_type, evidence, turn_number, createdAt.
  - `semantic_memories` — id, campaignId, category, content, heat, turn_number, embedding (vector, nullable until M4 embedder decision), createdAt. Index on (campaignId, category).
  - `foreshadowing_seeds` — id, campaignId, name, description, status (PLANTED|GROWING|CALLBACK|RESOLVED|ABANDONED|OVERDUE), payoff_window_min, payoff_window_max, depends_on (jsonb array of ids), conflicts_with (jsonb array), planted_turn, resolved_turn, createdAt, updatedAt.
  - `voice_patterns` — id, campaignId, pattern, evidence, turn_observed, createdAt.
  - `director_notes` — id, campaignId, content, scope, created_at_turn, createdAt.
  - `spotlight_debt` — id, campaignId, npc_id, debt, updated_at_turn. Unique on (campaignId, npc_id).
  - `arc_plan_history` — id, campaignId, current_arc, arc_phase, arc_mode, planned_beats (jsonb), tension_level, set_at_turn, createdAt.
- Zod types for each in `src/lib/types/entities.ts`.
- Migration runs and verifies round-trip.
- Semantic layer is pgvector-ready but `embedding` column stays null at M1 — the embedder decision is M4 per §9.3.

**Scope:** ~half day.

**Audit focus:** FK integrity (npc_id refs npcs.id); indexes on (campaignId, ...) are present for every lookup path Chronicler or its read tools will use; Zod types match the Drizzle shape.

### 7.2 — Chronicler tools (MCP surface)

**Why:** The tool surface is Chronicler's output channel. These tools are also what future read paths query.

**Deliverables:**
- New folder `src/lib/tools/chronicler/` with tools:
  - `register_npc` / `update_npc` — upsert NPC catalog entries; matches v3 NPCDetails shape.
  - `register_location` / `register_faction` — location and faction catalog.
  - `record_relationship_event` — append milestone to relationship_events.
  - `write_semantic_memory` — insert into semantic_memories; embedding stays null at M1.
  - `write_episodic_summary` — populates `turns.summary` for the just-completed turn.
  - `plant_foreshadowing_candidate` — inserts seed with status PLANTED (Chronicler) or status CALLBACK (Director ratifies).
  - `ratify_foreshadowing_seed` / `retire_foreshadowing_seed` — Director-path tools.
  - `update_arc_plan` — writes to arc_plan_history (append-only; latest is current).
  - `update_voice_patterns` / `write_director_note` / `adjust_spotlight_debt` — arc-level tools.
  - `trigger_compactor` — when working memory count > compaction threshold, summarize the oldest N turns.
- Register via the existing tool-registry pattern (`src/lib/tools/registry.ts`); expose as an MCP server (`aidm-chronicler` or extend `aidm-entities`).
- Each tool authorizes on campaignId; each has Zod I/O; each emits a span.
- Tests per tool with a mocked DB.

**Scope:** 1–1.5 days.

**Audit focus:** authz check fires on wrong-user campaigns; schema validation catches malformed tool args; upsert semantics on register_npc don't clobber existing NPCs; Compactor triggers don't fire on every turn (threshold check).

### 7.3 — Chronicler orchestrator + prompt + RelationshipAnalyzer consultant

**Why:** The agent that ties it all together. Single Agent SDK session, fast tier, Anthropic-only at M1. Reads the turn's narrative, calls the right tools based on what it sees.

**Deliverables:**
- `src/lib/agents/chronicler.ts` — Agent SDK orchestrator. Inputs: the completed turn (player_message + narrative + intent + outcome), existing NPC/location/faction catalog (loaded via tool calls). Agent decides what to call.
- `src/lib/prompts/agents/chronicler.md` — prompt. Covers:
  - Role: post-production archivist. Not a narrator.
  - Priorities: catalog named entities KA introduced; update existing entries with new details; record relationship milestones; write semantic facts that might matter later; populate episodic summary.
  - Arc-level tool guidance: fire only on hybrid triggers (every 3+ turns at epicness ≥ 0.6) or session boundaries.
  - RelationshipAnalyzer consultant: spawn when the turn has subtle emotional movement that's hard to classify.
- RelationshipAnalyzer as Agent SDK subagent (AgentDefinition with its own model/tools), wired via `agents: {...}` on Chronicler's query. Thinking tier.
- `src/lib/prompts/agents/relationship-analyzer.md` — prompt (milestone types: first_trust, first_vulnerability, first_sacrifice, etc.).
- Chronicler uses fast tier on the campaign's modelContext (so Anthropic Haiku by default). Provider guard: campaigns on non-available providers throw "Chronicler lands on Google-KA/OpenAI-KA at later milestone."

**Scope:** 1 day.

**Audit focus:** prompt quality (Chronicler is a judgment agent — the prompt matters); consultant subagent is invoked when the prompt says it should; RelationshipAnalyzer's output gets persisted via `record_relationship_event`; trace shows Chronicler's full tool-call sequence.

### 7.4 — Wire Chronicler into turn workflow via `after()`

**Why:** Chronicler is post-turn; it must NOT block the player's response. Next's `after()` + async-queue pattern.

**Deliverables:**
- After turn persistence in `runTurn`, fire Chronicler in the background. The SSE `done` event still fires immediately; Chronicler runs against the persisted turn row.
- Error handling: Chronicler failures don't retroactively fail the turn. Surface as a logged warn + trace span metadata.
- Per-campaign serialization: Chronicler needs to run in turn-order for a campaign so earlier turns' NPCs exist when later turns reference them. Use the same advisory lock pattern (or a FIFO queue) so turn N's Chronicler completes before turn N+1's starts.
- Idempotency: Chronicler can run N times on the same turn without creating duplicate NPCs (upsert semantics).
- Tests: integration-style — run a turn, drain runTurn's generator, wait for Chronicler, assert DB state has expected NPCs.

**Scope:** ~half day.

**Audit focus:** `done` event fires before Chronicler work completes (user-perceived latency unchanged); advisory-lock serialization actually works; idempotency holds; Chronicler failure doesn't break retry.

### 9 — Rate limiter + cost cap + budget UI indicator

**Why:** ROADMAP §M1 deliverable. Lands BEFORE Commit 8 because the eval harness runs N turns and shouldn't trip the limiter; easier to have the limiter know about the eval path than build the harness first and find out.

**Deliverables:**
- `rate_limits` table (Postgres counter per user per minute + per user per day).
- Per-turn cost captured at the end of `runTurn` (sum of all span costs from Langfuse metadata or summed directly from the LLM-call returns).
- Per-user daily cost cap (soft-warn at 80% runway, hard-block at 100%) + per-minute turn-rate cap.
- Budget indicator component in play UI header.
- Eval-mode bypass: eval runs pass a flag that skips the limiter.
- Tests: limiter holds under simulated burst; daily cap blocks the 11th turn when budget is set to cover 10.

**Scope:** 1–1.5 days.

**Audit focus:** race-free under concurrent POSTs; bypass flag only works from server-trusted contexts (not user input); cap error messages are actionable.

### 8 — Eval harness + 5 golden turns + Haiku judge + CI gate

**Why:** ROADMAP §M1 deliverable. Every future prompt or model change becomes measurable.

**Deliverables:**
- `evals/golden/gameplay/` — 5 turn fixtures spanning DEFAULT, COMBAT, SOCIAL, EXPLORATION, ABILITY intents. Each includes: input (player message + campaign + character + last-3-turns summary), expected intent (exact match target), expected outcome shape (narrative_weight, success_level), expected narrative criteria (rubric for Haiku judge).
- `evals/run.ts` — harness running each fixture through the real pipeline with eval-mode bypass on the rate limiter.
- Haiku judge prompt with rubric scoring 1–5 on: intent classification accuracy, outcome feasibility, narrative coherence, voice adherence, specifics (named-entity mentions, scene specificity).
- `evals/latest.json` — aggregated output.
- GitHub Actions workflow runs `pnpm evals` on PRs to master; fails if any dimension drops below threshold.
- `pnpm evals` script.

**Scope:** 2–3 days.

**Audit focus:** fixtures span the actual intent space; judge rubric produces stable scores across repeated runs; PR gate thresholds are defensible (not too loose, not impossibly tight); bypass flag plumbed correctly from harness to runTurn.

### Acceptance ritual

After all of the above ship:

1. **10 turns on prod** against the Bebop campaign, mixing intents (combat, social, exploration, some worldbuilding). Capture Langfuse screenshots of the trace tree.
2. **Verify acceptance criteria:**
   - Narrative coherent (subjective read; record feel).
   - Traces show OJ + Validator + Chronicler + tool calls (evidence that specialists actually get consulted, not bypassed).
   - Cache hit rate ≥ 80% after turn 3 (Langfuse trace metrics).
   - p95 TTFT < 3s (from turn persistence timestamps).
   - Eval suite green (`pnpm evals`).
   - Per-user daily cost cap actually enforces (try to bust it).
3. **Write `docs/retros/M1.md`.** What shipped, what was harder than planned, what the Chronicler-in-M1 decision cost vs rescope-to-M2.
4. **Close M1. Ship the retro. Move to M2.**

---

## Risk + constraints

- **Scope.** Path 2 is ~2 weeks of focused work. Subagent audits per commit are mandatory — they surface edge cases we'd otherwise find at acceptance time.
- **Chronicler prompt quality.** The single most load-bearing thing in this plan. A Chronicler that extracts the wrong entities silently poisons the NPC catalog for the life of the campaign. Prompt-level iteration expected; may need 2–3 passes in 7.3 before the output is trustable.
- **DB schema breadth.** ~9 new tables in 7.1. Migration + rollback rehearsal on the dev DB before pushing.
- **Advisory-lock serialization under load.** 7.4's FIFO-per-campaign assumption needs stress-testing — two rapid turns from one user could race; lock timeout behavior matters.
- **Rate limiter correctness.** 9 is the kind of thing that's easy to get subtly wrong (off-by-one on window boundaries; race conditions between read-and-decrement). Integration test + Playwright burst test required.

---

## Delivery order (chronological)

1. 7.0 (prompt fingerprints) — ~2 hr
2. 7.1 (schema) — ~half day
3. 7.2 (tools) — ~1.5 days
4. 7.3 (orchestrator + prompt + RelationshipAnalyzer) — ~1 day
5. 7.4 (wire into turn) — ~half day
6. 9 (rate limiter + cost cap + UI) — ~1.5 days
7. 8 (eval harness + CI gate) — ~2.5 days
8. Acceptance ritual + retro — ~1 evening

**Total: ~8.5 working days.** With audit + fix cycles per commit, realistic calendar time ~2 weeks.

---

*Revised 2026-04-20 after the M1 completion audit. Follows audit cadence per commit.*
