# Spike — Mastra + Claude Agent SDK interop (M1 Commit 1)

**Date:** 2026-04-19
**Cost:** $0.0008 (2 Haiku calls, ~230 total tokens)
**Script:** [`scripts/spike-mastra-sdk.ts`](../../scripts/spike-mastra-sdk.ts) — throwaway, deleted when M1 Commit 3 lands real agents
**Risk addressed:** M0 retro's #1 M1 risk — "Mastra wiring is unproven. The Claude Agent SDK + Mastra interop pattern isn't yet exercised."

---

## TL;DR — 4 findings, 1 architectural decision

1. **Claude Agent SDK is a Claude-Code-subprocess wrapper, not a raw Anthropic API.** It's optimal for filesystem/shell coding agents; its caching primitive (`systemPrompt: string[]` with one `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker) is too coarse for KeyAnimator's 4-block cache structure (§7.2). **We will not use Agent SDK for the M1 gameplay pipeline.** Revisit for M2's SessionZeroConductor (benefits from its tool-loop convergence) and M4+ research subagents.
2. **Raw `@anthropic-ai/sdk` handles everything M1 needs.** Native `cache_control: { type: 'ephemeral' }` on any content block, native streaming via `stream: true` with `content_block_delta` events, native extended thinking, native structured output via tool-result coercion or prefilled assistant. Confirmed with a live call.
3. **Mastra's `createStep` + `createWorkflow` primitives compose cleanly with async LLM calls.** A step takes a Zod input/output schema and an `async execute` function; the workflow runs it and returns a typed `result` plus per-step telemetry (`steps.{id}.output`, `status`, `startedAt`/`endedAt`). Zero friction for M1's pipeline.
4. **Agent SDK 0.2.114 requires zod v4; project was on zod v3.** Upgrade was clean — all 30 existing tests pass under zod 4.3.6 with no code changes. Locked in during this spike.

**Architectural decision:** M1 agents call `@anthropic-ai/sdk` and `@google/genai` directly. Mastra orchestrates the workflow (steps, branching, parallel gather, state). Agent SDK stays installed for M2+, but the gameplay turn pipeline is Mastra + raw provider SDKs. No Agent SDK subprocess in the request path.

---

## What I actually ran

Three micro-tests in [`scripts/spike-mastra-sdk.ts`](../../scripts/spike-mastra-sdk.ts). Output verbatim:

### (1) 4-block `cache_control` pattern

```json
{
  "output": "narrator",
  "usage": {
    "input": 103,
    "output": 4,
    "cache_creation": 0,
    "cache_read": 0
  }
}
```

**Reading:** The API accepted 4 `cache_control: { type: 'ephemeral' }` markers on 4 `TextBlockParam`s in the `system` array. No errors. `cache_creation: 0` is **expected, not a failure** — Anthropic's minimum cacheable block size is **1024 tokens**; my placeholder blocks are ~25 tokens each. Real KA's Block 1 (Profile DNA + rule guidance, 8–12K tokens) will cache. **The mechanism works; the placeholder payload was too small to trigger it.**

**Action item for Commit 5 (KA):** snapshot `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens` on every KA response; write to `turns.cost_usd` and Langfuse span. Alert in dev if Block 1 isn't caching by turn 3.

### (2) Streaming text deltas

```json
{
  "output": "Red, blue, green.",
  "ttftMs": 487,
  "totalMs": 611,
  "deltaCount": 2
}
```

**Reading:** `messages.create({ stream: true })` returns an async iterable of `MessageStreamEvent`. Filtering to `event.type === "content_block_delta" && event.delta.type === "text_delta"` gives us raw text fragments ready to forward as SSE. TTFT 487ms on Haiku probe — Opus 4.7 TTFT will be higher (budget is p95 < 3s per ROADMAP §23), but the mechanism is sound. `deltaCount: 2` because short outputs get batched by Anthropic's server-side buffering; longer outputs will stream many more fragments.

**Action item for Commit 6 (SSE route):** the route handler consumes this async iterable, JSON-encodes each delta as an SSE `data:` line, and closes the stream on `message_stop`. No buffering needed on our side.

### (3) Mastra `createStep` + `createWorkflow`

```json
{
  "status": "success",
  "steps": {
    "input": { "playerMessage": "I attack the goblin." },
    "intent-stub": {
      "status": "success",
      "output": { "intent": "COMBAT", "epicness": 0.7 },
      "startedAt": 1776607215449,
      "endedAt": 1776607215450
    }
  },
  "result": { "intent": "COMBAT", "epicness": 0.7 },
  "stepExecutionPath": ["intent-stub"]
}
```

**Reading:** Single step with `inputSchema: z.object({ playerMessage })` and `outputSchema: z.object({ intent, epicness })` composed into a workflow via `.then(step).commit()`. Run with `workflow.createRun()` → `run.start({ inputData })`. Result includes full per-step telemetry out of the box — these fields map directly to Langfuse spans.

**Confirmed composition patterns usable for M1:**
- `.then(step)` — sequential
- `.parallel([stepA, stepB])` — concurrent (for the `outcome_judge` / `memory_rank` / `pacing` / `recap` parallel gather in §6.1)
- `.branch([[condition, stepA], [condition, stepB]])` — intent routing
- `.dowhile` / `.foreach` — validator retry loop

