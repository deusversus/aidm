/**
 * C5 smoke: pre-warm writes the blocks 1–3 prefix cache; a second call
 * against the identical prefix reads it. Proves the §5.6 economics on the
 * real API. Run: pnpm spike:prewarm  (~a cent on Sonnet 5)
 */
import { assembleBlocks } from "@/lib/blocks/assemble";
import { prewarmPrefix } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";

// Synthetic but realistically-sized blocks — the prefix must clear the
// model's minimum cacheable length (1024 tokens on Sonnet).
const settei = [
  "# Smoke Campaign — Settei",
  "",
  "Register: clipped, jazz-phrased prose; deflection as intimacy; the long cool, then the sudden ache.",
  "",
  Array.from(
    { length: 60 },
    (_, i) =>
      `World rule ${i + 1}: the ${["docks", "lanes", "gates", "yards"][i % 4]} of sector ${i + 1} hold their own law, and the syndicates price passage in favors, not woolongs.`,
  ).join("\n"),
].join("\n");

const blocks = assembleBlocks({
  settei,
  beats: [
    {
      position: 0,
      content: "Spike bluffed his way past a dock guard on Ganymede.",
      isEpoch: false,
    },
  ],
  exchanges: [
    {
      turnNumber: 1,
      playerInput: "I wait at the noodle stand.",
      narration: "The broth steams. The guard from pier six sits down beside you with two beers.",
    },
  ],
  pins: [{ position: 0, content: "Whatever happens, happens.", sourceTurn: 0 }],
  watermark: 0,
});

console.log("budgets:", JSON.stringify(blocks.budgets));

const first = await prewarmPrefix(DEV_TIER_SELECTION, blocks.system);
console.log(
  `first call:  cacheCreation=${first.cacheCreation} cacheRead=${first.cacheRead} cost=$${first.costUsd.toFixed(6)}`,
);
const second = await prewarmPrefix(DEV_TIER_SELECTION, blocks.system);
console.log(
  `second call: cacheCreation=${second.cacheCreation} cacheRead=${second.cacheRead} cost=$${second.costUsd.toFixed(6)}`,
);

if (second.cacheRead <= 0) {
  process.exitCode = 1;
  console.error("spike_prewarm: FAIL — second call read no cache; prefix instability?");
} else {
  console.log(
    `spike_prewarm: OK — warm read covered ${second.cacheRead} tokens (${((second.cacheRead / (second.cacheRead + second.cacheCreation + 1)) * 100).toFixed(0)}% of prefix)`,
  );
}
await flushLangfuse();
