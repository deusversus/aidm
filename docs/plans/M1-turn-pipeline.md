# M1 — Playable single turn

**Status:** Draft · 2026-04-19
**Goal:** A 3-agent judgment cascade (IntentClassifier → OutcomeJudge → KeyAnimator) producing streamed narrative on prod. Play 10 turns, narrative coherent, cache hit rate ≥80% after turn 3, eval suite green, p95 TTFT < 3s.
**Duration estimate:** ~1 week wall-clock (ROADMAP §23 target).

Builds on [M0 retro](../retros/M0.md). Executes against [ROADMAP](../../ROADMAP.md) §5 (agent roster), §6 (turn state machine), §7 (prompts/caching/routing), §23 (M1 deliverables).

---

## Definition of done

- Player types a message in `/campaigns/[id]/play`, sees narrative stream token-by-token, turn persists, Langfuse trace captures the full cascade with cost.
- 10 consecutive turns play without regression on prod.
- Cache hit rate ≥80% on turns 3+ (Langfuse dashboard).
- p95 TTFT < 3s measured across the 10-turn run.
- Eval harness: 5 golden turns score ≥4/5 on intent accuracy + outcome feasibility + narrative coherence (Haiku judge). PR gate fails on regression.
- Per-user daily cost cap enforced; rate limiter holds under a burst test.
- Prompt registry: SHA-256 fingerprint per agent persisted on every turn row. `pnpm prompts:dump` works.

**What's deferred (explicitly out of scope):**
- `META_FEEDBACK`, `OVERRIDE_COMMAND`, `WORLD_BUILDING` routing — M1 ships DEFAULT + epic-cascade only. Router slots exist; handlers stubbed with TODO(M2/M3).
- `Director`, `MemoryRanker`, `PacingAgent`, `RecapAgent` — M4+/M5+/M7. `rag_context` is minimal (last 3 turns concatenated; no embedding retrieval).
- Research subagent phase inside KA — added when first play session shows KA is making up facts it could have retrieved. Not a day-one requirement.
- Background entity extraction, NPC cards, foreshadowing — M4+.
- Session Zero — M2. M1 uses a hardcoded seed campaign (Cowboy Bebop DNA + a pre-baked Spike Spiegel character).

---

## Risks carried in from M0 (addressed first)

1. **Mastra + Claude Agent SDK interop is unproven.** Addressed in Commit 1's spike doc before any production code commits.
2. **Budget assumptions in ROADMAP §20 are untested.** Addressed in Commit 8 (cost counter surfaces real numbers; we revise §20 if reality disagrees).
3. **Clerk dev-instance bot protection masks 404s for curl.** Any E2E test uses Playwright, not curl.
4. **First real Langfuse traces will reveal latency reality.** Commit 6's SSE wiring is where TTFT gets measured for real; accept it may force model/caching tuning in Commit 7.

---

## Commit plan (thorough commits, audit-before-push)

Each commit follows the audit cadence: **implement → subagent audit → address findings → push**. No commit lands on prod without an audit pass.

### Commit 1 — Mastra + Agent SDK interop spike (docs-only)

Throwaway spike that de-risks the M1 architecture before prompt or agent code lands.

**Deliverables:**
- `docs/spikes/M1-mastra-agent-sdk.md` — findings doc with:
  - Minimal working snippet wiring a Mastra workflow step that calls a Claude Agent SDK `query()` with structured output (Zod-validated)
  - Streaming path: how SSE events flow from Agent SDK → Mastra step → Route Handler
  - Cache block control: where `cache_control` gets set; whether Agent SDK accepts a block array or we need a raw Anthropic call for KA
  - Tool parameter passing between Mastra's tool primitive and Agent SDK's `tools` parameter
  - Failure modes found and how to handle them
- A deletable `scripts/spike-mastra-sdk.ts` exercising the findings (committed but marked throwaway in the doc)

**Why spike first:** M0 retro flagged this as the #1 M1 risk. One evening of experimentation saves a week of re-plumbing.

**Audit focus:** does the spike exercise the actual interop path KA will use, or just `query() → text`? If it's not touching cache blocks and structured output, it hasn't de-risked M1.

---

### Commit 2 — Prompt registry

`src/lib/prompts/` + `registry.ts` with SHA-256 fingerprinting and fragment composition.

**Deliverables:**
- `src/lib/prompts/registry.ts` — load + fingerprint + hot-reload in dev (fs watcher)
- `src/lib/prompts/fragments/` — reusable chunks (`style_opus_voice.md`, `structured_output_contract.md`, `sakuga_choreographic.md`, `sakuga_frozen_moment.md`, `sakuga_aftermath.md`, `sakuga_montage.md` — the last four from §7.2.1)
- `src/lib/prompts/agents/` — one markdown file per agent (stubs for Intent/Outcome; KA block templates live here too)
- `{{include:fragment_name}}` resolver at registry-load time — composed prompts fingerprint deterministically
- `scripts/prompts-dump.ts` → `pnpm prompts:dump` prints every composed prompt with fingerprint (for audit)
- Unit tests: fragment resolution produces byte-identical output across loads; fingerprint changes when a fragment changes

