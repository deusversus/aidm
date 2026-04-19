# M1 — First playable turn, full shape

**Status:** Revised 2026-04-19 after vision alignment (see [project_v4_vision.md](../../../.claude/projects/C--Users-admin-Downloads-aidm-v4/memory/project_v4_vision.md))
**Goal:** KA orchestrates a full turn end-to-end on Claude Agent SDK, with every specialist scaffolded as a callable consultant and every memory layer scaffolded as an MCP server. A seed campaign is playable. The player can take ten turns on prod and it feels like the real thing — not a subset, not a stub-riddled MVP.

---

## The orienting principle

**Build the whole shape.** Not "M1 with Intent + Outcome + KA, defer the rest." The shape KA runs at M8 is the shape it runs at M1 — KA on Agent SDK, invoking specialists via the Agent tool, querying seven memory MCP servers, spawning research subagents when judgment calls for it, streaming prose with a 4-block cache. What changes between M1 and M8 is how rich the *content inside* the shape becomes (arc_plan depth, memory population, voice_patterns accumulation, NPC catalog density). The shape is constant from turn one.

A specialist that returns a minimal output at M1 is still a specialist KA consults. An MCP server that returns `[]` for active seeds is a working layer KA can query. Empty sets are a valid state of a living system, not a missing feature.

This is the inversion from how I drafted the original M1 plan and how I've been thinking about milestones generally. The user caught it and re-anchored: *build whole, sharpen over time; don't carve into MVP subsets.*

---

## Definition of done

