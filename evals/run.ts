#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { resetAnthropicClientForTesting } from "@/lib/llm/anthropic";
import { loadFixtures, resetMockRuntimeForTesting, startMockServer } from "@/lib/llm/mock";
import { campaigns, turns, users } from "@/lib/state/schema";
import { type TurnWorkflowEvent, runTurn } from "@/lib/workflow/turn";
import { and, eq } from "drizzle-orm";
import jsYaml from "js-yaml";
import { evalResultPassed, formatResultLine, runDeterministicChecks, summarize } from "./aggregate";
import { seedScratchCampaign } from "./db-scratch";
import { type EvalResult, type GoldenFixture, GoldenFixture as GoldenFixtureSchema } from "./types";

/**
 * Eval harness (Commit 8). Loads golden-turn fixtures, seeds DB,
 * runs runTurn against MockLLM, runs deterministic checks, writes
 * latest.json. Zero live LLM calls in CI; the `--judge` flag adds
 * Haiku-based prose review and is invoked only manually with user
 * approval.
 *
 * Usage:
 *   pnpm evals          # local run, full output
 *   pnpm evals:ci       # CI mode — machine-readable summary, no judge
 *   pnpm evals --judge  # manual prose review (calls real Haiku ~$0.01;
 *                         requires user approval per pass)
 *
 * CI guard: judge.ts throws if process.env.CI === "true", so even
 * accidental `--judge` in a CI step can't spend.
 */

const FIXTURES_DIR = join(process.cwd(), "evals", "golden", "gameplay");
const LATEST_JSON = join(process.cwd(), "evals", "latest.json");

interface CliArgs {
  ci: boolean;
  judge: boolean;
  filter?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { ci: false, judge: false };
  for (const arg of argv) {
    if (arg === "--ci") args.ci = true;
    else if (arg === "--judge") args.judge = true;
    else if (arg.startsWith("--filter=")) args.filter = arg.slice("--filter=".length);
  }
  return args;
}

function loadGoldenFixtures(dir: string, filter?: string): GoldenFixture[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  const fixtures: GoldenFixture[] = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const parsed = GoldenFixtureSchema.safeParse(jsYaml.load(raw));
    if (!parsed.success) {
      console.error(`[eval] FAILED to parse fixture ${f}:`, parsed.error.issues);
      continue;
    }
    if (filter && !parsed.data.id.includes(filter)) continue;
    fixtures.push(parsed.data);
  }
  return fixtures;
}

interface CapturedTurn {
  intent: {
    intent: string;
    action?: string;
    epicness: number;
    special_conditions: string[];
  };
  outcome: {
    narrative_weight: string;
    success_level: string;
    rationale: string;
  } | null;
  narrative: string;
}