**Risks:** hot-reload in dev must not fire in production (gate on `env.NODE_ENV === "development"`).

---

### Commit 3 — IntentClassifier agent (fast tier)

First real agent. Fast tier (Gemini 3.1 Flash), Zod-structured output.

**Deliverables:**
- `src/lib/agents/intent-classifier.ts` — function `classifyIntent(input): Promise<IntentOutput>`
- Schema additions to `src/lib/types/turn.ts`: tighten `IntentOutput` (10 intent types, action, target, epicness 0–1, special_conditions, confidence). Already scaffolded in M0; this commit finalizes.
- Prompt file: `src/lib/prompts/agents/intent-classifier.md`
- Failure handling per §5.4: `confidence < 0.6` → logged warning + DEFAULT fallback; schema parse failure → one stricter retry then DEFAULT; 5xx → exp backoff ×2 then DEFAULT.
- Tests: table-driven over 8 canned player messages hitting each intent type, plus failure-mode simulations (mocked SDK errors).
- Langfuse span wrapping with input/output/tokens/cost.

**Audit focus:** schema is actually validated on the model's output (not just typed); fallback logic actually fires; cost per call measured.

---

### Commit 4 — OutcomeJudge agent (thinking tier)

**Deliverables:**
- `src/lib/agents/outcome-judge.ts` — thinking tier (Opus 4.7, extended thinking budget 2K)
- `src/lib/types/turn.ts`: finalize `OutcomeOutput` (SuccessLevel enum, DifficultyClass number, NarrativeWeight MINOR/SIGNIFICANT/CLIMACTIC, consequence?, cost?, rationale)
- Prompt file with Zod schema injection in the system prompt
- Validator retry loop (Commit 5 wires this; this commit ships the retry hook)
- Tests: judge a canned intent against a canned character_summary, assert reasonable output shape and narrative_weight escalation behavior
- Langfuse span

**Audit focus:** extended-thinking budget is actually being sent; `rationale` field is non-empty on real calls; the model doesn't collapse SuccessLevel under prompt ambiguity.

---

### Commit 5 — KeyAnimator agent (creative tier, streaming, 4-block cache)

The centerpiece. Built on Claude Agent SDK per the spike.

**Deliverables:**
- `src/lib/agents/key-animator.ts` — streaming generator yielding text deltas
- 4-block cache structure (§7.2):
  - **Block 1** (cached, ~8–12K): Profile DNA + effective composition + static rule-library guidance + author voice + genre scene guidance. Rendered from `profile + campaign.active_* + campaign.arc_override`.
  - **Block 2** (cached, ~2–4K): compaction buffer — M1 ships empty, Compactor writes it at M7.
  - **Block 3** (cached, ~3–5K): working memory — last N player/DM messages.
  - **Block 4** (uncached, ~4–8K): dynamic context (intent, outcome, sakuga mode directive, style drift nudge, scene flags).
- Sakuga mode selection per §7.2.1 (priority ladder + fallback). Mode's fragment injects into Block 4.
- Style drift directive shuffle-bag (§7.4) — pool of 8; scans last 6 messages to decide whether to inject.
- Vocabulary freshness regex (§7.4) — deferred behind a flag if time-boxed; target is to ship it but audit may defer to M1.5.
- Tests: non-streaming mode (full response buffered) against a canned input; snapshot test on Block 1 rendering; sakuga mode selector unit test.

