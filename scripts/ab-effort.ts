/**
 * A2 — the blind A/B (docs/plans/M3R4-punch-list.md, Bucket A2; USER-APPROVED
 * 2026-08-06, ~$4.60 on record). Two questions in one run, both measurement
 * rather than opinion:
 *
 *   ARM S (sakuga, FABLE) — does effort "xhigh" buy prose the player can FEEL?
 *     types/turn.ts records the debt in its own words: xhigh's quality delta
 *     "was designed-in, never measured. It earns its seat back only through a
 *     blind A/B (two sakuga scenes, both efforts, read cold)." That is this arm,
 *     literally: 2 scenes × 2 efforts = 4 Fable narration calls, ~$4.
 *
 *   ARM D (douga, SONNET) — can a conte-side line buy back douga latency?
 *     A1 closed the effort lever (effort is a cache-key ingredient, so douga→low
 *     would re-write the whole prefix twice per interleaved douga turn — ~$0.30
 *     of re-writes to save ~$0.06 of thinking). The replacement lever is a
 *     nudge in the STORYBOARD, which is Block 4 and never cached, so it costs
 *     no cache lineage at all. 4 Sonnet calls, ~$0.60.
 *
 * THIS IS THE ONE SANCTIONED FABLE-CALLING SCRIPT. The standing directive is
 * that no automated run — test, eval, smoke, soak — ever calls Fable; Fable
 * spend is player-facing only. Arm S is the named exception, approved by the
 * user on 2026-08-06 with the price stated (M3R4 punch list, bucket A2). It is
 * gated behind --live for exactly that reason: the flag-less invocation spends
 * nothing and prints the plan plus the price. Do NOT copy this file's Fable
 * selection into an eval, a suite, or the soak.
 *
 *   pnpm ab-effort                        DRY RUN — plan + price, ZERO model calls
 *   pnpm ab-effort -- --dry-run           the same, said out loud
 *   pnpm ab-effort -- --live              the run (user-gated spend, ~$4.60)
 *   pnpm ab-effort -- --live --arm=douga  only the $0.60 half
 *   pnpm ab-effort -- --live --seed=12345 reproducible A/B lettering
 *   pnpm ab-effort -- --live --max-usd=6  raise the $5 hard ceiling, deliberately
 *
 * EVERY FLAG TAKES ITS VALUE WITH AN `=`. A space-form `--arm douga` used to
 * parse as "no --arm at all" and quietly ran BOTH arms — four Fable calls
 * against an invoice the operator had priced at one. Unknown tokens are now
 * fatal before the banner prints.
 *
 * THE CEILING IS ENFORCED TWICE. Once against the printed estimate, before
 * anything runs — and again on the wire, because the estimate is not the wire:
 * it prices each sakuga call at the §10.8 p95 thinking allowance while the
 * request goes out at max_tokens 27k (high) / 35k (xhigh). Each completed
 * call's REAL cost accumulates, and a call whose full cap would carry the run
 * past the ceiling never starts. Nothing is aborted mid-stream; a run the
 * ceiling stops writes its partial report like any other.
 *
 * THE BLIND IS THE POINT. The report (docs/retros/ab-effort-<date>-seed<n>.md) presents
 * the four sakuga proses as Scene1-A/B and Scene2-A/B for the USER's own read.
 * The effort→letter mapping is sealed in a base64 line at the very bottom, and
 * the per-version telemetry (tokens, latency, cost) is sealed WITH it — those
 * numbers would give the answer away as surely as a label. The judge model's
 * verdicts sit beside the proses and are blind too: they reference A and B and
 * were never told what A and B are. His ear is the final judge (standing
 * ruling); this script's job is to keep it uncontaminated.
 */

import { randomInt } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { STRUCTURED_SMALL } from "@/lib/llm/budgets";
import {
  COMMIT_SCENE_TOOL,
  type Effort,
  callJudgment,
  computeEffectiveMaxTokens,
  streamNarration,
} from "@/lib/llm/calls";
import { estimateCostUsd } from "@/lib/llm/pricing";
import { DEV_TIER_SELECTION, FABLE_MODEL, type TierSelection } from "@/lib/llm/tiers";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { renderSettei } from "@/lib/renderer/settei";
import { KA_CONTRACT } from "@/lib/turn/ka";
import { TURN_CONTRACTS } from "@/lib/types/turn";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { THINKING_ALLOWANCE_TOKENS } from "../evals/suites/budget-assertions";
import { dbNow, fmtUsd } from "./soak-lib";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const ARGV = process.argv.slice(2);

/** The hard ceiling on a --live run: the A2 approval envelope, user-ratified
 *  2026-08-06 (~$4.60 approved; $5 is that number with its rounding). A run
 *  whose own printed estimate exceeds this refuses to spend rather than
 *  discovering the overrun in the invoice. `--max-usd=<n>` raises it, and the
 *  banner then prints the raised number so the override is never silent. */
const MAX_RUN_USD = 5;

/**
 * Every flag this script understands. A token outside this set is FATAL: the
 * space-form `--arm douga` parsed as no-arm-at-all and silently ran both arms
 * (4 Fable calls where the operator had priced 2). Validation runs at import,
 * before the banner, so a mis-typed invocation dies before it prints a price
 * that does not describe what it would do.
 */
const VALUE_FLAGS = ["--arm", "--seed", "--max-usd"] as const;
const BARE_FLAGS = ["--live", "--dry-run"] as const;

function assertKnownFlags(argv: string[]): void {
  for (const token of argv) {
    // pnpm forwards its own `--` separator into argv; it is punctuation, not an
    // argument. (Ignored, not rejected — `pnpm ab-effort -- --live` is the
    // documented invocation and must keep working.)
    if (token === "--") continue;
    if ((BARE_FLAGS as readonly string[]).includes(token)) continue;
    if ((VALUE_FLAGS as readonly string[]).some((f) => token.startsWith(`${f}=`))) continue;
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      console.error(
        `[ab] FATAL: '${token}' takes its value with an '=' — write '${token}=<value>'. The space form parses as an absent flag, which is how a half run becomes a whole one.`,
      );
      process.exit(1);
    }
    console.error(
      `[ab] FATAL: unrecognized argument '${token}'. Known: ${[...BARE_FLAGS, ...VALUE_FLAGS.map((f) => `${f}=<value>`)].join(" ")}`,
    );
    process.exit(1);
  }
}

assertKnownFlags(ARGV);

const LIVE = ARGV.includes("--live");

if (LIVE && ARGV.includes("--dry-run")) {
  console.error("[ab] FATAL: --live and --dry-run are contradictory — pass one.");
  process.exit(1);
}

type Arm = "both" | "sakuga" | "douga";

function parseArm(argv: string[]): Arm {
  const flag = argv.find((a) => a.startsWith("--arm="));
  if (!flag) return "both";
  const value = flag.slice("--arm=".length);
  if (value === "both" || value === "sakuga" || value === "douga") return value;
  console.error(`[ab] FATAL: --arm must be both|sakuga|douga (got '${value}')`);
  process.exit(1);
}

/** The A/B lettering is derived from this, so a run is reproducible from its
 *  report header — a re-run with the same seed letters the arms the same way. */
function parseSeed(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--seed="));
  if (!flag) return randomInt(1, 2 ** 31 - 1);
  const n = Number(flag.slice("--seed=".length));
  if (!Number.isInteger(n) || n < 1) {
    console.error(`[ab] FATAL: --seed must be a positive integer (got '${flag}')`);
    process.exit(1);
  }
  return n;
}

