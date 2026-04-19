/**
 * M1 spike — Mastra + Anthropic SDK interop.
 *
 * Throwaway exploration verifying the three interop claims M0's retro flagged
 * as unproven:
 *
 *   (1) 4-block cache_control pattern (§7.2) works via the raw Anthropic SDK
 *   (2) Streaming text deltas are usable for SSE
 *   (3) Mastra's createStep can wrap an async LLM call and be composed into
 *       a workflow with Zod-typed input/output
 *
 * Findings go in docs/spikes/M1-mastra-agent-sdk.md. This script is runnable
 * with a real ANTHROPIC_API_KEY and uses Haiku (probe tier) to keep cost near
 * zero — two calls, ~200 total tokens.
 *
 * Usage:
 *   pnpm tsx scripts/spike-mastra-sdk.ts
 *
 * This script is intentionally throwaway. It will be deleted when M1 Commit 3
 * (IntentClassifier) lands real agent code exercising the same patterns.
 */
import { tiers } from "@/lib/env";
import { getAnthropic } from "@/lib/llm/anthropic";
import type Anthropic from "@anthropic-ai/sdk";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

// --- (1) 4-block cache_control pattern -------------------------------------
//
// KA needs 4 system blocks: Profile DNA (static), compaction buffer
// (append-only), working memory (sliding), dynamic context (uncached). The
// raw Anthropic SDK lets us mark any content block with `cache_control`;
// up to 4 distinct breakpoints per request.
//
// The Claude Agent SDK's `systemPrompt: string[]` is too coarse — it supports
// ONE `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker, collapsing our 3 cacheable
// blocks into 1. That's why KA will use the raw SDK instead of Agent SDK.

async function spikeFourBlockCache() {
  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create({
    model: tiers.probe.model,
    max_tokens: 32,
    // Four distinct cache breakpoints. In real KA these would be:
    //   block 1: Profile DNA + rule-library guidance (~8-12K)
    //   block 2: compaction buffer (~2-4K, append-only)
    //   block 3: working memory (~3-5K, sliding window)
    //   block 4: dynamic scene context (NO cache_control — re-rendered each turn)
    system: [
      {
        type: "text",
        text: "BLOCK 1 — Profile DNA placeholder. This block is session-stable and caches from turn one.",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "BLOCK 2 — Compaction buffer placeholder. Append-only across turns.",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "BLOCK 3 — Working memory placeholder. Slides as new turns arrive; tail is stable.",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "BLOCK 4 — Dynamic scene context. Intent, outcome, sakuga directive. NO cache_control.",
      },
    ],
    messages: [{ role: "user", content: "Reply with a single word: 'narrator'." }],
  });

  // Anthropic returns per-request cache stats in `usage`. On a cold call the
  // cacheable blocks go into `cache_creation_input_tokens`; on repeat calls
  // with identical prefix they move to `cache_read_input_tokens` at 10% cost.
  return {
    output: resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(""),
    usage: {
      input: resp.usage.input_tokens,
      output: resp.usage.output_tokens,
      cache_creation: resp.usage.cache_creation_input_tokens ?? 0,
      cache_read: resp.usage.cache_read_input_tokens ?? 0,
    },
  };
}

// --- (2) Streaming text deltas ---------------------------------------------
//
// KA streams tokens to the browser via SSE. Raw SDK's `stream: true` returns
// an async iterable of MessageStreamEvent; we filter to content_block_delta
// of type text_delta and forward the text as SSE. Proves: TTFT is measurable,
// no hidden buffering in the SDK.

async function spikeStreaming() {
  const anthropic = getAnthropic();
  const start = Date.now();
  let firstTokenMs = 0;
  let fullText = "";
  let deltaCount = 0;

  const stream = await anthropic.messages.create({
    model: tiers.probe.model,
    max_tokens: 48,
    system: "Respond with exactly three short words, comma-separated.",
    messages: [{ role: "user", content: "Three colors." }],
    stream: true,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      if (firstTokenMs === 0) firstTokenMs = Date.now() - start;
      fullText += event.delta.text;
      deltaCount += 1;
    }
  }

  return {
    output: fullText.trim(),
    ttftMs: firstTokenMs,
    totalMs: Date.now() - start,
    deltaCount,
  };
}

// --- (3) Mastra createStep wrapping an LLM call ----------------------------
//
// The turn pipeline is a Mastra workflow (§6.1). Each agent is a step with a
// Zod input/output schema. Verify: Mastra's createStep accepts a plain async
// `execute` function that can call the Anthropic SDK and return typed data.
// Confirms the composition primitive works — workflow can chain steps by
// input/output schema match.

const intentStub = createStep({
  id: "intent-stub",
  description: "Spike-only: pretend IntentClassifier returning a typed verdict.",
  inputSchema: z.object({ playerMessage: z.string() }),
  outputSchema: z.object({
    intent: z.enum(["DEFAULT", "COMBAT", "SOCIAL"]),
    epicness: z.number().min(0).max(1),
  }),
  execute: async ({ inputData }) => {
    // Real agent would call Anthropic with structured output here. For the
    // spike we just assert the step receives typed input and must return
    // typed output — enough to confirm the primitive shape.
    const fake = inputData.playerMessage.toLowerCase().includes("attack")
      ? { intent: "COMBAT" as const, epicness: 0.7 }
      : { intent: "DEFAULT" as const, epicness: 0.2 };
    return fake;
  },
});

const stubWorkflow = createWorkflow({
  id: "spike-workflow",
  inputSchema: z.object({ playerMessage: z.string() }),
  outputSchema: z.object({
    intent: z.enum(["DEFAULT", "COMBAT", "SOCIAL"]),
    epicness: z.number().min(0).max(1),
  }),
})
  .then(intentStub)
  .commit();

async function spikeMastraWorkflow() {
  const run = await stubWorkflow.createRun();
  const result = await run.start({ inputData: { playerMessage: "I attack the goblin." } });
  return result;
}

// --- Main ------------------------------------------------------------------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set — spike hits real Anthropic");
  }

  console.log("--- (1) 4-block cache_control pattern ---");
  const cacheResult = await spikeFourBlockCache();
  console.log(JSON.stringify(cacheResult, null, 2));

  console.log("\n--- (2) Streaming text deltas ---");
  const streamResult = await spikeStreaming();
  console.log(JSON.stringify(streamResult, null, 2));

  console.log("\n--- (3) Mastra createStep + createWorkflow ---");
  const workflowResult = await spikeMastraWorkflow();
  console.log(JSON.stringify(workflowResult, null, 2));

  console.log("\nSpike complete. See docs/spikes/M1-mastra-agent-sdk.md for findings.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