**Audit focus:** cache block boundaries land where we intend (check via Langfuse `cache_creation_input_tokens` / `cache_read_input_tokens`); streaming surface is actually streaming, not batched; DNA is surfacing into Block 1 as prescribed (not accidentally mixed into Block 4 where it'd blow the cache every turn).

---

### Commit 6 — Mastra workflow + SSE Route Handler + play UI

End-to-end wiring. First commit that lets the author actually play a turn.

**Deliverables:**
- `src/lib/workflow/turn.ts` — Mastra workflow per §6.1:
  - `classify_intent` → `route` (M1: DEFAULT only; other branches stub with `throw new Error("M2/M3")` or a friendly "not yet supported" narration)
  - `rag_base_retrieval` → minimal: last 3 turns concatenated into a scene summary, no embedding retrieval
  - Tier 0 fast-path: if `intent.epicness < 0.2` → synthetic auto-success outcome → KA directly
  - Parallel gather: outcome_judge (memory_rank stubbed for M4)
  - `validator` (retry outcome once if invalid — simple consistency check using Opus; OK to stub as pass-through in M1 if audit agrees)
  - `build_rag_context` → assembles Block 4 inputs
  - `key_animator` streaming
  - `persist_turn` → writes turn row with prompt fingerprints + Langfuse trace ID
  - `schedule_background` → Next.js `after()` stub (actual background agents come M4+)
- Per-campaign Postgres advisory lock (`pg_try_advisory_lock`) with 15s wait for overlap case
- `src/app/api/turns/route.ts` — POST handler, SSE response
- `src/hooks/useTurnStream.ts` — client hook, typewriter rendering
- `src/app/campaigns/[id]/play/page.tsx` — input + narrative feed, auth-gated
- Seed script: `scripts/seed-campaign.ts` — inserts one campaign using Cowboy Bebop profile + a pre-baked Spike Spiegel character row
- DB migration: `turns` table with columns for `intent`, `outcome`, `narrative`, `prompt_fingerprints` (jsonb), `trace_id`, `cost_usd`, `ttft_ms`, `total_ms`

**Audit focus:** advisory lock actually prevents overlap (integration test with two concurrent turn POSTs); SSE stream closes cleanly on completion and error; seed script is idempotent; typewriter rendering doesn't buffer (visible character-by-character render).

---

### Commit 7 — Eval harness + 5 golden turns + PR gate

**Deliverables:**
- `evals/golden/gameplay/` — 5 turn fixtures, each containing:
  - input (player message + campaign + character + last-3-turns summary)
  - expected intent (exact match criterion)
  - expected outcome shape (narrative_weight, success_level)
  - expected narrative criteria (rubric bullets for Haiku judge to score 1–5)
- `evals/run.ts` — harness that runs each turn through the real pipeline (mocking LLM calls only for determinism? or hitting real APIs with `evals:record`/`evals:replay`? — spike to decide)
- Haiku judge prompt with rubric
- CI integration: `pnpm evals` runs on PRs; fails if any dimension drops below threshold
- Dashboard-friendly output (JSON summary written to `evals/latest.json`)

**Audit focus:** the 5 turns are actually diverse (different intents, different weights); the judge rubric is specific enough to produce stable scores across runs; PR gate threshold isn't so loose it's theater or so tight it blocks harmless prompt tuning.

---

### Commit 8 — Rate limiter + cost counter + budget guards

**Deliverables:**
- `rate_limits` table (user_id, window_start, count). Postgres-backed counter; per-user per-minute cap + per-user daily turn cap.
- Cost per turn derived from Langfuse per-span cost; written to `turns.cost_usd`. Aggregate query on `/api/account/usage` returns today's spend.
- Daily per-user USD cap. Soft warn at 80%, hard block at 100%.
- Surface remaining budget in the play UI (small header indicator).
- Update ROADMAP §20 cost model with real observed numbers from the 10-turn prod run (first commit where §20 stops being hypothetical).

**Audit focus:** rate limiter holds under a burst test (curl 20 POSTs in 1s from a test harness via Playwright if auth blocks curl); cost counter is per-turn accurate within 5% of what the Langfuse dashboard shows.

---

## Ordering rationale

1. **Spike before code.** M0 retro's #1 risk. Cheap to run, expensive to skip.
2. **Prompt registry before agents.** Agents import from it; no point writing an agent against a registry that doesn't exist.
3. **Intent → Outcome → KA in that order.** Each agent's output is the next's input; testable in isolation; incremental complexity (fast → thinking → creative+streaming).
4. **Workflow wiring AFTER the three agents are green.** Workflow is glue; glue is easier when the pieces work.
5. **Eval harness after playable loop.** You can't eval what you can't run.
6. **Budget guards last.** You can't cap what you haven't measured.

---

## What M1 produces that M2 consumes directly

- `IntentClassifier`, `OutcomeJudge`, `KeyAnimator` (reused by SZ Conductor's opening-scene generation path)
- Prompt registry + fragment composition (SZ Conductor is another fragment consumer)
- Mastra workflow primitive in the codebase (SZ is its own workflow on the same primitive)
- SSE streaming harness (SZ UI reuses the stream hook with different event shape)
- Eval harness (SZ adds 5 golden SZ transcripts to it)
- Rate limiter + cost counter (SZ calls count against the same budget)

---

## Acceptance ritual

Before marking M1 closed:
1. Play 10 turns on prod. Screenshot narrative output.
2. Langfuse: confirm cache hit rate, TTFT p95, cost-per-turn.
3. Run `pnpm evals` — all 5 golden turns green.
4. Write `docs/retros/M1.md` mirroring M0's structure (what shipped, what was harder, lessons, deferred, risks into M2).
5. Compact context before M2.

---

*Plan written 2026-04-19 at M0 close. Commit cadence per `feedback_audit_cadence.md` — each of Commits 1–8 ships after a subagent audit passes, not before.*
