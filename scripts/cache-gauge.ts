/**
 * The cache gauge (M2R5 C1) — the standing meter on prompt-cache economics.
 * Reads `model_calls` over a window and reports, per tier × model, what the
 * cache actually bought: hit ratio, the creation-vs-read balance, and the one
 * number the 2026-07-26 audit turned on — net USD saved (or lost) against the
 * counterfactual where the same tokens had never been cached at all.
 *
 * The cache is a bet: a write costs 2× the base input rate at the 1h TTL
 * (1.25× at 5m) and a read costs 0.1×. Write once, read twice and you are
 * ahead; write and never read and you paid double for nothing. This script
 * settles the bet.
 *
 *   pnpm cache:gauge [days]     (days = window, default 14)
 *
 * Since M3R2 C5 it also prints the assembled PROMPT SHAPE per campaign — the
 * §5.6 block budgets and the dropped-pin count the assembler computes and
 * nothing read. The ledger says what the cache bought; the shape says what it
 * is buying.
 *
 * No model calls, no spend. Not quite read-only: assembling a campaign that has
 * never been assembled lazily freezes its Settei snapshot, exactly as the first
 * real assembly would (blocks/campaign.ts) — a played campaign always has one.
 * Run it before and after any cache-touching commit — the net number moves the
 * right way or the commit doesn't push.
 */

import { assembleForCampaign } from "@/lib/blocks/campaign";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { pricingFor } from "@/lib/llm/pricing";
import { desc, gte, inArray, sql } from "drizzle-orm";

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

/** One lifecycle's slice of the ledger (M3 C1) — the whole bill, not just play. */
interface PhaseRow {
  phase: string;
  calls: number;
  input: number;
  read: number;
  creation: number;
  costUsd: number;
}

/** NULL phase = written before the column existed. Named, never counted as play. */
const UNATTRIBUTED = "(unattributed)";

