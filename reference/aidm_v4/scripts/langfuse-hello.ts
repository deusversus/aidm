/**
 * Hello-world Langfuse trace. Wraps a minimal Anthropic call in a trace so we
 * can verify the integration end-to-end: SDK init, trace creation, generation
 * span with tokens, flush to cloud.
 *
 * Usage (with .env.local env vars loaded):
 *   pnpm tsx scripts/langfuse-hello.ts
 *
 * Uses the same lazy singletons production code uses (`getAnthropic`,
 * `getLangfuse`) so this script stays aligned with the rest of the app —
 * one place to fix if SDK init changes.
 */
import { getAnthropic } from "@/lib/llm/anthropic";
import { flushLangfuse, getLangfuse } from "@/lib/observability/langfuse";
import type Anthropic from "@anthropic-ai/sdk";

async function main() {
  const anthropic = getAnthropic(); // throws if ANTHROPIC_API_KEY missing
  const langfuse = getLangfuse();
  if (!langfuse) throw new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing");

  const trace = langfuse.trace({
    name: "hello-world",
    metadata: { commit: process.env.GITHUB_SHA ?? "local", milestone: "M0-commit-5" },
  });

  const model = "claude-haiku-4-5-20251001";
  const input = "Say 'ok' and nothing else.";

  const generation = trace.generation({
    name: "anthropic-hello",
    model,
    input,
  });

  const start = Date.now();
  const resp = await anthropic.messages.create({
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: input }],
  });
  const latencyMs = Date.now() - start;

  const output = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  generation.end({
    output,
    usage: {
      input: resp.usage.input_tokens,
      output: resp.usage.output_tokens,
    },
  });

  trace.update({ output });

  await flushLangfuse();

  console.log(
    JSON.stringify(
      {
        status: "ok",
        traceId: trace.id,
        model,
        output,
        latencyMs,
        tokens: { input: resp.usage.input_tokens, output: resp.usage.output_tokens },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