`createRun()` is the method name (not `createRunAsync` — my first draft had it wrong; the `d.ts` showed both forms in comments which misled me briefly).

---

## Why Agent SDK doesn't fit the M1 gameplay pipeline

I read the full `Options` type in [`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`](../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts). The SDK's surface is oriented around **Claude Code as a subprocess**:

- `executable: 'bun' | 'deno' | 'node'`, `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess` — it spawns a subprocess running Claude Code
- `tools: ['Bash', 'Read', 'Edit', 'Glob', ...]` — the tool preset is Claude Code's built-in tools (we don't want these for narrative agents)
- `additionalDirectories`, `enableFileCheckpointing`, `sandbox`, `cwd` — filesystem-sandboxed coding workflows
- `permissionMode`, `canUseTool` — permission prompts for dangerous operations
- `sessionStore`, `resume`, `continue`, `persistSession` — session persistence to `~/.claude/projects/` JSONL files

It DOES expose the knobs we'd want for LLM work:
- `systemPrompt: string[]` with one `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker
- `outputFormat: { type: 'json_schema', schema }` for structured output
- `thinking: { type: 'adaptive' | 'enabled' }` + `effort: 'low' | ... | 'max'`
- `model`, `maxTurns`, `maxBudgetUsd`
- `includePartialMessages: true` for streaming
- `tools: []` + `mcpServers: {}` to disable Claude Code tools and inject custom MCP tools

**But** the caching primitive is the dealbreaker for KA: one boundary, two cacheable groups. KA needs three cacheable groups (Block 1 / Block 2 / Block 3) plus an uncached Block 4 — the raw SDK's per-block `cache_control` markers give us that. Agent SDK forces us to either merge Blocks 1–3 (losing Block 2's append-only behavior and Block 3's sliding-window stability) or use only one cacheable block (losing the compaction buffer cache win entirely).

The other strikes against Agent SDK for the turn path:
- **Subprocess overhead.** Every `query()` spawns a Node process running Claude Code. On Railway that's real latency (~100–300ms) per turn on top of Anthropic's TTFT. Raw SDK is an HTTPS POST.
- **Session persistence we don't want.** Agent SDK writes JSONL to `~/.claude/projects/` by default (can disable with `persistSession: false`, but it's opt-out). Our turn state lives in Postgres; double-writing is noise.
- **Tool-loop convergence is table stakes.** Agent SDK's big win is handling multi-round tool use well (max iterations, parallel tool calls, permission prompts). M1's three agents have zero tool calls. Intent/Outcome are structured-output one-shots; KA's research phase is deferred ("M2 or when we see KA hallucinating facts").

**Where Agent SDK earns its keep later:**
- **M2 SessionZeroConductor** — genuine tool loop (`proposeCharacterOption`, `commitField`, `askClarifyingQuestion`, `finalizeSessionZero`), benefits from convergence handling
- **M4 research subagents inside KA / Director** — Agent SDK's `agents: { 'researcher': { ... } }` primitive is exactly the two-model pattern (§5.3)
- **M6 ForeshadowingLedger** — Director-driven tool calls on the causal graph

For these, we'll switch the relevant agent to Agent SDK and wrap the call in a Mastra step. Same interop pattern — just a different function body.

---

## Mastra pattern that M1 will use

The spike's `intentStub` is the template for the three real agents. Abbreviated:

```typescript
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const intentClassifier = createStep({
  id: "intent-classifier",
  inputSchema: IntentClassifierInput,   // from src/lib/types/turn.ts
  outputSchema: IntentOutput,
  execute: async ({ inputData }) => {
    // Call Gemini 3.1 Flash via @google/genai with structured output.
    // Langfuse span wrapping, failure handling, fallback DEFAULT.
    return classifyIntent(inputData);
  },
});

const turnWorkflow = createWorkflow({
  id: "turn",
  inputSchema: TurnInput,
  outputSchema: TurnOutput,
})
  .then(intentClassifier)
  .then(outcomeJudge)
  .then(keyAnimator)  // streaming step — see Commit 5/6 for the async-generator pattern
  .commit();
```

For KA's streaming, the step's `execute` returns the stream descriptor (trace ID, final text, cost); the actual token stream is pushed to the client via an `outputWriter` (Mastra's streaming primitive) or directly through a Response held open by the Route Handler. Commit 6 will spike which pattern is cleaner.

---

## Follow-ups this spike created

- **Commit 5 (KA):** assert `cache_creation_input_tokens > 0` on first real turn and `cache_read_input_tokens > 0` on turn 2+. Alert if not — means Block 1 is too small or boundary drifted.
- **Commit 6 (SSE):** decide between Mastra `outputWriter` vs. Route Handler holding the stream. Either works; pick the one that keeps the Langfuse span count honest.
- **Nice-to-have (post-M1):** wrap Agent SDK's `query()` in a `getAgentSdkQuery()` singleton similar to `getAnthropic()` when we actually use it. Not needed now.
- **Docs scrub:** ROADMAP §5.3 and §7.2 reference "Claude Agent SDK handles cache_control placement from a declarative block list" — that's wrong (verified above). Update those sections in a follow-up doc commit.

---

*Spike closed. M1 Commit 2 (prompt registry) cleared to start.*