interface Priced extends Row {
  /** creation × cacheCreationPer1M (the 2× 1h write premium). */
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

/**
 * The spend ledger by lifecycle (M3 C1). The 2026-08-01 audit found 47% of
 * real spend invisible to per-turn telemetry — session opens, recaps,
 * pre-warms and Director cycles — which made the cost model understate a
 * sitting by roughly 2×. Per tier × model says what ran; this says what it
 * was FOR, and the share column is the number that was missing.
 */
function printPhases(phases: PhaseRow[]): void {
  if (phases.length === 0) return;
  const total = phases.reduce((s, p) => s + p.costUsd, 0);
  console.log("");
  console.log("Spend by phase (the whole ledger, not just the turn):");
  console.log(
    `${"phase".padEnd(16)} ${"calls".padStart(6)} ${"input".padStart(11)} ${"read".padStart(12)} ${"creation".padStart(11)} ${"cost".padStart(11)} ${"share".padStart(7)}`,
  );
  console.log("-".repeat(80));
  for (const p of [...phases].sort((a, b) => b.costUsd - a.costUsd)) {
    const share = total === 0 ? 0 : p.costUsd / total;
    console.log(
      `${p.phase.padEnd(16)} ${String(p.calls).padStart(6)} ${int(p.input).padStart(11)} ${int(p.read).padStart(12)} ${int(p.creation).padStart(11)} ${usd(p.costUsd).padStart(11)} ${pct(share).padStart(7)}`,
    );
  }
  const turn = phases.find((p) => p.phase === "turn")?.costUsd ?? 0;
  const offTurn = total - turn;
  console.log("-".repeat(80));
  console.log(
    `${"TOTAL".padEnd(16)} ${String(phases.reduce((s, p) => s + p.calls, 0)).padStart(6)} ${"".padStart(11)} ${"".padStart(12)} ${"".padStart(11)} ${usd(total).padStart(11)}`,
  );
  console.log(
    `  off-turn spend: ${usd(offTurn)} (${pct(total === 0 ? 0 : offTurn / total)}) — the share a per-turn cost model cannot see.`,
  );
}

/** One campaign's assembled prompt shape — what the cached prefix WEIGHS. */
interface BlockBudgetRow {
  campaignId: string;
  title: string;
  b1: number;
  b2: number;
  b3: number;
  pins: number;
  total: number;
  epochs: number;
  droppedPins: number;
}

/**
 * The assembler's budgets, metered (M3R2 C5). `assembleBlocks` has always
 * returned per-block token counts and a droppedPins list; the only readers
 * were two spike scripts and a prewarm route that echoes them into a JSON
 * response nobody prints. The gauge is where they belong: the ledger above
 * says what the cache BOUGHT, and this says what it is buying — which block
 * grew, whether Block 2 is compacting, and whether the pin bound is silently
 * dropping player-held passages.
 *
 * DB reads only; no model calls, so the script stays free to run.
 */
function printBlockBudgets(rows: BlockBudgetRow[]): void {
  if (rows.length === 0) return;
  console.log("");
  console.log("Assembled prompt shape (what the cached prefix weighs, per campaign):");
  console.log(
    `${"campaign".padEnd(26)} ${"B1 settei".padStart(10)} ${"B2 story".padStart(9)} ${"B3 window".padStart(10)} ${"pins".padStart(6)} ${"total".padStart(8)} ${"epochs".padStart(7)} ${"dropped".padStart(8)}`,
  );
  console.log("-".repeat(92));
  for (const r of rows) {
    console.log(
      `${r.title.slice(0, 26).padEnd(26)} ${int(r.b1).padStart(10)} ${int(r.b2).padStart(9)} ${int(r.b3).padStart(10)} ${int(r.pins).padStart(6)} ${int(r.total).padStart(8)} ${String(r.epochs).padStart(7)} ${String(r.droppedPins).padStart(8)}`,
    );
  }
  const dropping = rows.filter((r) => r.droppedPins > 0);
  if (dropping.length > 0) {
    console.log(
      `  ${dropping.length} campaign(s) have pins the head of memory is NOT carrying — the play surface says so at pin time.`,
    );
  }
}

function printReport(
  days: number,
  since: Date,
  rows: Row[],
  phases: PhaseRow[],
  blocks: BlockBudgetRow[],
): void {
  console.log("");
  console.log(`=== Cache gauge — last ${days} day(s) ===`);
  console.log(`window since ${since.toISOString()} · ${rows.length} tier×model pair(s)`);
  console.log("");

  if (rows.length === 0) {
    console.log("No model_calls rows in the window.");
    return;
  }

  printPhases(phases);
  printBlockBudgets(blocks);
  console.log("");

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
        // Flat 2×: model_calls stores one creation total, not the per-TTL
        // split the meter now prices from (the rows predate it and the schema
        // stays put) — so a 5m write shows here at 2× and the NET line below
        // is, if anything, conservative.
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
  console.log(`  written    ${int(creation).padStart(12)} tokens @ 2× 1h = ${usd(writeUsd)}`);
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

  // The phase column is additive and lands with its own migration; until the
  // operator applies it the gauge still has a job to do, so a missing column
  // costs the phase table and nothing else.
  const rawPhases = await selectPhases(db, since);

  const phases: PhaseRow[] = rawPhases.map((p) => ({
    phase: p.phase,
    calls: num(p.calls),
    input: num(p.input),
    read: num(p.read),
    creation: num(p.creation),
    costUsd: num(p.costUsd),
  }));

  printReport(days, since, rows, phases, await selectBlockBudgets(db, since));
}

/** The campaigns that actually billed in the window, assembled and measured. */
async function selectBlockBudgets(
  db: ReturnType<typeof getDb>,
  since: Date,
): Promise<BlockBudgetRow[]> {
  const active = await db
    .selectDistinct({ campaignId: schema.modelCalls.campaignId })
    .from(schema.modelCalls)
    .where(gte(schema.modelCalls.createdAt, since));
  const ids = active.map((a) => a.campaignId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return [];
  const campaigns = await db
    .select({ id: schema.campaigns.id, title: schema.campaigns.title })
    .from(schema.campaigns)
    .where(inArray(schema.campaigns.id, ids))
    .orderBy(desc(schema.campaigns.updatedAt));

  const out: BlockBudgetRow[] = [];
  for (const c of campaigns) {
    try {
      const assembled = await assembleForCampaign(db, c.id);
      if (!assembled) continue;
      out.push({
        campaignId: c.id,
        title: c.title,
        b1: assembled.budgets.b1Tokens,
        b2: assembled.budgets.b2Tokens,
        b3: assembled.budgets.b3Tokens,
        pins: assembled.budgets.pinTokens,
        total: assembled.budgets.totalTokens,
        epochs: assembled.budgets.epochCount,
        droppedPins: assembled.droppedPins.length,
      });
    } catch (err) {
      // One unassemblable campaign (a pre-contract row, a bad jsonb) must not
      // cost the whole report — the ledger above is the gauge's main job.
      console.warn(
        `[cache-gauge] block budgets skipped for ${c.id} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

async function selectPhases(
  db: ReturnType<typeof getDb>,
  since: Date,
): Promise<
  { phase: string; calls: string; input: string; read: string; creation: string; costUsd: string }[]
> {
  try {
    return await db
      .select({
        phase: sql<string>`coalesce(${schema.modelCalls.phase}, ${UNATTRIBUTED})`,
        calls: sql<string>`count(*)`,
        input: sql<string>`coalesce(sum(${schema.modelCalls.inputTokens}), 0)`,
        read: sql<string>`coalesce(sum(${schema.modelCalls.cacheReadInputTokens}), 0)`,
        creation: sql<string>`coalesce(sum(${schema.modelCalls.cacheCreationInputTokens}), 0)`,
        costUsd: sql<string>`coalesce(sum(${schema.modelCalls.costUsd}), 0)`,
      })
      .from(schema.modelCalls)
      .where(gte(schema.modelCalls.createdAt, since))
      // Group by the RAW column, not the coalesce expression (M3R2 C5): the
      // sentinel binds as a parameter, so `coalesce(phase, $1)` in the
      // projection and `coalesce(phase, $2)` in GROUP BY are different
      // expressions to Postgres — it rejected the query with "must appear in
      // the GROUP BY clause" and the catch below swallowed it as a missing
      // migration. The whole phase ledger (M3 C1's answer to the 47% invisible
      // spend) has therefore been printing NOTHING. NULL forms its own group,
      // which is exactly the "(unattributed)" bucket.
      .groupBy(schema.modelCalls.phase);
  } catch (err) {
    console.warn(
      `\n[cache-gauge] phase table skipped — ${err instanceof Error ? err.message : String(err)}`,
    );
    console.warn("[cache-gauge] run the pending migration to see spend by phase.\n");
    return [];
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error("[cache-gauge] error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
