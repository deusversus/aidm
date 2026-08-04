/**
 * M2R5 C1 wire proof: the pre-warm writes the entry the KA reads.
 *
 * Mocks prove request SHAPE; only the wire proves the cache. This assembles a
 * real campaign's blocks, fires `prewarmPrefix` with the constant KA tool array
 * (§5.6 — tools render ahead of `system` in the cache key, so the pre-warm must
 * carry them or it writes an entry the narration call structurally cannot hit),
 * then makes ONE narration call against the identical prefix and reports its
 * cache_read_input_tokens.
 *
 *   pnpm spike:cache <campaignId>
 *
 * DEV tiers only — Sonnet, never Fable (standing directive). One short
 * narration call; cents. The operator runs this deliberately.
 */

import { assembleForCampaign } from "@/lib/blocks/campaign";
import { type Db, getDb } from "@/lib/db";
import { prewarmPrefix, streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { KA_TOOLS } from "@/lib/turn/tools";
import { guardNoFable } from "./soak-lib";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A deliberately tiny scene — this measures the prefix, not the prose. */
const SPIKE_MAX_TOKENS = 300;

function printUsage(problem?: string): void {
  if (problem) console.error(`[spike-cache] ${problem}\n`);
  console.error(
    [
      "Usage: pnpm spike:cache <campaignId>",
      "  <campaignId>  a campaign with an assembled premise contract (uuid)",
      "",
      "Pre-warms the campaign's real four-block prefix with the KA tool array,",
      "then makes one dev-tier narration call against it and reports the cache",
      "read. Spends a few cents of API budget.",
    ].join("\n"),
  );
}

function parseArgs(): string {
  const campaignId = process.argv[2];
  if (!campaignId) {
    printUsage("missing <campaignId>");
    process.exit(1);
  }
  if (!UUID_RE.test(campaignId)) {
    printUsage(`"${campaignId}" is not a valid campaign id (uuid)`);
    process.exit(1);
  }
  return campaignId;
}

async function main(): Promise<void> {
  guardNoFable(DEV_TIER_SELECTION);
  const campaignId = parseArgs();
  const db: Db = getDb();

  const blocks = await assembleForCampaign(db, campaignId);
  if (!blocks) {
    console.error(`[spike-cache] campaign ${campaignId} has no premise contract — nothing to warm`);
    process.exit(1);
  }
  console.log(`budgets: ${JSON.stringify(blocks.budgets)}`);
  console.log(`tools:   ${KA_TOOLS.map((t) => t.name).join(", ")}`);

  // M3R2 C2: the window is MESSAGES now — the proof must exercise the moved
  // shape or it validates only the half that did not change.
  const warm = await prewarmPrefix(
    DEV_TIER_SELECTION,
    blocks.system,
    KA_TOOLS,
    { campaignId },
    blocks.exchangeMessages,
  );
  console.log(
    `prewarm:   cacheCreation=${warm.cacheCreation} cacheRead=${warm.cacheRead} cost=$${warm.costUsd.toFixed(6)}`,
  );

  // Two reads at DIFFERENT efforts. (The KA no longer varies effort per tier
  // — flat high since the §3 amendment 2026-08-01 — but the spike keeps both
  // legs as the standing cache-key probe.) MEASURED 2026-07-26 here: effort
  // PARTICIPATES in the cache key — "high" reads a no-effort entry (high is
  // the API default, same normalized key) while "low" misses the identical
  // prefix and re-writes it at 2×. The high leg is therefore the pass/fail
  // wire proof (it matches the pre-warm's shape and genga, the default
  // tier); the low leg is a measurement, reported but never a failure —
  // the effort↔tier mapping is a §3 decision, not this spike's.
  const efforts = ["high", "low"] as const;
  let anyFail = false;
  for (const effort of efforts) {
    const { stream, done } = streamNarration({
      name: `spike_cache_${effort}`,
      selection: DEV_TIER_SELECTION,
      system: blocks.system,
      messages: [
        ...blocks.exchangeMessages,
        {
          role: "user",
          content:
            "Warm-read probe. Write ONE short sentence of prose set in this world, then call commit_scene once.",
        },
      ],
      maxTokens: SPIKE_MAX_TOKENS,
      effort,
      tools: KA_TOOLS,
      campaignId,
    });
    stream.on("text", (t) => process.stdout.write(t));
    const result = await done();
    const usage = result.message.usage;
    const read = usage.cache_read_input_tokens ?? 0;
    const creation = usage.cache_creation_input_tokens ?? 0;

    console.log("\n---");
    console.log(`served by: ${result.message.model} (effort ${effort})`);
    console.log(
      `narration: cacheRead=${read} cacheCreation=${creation} input=${usage.input_tokens} cost=$${result.costUsd.toFixed(6)}`,
    );
    if (read > 0) {
      const covered = read / (read + creation + usage.input_tokens);
      console.log(
        `spike_cache (effort ${effort}): warm — read ${read} tokens (${(covered * 100).toFixed(0)}% of the prompt).`,
      );
    } else if (effort === "high") {
      anyFail = true;
      process.exitCode = 1;
      console.error(
        "spike_cache (effort high): FAIL — ZERO cached tokens read on the pre-warm-matching shape. The pre-warm's entry is unreachable (check tools/system parity).",
      );
    } else {
      console.log(
        `spike_cache (effort ${effort}): cold — effort participates in the cache key (expected; measured 2026-07-26).`,
      );
    }
  }
  if (!anyFail) {
    console.log("spike_cache: OK — the pre-warm's write is reachable by the KA's default shape.");
  }
}

try {
  await main();
  await flushLangfuse();
  process.exit(process.exitCode ?? 0);
} catch (err) {
  console.error("[spike-cache] error:", err instanceof Error ? err.message : String(err));
  await flushLangfuse();
  process.exit(1);
}