- KA runs on Claude Agent SDK for every turn (not raw SDK for "M1 synthesis" — the real thing).
- Every gameplay specialist (IntentClassifier, WorldBuilder, OutcomeJudge, Validator, CombatAgent, ScaleSelectorAgent, PacingAgent, MemoryRanker, RecapAgent, ProductionAgent, RelationshipAnalyzer, Compactor) exists as a callable agent and is reachable from KA via Agent SDK's `Agent` tool or via direct Mastra step calls.
- All seven memory-layer MCP servers exist (§9.0): `aidm-ambient`, `aidm-working`, `aidm-episodic`, `aidm-semantic`, `aidm-voice`, `aidm-arc`, `aidm-critical`. Each has a working implementation even if its content is initially empty for campaigns without history.
- Seed campaign playable: Spike Spiegel in a Cowboy Bebop world (or the user's choice of SL/Bebop fixture). KA streams token-by-token to the browser via SSE.
- 10 consecutive turns on prod; narrative coherent; cache hit rate ≥ 80% after turn 3; p95 TTFT < 3s; eval suite green.
- Traces visibly show KA consulting specialists — OutcomeJudge being called before consequential actions, memory MCP servers being queried when KA reaches for specific content.
- Per-user daily cost cap enforced; rate limiter holds under burst test.
- Prompt registry: SHA-256 fingerprint per agent persisted on every turn row. `pnpm prompts:dump` works.

**What gets richer at later milestones (without changing shape):**
- M2 adds the SZ conductor conversation; premise becomes authored rather than hardcoded seed.
- M4 populates `aidm-semantic`, `aidm-voice`, NPC catalog, Director's arc_plan.
- M5 tunes CombatAgent + ScaleSelectorAgent + Validator's OP-mode rules.
- M6 fills `aidm-arc` with real seeds and lifecycle automation.
- M7 tunes Compactor and Recap on long-horizon play.

---

## Risks carried in from M0 + architecture conversation

1. **Agent SDK subprocess overhead.** Every turn spawns a Claude Code subprocess. Real latency per turn we'll measure. If p95 TTFT ends up above 3s due to spawn time, mitigations: `effort: 'medium'` instead of `'high'`, warm subprocess pool, streaming partial messages aggressively. The spike's 4-block-cache findings still apply — Agent SDK's `systemPrompt: string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is what we use; we accept the one-boundary cache model because the capabilities (tool loop, subagent, MCP) are worth the 2× cache cost on Block 1.
2. **Budget assumptions in ROADMAP §20 are untested.** First real turns surface actual numbers. Commit 9's cost counter is where hypotheticals meet reality.
3. **Clerk dev-instance bot protection masks 404s for curl.** E2E tests use Playwright, not curl.
4. **MCP server plumbing is new to the project.** Seven MCP servers is a lot of surface to register on day one. Commit 2's prompt registry + Commit 3's tool/MCP registry decides whether we register them in-process (Mastra-managed) or as actual MCP server processes. Default: in-process; promote to external MCP servers only when a second consumer appears (external Claude Code, third-party agent).

---

## Commit plan

Each commit follows the audit cadence: **implement → subagent audit → address findings → push**. Commits are thorough, not tiny.

### Commit 1 (done) — Mastra + Agent SDK interop spike

[`2d681b7`](https://github.com/deusversus/aidm/commit/2d681b7). Verified 4-block cache mechanics, streaming, Mastra step composition. Architectural decision has since updated: we're using Agent SDK for KA (reversing the spike's original recommendation) because the substrate capabilities (tool loop, subagents, MCP, Claude Code's agentic scaffolding) are the point. The cache cost delta is real but not decisive. See [spike doc](../spikes/M1-mastra-agent-sdk.md); it needs a decision-update note in a later commit.

### Commit 2 — Prompt registry + fragment composition

`src/lib/prompts/` with deterministic fragment composition, SHA-256 fingerprints, hot-reload in dev, `pnpm prompts:dump` for audit.

**Deliverables:**
- Registry loads markdown files, resolves `{{include:fragment_name}}` at load time, produces byte-deterministic composed prompts.
- SHA-256 fingerprint on every composed prompt; fingerprint is what persists on each turn row.
- Fragments for `style_opus_voice`, `structured_output_contract`, `sakuga_choreographic`, `sakuga_frozen_moment`, `sakuga_aftermath`, `sakuga_montage`.
- Agent prompt stubs for every gameplay agent (scaffolded; details fill in with their own commits).
- `KA_BLOCK_1.md`, `KA_BLOCK_2.md`, `KA_BLOCK_3.md`, `KA_BLOCK_4.md` templates.
- Hot-reload gated on `env.NODE_ENV === "development"`.

**Audit focus:** fragment composition is actually deterministic across loads; fingerprint changes when a fragment changes; hot-reload doesn't fire in production.

### Commit 3 — Tool + MCP registry

All tools KA will use, registered in one place with Zod schemas + Langfuse span wrapping. Exposed to KA via Agent SDK's `mcpServers` config as seven MCP servers (one per memory cognitive layer, plus entity and arc surfaces).

**Deliverables:**
- `src/lib/tools/` with Zod-typed tool implementations. MVP tools populated now: `get_character_sheet`, `get_world_state`, `get_recent_episodes`, `recall_scene`, `get_turn_narrative` (requires Commit 6's turns table), `search_memory` (stub — returns empty until M4), `get_critical_memories`, `get_npc_details` (stub), `list_known_npcs` (stub), `get_arc_state` (stub), `list_active_seeds` (stub).
- MCP server wrappers for each memory cognitive layer (§9.0 table). Start in-process via Mastra's MCP server primitive; external MCP promotion deferred to when a second consumer appears.
- Each tool emits a Langfuse span with input/output/latency. Tools authorize on `campaignId` against the calling user.
- Tests: invoke each tool with a canned campaign, assert schema match.

**Audit focus:** stubs return well-typed empty sets (not errors); authorization check actually fires on mismatched campaign; MCP server registration is discoverable by Agent SDK.

### Commit 4 — IntentClassifier + WorldBuilder + OverrideHandler (routing pre-pass)

The fast pre-pass that annotates the player message and handles routing before KA is invoked.

**Deliverables:**
- `IntentClassifier` (fast, Gemini 3.1 Flash) — 10 intent types, returns intent + action + target + epicness + special_conditions + confidence. Full per-agent spec from §5.4 (failure handling, retry policies).
- `WorldBuilder` (thinking, Opus 4.7) — validates in-fiction assertions; rejection phrased in-character.
- `OverrideHandler` (fast) — routes `/meta` and `/override` commands; auto-detects override category.
- Mastra workflow envelope routes: `META_FEEDBACK → meta loop`, `OVERRIDE_COMMAND → persist`, `WORLD_BUILDING → WorldBuilder`, else → continue to KA.
- Tests: canned player messages across all 10 intent types; override detection; WB acceptance/rejection/clarification cases.

**Audit focus:** router actually short-circuits on META/OVERRIDE; WB's in-character rejection renders via SSE to the browser (no error modals); intent fallback to DEFAULT on low confidence works.

### Commit 5 — OutcomeJudge, Validator, MemoryRanker, PacingAgent, RecapAgent, CombatAgent, ScaleSelectorAgent

All the consultants KA will call via the `Agent` tool. Each is a scaffolded agent with its full Zod I/O contract even if its outputs are minimal at M1.

**Deliverables:**
- Per-agent spec from §5.4 realized: prompts, Zod I/O, failure handling, Langfuse span wrapping.
- `OutcomeJudge` (thinking, Opus 4.7, 2K thinking budget) — success level, DC, narrative weight, consequence, cost, rationale.
- `Validator` (thinking) — consistency check on intent/outcome; one-retry loop on OJ.
- `MemoryRanker` (fast) — re-ranks >3 candidates via one structured-output call.
- `PacingAgent` (thinking) — reads arc_plan (empty at M1 from `aidm-arc`), returns beat guidance. At M1 returns minimal guidance; sharpens at M4+.
- `RecapAgent` (fast) — first turn of session; reads last session's final exchanges; returns a short catch-up summary. At M1 with a single-session seed campaign, it noops cleanly.
- `CombatAgent` + `ScaleSelectorAgent` (thinking + fast) — scaffolded with rules-lite; tuned at M5.
- Each agent registered in Agent SDK's `agents: {...}` config so KA can spawn them as subagents, and also callable as Mastra steps for non-KA invocations (validator retry, parallel gather if needed).
- Tests: per-agent unit tests with canned inputs; failure-mode simulations (mocked SDK errors).

**Audit focus:** each agent's failure fallback matches §5.4 spec; extended-thinking budgets actually reach the API; no agent is silently no-op when it should be returning real structure.

### Commit 6 — Turns table + seed campaign + KA orchestration + SSE + play UI

The centerpiece. KA running on Agent SDK, real seed campaign, SSE streaming to the browser, turn persistence.

**Deliverables:**
- Drizzle migration: `campaigns`, `turns`, `rate_limits` tables. `turns` includes columns for `narrative_text` (with tsvector index for `recall_scene`), `intent`, `outcome`, `prompt_fingerprints` (jsonb), `trace_id`, `cost_usd`, `ttft_ms`, `total_ms`, `summary` (populated at M4 when memory writer sharpens).
- Seed script: one campaign with Bebop profile + Spike character.
- `src/lib/agents/key-animator.ts`: KA on Agent SDK. Full Options config — 4-block `systemPrompt: string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, `includePartialMessages: true`, `thinking: { type: 'adaptive' }`, `effort: 'medium'`, `mcpServers` (the seven layer servers), `agents` (the consultants from Commit 5), `tools: []` (no Claude Code preset), `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` + session persistence disabled.
- Block rendering: Block 1 from profile + composition + rule library (session-stable), Block 2 from compaction buffer (empty at M1), Block 3 from working memory (last N exchanges), Block 4 dynamic (intent, outcome-placeholder-before-KA-decides-to-consult, sakuga mode, style drift, vocab freshness).
- Sakuga mode selection per §7.2.1; mode fragment renders into Block 4.
- `src/app/api/turns/route.ts` — POST handler, SSE response from Agent SDK's async generator. Forwards `SDKPartialAssistantMessage` text_delta events to client. Handles `stop_reason === "end_turn"` cleanly.
- `src/hooks/useTurnStream.ts` — client hook, typewriter rendering.
- `src/app/campaigns/[id]/play/page.tsx` — auth-gated play surface.
- Per-campaign Postgres advisory lock (`pg_try_advisory_lock`) with 15s wait for overlap.
- Portrait map: post-hoc scan of `**Name**` mentions.

**Audit focus:** KA actually invokes consultants when it should (traces show OutcomeJudge being called); 4-block cache is hitting (Langfuse `cache_read_input_tokens` > 0 by turn 3); streaming is character-by-character in the UI (not batched); advisory lock prevents overlap under a concurrent-POST integration test.

### Commit 7 — Post-turn background agents + memory writer

Next.js `after()` subgraph: memory writer, production, relationships, foreshadowing, director. Most run with minimal output at M1 and sharpen with later milestones — but the subgraph shape is in place and runs on every turn.

**Deliverables:**
- Memory writer (fast tier, background): reads completed turn + rag_context + outcome, emits structured candidates per §9.0 write path (storyboarded fragment + facts). Writes to `aidm-semantic` (pgvector when embedder decided at M4; fallback to no-op at M1 with a stub), `aidm-episodic` (summary column), `aidm-voice` (stub), `aidm-arc` (stub).
- `ProductionAgent` stub — registered and called post-turn but returns minimal (full wiring at M4+ when NPC catalog exists).
- `RelationshipAnalyzer` stub — same shape.
- `ForeshadowingLedger` stub — tables exist, seed lifecycle automation scaffolded, Director plants zero seeds at M1.
- `Director` scaffolded to run at session boundaries; produces an empty-but-shape-valid arc_plan at M1.
- `mark_turn_complete` releases advisory lock + emits final trace.

**Audit focus:** background subgraph actually runs post-response (doesn't block the turn); stubs don't silently eat errors; the full shape is in place even when outputs are minimal.

### Commit 8 — Eval harness + 5 golden turns + PR gate

**Deliverables:**
- `evals/golden/gameplay/` — 5 turn fixtures spanning DEFAULT, COMBAT, SOCIAL, EXPLORATION, ABILITY intents.
- Each fixture includes: input (player message + campaign + character + last-3-turns summary), expected intent (exact match), expected outcome shape (narrative_weight, success_level), expected narrative criteria (rubric for Haiku judge).
- `evals/run.ts` — harness running each turn through the real pipeline.
- Haiku judge prompt with rubric scoring 1–5 on intent accuracy, outcome feasibility, narrative coherence.
- CI integration: `pnpm evals` on PRs; fails if any dimension drops below threshold.
- Dashboard-friendly output (`evals/latest.json`).

**Audit focus:** the 5 turns are diverse (different intents, weights, sakuga modes); judge rubric produces stable scores across repeated runs; PR gate threshold is defensible.

### Commit 9 — Rate limiter + cost counter + budget guards

**Deliverables:**
- `rate_limits` table populated per turn; per-user per-minute cap + daily turn cap enforced.
- Cost per turn derived from Langfuse per-span cost; written to `turns.cost_usd`.
- Daily per-user USD cap: soft warn at 80%, hard block at 100%.
- Budget indicator in play UI header.
- ROADMAP §20 cost model updated with real observed numbers from 10-turn prod run.

**Audit focus:** rate limiter holds under a burst test (Playwright 20 POSTs in 1s); cost counter accurate within 5% vs Langfuse dashboard.

---

## Acceptance ritual

Before marking M1 closed:
1. Play 10 turns on prod with the seed campaign. Screenshot narrative output.
2. Langfuse: confirm cache hit rate ≥80% after turn 3, p95 TTFT < 3s, traces show KA consulting specialists and querying memory MCP servers.
3. Run `pnpm evals` — all 5 golden turns green.
4. Write `docs/retros/M1.md`: what shipped, what was harder, lessons, what M2 uses directly.
5. Compact context before M2.

---

## What M2 uses directly from M1

- Full agent roster + prompt registry + tool registry + seven memory MCP servers — M2 builds SZ on top without adding new primitives.
- KA on Agent SDK — M2 reuses the same shape, just triggered from SZ's handoff instead of a hardcoded seed.
- SSE streaming harness — M2's SZ conductor streams its conversation the same way.
- Eval harness — M2 adds 5 golden SZ transcripts.
- Rate limiter + cost counter — SZ calls count against the same budget.

---

*Revised 2026-04-19 after vision alignment. The commit cadence is work → subagent audit → fix → push on each of Commits 2–9.*
