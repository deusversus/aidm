/**
 * The exit gauge (M2R2 "The exit", deliverable 5) — on-demand measurement of
 * how a campaign's recent scenes END. Mechanizes the 2026-07-20 investigation
 * rubric so the deflating-close fix is measured, not vibed (blueprint axiom:
 * measured, not vibed) and can't silently regress.
 *
 * For the last N completed story turns it classifies each close:
 *   ending                  motion | fork | rest
 *   pressure_alive_at_close  did the scene's own pressure survive the curtain?
 *   treadmill                a fork re-posing the previous turn's standing dilemma
 *   evidence                 the closing 1-2 sentences, verbatim
 * …then reports the tallies. It REPORTS numbers only — no pass/fail verdict,
 * no adjudication of the classifier's calls (the C10 discipline: the script
 * never substitutes for or overrides a computed result).
 *
 *   pnpm tsx scripts/exit-gauge.ts <campaignId> [n]   (n = last N turns, default 12)
 *
 * DEV tiers only — the probe is Haiku (never Fable; the repo law the soaks
 * hold). One probe per turn, traced + metered through the standard trio
 * (callProbe); ~cents per run. Point it only at a campaign you're willing to
 * spend a few probe calls against — the orchestrator runs it deliberately.
 */

import { type Db, getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { CLASSIFY } from "@/lib/llm/budgets";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { guardNoFable } from "./soak-lib";

const DEFAULT_N = 12;
/** The close is what we measure — send the tail, not the whole scene. */
const THIS_TAIL_CHARS = 600;
const PREV_TAIL_CHARS = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// The classification (the 2026-07-20 rubric, mechanized as strict output).
// ---------------------------------------------------------------------------

const Classification = z.object({
  ending: z
    .enum(["motion", "fork", "rest"])
    .describe(
      "motion: a new event/arrival/discovery/pressure lands at the close and demands the player react. " +
        "fork: an explicit decision point is presented and left open. " +
        "rest: descriptive equilibrium — the scene settles, nothing new is in motion at the close.",
    ),
  pressure_alive_at_close: z
    .boolean()
    .describe(
      "true if pressure introduced in THIS scene survives to the close; false if it was defused before the curtain (e.g. 'went quiet', 'he forgot it').",
    ),
  treadmill: z
    .boolean()
    .describe(
      "Only meaningful when ending is 'fork': true if the fork is substantially the SAME standing dilemma the previous scene's close already posed (re-worn, not advanced). false when ending is not 'fork' or no previous scene is given.",
    ),
  evidence: z.string().describe("The closing 1-2 sentences of THIS scene, verbatim and short."),
});
type Classification = z.infer<typeof Classification>;

const RUBRIC = [
  "You classify how a single scene of interactive fiction ENDS. You are given the closing text of a scene",
  "(and, when available, the closing text of the PREVIOUS scene, for comparison only). Judge the CLOSE — the",
  "final beat — not the whole scene.",
  "",
  "Fields:",
  "- ending:",
  "    motion: a new event, arrival, discovery, or pressure lands at the close and demands the player react.",
  "    fork:   an explicit decision point is presented to the player and left open.",
  "    rest:   descriptive equilibrium — the scene settles; nothing new is in motion at the close.",
  "- pressure_alive_at_close: true if pressure introduced in THIS scene survives to the close; false if it was",
  "    defused before the curtain (tension released, a threat 'went quiet', a thread 'he forgot it').",
  "- treadmill: only meaningful when ending is 'fork'. true if the fork is substantially the SAME standing",
  "    dilemma the previous scene's close already posed (re-worn, not advanced). If ending is not 'fork', or no",
  "    previous scene is given, set false.",
  "- evidence: the closing 1-2 sentences of THIS scene, verbatim and short.",
  "",
  "Classify strictly from the text shown. Do not invent content beyond it.",
].join("\n");

function buildPrompt(thisTail: string, prevTail: string | null, turnNumber: number): string {
  const parts = [`THIS scene (turn ${turnNumber}) — closing text:`, '"""', thisTail, '"""'];
  if (prevTail !== null) {
    parts.push(
      "",
      "PREVIOUS scene — closing text (for the treadmill comparison only):",
      '"""',
      prevTail,
      '"""',
    );
  }
  parts.push("", "Classify this scene's close.");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(problem?: string): void {
  if (problem) console.error(`[exit-gauge] ${problem}\n`);
  console.error(
    [
      "Usage: pnpm tsx scripts/exit-gauge.ts <campaignId> [n]",
      "  <campaignId>  the campaign to gauge (uuid)",
      "  [n]           number of most-recent completed story turns to classify (default 12)",
      "",
      "Classifies how each of the last n scenes ENDS (motion / fork / rest), whether the",
      "scene's own pressure survived to the close, and fork-treadmill repetition, then reports",
      "the tallies. Dev-tier probes only (never Fable); spends a small amount of API budget.",
    ].join("\n"),
  );
}

function parseArgs(): { campaignId: string; n: number } {
  const [, , campaignId, nRaw] = process.argv;
  if (!campaignId) {
    printUsage("missing <campaignId>");
    process.exit(1);
  }
  if (!UUID_RE.test(campaignId)) {
    printUsage(`"${campaignId}" is not a valid campaign id (uuid)`);
    process.exit(1);
  }
  let n = DEFAULT_N;
  if (nRaw !== undefined) {
    if (!/^\d+$/.test(nRaw) || Number.parseInt(nRaw, 10) < 1) {
      printUsage(`n must be a positive integer (got "${nRaw}")`);
      process.exit(1);
    }
    n = Number.parseInt(nRaw, 10);
  }
  return { campaignId, n };
}

/** The stated usage is bare `pnpm tsx …` (no --env-file, and this script owns
 *  no package.json entry), so pull .env.local ourselves when the ambient env
 *  lacks DATABASE_URL. A caller who already provided env (--env-file, Railway)
 *  is untouched. */
function loadEnvIfNeeded(): void {
  if (process.env.DATABASE_URL) return;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local — rely on ambient env; getDb() reports the missing case cleanly.
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function pct(x: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((x / total) * 100).toFixed(1)}%`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface Row {
  turnNumber: number;
  c: Classification;
}

function printReport(
  campaignId: string,
  campaignTitle: string,
  requested: number,
  withNarration: number,
  emptySkipped: number,
  probeFailures: number,
  rows: Row[],
): void {
  console.log("");
  console.log(`=== Exit gauge — ${campaignTitle} ===`);
  console.log(
    `campaign ${campaignId} · probe ${DEV_TIER_SELECTION.probe} · requested last ${requested} turns`,
  );
  console.log("");

  if (rows.length === 0) {
    console.log(
      `No turns classified (${withNarration} with narration; ${probeFailures} probe failure(s), ${emptySkipped} empty).`,
    );
    return;
  }

  // Per-turn table. Fixed leading columns, evidence trails free at line end.
  console.log(
    `${"turn".padStart(5)}  ${"ending".padEnd(7)}  ${"pressure".padEnd(8)}  ${"treadmill".padEnd(9)}  evidence`,
  );
  console.log("-".repeat(52));
  for (const { turnNumber, c } of rows) {
    console.log(
      `${String(turnNumber).padStart(5)}  ${c.ending.padEnd(7)}  ${(c.pressure_alive_at_close ? "yes" : "no").padEnd(8)}  ${(c.treadmill ? "yes" : "no").padEnd(9)}  "${oneLine(c.evidence)}"`,
    );
  }

  const total = rows.length;
  const motion = rows.filter((r) => r.c.ending === "motion").length;
  const fork = rows.filter((r) => r.c.ending === "fork").length;
  const rest = rows.filter((r) => r.c.ending === "rest").length;
  const pressureAlive = rows.filter((r) => r.c.pressure_alive_at_close).length;
  const treadmill = rows.filter((r) => r.c.treadmill).length;

  console.log("");
  console.log(
    `Classified ${total} of ${withNarration} turns with narration (${emptySkipped} empty skipped, ${probeFailures} probe failure(s)).`,
  );
  console.log("");
  console.log("Endings:");
  console.log(`  motion  ${String(motion).padStart(3)}  (${pct(motion, total)})`);
  console.log(`  fork    ${String(fork).padStart(3)}  (${pct(fork, total)})`);
  console.log(`  rest    ${String(rest).padStart(3)}  (${pct(rest, total)})`);
  console.log(
    `Pressure alive at close:  ${pressureAlive}/${total}  (${pct(pressureAlive, total)})`,
  );
  console.log(`Treadmill forks:          ${treadmill} of ${fork} fork ending(s)`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvIfNeeded();
  guardNoFable(DEV_TIER_SELECTION);
  const { campaignId, n } = parseArgs();
  const db: Db = getDb();

  const [campaign] = await db
    .select({ id: schema.campaigns.id, title: schema.campaigns.title })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId));
  if (!campaign) {
    console.error(`[exit-gauge] no campaign found with id ${campaignId}`);
    process.exit(1);
  }

  // The LAST n completed turns, then oldest→newest so treadmill can look back.
  const fetched = await db
    .select({ turnNumber: schema.turns.turnNumber, narration: schema.turns.narration })
    .from(schema.turns)
    .where(and(eq(schema.turns.campaignId, campaignId), eq(schema.turns.status, "complete")))
    .orderBy(desc(schema.turns.turnNumber))
    .limit(n);
  fetched.sort((a, b) => a.turnNumber - b.turnNumber);

  try {
    const analyzed: { turnNumber: number; narration: string }[] = [];
    let emptySkipped = 0;
    for (const row of fetched) {
      const text = (row.narration ?? "").trim();
      if (text.length === 0) {
        emptySkipped++;
        console.warn(`[exit-gauge] turn ${row.turnNumber}: empty narration — skipping`);
        continue;
      }
      analyzed.push({ turnNumber: row.turnNumber, narration: text });
    }

    if (analyzed.length === 0) {
      printReport(campaignId, campaign.title, n, 0, emptySkipped, 0, []);
      return;
    }

    console.log(
      `[exit-gauge] classifying ${analyzed.length} turn(s) via dev-tier probe (${DEV_TIER_SELECTION.probe})…`,
    );

    const rows: Row[] = [];
    let probeFailures = 0;
    for (let i = 0; i < analyzed.length; i++) {
      const current = analyzed[i];
      if (!current) continue;
      const prev = i > 0 ? analyzed[i - 1] : undefined;
      const thisTail = current.narration.slice(-THIS_TAIL_CHARS);
      const prevTail = prev ? prev.narration.slice(-PREV_TAIL_CHARS) : null;
      try {
        const c = await callProbe(DEV_TIER_SELECTION, {
          name: "exit_gauge",
          schema: Classification,
          system: RUBRIC,
          prompt: buildPrompt(thisTail, prevTail, current.turnNumber),
          maxTokens: CLASSIFY,
          campaignId,
          turnNumber: current.turnNumber,
        });
        rows.push({ turnNumber: current.turnNumber, c });
        console.log(
          `[exit-gauge] turn ${current.turnNumber}: ${c.ending} · pressure_alive=${c.pressure_alive_at_close ? "yes" : "no"} · treadmill=${c.treadmill ? "yes" : "no"}`,
        );
      } catch (err) {
        probeFailures++;
        console.warn(
          `[exit-gauge] turn ${current.turnNumber}: probe failed (${err instanceof Error ? err.message : String(err)}) — skipping`,
        );
      }
    }

    printReport(campaignId, campaign.title, n, analyzed.length, emptySkipped, probeFailures, rows);
  } finally {
    await flushLangfuse();
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error("[exit-gauge] error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
