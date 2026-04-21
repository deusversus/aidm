/**
 * MockLLM server CLI — start a standalone mock LLM server for local
 * development. `pnpm dev` with AIDM_MOCK_LLM=1 routes all provider
 * SDK calls here; the server replays fixtures + synthesizes fallbacks.
 *
 * Usage:
 *   pnpm mockllm                          # default port 7777, default fixture dir
 *   pnpm mockllm --port 8080              # custom port
 *   pnpm mockllm --strict                 # error on unknown prompts (CI mode)
 *   pnpm mockllm --fixtures ./evals/fixtures/llm   # override fixture dir
 *   pnpm mockllm --record                 # enable record mode (hits real API $)
 *   pnpm mockllm --record-to ./evals/fixtures/llm/recorded
 *
 * Env overrides:
 *   MOCKLLM_PORT              — default 7777
 *   MOCKLLM_FIXTURES_DIR      — default evals/fixtures/llm
 *   MOCKLLM_STRICT            — "1" enables strict mode
 *   MOCKLLM_MODE              — "record" enables record mode
 *   MOCKLLM_RECORD_TO         — default evals/fixtures/llm/recorded
 *   ANTHROPIC_API_KEY         — required when --record / MOCKLLM_MODE=record
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
  const recordMode = process.argv.includes("--record") || process.env.MOCKLLM_MODE === "record";
  const recordDir =
    parseArg("--record-to") ??
    process.env.MOCKLLM_RECORD_TO ??
    join(process.cwd(), "evals", "fixtures", "llm", "recorded");

  if (strict && recordMode) {
    console.error("--strict and --record are mutually exclusive.");
    process.exit(1);
  }
  if (recordMode && !process.env.ANTHROPIC_API_KEY) {
    console.error("--record requires ANTHROPIC_API_KEY in env (real API calls incur $).");
    process.exit(1);
  }

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

  const server = await startMockServer({
    port,
    registry,
    strict,
    record: recordMode ? { recordDir } : undefined,
  });
  const modeTag = recordMode ? "RECORD" : strict ? "strict" : "fixture-or-synth";
  console.log(
    `MockLLM listening on http://127.0.0.1:${server.port} · ${fixtureCount} fixtures · mode=${modeTag}`,
  );
  console.log(
    `To route through the mock, run the app with AIDM_MOCK_LLM=1 MOCKLLM_PORT=${server.port}`,
  );
  if (recordMode) {
    console.log("⚠  Record mode ACTIVE — unknown prompts will hit real Anthropic API.");
    console.log(`   Captured fixtures write to ${recordDir}`);
  }

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