/** The spend ceiling, and whether the operator raised it on purpose. */
function parseMaxUsd(argv: string[]): { ceiling: number; overridden: boolean } {
  const flag = argv.find((a) => a.startsWith("--max-usd="));
  if (!flag) return { ceiling: MAX_RUN_USD, overridden: false };
  const n = Number(flag.slice("--max-usd=".length));
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[ab] FATAL: --max-usd must be a positive number (got '${flag}')`);
    process.exit(1);
  }
  return { ceiling: n, overridden: true };
}

const ARM = parseArm(ARGV);
const SEED = parseSeed(ARGV);
const { ceiling: MAX_USD, overridden: MAX_USD_OVERRIDDEN } = parseMaxUsd(ARGV);

/** Seeded PRNG — the lettering must be reproducible from the seed, which
 *  Math.random cannot promise. (A one-off script may take its DEFAULT seed from
 *  crypto; what it may not do is make the mapping underivable afterwards.) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Tier selections
// ---------------------------------------------------------------------------

/**
 * Arm S narrates at FABLE — the sanctioned exception above — with the §3
 * server-side fallback to Opus 5 that streamNarration configures for every
 * Fable call. A fallback event is reported in the open (it says the voice
 * shifted; it says nothing about which effort ran).
 */
const SAKUGA_SELECTION: TierSelection = { ...DEV_TIER_SELECTION, narration: FABLE_MODEL };

/** Arm D is a MECHANISM test, not a taste test: Sonnet, the DEV narration rung. */
const DOUGA_SELECTION: TierSelection = { ...DEV_TIER_SELECTION, narration: "claude-sonnet-5" };

/** The judge runs at the campaign judgment tier (control-key's posture). */
const JUDGE_SELECTION: TierSelection = { ...DEV_TIER_SELECTION, judgment: "claude-sonnet-5" };

/** The standing directive, enforced where it still applies: everything EXCEPT
 *  arm S's narration stays off Fable. SUBSTRING, not equality — soak-lib's
 *  `guardNoFable` matches any id containing "fable" for the reason this one
 *  now does too: an equality check against today's FABLE_MODEL would wave
 *  through tomorrow's alias (a dated snapshot id, a `-fable-` rung) and the
 *  guard would report clean while spending Fable money. */
function assertNotFable(label: string, model: string): void {
  if (model.toLowerCase().includes("fable")) {
    console.error(`[ab] FATAL: ${label} resolves to Fable — only arm S narration is sanctioned`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The prompts. Blocks 1–2 are the Bebop fixture's Settei (same charter for every
// call in the run); the storyboard is Block 4, in the user message.
//
// COLD BY CONSTRUCTION: no block here carries a cache_control breakpoint, so
// nothing is written to the cache and nothing is read from it — every call in
// this script prices at list. That is the arm's requirement ("read cold"), and
// it is also why the arms are comparable: effort is itself a cache-key
// ingredient, so a warm run would advantage whichever effort ran second.
// ---------------------------------------------------------------------------

// PROVENANCE: the charter comes from the renderer's own Bebop test fixture —
// the same source the soak seeds from, deliberately, so the two harnesses argue
// about the same world. It also means cross-run comparability assumes that
// fixture is UNCHANGED between the runs being compared: an edit to
// `renderer/__tests__/fixtures` moves the system bytes under arm S, and a
// later run's numbers are then a different experiment wearing this one's name.
const SETTEI = renderSettei({ contract: bebopContract(), marks: [] }).text;
const SYSTEM: TextBlockParam[] = [{ type: "text", text: `${KA_CONTRACT}\n\n${SETTEI}` }];

interface SakugaScene {
  id: "scene1" | "scene2";
  label: string;
  brief: string;
}

/**
 * Two sakuga-shaped storyboards, written in renderConte's own vocabulary
 * (judged outcome / beat / present cast / active consequences) so the pen sees
 * a production-shaped Block 4 — the way control-key.ts hand-builds its scene.
 * One combat-heavy, one interiority-heavy: the two things a sakuga turn is
 * asked to do, and the two places a deeper think would show up differently.
 */
const SAKUGA_SCENES: SakugaScene[] = [
  {
    id: "scene1",
    label: "combat-heavy — three in a corridor, no cover",
    brief: [
      "# Storyboard (this scene only)",
      "Player action: I draw the Jericho and go loud — three of them between me and the gantry, close quarters, no cover, and I mean to walk out the far side.",
      "Turn 8 · tier sakuga",
      "Research allowance this scene: NONE. Write from what you hold — a research call this turn will be refused.",
      "",
      "## Judged outcome (already rolled — narrate this)",
      "SUCCESS vs DC 16 (d20: 13 +4 = 17); weight major.",
      "Cost to honor: a round goes through his left side, low, under the ribs — he does not feel it until the far side.",
      "Consequence in play: the whole dock heard it; whatever quiet this job had is spent.",
      "Reasoning: three-on-one in a corridor with no cover is a losing shape. He takes it on speed and on knowing the gantry, and he pays in blood.",
      "",
      "## Beat",
      "climax · tone: cold, kinetic · escalating toward: the walk out the far side (strong)",
      "Drive: this is the beat the episode has been holding its breath for — spend the animation budget here.",
      "Avoid: bullet-time philosophizing; a villain monologue",
      "",
      "## Present cast",
      "- Three dock enforcers in Red Sash colors. None of them is a name worth learning.",
      "",
      "## Active consequences (the world remembers)",
      "- The bounty went quiet an hour ago; someone moved him while the docks were watching something else.",
      "",
      "Write the scene.",
    ].join("\n"),
  },
  {
    id: "scene2",
    label: "interiority-heavy — the second bowl, the thing not said",
    brief: [
      "# Storyboard (this scene only)",
      "Player action: I sit down across from her with the second bowl and don't say anything about the money.",
      "Turn 22 · tier sakuga",
      "Research allowance this scene: NONE. Write from what you hold — a research call this turn will be refused.",
      "",
      "## Judged outcome (already rolled — narrate this)",
      "PARTIAL vs DC 14 (d20: 9 +3 = 12); weight major.",
      "Cost to honor: the thing he came to say does not get said.",
      "Consequence in play: she takes the bowl. She also takes the silence for an answer, and it is the wrong one.",
      "Reasoning: he is trying to apologize without spending a word on it. That works exactly once, and it already has.",
      "",
      "## Beat",
      "falling · tone: quiet, unsentimental · escalating toward: nothing — this one lands (strong)",
      "Drive: interiority carries this scene. No fight, no reveal: it is what he does not say and what she hears instead.",
      "Must reference: the money that is already gone",
      "Avoid: a speech; a confession; naming the feeling out loud",
      "",
      "## Present cast",
      "- Faye — across the table, eating, not looking at him.",
      "",
      "## Active consequences (the world remembers)",
      "- The bounty paid out to someone else three days ago; the crew has eaten instant noodles since.",
      "",
      "Write the scene.",
    ].join("\n"),
  },
];

/**
 * The lever under test in arm D. It is appended to the STORYBOARD — the user
 * message, Block 4 — and never to a cached block: that is the entire point.
 * Blocks 1–3 carry the prefix the whole campaign reads warm, so a line added
 * there would re-key the cache once per posture and cost more than the thinking
 * it saves (A1's ruling). Block 4 is rebuilt every turn regardless, so this
 * lever is free.
 */
const DOUGA_NUDGE = "This is a trivial beat: no deliberation — write the scene directly.";

interface DougaBeat {
  id: "beat1" | "beat2";
  label: string;
  brief: string;
}

const DOUGA_BEATS: DougaBeat[] = [
  {
    id: "beat1",
    label: "I light a cigarette and watch the rain",
    brief: [
      "# Storyboard (this scene only)",
      "Player action: I light a cigarette and watch the rain.",
      "Turn 12 · tier douga",
      "Research allowance this scene: NONE. Write from what you hold — a research call this turn will be refused.",
      "",
      "Write the scene.",
    ].join("\n"),
  },
  {
    id: "beat2",
    label: "I pocket the key and leave quietly",
    brief: [
      "# Storyboard (this scene only)",
      "Player action: I pocket the key and leave quietly.",
      "Turn 19 · tier douga",
      "Research allowance this scene: NONE. Write from what you hold — a research call this turn will be refused.",
      "",
      "Write the scene.",
    ].join("\n"),
  },
];

// ---------------------------------------------------------------------------
// One narration call
// ---------------------------------------------------------------------------

interface NarrationSample {
  prose: string;
  servedBy: string;
  fallbackUsed: boolean;
  refused: boolean;
  /** Did the §5.7 trailer arrive as a tool_use block (production's contract)? */
  trailerLanded: boolean;
  /** Approximate output tokens the trailer's tool_use blocks consumed. */
  trailerTokens: number;
  ttftMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * What the tool_use blocks cost in OUTPUT tokens, approximated — the wire bills
 * a tool call as output, and the thinking estimator below has to know how much
 * of `output_tokens` was trailer rather than reasoning.
 *
 * The approximation: the serialized JSON of each tool_use block's input plus
 * its name, at the house 4-chars-per-token rate. This is directional and
 * LEANS LOW — the API's own tool encoding carries wrapper tokens this does not
 * model — so a residual "thinking" figure computed from it leans HIGH by a
 * couple hundred tokens on a full sidecar. Stated, not hidden.
 */
function trailerTokensOf(content: { type: string; name?: string; input?: unknown }[]): number {
  let chars = 0;
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    chars += (block.name ?? "").length + JSON.stringify(block.input ?? {}).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * THE CONSOLE IS PART OF THE BLIND — and calls.ts punches a hole straight
 * through it. `src/lib/llm/calls.ts:997-1004` warns
 *
 *     console.warn("[llm] TRUNCATED at max_tokens", { name, outputBudget, effectiveCap, model })
 *
 * whenever a message stops at its cap, and `effectiveCap` IS the effort in
 * arithmetic form: computeEffectiveMaxTokens adds thinkingPad to the output
 * budget, so sakuga's 3,000 becomes 27,000 under `high` and 35,000 under
 * `xhigh`. That line prints the call name — which carries the LETTER — next to
 * the number that names the depth of think. One truncated version and the
 * terminal has decoded the seal before the report is opened. calls.ts:939's
 * stream-failure `console.error` leaks the same way (it prints `name` beside
 * the raw API error, whose body quotes max_tokens), which is why both console
 * fns are wrapped here.
 *
 * calls.ts is PRODUCTION and is not edited to suit a harness's blind, so the
 * harness closes the hole from its own side. Any line whose rendered text
 * names this call — or matches the TRUNCATED warn from any caller — is
 * DIVERTED into `sink`, which runSakuga seals into the report's base64 key.
 * The information is preserved for the post-decode read, not destroyed;
 * everything else passes through to the real console untouched, and the
 * originals are restored in a `finally` so a throw cannot leave the process
 * muted for the rest of the run.
 *
 * Sequential by construction: arm S awaits one version at a time and arm D
 * runs only after arm S has finished, so this global patch never spans two
 * live calls. Arm D never asks for it — that arm is open by design.
 */
async function withSealedConsole<T>(
  name: string,
  sink: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const originals = { warn: console.warn, error: console.error };
  const divert =
    (channel: "warn" | "error") =>
    (...args: unknown[]): void => {
      const line = format(...args);
      if (line.includes(name) || /TRUNCATED at max_tokens/i.test(line)) {
        sink.push(`[${channel}] ${line}`);
        return;
      }
      originals[channel](...args);
    };
  console.warn = divert("warn");
  console.error = divert("error");
  try {
    return await fn();
  } finally {
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

async function narrate(opts: {
  name: string;
  selection: TierSelection;
  brief: string;
  maxTokens: number;
  effort: Effort;
  /** Arm S only: where the blind-breaking console lines go instead of stdout. */
  consoleSink?: string[];
}): Promise<NarrationSample> {
  const sink = opts.consoleSink;
  return sink ? withSealedConsole(opts.name, sink, () => callOnce(opts)) : callOnce(opts);
}

async function callOnce(opts: {
  name: string;
  selection: TierSelection;
  brief: string;
  maxTokens: number;
  effort: Effort;
}): Promise<NarrationSample> {
  const started = Date.now();
  const { stream, done } = streamNarration({
    name: opts.name,
    selection: opts.selection,
    system: SYSTEM,
    messages: [{ role: "user", content: opts.brief }],
    maxTokens: opts.maxTokens,
    effort: opts.effort,
    // PRODUCTION POSTURE. The system text is KA_CONTRACT verbatim, and the
    // contract MANDATES the commit_scene trailer — so sending `tools: []` did
    // not remove the trailer, it removed the only channel the trailer had:
    // one blind sample typed its sidecar as a JSON code block INSIDE the prose
    // the user was asked to read as a scene. The real tool goes on the wire so
    // the trailer arrives as a tool_use block and `prose` is text blocks only.
    // Just commit_scene, not the KA's full array: the storyboards grant zero
    // research, and this script has no tool executor to answer a research call
    // with (the KA's own loop does that work). The estimator below now
    // subtracts the trailer's tokens instead of counting them as thinking.
    tools: [COMMIT_SCENE_TOOL],
    // NO turnNumber — nothing here is play, and a turn number would file the
    // experiment as the cost of one. The phase IS honest now: `harness` is the
    // ledger's word for spend the harness made rather than the engine, which is
    // this script exactly. Without it these rows sit in "(unattributed)",
    // indistinguishable from the gap the phase column was built to close.
    phase: "harness",
  });
  let ttftMs: number | null = null;
  stream.on("text", () => {
    ttftMs ??= Date.now() - started;
  });
  const result = await done();
  return {
    prose: result.prose,
    servedBy: result.message.model,
    fallbackUsed: result.fallbackUsed,
    refused: result.refused,
    trailerLanded: result.sidecar !== null,
    trailerTokens: trailerTokensOf(result.message.content),
    ttftMs,
    totalMs: Date.now() - started,
    inputTokens: result.message.usage.input_tokens,
    outputTokens: result.message.usage.output_tokens,
    costUsd: result.costUsd,
  };
}

/**
 * The soak's estimator, corrected for the trailer. Output tokens are prose AND
 * thinking AND the tool call billed together (adaptive thinking bills as
 * output), while only the prose is visible client-side — so thinking is what
 * the counter holds that the page does not, at the house ~4-chars-per-token
 * approximation.
 *
 * The soak's version subtracts prose alone, which was right when this script
 * sent `tools: []`. With the real commit_scene trailer on the wire (production
 * posture), a bare prose subtraction would bank the whole sidecar as
 * "thinking" — several hundred tokens of pure bias, and arm D's finding is a
 * DELTA in exactly that number. So the trailer comes out too, at the
 * approximation `trailerTokensOf` documents. Residual bias after the fix:
 * still slightly HIGH, because the tool encoding's wrapper tokens are not
 * modeled. Directional, not exact — and no longer silently wrong.
 */
function estThinkingTokens(
  sample: Pick<NarrationSample, "outputTokens" | "prose" | "trailerTokens">,
): number {
  return Math.max(
    0,
    sample.outputTokens - Math.ceil(sample.prose.length / 4) - sample.trailerTokens,
  );
}

// ---------------------------------------------------------------------------
// The price, printed before anything runs
// ---------------------------------------------------------------------------

const approxTokens = (chars: number): number => Math.ceil(chars / 4);
const SYSTEM_CHARS = SYSTEM.reduce((n, b) => n + b.text.length, 0);

interface PlannedCall {
  label: string;
  model: string;
  inputTokens: number;
  /** Output budget PLUS the §10.8 p95 thinking allowance — thinking bills as
   *  output, so a price that omits it is not a price. */
  outputTokens: number;
}

function plannedCalls(): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (ARM !== "douga") {
    for (const scene of SAKUGA_SCENES) {
      for (const effort of ["high", "xhigh"] as const) {
        calls.push({
          label: `arm S · ${scene.id} · effort ${effort}`,
          model: SAKUGA_SELECTION.narration,
          inputTokens: approxTokens(SYSTEM_CHARS + scene.brief.length),
          outputTokens: TURN_CONTRACTS.sakuga.outputBudgetTokens + THINKING_ALLOWANCE_TOKENS.sakuga,
        });
      }
    }
    for (const scene of SAKUGA_SCENES) {
      calls.push({
        label: `judge · ${scene.id} (blind A/B)`,
        model: JUDGE_SELECTION.judgment,
        // Two full sakuga proses plus the brief; the emit is one short verdict
        // on top of a modest structured think.
        inputTokens:
          approxTokens(scene.brief.length) + 2 * TURN_CONTRACTS.sakuga.outputBudgetTokens,
        outputTokens: 2_200,
      });
    }
  }
  if (ARM !== "sakuga") {
    for (const beat of DOUGA_BEATS) {
      for (const nudged of [false, true]) {
        calls.push({
          label: `arm D · ${beat.id} · ${nudged ? "nudged" : "control"}`,
          model: DOUGA_SELECTION.narration,
          inputTokens: approxTokens(
            SYSTEM_CHARS + beat.brief.length + (nudged ? DOUGA_NUDGE.length + 1 : 0),
          ),
          outputTokens: TURN_CONTRACTS.douga.outputBudgetTokens + THINKING_ALLOWANCE_TOKENS.douga,
        });
      }
    }
  }
  return calls;
}

function priceOf(c: PlannedCall): number {
  return estimateCostUsd(c.model, { input_tokens: c.inputTokens, output_tokens: c.outputTokens });
}

function printBanner(): number {
  const calls = plannedCalls();
  const total = calls.reduce((sum, c) => sum + priceOf(c), 0);
  console.log("=".repeat(78));
  console.log("A2 — the blind A/B: sakuga effort high-vs-xhigh (FABLE) + the douga conte nudge");
  console.log("user-approved 2026-08-06 (M3R4 A2) — budget ~$4.60, price on record");
  console.log(
    "THE ONE SANCTIONED FABLE-CALLING SCRIPT: arm S is the named exception to the standing",
  );
  console.log("no-Fable-in-automation directive. Everything else in the run is Sonnet.");
  console.log("=".repeat(78));
  const selections = [
    ARM !== "douga" ? `narration(S)=${SAKUGA_SELECTION.narration}` : null,
    ARM !== "sakuga" ? `narration(D)=${DOUGA_SELECTION.narration}` : null,
    ARM !== "douga" ? `judge=${JUDGE_SELECTION.judgment}` : null,
  ].filter((s): s is string => s !== null);
  console.log(`arm=${ARM} · seed=${SEED} · ${selections.join(" · ")}`);
  console.log("");
  console.log("PLAN + PRICE (upper-leaning: every call priced at its p95 thinking allowance,");
  console.log("cold, at list rates — nothing in this script writes or reads the prompt cache):");
  console.log("");
  for (const c of calls) {
    console.log(
      `  ${c.label.padEnd(38)} ${c.model.padEnd(16)} ~${c.inputTokens} in / ~${c.outputTokens} out  ${fmtUsd(priceOf(c))}`,
    );
  }
  console.log("");
  console.log(`  ESTIMATED TOTAL: ${fmtUsd(total)}  (${calls.length} model calls)`);
  if (ARM === "both") {
    console.log(
      "  vs the approved ~$4.60 — the model prices EVERY call at its p95 thinking allowance, so",
    );
    console.log("  a run that thinks like the measured median lands under this, not over it.");
  } else {
    console.log(`  (a PARTIAL run: arm '${ARM}' only, inside the approved ~$4.60 whole.)`);
  }
  console.log(
    MAX_USD_OVERRIDDEN
      ? `  HARD CEILING: ${fmtUsd(MAX_USD)} — RAISED from the ${fmtUsd(MAX_RUN_USD)} approval envelope by an explicit --max-usd.`
      : `  HARD CEILING: ${fmtUsd(MAX_USD)} (the A2 approval envelope) — --live refuses above it; --max-usd=<n> raises it.`,
  );
  console.log(
    "  ENFORCED AT RUNTIME TOO: the estimate above prices each call at its p95 thinking allowance,",
  );
  console.log(
    "  but the wire caps are higher (sakuga goes out at 27k/35k max_tokens). Each completed call's",
  );
  console.log(
    "  REAL cost accumulates, and any call whose FULL cap would carry the run past the ceiling never",
  );
  console.log("  starts — the run stops cleanly and the partial report is still written.");
  console.log("");
  return total;
}

// ---------------------------------------------------------------------------
// The public failure vocabulary, and the runtime spend guard
// ---------------------------------------------------------------------------

/** What a call that never ran carries as its reason. Digit-free on purpose —
 *  it is printed in the clear beside a public letter. */
const BUDGET_SKIP = "SKIPPED: budget ceiling";

/**
 * An API error body is not safe to print beside a public letter. A 400 quotes
 * what it rejected (`max_tokens: 35000`, the output_config it did not like); a
 * 429 quotes the window it counted. Those numbers decode arm S's seal exactly
 * the way calls.ts's TRUNCATED warn does — 27,000 is `high`, 35,000 is
 * `xhigh`, and either one printed next to "Scene 1 — B" ends the blind.
 *
 * So the PUBLIC surfaces (the report's PARTIAL block, the per-version FAILED
 * line, arm S's console) say only which KIND of failure it was, from this
 * fixed vocabulary, and every fragment they do show has ALL digits stripped.
 * The verbatim message is kept, not thrown away: arm S seals it in the report
 * key, arm D prints it on the console (that arm is open by design) and it is
 * carried in the key beside it.
 */
function sanitizeFailureReason(raw: string | undefined | null): string {
  const message = (raw ?? "").trim();
  if (!message) return "other";
  if (message.startsWith(BUDGET_SKIP)) return BUDGET_SKIP;
  const m = message.toLowerCase();
  if (/rate.?limit|too many requests|\b429\b/.test(m)) return "rate-limited";
  if (/overload|\b529\b/.test(m)) return "overloaded";
  if (/invalid.?request|bad request|\b400\b|\b422\b/.test(m)) return "invalid-request";
  if (/timeout|timed out|etimedout|abort/.test(m)) return "timeout";
  if (/econn|enotfound|epipe|socket|network|fetch failed|stream|tls|dns/.test(m))
    return "transport";
  // Unclassified: a short digit-free fragment beats a bare "other" for the
  // operator, and with every digit gone it cannot carry a cap or a window.
  const fragment = message.replace(/\d/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return fragment ? `other (${fragment})` : "other";
}

/** The one form a public surface may print about a call that produced no
 *  sample: the skip sentinel already says what it is, anything else is a
 *  failure named only by its category. */
function publicFailure(error: string | undefined | null): string {
  const reason = sanitizeFailureReason(error);
  return reason === BUDGET_SKIP ? reason : `FAILED: ${reason}`;
}

/**
 * The ceiling used to gate the ESTIMATE alone — and the estimate is not the
 * wire. It prices sakuga output at the §10.8 p95 thinking allowance (~19k),
 * while the request goes out with max_tokens = computeEffectiveMaxTokens:
 * 27k under `high`, 35k under `xhigh`. Four sakuga calls that each ran to
 * their cap would bill ~$6.3 against a printed ~$4.73, and nothing in the
 * script would have stopped them.
 *
 * This is the second gate. Each completed call's real `costUsd` accumulates
 * here, and before every subsequent paid call the guard prices that call's
 * FULL cap as though it will be spent. If spent + worst-case would breach the
 * ceiling, the call never STARTS. A call in flight is never aborted: prose
 * already paid for is prose the report keeps.
 */
interface SpendGuard {
  /** Real cost of everything that completed, plus upper bounds where the
   *  traced call returns no cost (the judge). */
  spentUsd: number;
  /** Non-null once the ceiling has refused a call — the run stops paying. */
  stopped: string | null;
  /** The arithmetic of each refusal. SEALED, never printed: a running total
   *  taken after arm S's first version IS that version's cost. */
  log: string[];
}

function newSpendGuard(): SpendGuard {
  return { spentUsd: 0, stopped: null, log: [] };
}

/** The conservative price of a call that has not run yet: its full effective
 *  cap of output at list rates, on top of the input we can count. Mirrors the
 *  estimator's helpers (approxTokens + estimateCostUsd) so the two numbers are
 *  the same arithmetic, differing only in how much output they assume. */
function worstCaseUsd(args: {
  model: string;
  inputChars: number;
  outputBudget: number;
  effort?: Effort;
}): number {
  return estimateCostUsd(args.model, {
    input_tokens: approxTokens(args.inputChars),
    output_tokens: computeEffectiveMaxTokens(args.outputBudget, args.model, args.effort),
  });
}

/** May this call start? Flips the guard and records the arithmetic when not. */
function affords(guard: SpendGuard, label: string, worstCaseUsdForCall: number): boolean {
  if (guard.stopped !== null) return false;
  if (guard.spentUsd + worstCaseUsdForCall <= MAX_USD) return true;
  guard.stopped = BUDGET_SKIP;
  guard.log.push(
    `refused before ${label}: spent ${guard.spentUsd.toFixed(4)} + worst-case ${worstCaseUsdForCall.toFixed(4)} > ceiling ${MAX_USD.toFixed(2)}`,
  );
  // NO NUMBERS ON THE CONSOLE, for the same reason the telemetry is sealed.
  console.error(
    "[ab] BUDGET CEILING reached — refusing to START any further paid call. Nothing in flight was interrupted; the arithmetic is in the report's sealed key.",
  );
  return false;
}

// ---------------------------------------------------------------------------
// The blind judge
// ---------------------------------------------------------------------------

const Comparison = z.object({
  preferred: z.enum(["A", "B"]),
  margin: z.enum(["slight", "clear"]),
  reason: z.string().min(1),
});
type Comparison = z.infer<typeof Comparison>;

const JUDGE_SYSTEM = [
  "You are comparing two versions of the SAME scene in an anime tabletop campaign.",
  "They were written from the identical storyboard by the same studio, and are labeled A and B.",
  "You are told NOTHING about how either was produced — no model, no settings, no order.",
  "Judge only what is on the page: which is the better scene at the table?",
  "Weigh craft the way a reader feels it — specificity of image, control of the camera, the",
  "characters' interiority, restraint where restraint is earned, and whether the scene ends on",
  "something that asks. Length is not quality; neither is ornament.",
  "Answer with preferred (A or B), margin (slight when it is close, clear when it is not), and",
  "one or two sentences of reason quoting nothing longer than a short phrase.",
].join(" ");

async function judgePair(scene: SakugaScene, a: string, b: string): Promise<Comparison> {
  return callJudgment(JUDGE_SELECTION, {
    name: `ab_effort_judge_${scene.id}`,
    schema: Comparison,
    system: JUDGE_SYSTEM,
    prompt: [
      "## The storyboard both versions were written from",
      scene.brief,
      "",
      "## Version A",
      a,
      "",
      "## Version B",
      b,
    ].join("\n"),
    maxTokens: STRUCTURED_SMALL,
    // Same ledger posture as the narration calls: the judge is the harness
    // reading its own experiment, not the engine judging a turn.
    phase: "harness",
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface SakugaVersion {
  letter: "A" | "B";
  effort: Effort;
  /** null when the call failed or the ceiling refused it — the run continues
   *  and the report says so. */
  sample: NarrationSample | null;
  /** VERBATIM, and sealed: the public surfaces get sanitizeFailureReason. */
  error?: string;
  /** Console lines calls.ts would have printed with the cap beside the call
   *  name. Diverted here, sealed with the rest of this version's telemetry. */
  consoleCaptured: string[];
}

interface SakugaResult {
  scene: SakugaScene;
  versions: SakugaVersion[];
  verdict: Comparison | null;
  verdictError?: string;
}

interface DougaResult {
  beat: DougaBeat;
  nudged: boolean;
  sample: NarrationSample | null;
  estThinking: number | null;
  error?: string;
}

/**
 * Arm S, one scene at a time, ACCUMULATING INTO THE CALLER'S ARRAY. That is
 * load-bearing, not style: every version here is paid Fable prose, and the
 * previous shape threw the lot away if version four raised — a throw skipped
 * writeFileSync entirely and ~$1.25 of finished writing went with it. The
 * caller's `finally` writes whatever this has filled in by the time it stops.
 */
async function runSakuga(
  rand: () => number,
  into: SakugaResult[],
  guard: SpendGuard,
): Promise<void> {
  for (const scene of SAKUGA_SCENES) {
    // The lettering, per scene, from the seeded PRNG: A is high half the time.
    const aIsHigh = rand() < 0.5;
    // The RUN ORDER is drawn separately, and it is a blind fix, not a flourish.
    // Langfuse names each generation after the call and attaches the prose as
    // its output; the call name carries the LETTER now (never the effort), so
    // a fixed high-then-xhigh order would hand the mapping straight back via
    // trace timestamps. With the order drawn too, neither the trace sequence
    // nor the console's wall clock pairs a letter with a depth of think.
    const highFirst = rand() < 0.5;
    const efforts: readonly Effort[] = highFirst ? ["high", "xhigh"] : ["xhigh", "high"];
    const versions: SakugaVersion[] = [];
    const result: SakugaResult = { scene, versions, verdict: null };
    into.push(result);
    for (const [index, effort] of efforts.entries()) {
      const letter: "A" | "B" = (effort === "high") === aIsHigh ? "A" : "B";
      // Owned by the loop, not by narrate: a version that THROWS must still
      // hand its diverted console lines to the seal.
      const consoleCaptured: string[] = [];
      // The ceiling, on the wire. Priced at the FULL cap this call would be
      // allowed to spend — 27k under high, 35k under xhigh — not at the p95
      // allowance the banner's estimate assumed.
      if (
        !affords(
          guard,
          `arm S · ${scene.id} · version ${letter}`,
          worstCaseUsd({
            model: SAKUGA_SELECTION.narration,
            inputChars: SYSTEM_CHARS + scene.brief.length,
            outputBudget: TURN_CONTRACTS.sakuga.outputBudgetTokens,
            effort,
          }),
        )
      ) {
        versions.push({ letter, effort, sample: null, error: BUDGET_SKIP, consoleCaptured });
        console.log(`[ab] arm S · ${scene.id} · version ${letter}: ${BUDGET_SKIP}`);
        continue;
      }
      // THE CONSOLE IS PART OF THE BLIND. Arm S logs progress and NOTHING that
      // pairs an effort with a measurement: prose length, latency and cost all
      // identify the deeper think, and a terminal scrollback read before the
      // report would spoil the read the report is built to protect. The index
      // is safe precisely because the order is drawn — it names neither the
      // effort nor the letter. Per-version telemetry exists — sealed, in the
      // report's key. Do not "improve" this logging back into a table.
      console.log(
        `[ab] arm S · ${scene.id} · version ${index + 1}/${efforts.length} · ${SAKUGA_SELECTION.narration}…`,
      );
      try {
        const sample = await narrate({
          // THE TRACE NAME CARRIES THE LETTER, NEVER THE EFFORT. calls.ts uses
          // this string as the Langfuse trace AND generation name and attaches
          // the prose as the generation's output — `…_xhigh` beside the text
          // published as "Scene 1 — A" decoded the seal for anyone who ran
          // `pnpm langfuse:latest`. The letter is public in the report; the
          // effort lives in the sealed key alone. What tracing cannot close:
          // Langfuse records each generation's LATENCY, and a much slower
          // version is an inference about depth of think. The seal keeps that
          // out of the REPORT; opening the tracing UI mid-read is still a way
          // to spoil your own blind.
          name: `ab_effort_sakuga_${scene.id}_${letter}`,
          selection: SAKUGA_SELECTION,
          brief: scene.brief,
          maxTokens: TURN_CONTRACTS.sakuga.outputBudgetTokens,
          effort,
          consoleSink: consoleCaptured,
        });
        guard.spentUsd += sample.costUsd;
        versions.push({ letter, effort, sample, consoleCaptured });
        console.log(`[ab]   version ${index + 1}/${efforts.length} complete`);
        if (sample.fallbackUsed) {
          console.warn(`[ab] NOTE: a version of ${scene.id} was served by ${sample.servedBy}`);
        }
        if (!sample.prose.trim()) {
          console.warn(`[ab] WARNING: a version of ${scene.id} returned empty prose`);
        }
        if (!sample.trailerLanded) {
          console.warn(`[ab] NOTE: a version of ${scene.id} landed no commit_scene trailer`);
        }
      } catch (err) {
        // One version failing costs that version, never the other three and
        // never the report. The letter is named (it is public); the effort is
        // not (the seal records it). Neither is the API's own words: a 400
        // quoting max_tokens on the console decodes the seal as surely as a
        // label would, so the console gets the sanitized category and the
        // verbatim message rides into the key on `error`.
        const message = err instanceof Error ? err.message : String(err);
        versions.push({ letter, effort, sample: null, error: message, consoleCaptured });
        console.error(
          `[ab] arm S · ${scene.id} · version ${letter} FAILED: ${sanitizeFailureReason(message)}`,
        );
      }
    }
    versions.sort((x, y) => x.letter.localeCompare(y.letter));
    const a = versions.find((v) => v.letter === "A");
    const b = versions.find((v) => v.letter === "B");
    if (a?.sample?.prose.trim() && b?.sample?.prose.trim()) {
      const judgeWorstCase = worstCaseUsd({
        model: JUDGE_SELECTION.judgment,
        inputChars:
          JUDGE_SYSTEM.length + scene.brief.length + a.sample.prose.length + b.sample.prose.length,
        outputBudget: STRUCTURED_SMALL,
      });
      if (!affords(guard, `judge · ${scene.id}`, judgeWorstCase)) {
        result.verdictError = BUDGET_SKIP;
        continue;
      }
      try {
        result.verdict = await judgePair(scene, a.sample.prose, b.sample.prose);
        // callJudgment returns the parsed verdict, not a cost — the ledger has
        // the real number, this process does not. Charging the guard the worst
        // case keeps the running total an UPPER bound, the only direction a
        // ceiling may err.
        guard.spentUsd += judgeWorstCase;
        console.log(
          `[ab] judge · ${scene.id}: prefers ${result.verdict.preferred} (${result.verdict.margin})`,
        );
      } catch (err) {
        // The judge is the SIDE dish — his read is the verdict that matters.
        // A judge failure must never cost the proses that were already paid for.
        // Sanitized on both surfaces: the judge's prompt is two arm-S proses,
        // so a 400 quoting their token count is an arm-S measurement.
        result.verdictError = sanitizeFailureReason(
          err instanceof Error ? err.message : String(err),
        );
        console.warn(`[ab] judge failed on ${scene.id}: ${result.verdictError}`);
      }
    } else {
      result.verdictError = "one version produced no prose — nothing to compare";
    }
  }
}

/** Same accumulate-as-you-go contract as arm S: Sonnet money is smaller money,
 *  but a lost sample is a lost cell in an N=1 table. */
async function runDouga(into: DougaResult[], guard: SpendGuard): Promise<void> {
  for (const beat of DOUGA_BEATS) {
    for (const nudged of [false, true]) {
      const brief = nudged ? `${beat.brief}\n${DOUGA_NUDGE}` : beat.brief;
      if (
        !affords(
          guard,
          `arm D · ${beat.id} · ${nudged ? "nudged" : "control"}`,
          worstCaseUsd({
            model: DOUGA_SELECTION.narration,
            inputChars: SYSTEM_CHARS + brief.length,
            outputBudget: TURN_CONTRACTS.douga.outputBudgetTokens,
            effort: "high",
          }),
        )
      ) {
        into.push({ beat, nudged, sample: null, estThinking: null, error: BUDGET_SKIP });
        console.log(`[ab] arm D · ${beat.id} · ${nudged ? "nudged" : "control"}: ${BUDGET_SKIP}`);
        continue;
      }
      console.log(`[ab] arm D · ${beat.id} · ${nudged ? "nudged" : "control"}…`);
      try {
        const sample = await narrate({
          // Arm D is OPEN by design — it is a mechanism test, its numbers are
          // published in the clear, and the descriptive name is the point.
          name: `ab_effort_douga_${beat.id}_${nudged ? "nudged" : "control"}`,
          selection: DOUGA_SELECTION,
          brief,
          maxTokens: TURN_CONTRACTS.douga.outputBudgetTokens,
          // Flat high, both arms — the whole question is whether the CONTE can do
          // what the effort dial is not allowed to (A1).
          effort: "high",
        });
        guard.spentUsd += sample.costUsd;
        const estThinking = estThinkingTokens(sample);
        into.push({ beat, nudged, sample, estThinking });
        console.log(
          `[ab]   ttft ${sample.ttftMs ?? "—"}ms · ${sample.totalMs}ms · ${sample.prose.length} chars · ~${estThinking} thinking tok (trailer ~${sample.trailerTokens} tok, ${sample.trailerLanded ? "landed" : "MISSING"}) · ${fmtUsd(sample.costUsd)}`,
        );
      } catch (err) {
        // Arm D is OPEN, so its verbatim message stays on the console and is
        // carried into the key's `douga_failures`. The REPORT still renders the
        // sanitized category: the two arms share one public vocabulary, and a
        // reader scanning the PARTIAL block never has to wonder which numbers
        // he was allowed to see.
        const message = err instanceof Error ? err.message : String(err);
        into.push({ beat, nudged, sample: null, estThinking: null, error: message });
        console.error(
          `[ab] arm D · ${beat.id} · ${nudged ? "nudged" : "control"} FAILED: ${message}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function dougaTable(rows: DougaResult[]): string[] {
  const out: string[] = [];
  out.push(
    "| beat | arm | TTFT ms | total ms | prose chars | output tok | trailer tok | est. thinking tok | $ |",
  );
  out.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    const cell = `| ${r.beat.label} | ${r.nudged ? "**nudged**" : "control"} |`;
    out.push(
      r.sample === null
        ? `${cell} ${publicFailure(r.error)} | | | | | | |`
        : `${cell} ${r.sample.ttftMs ?? "—"} | ${r.sample.totalMs} | ${r.sample.prose.length} | ${r.sample.outputTokens} | ${r.sample.trailerTokens}${r.sample.trailerLanded ? "" : " (missing)"} | ${r.estThinking} | ${fmtUsd(r.sample.costUsd)} |`,
    );
  }
  return out;
}

