/**
 * C4 smoke: streaming free prose + mandatory commit_scene tool trailer +
 * cache accounting, traced + metered. Run:
 *   pnpm spike:narration            (Sonnet 5, ~a cent)
 *   pnpm spike:narration -- --fable (Fable 5 w/ server-side Opus 4.8 fallback config, ~a few cents)
 */
import { streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, type TierSelection } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";

const useFable = process.argv.includes("--fable");
const selection: TierSelection = useFable
  ? { ...DEV_TIER_SELECTION, narration: "claude-fable-5" }
  : DEV_TIER_SELECTION;

const { stream, done } = streamNarration({
  name: "smoke_narration",
  selection,
  // deliberate smoke-size: a dev connectivity spike, not a budget class.
  maxTokens: 700,
  system: [
    {
      type: "text",
      text: "You are the narrator of a Cowboy Bebop-flavored story: clipped, jazz-phrased prose; deflection as intimacy; the long cool, then the sudden ache. Narrate ONE short beat (under 150 words), then call the commit_scene tool exactly once with the scene's sidecar. Never mention the tool in prose.",
      // Exercises cache-creation accounting; a second run within the TTL reads it.
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: [
    {
      role: "user",
      content:
        "Spike is waiting outside a noodle stand on Ganymede when the dock guard he bluffed an hour ago walks up — off duty, not angry, holding two beers.",
    },
  ],
});

stream.on("text", (t) => process.stdout.write(t));
const result = await done();
console.log("\n---");
console.log("served by:", result.message.model, result.fallbackUsed ? "(FALLBACK FIRED)" : "");
console.log("stop_reason:", result.message.stop_reason);
console.log("sidecar:", JSON.stringify(result.sidecar, null, 2));
console.log("usage:", JSON.stringify(result.message.usage));
console.log("cost: $", result.costUsd.toFixed(6));
if (!result.sidecar) {
  process.exitCode = 1;
  console.error("smoke_narration: FAIL — commit_scene trailer missing/unparseable");
} else {
  console.log("smoke_narration: OK — check langfuse:latest and the model_calls row");
}
await flushLangfuse();
