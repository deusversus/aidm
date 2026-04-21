/**
 * MockLLM server CLI — start a standalone mock LLM server for local
 * development. `pnpm dev` with AIDM_MOCK_LLM=1 routes all provider
 * SDK calls here; the server replays fixtures + synthesizes fallbacks.
 *
 * Usage:
 *   pnpm mockllm                      # default port 7777, default fixture dir
 *   pnpm mockllm --port 8080          # custom port
 *   pnpm mockllm --strict             # error on unknown prompts (CI mode)
 *   pnpm mockllm --fixtures ./evals/fixtures/llm  # override fixture dir
 *
 * Env overrides:
 *   MOCKLLM_PORT              — default 7777
 *   MOCKLLM_FIXTURES_DIR      — default evals/fixtures/llm
 *   MOCKLLM_STRICT            — "1" enables strict mode
 */
import { join } from "node:path";
import { loadFixtures } from "@/lib/llm/mock/fixtures";
import { startMockServer } from "@/lib/llm/mock/server";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const port = Number(parseArg("--port") ?? process.env.MOCKLLM_PORT ?? 7777);
  const fixturesDir =
    parseArg("--fixtures") ??
    process.env.MOCKLLM_FIXTURES_DIR ??
    join(process.cwd(), "evals", "fixtures", "llm");
  const strict = process.argv.includes("--strict") || process.env.MOCKLLM_STRICT === "1";

  console.log(`Loading fixtures from ${fixturesDir}…`);
  let fixtureCount = 0;
  let registry: ReturnType<typeof loadFixtures>;
  try {
    registry = loadFixtures(fixturesDir);
    fixtureCount = registry.byId.size;
  } catch (err) {
    console.error(`Failed to load fixtures: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const server = await startMockServer({ port, registry, strict });
  console.log(
    `MockLLM listening on http://127.0.0.1:${server.port} · ${fixtureCount} fixtures · strict=${strict}`,
  );
  console.log(`Point Anthropic SDK at ANTHROPIC_BASE_URL=http://127.0.0.1:${server.port}`);

  const shutdown = async () => {
    console.log("\nMockLLM shutting down…");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