function dougaDeltas(rows: DougaResult[]): string[] {
  const out: string[] = [];
  for (const beat of DOUGA_BEATS) {
    const control = rows.find((r) => r.beat.id === beat.id && !r.nudged);
    const nudged = rows.find((r) => r.beat.id === beat.id && r.nudged);
    if (!control || !nudged) continue;
    if (
      control.sample === null ||
      nudged.sample === null ||
      control.estThinking === null ||
      nudged.estThinking === null
    ) {
      out.push(
        `- **${beat.label}** — no delta: a cell produced nothing (${publicFailure(control.error ?? nudged.error)}).`,
      );
      continue;
    }
    const pct = (a: number, b: number): string =>
      a === 0 ? "n/a" : `${(((b - a) / a) * 100).toFixed(0)}%`;
    const ttft =
      control.sample.ttftMs !== null && nudged.sample.ttftMs !== null
        ? `${nudged.sample.ttftMs - control.sample.ttftMs} ms (${pct(control.sample.ttftMs, nudged.sample.ttftMs)})`
        : "—";
    out.push(
      `- **${beat.label}** — TTFT Δ ${ttft} · thinking Δ ${nudged.estThinking - control.estThinking} tok (${pct(control.estThinking, nudged.estThinking)}) · total Δ ${nudged.sample.totalMs - control.sample.totalMs} ms · prose Δ ${nudged.sample.prose.length - control.sample.prose.length} chars`,
    );
  }
  return out;
}