async function runOneScenario(
  fixture: GoldenFixture,
  runId: string,
): Promise<{ captured: CapturedTurn; error?: string }> {
  const db = getDb();
  const refs = await seedScratchCampaign(db, fixture, runId);

  let narrative = "";
  let capturedIntent: CapturedTurn["intent"] | null = null;
  let capturedOutcome: CapturedTurn["outcome"] = null;
  let error: string | undefined;

  try {
    // Eval harness calls runTurn DIRECTLY, not through /api/turns/route.ts,
    // so the budget gate + rate counter never fire. That's why there's
    // no bypass flag: the field was dead plumbing and was dropped along
    // with the leftover Commit 9 audit-MINOR fixes.
    const iter = runTurn(
      {
        campaignId: refs.campaignId,
        userId: refs.userId,
        playerMessage: fixture.input.player_message,
      },
      { db },
    );
    for await (const ev of iter as AsyncIterable<TurnWorkflowEvent>) {
      if (ev.type === "text") {
        narrative += ev.delta;
      } else if (ev.type === "done") {
        narrative = ev.narrative;
        capturedIntent = {
          intent: ev.intent.intent,
          action: ev.intent.action,
          epicness: ev.intent.epicness,
          special_conditions: ev.intent.special_conditions,
        };
        capturedOutcome = ev.outcome
          ? {
              narrative_weight: ev.outcome.narrative_weight,
              success_level: ev.outcome.success_level,
              rationale: ev.outcome.rationale,
            }
          : null;
      } else if (ev.type === "error") {
        error = ev.message;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    // Clean up the scratch campaign. Idempotent if another retry
    // picks up the same runId later. User rows are left to the
    // post-run cleanup (see main() — the eval user is per-runId so
    // concurrent runs don't collide; cleanup runs once after all
    // scenarios complete).
    await db.delete(turns).where(eq(turns.campaignId, refs.campaignId));
    await db
      .delete(campaigns)
      .where(and(eq(campaigns.id, refs.campaignId), eq(campaigns.userId, refs.userId)));
  }

  return {
    captured: {
      intent: capturedIntent ?? {
        intent: "UNKNOWN",
        epicness: 0,
        special_conditions: [],
      },
      outcome: capturedOutcome,
      narrative,
    },
    error,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode: "ci" | "local" | "judge" = args.judge ? "judge" : args.ci ? "ci" : "local";

  console.log(`[eval] mode=${mode}`);
  if (args.judge && process.env.CI === "true") {
    console.error("[eval] REFUSING: --judge is blocked in CI (would spend $).");
    process.exit(2);
  }

  const fixtures = loadGoldenFixtures(FIXTURES_DIR, args.filter);
  if (fixtures.length === 0) {
    console.error("[eval] no fixtures matched; exiting non-zero");
    process.exit(1);
  }
  console.log(`[eval] loaded ${fixtures.length} scenarios`);

  // Spin up the MockLLM HTTP server with ALL gameplay fixtures loaded.
  // The harness sets AIDM_MOCK_LLM=1 internally (below) so every
  // LLM provider call routes through the mock; callers don't need
  // to pre-export the env.
  // Pre-pass agents (IntentClassifier / OJ / Validator / WB) go through
  // the Anthropic SDK with its baseURL swapped to this server. KA +
  // Chronicler use the Agent SDK mock via the runtime registry (same
  // fixtures, loaded via resetMockRuntimeForTesting below).
  //
  // `strict: true` — every un-matched prompt errors with a clear
  // fixture-miss message, so drift surfaces immediately instead of
  // silently falling through to synth.
  const fixturesRoot = join(process.cwd(), "evals", "fixtures", "llm", "gameplay");
  const registry = loadFixtures(fixturesRoot);
  const server = await startMockServer({ port: 0, strict: true });
  server.replaceRegistry(registry);

  process.env.AIDM_MOCK_LLM = "1";
  process.env.MOCKLLM_HOST = "127.0.0.1";
  process.env.MOCKLLM_PORT = String(server.port);
  process.env.MOCKLLM_FIXTURES_DIR = fixturesRoot;
  // Flush any cached client/queryFn that may have captured a stale env.
  resetAnthropicClientForTesting();
  resetMockRuntimeForTesting();

  console.log(
    `[eval] mock server on :${server.port}; registry loaded with ${registry.byId.size} fixtures`,
  );

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const results: EvalResult[] = [];

  for (const fixture of fixtures) {
    process.stdout.write(`[eval] running ${fixture.id}… `);
    const { captured, error } = await runOneScenario(fixture, runId);
    const deterministic = runDeterministicChecks(fixture, captured);
    const passed = !error && evalResultPassed(deterministic);
    const result: EvalResult = {
      id: fixture.id,
      passed,
      narrative: captured.narrative,
      deterministic,
      error,
    };

    if (args.judge && !error) {
      // Gated; judge.ts enforces the CI guard again and logs loudly.
      const { judgeScenario } = await import("./judge");
      try {
        result.judge = await judgeScenario(fixture, captured.narrative);
      } catch (err) {
        result.error = `judge failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    results.push(result);
    console.log(formatResultLine(result));
  }

  const summary = summarize(mode, results, process.env.GIT_COMMIT);
  writeFileSync(LATEST_JSON, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[eval] wrote ${LATEST_JSON}`);
  console.log(
    `[eval] ${summary.passed}/${summary.passed + summary.failed} scenarios passed (mode=${mode})`,
  );

  // Cleanup: drop the per-run eval user. Turns + campaigns were
  // cleaned per-scenario; this cascades any leftover state and keeps
  // long-lived dev DBs tidy. CI's ephemeral Postgres makes this
  // redundant there, but it's cheap.
  try {
    const db = getDb();
    await db.delete(users).where(eq(users.id, `eval-${runId}`));
  } catch (err) {
    console.warn("[eval] cleanup: failed to drop eval user (non-fatal)", err);
  }

  await server.close();
  if (summary.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[eval] fatal:", err);
  process.exit(2);
});
