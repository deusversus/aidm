/**
 * The cache gauge (M2R5 C1) — the standing meter on prompt-cache economics.
 * Reads `model_calls` over a window and reports, per tier × model, what the
 * cache actually bought: hit ratio, the creation-vs-read balance, and the one
 * number the 2026-07-26 audit turned on — net USD saved (or lost) against the
 * counterfactual where the same tokens had never been cached at all.
 *
 * The cache is a bet: a write costs 2× the base input rate (1h TTL, the only
 * TTL this engine uses) and a read costs 0.1×. Write once, read twice and you
 * are ahead; write and never read and you paid double for nothing. This script
 * settles the bet.
 *
 *   pnpm cache:gauge [days]     (days = window, default 14)
 *
 * Read-only: one aggregate query, no model calls, no spend. Run it before and
 * after any cache-touching commit — the net number moves the right way or the
 * commit doesn't push.
 */

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { pricingFor } from "@/lib/llm/pricing";
import { gte, sql } from "drizzle-orm";

const DEFAULT_DAYS = 14;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(problem?: string): void {
  if (problem) console.error(`[cache-gauge] ${problem}\n`);
  console.error(
    [
      "Usage: pnpm cache:gauge [days]",
      "  [days]  window of model_calls rows to meter (default 14)",
      "",
      "Reports per tier × model cache accounting and the net USD the cache saved",
      "or lost against the uncached counterfactual. Read-only; spends nothing.",
    ].join("\n"),
  );
}

function parseArgs(): { days: number } {
  const raw = process.argv[2];
  if (raw === undefined) return { days: DEFAULT_DAYS };
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
    printUsage(`days must be a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return { days: Number.parseInt(raw, 10) };
}

/** The npm script supplies --env-file; a bare `tsx scripts/cache-gauge.ts`
 *  does not. Pull .env.local ourselves when the ambient env lacks the URL. */
function loadEnvIfNeeded(): void {
  if (process.env.DATABASE_URL) return;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local — rely on ambient env; getDb() reports the missing case cleanly.
  }
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

interface Row {
  tier: string;
  model: string;
  calls: number;
  input: number;
  read: number;
  creation: number;
  costUsd: number;
}

interface Priced extends Row {
  /** creation × cacheCreationPer1M (the 2× write premium). */
  writeUsd: number;
  /** read × cacheReadPer1M (the 0.1× discount). */
  readUsd: number;
  /** (creation + read) × inputPer1M — the same tokens at the base rate. */
  counterfactualUsd: number;
}

/** read / (read + creation + input) — the share of the prompt served warm. */
function hitRatio(r: Row): number {
  const total = r.read + r.creation + r.input;
  return total === 0 ? 0 : r.read / total;
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(days: number, since: Date, rows: Row[]): void {
  console.log("");
  console.log(`=== Cache gauge — last ${days} day(s) ===`);
  console.log(`window since ${since.toISOString()} · ${rows.length} tier×model pair(s)`);
  console.log("");

  if (rows.length === 0) {
    console.log("No model_calls rows in the window.");
    return;
  }

  console.log(
    `${"tier".padEnd(10)} ${"model".padEnd(24)} ${"calls".padStart(6)} ${"input".padStart(11)} ${"read".padStart(12)} ${"creation".padStart(11)} ${"cost".padStart(11)} ${"hit".padStart(7)}`,
  );
  console.log("-".repeat(98));
  for (const r of rows) {
    console.log(
      `${r.tier.padEnd(10)} ${r.model.padEnd(24)} ${String(r.calls).padStart(6)} ${int(r.input).padStart(11)} ${int(r.read).padStart(12)} ${int(r.creation).padStart(11)} ${usd(r.costUsd).padStart(11)} ${pct(hitRatio(r)).padStart(7)}`,
    );
  }

  // The bet, settled. Cache-touched tokens ONLY — input tokens bill the same
  // either way, so they cancel out of the comparison and would only dilute it.
  const priced: Priced[] = [];
  const unpriced: string[] = [];
  for (const r of rows) {
    if (r.read === 0 && r.creation === 0) continue;
    try {
      const p = pricingFor(r.model);
      priced.push({
        ...r,
        writeUsd: (r.creation / 1_000_000) * p.cacheCreationPer1M,
        readUsd: (r.read / 1_000_000) * p.cacheReadPer1M,
        counterfactualUsd: ((r.creation + r.read) / 1_000_000) * p.inputPer1M,
      });
    } catch {
      unpriced.push(r.model);
    }
  }

  const creation = priced.reduce((s, r) => s + r.creation, 0);
  const read = priced.reduce((s, r) => s + r.read, 0);
  const writeUsd = priced.reduce((s, r) => s + r.writeUsd, 0);
  const readUsd = priced.reduce((s, r) => s + r.readUsd, 0);
  const actual = writeUsd + readUsd;
  const counterfactual = priced.reduce((s, r) => s + r.counterfactualUsd, 0);
  const net = counterfactual - actual;

  console.log("");
  console.log("Cache-token accounting (creation + read; plain input tokens cancel out):");
  console.log(`  written    ${int(creation).padStart(12)} tokens @ 2×    = ${usd(writeUsd)}`);
  console.log(`  read       ${int(read).padStart(12)} tokens @ 0.1×  = ${usd(readUsd)}`);
  console.log(`  actual paid                              = ${usd(actual)}`);
  console.log(`  uncached counterfactual @ 1×             = ${usd(counterfactual)}`);
  console.log("");
  if (net >= 0) {
    console.log(`  NET SAVED  ${usd(net)}  — the cache is paying for itself.`);
  } else {
    console.log(`  NET LOST   ${usd(-net)}  — the cache costs more than it saves.`);
  }
  const ratio = read + creation === 0 ? 0 : read / (read + creation);
  // Token break-even at 2×-write/0.1×-read: reads ≈ 1.11 × writes, i.e. a
  // read share above ~53% of cache tokens. The NET line above is authoritative.
  console.log(`  read share of cache tokens: ${pct(ratio)} (token break-even ≈53%)`);
  if (unpriced.length > 0) {
    console.log("");
    console.log(`  (excluded — no pricing entry: ${[...new Set(unpriced)].join(", ")})`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvIfNeeded();
  const { days } = parseArgs();
  const db = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const raw = await db
    .select({
      tier: schema.modelCalls.tier,
      model: schema.modelCalls.model,
      calls: sql<string>`count(*)`,
      input: sql<string>`coalesce(sum(${schema.modelCalls.inputTokens}), 0)`,
      read: sql<string>`coalesce(sum(${schema.modelCalls.cacheReadInputTokens}), 0)`,
      creation: sql<string>`coalesce(sum(${schema.modelCalls.cacheCreationInputTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${schema.modelCalls.costUsd}), 0)`,
    })
    .from(schema.modelCalls)
    .where(gte(schema.modelCalls.createdAt, since))
    .groupBy(schema.modelCalls.tier, schema.modelCalls.model)
    .orderBy(schema.modelCalls.tier, schema.modelCalls.model);

  const rows: Row[] = raw.map((r) => ({
    tier: r.tier,
    model: r.model,
    calls: num(r.calls),
    input: num(r.input),
    read: num(r.read),
    creation: num(r.creation),
    costUsd: num(r.costUsd),
  }));

  printReport(days, since, rows);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error("[cache-gauge] error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