function buildReport(args: {
  sakuga: SakugaResult[];
  douga: DougaResult[];
  narrationUsd: number;
  ledgerUsd: number | null;
  estimateUsd: number;
  /** Non-null when the run stopped early — the report is written anyway. */
  aborted: string | null;
  /** The runtime ceiling's own record: its refusals are public in kind, and
   *  its arithmetic is sealed (a running total is a per-version cost). */
  guard: SpendGuard;
}): string {
  const out: string[] = [];
  out.push("# A2 — the blind A/B: sakuga effort (high vs xhigh) + the douga conte nudge");
  out.push("");
  out.push(
    `Generated: ${new Date().toISOString()} · seed \`${SEED}\` · arm \`${ARM}\` · user-approved 2026-08-06 (M3R4 punch list, bucket A2).`,
  );
  out.push("");
  out.push("## How to read this");
  out.push("");
  out.push(
    "Arm D is open — it is a mechanism test, and the numbers are the finding. **Arm S is blind, and you are the judge.** Read Scene 1 A and B, decide which scene you would rather have received at the table, then do the same for Scene 2. Only then decode the key at the bottom.",
  );
  out.push("");
  out.push(
    "The per-version telemetry for arm S (tokens, latency, cost) is sealed WITH the key: those numbers identify the effort as surely as a label would. The model judge's verdicts are printed beside the proses — it was shown the same two texts as A and B and told nothing else.",
  );
  out.push("");

  // Completeness, stated at the TOP. A report that quietly holds three of four
  // versions reads exactly like a whole one, and the reader's blind verdict
  // would be cast over a hole he was never shown.
  // Every reason here is SANITIZED. The verbatim API message would sit beside
  // a public letter, and a 400 or a 429 quotes token numbers — the same
  // arithmetic the sealed telemetry exists to withhold. The verbatim text is
  // in the key, per version.
  const failed = [
    ...args.sakuga.flatMap((r) =>
      r.versions
        .filter((v) => v.sample === null)
        .map((v) => `arm S · ${r.scene.id} · version ${v.letter}: ${publicFailure(v.error)}`),
    ),
    ...args.douga
      .filter((r) => r.sample === null)
      .map(
        (r) =>
          `arm D · ${r.beat.id} · ${r.nudged ? "nudged" : "control"}: ${publicFailure(r.error)}`,
      ),
  ];
  if (failed.length > 0 || args.aborted || args.guard.stopped) {
    out.push("> **This run is PARTIAL.** What follows is everything that completed and was paid");
    out.push("> for; what did not is named here rather than left as an absence.");
    out.push(">");
    for (const line of failed) out.push(`> - ${line}`);
    if (args.guard.stopped) {
      out.push(
        "> - the hard ceiling refused the remaining paid calls before they started. Nothing was",
      );
      out.push(
        ">   interrupted mid-stream; the spend arithmetic is in the sealed key, where a running",
      );
      out.push(">   total cannot spoil the blind.");
    }
    if (args.aborted) out.push(`> - the run stopped early: ${sanitizeFailureReason(args.aborted)}`);
    out.push("");
  }

  if (args.douga.length > 0) {
    out.push("## Arm D — the douga conte nudge (Sonnet, effort high both arms, OPEN)");
    out.push("");
    out.push("The line under test, appended to the storyboard verbatim:");
    out.push("");
    out.push(`> ${DOUGA_NUDGE}`);
    out.push("");
    out.push(
      "It rides in **Block 4 (the user message), never in a cached block** — that is the whole design. A1 closed the effort dial as the douga latency lever because effort is a cache-key ingredient; the conte is rebuilt every turn regardless, so this lever costs no cache lineage.",
    );
    out.push("");
    out.push(...dougaTable(args.douga));
    out.push("");
    out.push("Deltas (nudged − control):");
    out.push("");
    out.push(...dougaDeltas(args.douga));
    out.push("");
    out.push(
      "N=1 per cell. This is a direction-finder, not a measurement: if the nudge shows nothing here it is dead, and if it shows something the honest next step is reps, not a rollout.",
    );
    out.push("");
    out.push(
      "Every call in this run sends the real `commit_scene` tool (production posture), so the trailer arrives as a tool_use block rather than as JSON typed into the prose. `est. thinking tok` is `output_tokens − ceil(prose_chars/4) − trailer_tokens`, the trailer approximated at 4 chars per token over its serialized input. The residual leans HIGH by the tool encoding's unmodeled wrapper tokens — a constant-ish bias on both sides of a delta.",
    );
    out.push("");
  }

  if (args.sakuga.length > 0) {
    out.push("## Arm S — the blind pairs (Fable, cold, one storyboard per scene)");
    out.push("");
    const fallbacks = args.sakuga.flatMap((r) =>
      r.versions
        .filter((v) => v.sample?.fallbackUsed)
        .map((v) => `${r.scene.id}-${v.letter} was served by ${v.sample?.servedBy}`),
    );
    out.push(
      fallbacks.length > 0
        ? `**Fallback fired:** ${fallbacks.join("; ")} — the voice shifted on that version (§3), which is worth knowing before you weigh it.`
        : "No fallback fired: every version was served by Fable itself.",
    );
    out.push("");
    for (const result of args.sakuga) {
      out.push(
        `### ${result.scene.id === "scene1" ? "Scene 1" : "Scene 2"} — ${result.scene.label}`,
      );
      out.push("");
      out.push("<details><summary>The storyboard both versions were written from</summary>");
      out.push("");
      out.push("```");
      out.push(result.scene.brief);
      out.push("```");
      out.push("");
      out.push("</details>");
      out.push("");
      for (const version of result.versions) {
        out.push(
          `#### ${result.scene.id === "scene1" ? "Scene 1" : "Scene 2"} — ${version.letter}`,
        );
        out.push("");
        out.push(
          version.sample === null
            ? `_${publicFailure(version.error)} — this version was never written. (Which effort it would have been stays in the sealed key, like the rest, and so does what the wire actually said.)_`
            : version.sample.prose.trim() || "_(empty — the call returned no prose)_",
        );
        out.push("");
      }
      out.push(
        result.verdict
          ? `**Judge (Sonnet, blind):** prefers **${result.verdict.preferred}**, margin _${result.verdict.margin}_ — ${result.verdict.reason}`
          : `**Judge:** no verdict — ${result.verdictError ?? "unknown"}.`,
      );
      out.push("");
    }
  }

  out.push("## Spend");
  out.push("");
  out.push(
    `- Pre-run estimate (the number the run was authorized against): ${fmtUsd(args.estimateUsd)}`,
  );
  out.push(
    `- Narration spend, summed from the traced calls' own \`costUsd\`: **${fmtUsd(args.narrationUsd)}**`,
  );
  out.push(
    args.ledgerUsd === null
      ? "- Ledger total: unavailable (no DATABASE_URL — the meter had nowhere to write)."
      : `- Ledger total (\`model_calls\` rows in this run's window: campaign-less, provider anthropic, the models used): **${fmtUsd(args.ledgerUsd)}** — includes the judge calls the narration sum cannot see. A concurrent campaign-less call elsewhere would land in this window too.`,
  );
  out.push(
    "- Phase on every row: `harness` — spend the harness made, not the engine. Turn number stays NULL: nothing here is play, so nothing here is a turn's cost.",
  );
  out.push("");

  // The seal. Everything that would identify an effort lives in here, base64'd
  // so a scroll to the bottom cannot spoil a read in progress.
  const key = {
    approved: "user-approved 2026-08-06 (M3R4 A2)",
    seed: SEED,
    mapping: args.sakuga.map((r) => ({
      scene: r.scene.id,
      A: r.versions.find((v) => v.letter === "A")?.effort ?? "n/a",
      B: r.versions.find((v) => v.letter === "B")?.effort ?? "n/a",
      judge_preferred: r.verdict?.preferred ?? null,
      judge_margin: r.verdict?.margin ?? null,
    })),
    // The ceiling's arithmetic lives here for the same reason the telemetry
    // does: "spent $X so far" read after arm S's first version IS that
    // version's cost, and cost names the deeper think.
    budget_guard: {
      ceiling_usd: MAX_USD,
      ceiling_overridden: MAX_USD_OVERRIDDEN,
      runtime_spent_usd: Number(args.guard.spentUsd.toFixed(6)),
      stopped: args.guard.stopped,
      refusals: args.guard.log,
    },
    run_stopped_verbatim: args.aborted,
    // Arm D is open, but its verbatim failure text has nowhere else durable to
    // live once the terminal scrolls — the report renders the category only.
    douga_failures: args.douga
      .filter((r) => r.sample === null)
      .map((r) => ({
        beat: r.beat.id,
        arm: r.nudged ? "nudged" : "control",
        verbatim: r.error ?? "unknown",
      })),
    telemetry: args.sakuga.flatMap((r) =>
      r.versions.map((v) =>
        v.sample === null
          ? {
              scene: r.scene.id,
              letter: v.letter,
              effort: v.effort,
              // VERBATIM — this is where the sanitized public line's real
              // words went, and where calls.ts's diverted console output goes.
              failed: v.error ?? "unknown",
              console_captured: v.consoleCaptured,
            }
          : {
              scene: r.scene.id,
              letter: v.letter,
              effort: v.effort,
              console_captured: v.consoleCaptured,
              served_by: v.sample.servedBy,
              prose_chars: v.sample.prose.length,
              input_tokens: v.sample.inputTokens,
              output_tokens: v.sample.outputTokens,
              trailer_tokens: v.sample.trailerTokens,
              trailer_landed: v.sample.trailerLanded,
              est_thinking_tokens: estThinkingTokens(v.sample),
              ttft_ms: v.sample.ttftMs,
              total_ms: v.sample.totalMs,
              cost_usd: Number(v.sample.costUsd.toFixed(6)),
            },
      ),
    ),
  };
  const sealed = Buffer.from(JSON.stringify(key, null, 2), "utf8").toString("base64");
  out.push("## KEY — decode only after reading");
  out.push("");
  out.push(
    "The effort→letter mapping, arm S's per-version telemetry, the verbatim text of anything that failed, the console lines the harness diverted out of the terminal (calls.ts prints the effective max_tokens cap beside the call name when a version truncates — that number IS the effort), and the runtime ceiling's arithmetic. Decode with `echo '<line>' | base64 -d`:",
  );
  out.push("");
  out.push("```");
  out.push(sealed);
  out.push("```");
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Everything this run spent, bounded on the DATABASE clock and on the models it
 *  used. The script has no campaignId, so its rows are campaign-less by
 *  construction — which is also the filter that keeps a concurrent SOAK's rows
 *  (all campaign-bound) out of the total. */
async function ledgerSpendSince(since: Date | null, models: string[]): Promise<number | null> {
  if (!since || !process.env.DATABASE_URL) return null;
  try {
    const rows = await getDb()
      .select({ costUsd: schema.modelCalls.costUsd })
      .from(schema.modelCalls)
      .where(
        and(
          gte(schema.modelCalls.createdAt, since),
          isNull(schema.modelCalls.campaignId),
          eq(schema.modelCalls.provider, "anthropic"),
          inArray(schema.modelCalls.model, models),
        ),
      );
    return rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
  } catch (err) {
    console.warn("[ab] ledger read failed — reporting the traced sum only:", err);
    return null;
  }
}

/**
 * Where this run's record goes. The seed is IN THE NAME because the date alone
 * is not an identity: the honest next step after this A/B is reps, and a second
 * run on the same day addressed `ab-effort-<date>.md` — the first run's sealed
 * key and its four paid proses — with an unconditional writeFileSync.
 */
function reportPath(): string {
  return join(
    process.cwd(),
    "docs",
    "retros",
    `ab-effort-${new Date().toISOString().slice(0, 10)}-seed${SEED}.md`,
  );
}

/** Write the report, and NEVER over an existing file. The `wx` flag is the
 *  refusal; the sibling path is the safety net under it, because by the time
 *  this runs the prose is already bought and losing it to a name collision
 *  would be the same defect in a politer coat. */
function writeReport(path: string, report: string): string {
  try {
    writeFileSync(path, report, { flag: "wx" });
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const alt = path.replace(/\.md$/, `-conflict-${Date.now()}.md`);
    console.error(`[ab] FATAL-ish: ${path} already exists — REFUSING to overwrite it.`);
    console.error(`[ab] This run's report went to ${alt} instead. Reconcile them by hand.`);
    writeFileSync(alt, report, { flag: "wx" });
    return alt;
  }
}

async function main(): Promise<boolean> {
  assertNotFable("arm D narration", DOUGA_SELECTION.narration);
  assertNotFable("the judge", JUDGE_SELECTION.judgment);

  const estimateUsd = printBanner();

  if (!LIVE) {
    console.log("The storyboards, verbatim:");
    console.log("");
    if (ARM !== "douga") {
      for (const scene of SAKUGA_SCENES) {
        console.log(`--- arm S · ${scene.id} (${scene.label}) ---`);
        console.log(scene.brief);
        console.log("");
      }
    }
    if (ARM !== "sakuga") {
      for (const beat of DOUGA_BEATS) {
        console.log(`--- arm D · ${beat.id} (control) ---`);
        console.log(beat.brief);
        console.log(`--- arm D · ${beat.id} (nudged: the same brief plus one line) ---`);
        console.log(`${beat.brief}\n${DOUGA_NUDGE}`);
        console.log("");
      }
    }
    console.log(
      `[dry-run] plan + price printed — ZERO model calls, nothing written. Pass --live to spend the ${fmtUsd(estimateUsd)}.`,
    );
    console.log(
      "[dry-run] --live is REQUIRED: arm S calls Fable, and Fable spend is user-gated by standing directive.",
    );
    console.log(`[dry-run] a live run would write ${reportPath()}`);
    return true;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[ab] FATAL: --live needs ANTHROPIC_API_KEY");
    process.exit(1);
  }

  // The ceiling, checked against the number this run just printed for itself.
  if (estimateUsd > MAX_USD) {
    console.error(
      `[ab] FATAL: the estimate ${fmtUsd(estimateUsd)} exceeds the hard ceiling ${fmtUsd(MAX_USD)} (the A2 approval envelope, user-ratified 2026-08-06).`,
    );
    console.error(
      `[ab] Nothing was spent. Re-price the run, or authorize the overrun explicitly with --max-usd=${Math.ceil(estimateUsd)}.`,
    );
    process.exit(1);
  }

  // Fail FAST on a name collision — before a dollar is spent, not after. The
  // write path refuses again at the end in case the file appeared meanwhile.
  const path = reportPath();
  if (existsSync(path)) {
    console.error(`[ab] FATAL: ${path} already exists — that file is a sealed record.`);
    console.error("[ab] Nothing was spent. Pass a different --seed=<n> to run again today.");
    process.exit(1);
  }

  const since = process.env.DATABASE_URL ? await dbNow(getDb()) : null;
  const rand = mulberry32(SEED);
  // Owned HERE, filled by the arms as they go: the report is written from
  // whatever these hold when the run stops, however it stops.
  const sakuga: SakugaResult[] = [];
  const douga: DougaResult[] = [];
  // The ceiling's second gate, live for the whole run and across both arms:
  // the estimate checked above priced the p95 thinking allowance, not the
  // 27k/35k caps the requests actually carry.
  const guard = newSpendGuard();
  let aborted: string | null = null;
  try {
    // Arm S first: it is the expensive half and the one the user is waiting on.
    if (ARM !== "douga") await runSakuga(rand, sakuga, guard);
    if (ARM !== "sakuga") await runDouga(douga, guard);
  } catch (err) {
    // Per-call failures are already handled inside the arms; this catches the
    // unexpected — and it still must not cost the prose already paid for.
    aborted = err instanceof Error ? err.message : String(err);
    // Sanitized on the console too: an unexpected throw during arm S is as
    // likely as any other to be an API body quoting the cap. The verbatim text
    // is carried into the sealed key (`run_stopped_verbatim`).
    console.error(`[ab] the run stopped early: ${sanitizeFailureReason(aborted)}`);
  } finally {
    await flushLangfuse();
  }

  const narrationUsd =
    sakuga.reduce(
      (sum, r) => sum + r.versions.reduce((s, v) => s + (v.sample?.costUsd ?? 0), 0),
      0,
    ) + douga.reduce((sum, r) => sum + (r.sample?.costUsd ?? 0), 0);
  const models = [
    ...new Set([SAKUGA_SELECTION.narration, DOUGA_SELECTION.narration, JUDGE_SELECTION.judgment]),
  ];
  const ledgerUsd = await ledgerSpendSince(since, models);

  const report = buildReport({
    sakuga,
    douga,
    narrationUsd,
    ledgerUsd,
    estimateUsd,
    aborted,
    guard,
  });
  const written = writeReport(path, report);

  const failures =
    sakuga.reduce((n, r) => n + r.versions.filter((v) => v.sample === null).length, 0) +
    douga.filter((r) => r.sample === null).length;

  console.log("");
  console.log("=== A2 SUMMARY ===");
  console.log(`report → ${written}`);
  console.log(
    `narration spend (traced): ${fmtUsd(narrationUsd)} · ledger window total: ${ledgerUsd === null ? "n/a" : fmtUsd(ledgerUsd)} · estimate was ${fmtUsd(estimateUsd)}`,
  );
  // The mapping is NEVER printed: a console scroll would spoil the read the
  // report exists to protect. It lives in the report's sealed key alone.
  console.log(
    `arm S pairs: ${sakuga.length} · judge verdicts: ${sakuga.filter((r) => r.verdict).length} · arm D samples: ${douga.length} · failed calls: ${failures}`,
  );
  if (guard.stopped !== null) {
    console.log(
      "the HARD CEILING stopped this run: every remaining paid call was skipped before it started, and the report is the partial. Its arithmetic is in the sealed key.",
    );
  }
  console.log("The effort→letter key is SEALED in the report. Read the proses first.");
  return failures === 0 && aborted === null;
}

const ok = await main();
process.exit(ok ? 0 : 1);
