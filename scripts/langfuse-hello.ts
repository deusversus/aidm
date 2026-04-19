/**
 * Hello-world Langfuse trace. Wraps a minimal Anthropic call in a trace so we
 * can verify the integration end-to-end: SDK init, trace creation, generation
 * span with tokens, flush to cloud.
 *
 * Usage (with .env.local env vars loaded):
 *   pnpm tsx scripts/langfuse-hello.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { Langfuse } from "langfuse";

async function main() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const lfPublic = process.env.LANGFUSE_PUBLIC_KEY;
  const lfSecret = process.env.LANGFUSE_SECRET_KEY;
  const lfHost = process.env.LANGFUSE_HOST ?? "https://us.cloud.langfuse.com";

  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY missing");
  if (!lfPublic || !lfSecret) throw new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing");

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const langfuse = new Langfuse({ publicKey: lfPublic, secretKey: lfSecret, baseUrl: lfHost });

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

  await langfuse.flushAsync();

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
