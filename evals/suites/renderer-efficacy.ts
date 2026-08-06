import { streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { PUNCH_THROUGH_TURNS, renderAmendments } from "@/lib/renderer/amendments";
import { renderSettei } from "@/lib/renderer/settei";
import { scoreAxes } from "@/lib/sakkan/score";
import type { AxisName } from "@/lib/types/grounding";
import type { Suite, SuiteResult } from "../types";

/**
 * §10.2 — Renderer efficacy, LIVE from M1 (risk §14.4's tripwire): the
 * same neutral scene narrated WITH and WITHOUT the Settei; both outputs
 * blind-scored by the shared Gauge-v2 scorer. The charter must move the
 * target axes toward their extremes without dragging the controls.
 * Runs on DEV tiers (never Fable — standing directive).
 *
 * HARDENED M3R4 B1, and the forensics are the reason. Across the four runs of
 * the 2026-08-05 live sweep this suite went red FOUR TIMES on FOUR DIFFERENT
 * single-sample modes — a tie read as FAIL, a different axis each run, a
 * control-arm drift, and a 529 counted as a charter regression. No axis ever
 * repeated. That is an instrument reporting its own noise as a verdict about
 * the charter, and the repair is the one its siblings already carry:
 *
 *   - PER-ARM REPS + MAJORITY (channel-routing's `reps: 3` on flaky probes).
 *     Each rep draws a FRESH narration on both arms, so the reps sample the
 *     generator's variance, not just the scorer's — the old mean-of-2 scored
 *     one prose twice and could not see a bad draw at all.
 *   - THREE-WAY VERDICTS (thin-ip-drill, control-key): pass / fail / UNPROVEN.
 *     A tie is not a regression, it is a non-result; a 529 or a rate limit is
 *     evidence NOT COLLECTED. Neither may print as "the charter regressed".
 *   - A SUMMARY THAT SAYS WHICH IT WAS. A run where nothing could be proven
 *     returns `skipped`, which the harness rolls up as "MEASURED NOTHING (ran,
 *     no evidence — NOT a pass)". Only a real majority-of-reps regression is
 *     a FAIL.
 *
 * COST, honestly: 18 narration + 21 judgment calls at the DEV tiers (Sonnet
 * narration / Haiku judgment) against 6 + 14 pre-hardening — 39 calls vs 20,
 * so 1.95× by call count, but 3.0× on NARRATION, which is what dominates the
 * dollars. That is what three reps of a two-armed A/B costs, and the
 * alternative — a coin flip dressed as a gate — trained exactly the ignoring
 * §10's roll-up exists to prevent. The integrator meters this; it is not for
 * tuning loops.
 */

// Synthetic extreme premise: strong signal on two covered axes. The A/B
// needs HEADROOM: the scene must baseline FAR from every target (first
// live runs failed on this twice — comedy-at-1 against an already-serious
// scene, then darkness-9 against a dust-storm scene Sonnet narrates noir
// unprompted). A cozy, neutral-valence scene baselines low on darkness AND
// comedy, so a 9 on either must visibly bend it.
const TARGETS: { axis: AxisName; value: number }[] = [
  { axis: "darkness", value: 9 },
  { axis: "comedy", value: 9 },
];
const CONTROLS: AxisName[] = ["pacing", "interiority"];

/** A control moved this far is collateral damage, not scorer noise. */
const CONTROL_DRIFT_BAND = 4;

/** Reps per arm. Odd, so a majority always exists among usable reps. */
export const REPS = 3;

/**
 * Fewer usable reps than this and the arm is UNPROVEN, whatever they said.
 * One sample IS the failure mode this hardening exists for: four single
 * samples produced four different verdicts about a charter that never moved.
 */
export const MIN_USABLE_REPS = 2;

/**
 * Transport / quota / auth failures — evidence NOT collected. Mirrors
 * thin-ip-drill's `UNPROVEN` regex (same doctrine: a canary that greens, or
 * reddens, on a transport error is worse than no canary). Anything else that
 * throws is a real defect in what we sent and stays a FAIL.
 */
const TRANSPORT =
  /401|403|429|5\d{2}|overloaded|rate.?limit|api.?key|ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|network/i;

const SCENE =
  "Narrate one short scene (under 200 words): two old friends reopen their family noodle stand after months of repairs, and the first customer of the morning walks in just as the new sign goes up. Then call commit_scene once.";

// ---------------------------------------------------------------------------
// The verdict machinery, pure (unit-tested in renderer-efficacy.test.ts — a
// hardening nobody can run without spending is a hardening nobody has checked).
// ---------------------------------------------------------------------------

/**
 * One rep's contribution to its arm's claim.
 *  - `toward`   — the rep SUPPORTS the claim (the charter pulled the axis
 *                 toward its target; or, on a control arm, the control held).
 *  - `away`     — the rep CONTRADICTS it (pulled away; or the control drifted).
 *  - `tie`      — the rep separated nothing. A non-result, never a regression.
 *  - `unproven` — the evidence never arrived (transport error, empty prose, a
 *                 scorer that returned no score for the axis).
 */
export type RepOutcome = "toward" | "away" | "tie" | "unproven";

export type ArmVerdict = "pass" | "fail" | "unproven";

export interface ArmTally {
  verdict: ArmVerdict;
  toward: number;
  away: number;
  tie: number;
  unproven: number;
  /** Reps that produced a reading at all — the majority's denominator. */
  usable: number;
}

/**
 * Majority of USABLE reps, with ties counted in the denominator and in
 * nobody's favor. A split (2 toward / 2 away, or 1/1/1) proves nothing and
 * says so; only a majority AGAINST the claim is a regression.
 */
export function tallyReps(
  outcomes: readonly RepOutcome[],
  minUsable: number = MIN_USABLE_REPS,
): ArmTally {
  const count = (o: RepOutcome) => outcomes.filter((x) => x === o).length;
  const toward = count("toward");
  const away = count("away");
  const tie = count("tie");
  const unproven = count("unproven");
  const usable = toward + away + tie;
  const verdict: ArmVerdict =
    usable < minUsable
      ? "unproven"
      : toward * 2 > usable
        ? "pass"
        : away * 2 > usable
          ? "fail"
          : "unproven";
  return { verdict, toward, away, tie, unproven, usable };
}

export interface Arm {
  name: string;
  tally: ArmTally;
  detail: string;
}

export interface EfficacySummary {
  status: "pass" | "fail" | "skipped";
  failures: string[];
  /** The line that says WHICH kind of run this was. */
  summary: string;
}

/**
 * The distinction the four red runs never made: "the charter regressed" is a
 * majority of reps pulling the wrong way on some arm; "the instrument couldn't
 * prove anything this run" is arms that never collected their evidence. A run
 * with no regression and no proof returns `skipped` — the harness prints that
 * as MEASURED NOTHING, which is the truth and is NOT a pass.
 */
export function summarizeArms(arms: readonly Arm[]): EfficacySummary {
  const regressed = arms.filter((a) => a.tally.verdict === "fail");
  const proven = arms.filter((a) => a.tally.verdict === "pass");
  const unproven = arms.filter((a) => a.tally.verdict === "unproven");
  const status = regressed.length > 0 ? "fail" : proven.length === 0 ? "skipped" : "pass";
  const verdictClause =
    regressed.length > 0
      ? `the charter moved the wrong way on ${regressed.map((a) => a.name).join(", ")}`
      : proven.length === 0
        ? "the INSTRUMENT proved nothing this run (no charter verdict was collected); this is not a pass and not a regression"
        : unproven.length > 0
          ? `no regression; ${unproven.map((a) => a.name).join(", ")} collected no verdict (evidence gap, not a charter finding)`
          : "the charter holds on every arm";
  const summary = `${arms.length} arm(s): ${proven.length} proven, ${regressed.length} REGRESSED, ${unproven.length} unproven — ${verdictClause}`;
  return {
    status,
    failures: regressed.map((a) => `${a.name}: ${a.detail}`),
    summary,
  };
}

// ---------------------------------------------------------------------------
// The live half.
// ---------------------------------------------------------------------------

/** A narration attempt: prose, or the reason there is none. */
type Draw = { prose: string } | { unproven: string } | { failed: string };

async function narrate(system: string): Promise<Draw> {
  try {
    const { done } = streamNarration({
      name: "eval_renderer_efficacy",
      selection: DEV_TIER_SELECTION,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: SCENE }],
      maxTokens: 900,
    });
    const { prose } = await done();
    // Empty prose is no evidence, not a charter verdict (adaptive thinking can
    // eat the budget — the M1 class, sighted repeatedly).
    return prose.trim() ? { prose } : { unproven: "narration returned empty prose" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return TRANSPORT.test(msg) ? { unproven: msg.slice(0, 120) } : { failed: msg.slice(0, 120) };
  }
}

/** Why a draw carries no prose — the reason, whichever shape it arrived in. */
function whyNoProse(draw: Draw): string {
  if ("unproven" in draw) return draw.unproven;
  if ("failed" in draw) return draw.failed;
  return "prose present";
}

type Sheet = { scores: Map<AxisName, number> } | { unproven: string } | { failed: string };

async function score(sample: string, axes: AxisName[], name: string): Promise<Sheet> {
  try {
    const rows = await scoreAxes(DEV_TIER_SELECTION, { sample, axes, name });
    return { scores: new Map(rows.map((r) => [r.axis as AxisName, r.score])) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return TRANSPORT.test(msg) ? { unproven: msg.slice(0, 120) } : { failed: msg.slice(0, 120) };
  }
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const fmt = (xs: number[]): string => (xs.length === 0 ? "—" : median(xs).toFixed(1));

export const rendererEfficacy: Suite = {
  name: "renderer-efficacy",
  gate: "M1+ (§10.2)",
  requiresLlm: true,
  async run(): Promise<SuiteResult> {
    const { bebopContract } = await import("@/lib/renderer/__tests__/fixtures");
    const { DNAScales } = await import("@/lib/types/dna");
    const details: string[] = [];
    const arms: Arm[] = [];
    /** Non-transport call errors: real defects in what we sent, kept apart
     *  from the arm verdicts so they can never read as a charter finding. */
    const errors: string[] = [];

    const flatContract = () => {
      const contract = bebopContract();
      for (const axis of Object.keys(DNAScales.shape) as AxisName[]) {
        contract.active.treatment[axis] = 5;
      }
      return contract;
    };

    // The baseline arm is target-independent, so its reps are drawn ONCE and
    // reused across targets — one draw per rep, not one per (rep × target).
    const NEUTRAL = "You narrate scenes for an interactive story. Write well.";
    const baseline: Draw[] = [];
    for (let r = 0; r < REPS; r++) {
      const draw = await narrate(NEUTRAL);
      // Reported HERE, once: a shared draw's call error belongs to the draw,
      // not to each target that later reads it.
      if ("failed" in draw) errors.push(`baseline narration rep ${r + 1}: ${draw.failed}`);
      baseline.push(draw);
    }

    for (const t of TARGETS) {
      // One pressure per run: flat-5 treatment except the target, so the
      // rendered charter carries exactly one extreme and the A/B isolates it.
      const contract = flatContract();
      contract.active.treatment[t.axis] = t.value;
      const settei = renderSettei({ contract, marks: [] });
      const axes = [t.axis, ...CONTROLS];

      const outcomes: RepOutcome[] = [];
      const controlOutcomes = new Map<AxisName, RepOutcome[]>(CONTROLS.map((c) => [c, []]));
      const dWiths: number[] = [];
      const dWithouts: number[] = [];

      for (let r = 0; r < REPS; r++) {
        const noteUnproven = (why: string) => {
          outcomes.push("unproven");
          for (const c of CONTROLS) controlOutcomes.get(c)?.push("unproven");
          details.push(`${t.axis} rep ${r + 1}: unproven — ${why}`);
        };
        const withDraw = await narrate(settei.text);
        const withoutDraw = baseline[r] ?? { unproven: "no baseline draw" };
        if ("failed" in withDraw)
          errors.push(`${t.axis} rep ${r + 1} charter narration: ${withDraw.failed}`);
        if (!("prose" in withDraw) || !("prose" in withoutDraw)) {
          noteUnproven(
            "prose" in withDraw
              ? `baseline draw: ${whyNoProse(withoutDraw)}`
              : `charter draw: ${whyNoProse(withDraw)}`,
          );
          continue;
        }

        const [sheetWith, sheetWithout] = await Promise.all([
          score(withDraw.prose, axes, `efficacy_with_${t.axis}_r${r + 1}`),
          score(withoutDraw.prose, axes, `efficacy_without_${t.axis}_r${r + 1}`),
        ]);
        for (const [tag, sheet] of [
          ["with", sheetWith],
          ["without", sheetWithout],
        ] as const) {
          if ("failed" in sheet)
            errors.push(`${t.axis} rep ${r + 1} ${tag} scorer: ${sheet.failed}`);
        }
        if (!("scores" in sheetWith) || !("scores" in sheetWithout)) {
          noteUnproven("the blind scorer returned nothing");
          continue;
        }
        const w = sheetWith.scores.get(t.axis);
        const wo = sheetWithout.scores.get(t.axis);
        if (w === undefined || wo === undefined) {
          noteUnproven(`no score for ${t.axis}`);
          continue;
        }
        const dWith = Math.abs(w - t.value);
        const dWithout = Math.abs(wo - t.value);
        dWiths.push(dWith);
        dWithouts.push(dWithout);
        // A TIE is not a regression — the pre-hardening `dWith >= dWithout`
        // read one as a charter failure and turned a non-result red.
        outcomes.push(dWith < dWithout ? "toward" : dWith > dWithout ? "away" : "tie");

        for (const c of CONTROLS) {
          const cw = sheetWith.scores.get(c);
          const cwo = sheetWithout.scores.get(c);
          controlOutcomes
            .get(c)
            ?.push(
              cw === undefined || cwo === undefined
                ? "unproven"
                : Math.abs(cw - cwo) >= CONTROL_DRIFT_BAND
                  ? "away"
                  : "toward",
            );
        }
      }

      const tally = tallyReps(outcomes);
      arms.push({
        name: `${t.axis}→${t.value}`,
        tally,
        detail: `${tally.toward} toward / ${tally.away} away / ${tally.tie} tie / ${tally.unproven} unproven over ${REPS} reps; median Δ with ${fmt(dWiths)} vs without ${fmt(dWithouts)}`,
      });
      for (const c of CONTROLS) {
        const controlTally = tallyReps(controlOutcomes.get(c) ?? []);
        arms.push({
          name: `control ${c} under ${t.axis}`,
          tally: controlTally,
          detail: `held in ${controlTally.toward} of ${controlTally.usable} usable rep(s); drifted ≥${CONTROL_DRIFT_BAND} in ${controlTally.away}`,
        });
      }
    }

    // --- Corrective punch-through (§12, M2-C6) -------------------------------
    // The escalated Amendments note must pull the target axis at least as far
    // as the plain note, and clearly past the no-correction baseline. Isolates
    // the Amendments channel: a flat, pressure-free Settei is the shared base
    // for all three arms, so only the corrective note varies. Directional, not
    // strict (model variance, §0.9) — one band of tolerance on each assertion,
    // now decided by a majority of reps rather than by one draw.
    const PUNCH = { axis: "darkness" as AxisName, active: 9, observed: 3 };
    const baseCharter = renderSettei({ contract: flatContract(), marks: [] }).text;
    const note = {
      axis: PUNCH.axis,
      active: PUNCH.active,
      observed: PUNCH.observed,
      since_turn: 1,
    };
    const plainAmend = renderAmendments({ sakkanNotes: [note], freshMarks: [] });
    const escalatedAmend = renderAmendments({
      sakkanNotes: [note],
      freshMarks: [],
      currentTurn: 1 + PUNCH_THROUGH_TURNS,
      // The re-measurement tether (C6 audit #1): a post-note sample happened.
      lastSampleTurn: PUNCH_THROUGH_TURNS,
    });
    const withAmend = (amend: string) => (amend ? `${baseCharter}\n\n${amend}` : baseCharter);

    const escalationOutcomes: RepOutcome[] = [];
    const liftOutcomes: RepOutcome[] = [];
    const gaps: number[] = [];
    for (let r = 0; r < REPS; r++) {
      const draws = await Promise.all([
        narrate(withAmend("")),
        narrate(withAmend(plainAmend.text)),
        narrate(withAmend(escalatedAmend.text)),
      ]);
      const scored = await Promise.all(
        draws.map((d, i) =>
          "prose" in d
            ? score(
                d.prose,
                [PUNCH.axis],
                `punch_${["baseline", "plain", "escalated"][i]}_r${r + 1}`,
              )
            : Promise.resolve<Sheet>(
                "unproven" in d ? { unproven: d.unproven } : { failed: d.failed },
              ),
        ),
      );
      for (const [i, sheet] of scored.entries()) {
        if ("failed" in sheet) {
          errors.push(
            `punch rep ${r + 1} arm ${["baseline", "plain", "escalated"][i]}: ${sheet.failed}`,
          );
        }
      }
      const values = scored.map((s) => ("scores" in s ? s.scores.get(PUNCH.axis) : undefined));
      const [b, plain, esc] = values;
      if (b === undefined || plain === undefined || esc === undefined) {
        escalationOutcomes.push("unproven");
        liftOutcomes.push("unproven");
        details.push(`punch rep ${r + 1}: unproven — one of the three arms produced no score`);
        continue;
      }
      escalationOutcomes.push(esc >= plain - 1 ? "toward" : "away");
      liftOutcomes.push(esc - b >= 1 ? "toward" : "away");
      gaps.push(esc - b);
    }
    const escalationTally = tallyReps(escalationOutcomes);
    const liftTally = tallyReps(liftOutcomes);
    arms.push({
      name: "punch-through escalation ≥ plain",
      tally: escalationTally,
      detail: `escalated held its band in ${escalationTally.toward} of ${escalationTally.usable} usable rep(s)`,
    });
    arms.push({
      name: "punch-through clears baseline",
      tally: liftTally,
      detail: `escalated cleared the no-correction baseline by a band in ${liftTally.toward} of ${liftTally.usable} usable rep(s); median lift ${fmt(gaps)}`,
    });

    const { status, failures, summary } = summarizeArms(arms);
    // The arm lines lead; the per-rep unproven notes collected above trail.
    const armLines = arms.map(
      (a) =>
        `${a.tally.verdict === "pass" ? "✓" : a.tally.verdict === "fail" ? "✗" : "?"} ${a.name}: ${a.detail}`,
    );
    // The roll-up prints a pass's details only when they are few, and this
    // suite's are not — the one line that says which kind of run this was goes
    // to the console directly (channel-routing's metered-cost pattern).
    console.log(`[renderer-efficacy] ${summary}`);
    return {
      name: this.name,
      gate: this.gate,
      // A call the API refused is a defect on our side and reddens the run
      // whatever the arms said; it must never be silently absorbed by a
      // "pass" that came from the arms that did answer.
      status: errors.length > 0 ? "fail" : status,
      details: [summary, ...armLines, ...details],
      // A non-transport call error is a real defect (a malformed request, a
      // schema the API refuses) and reddens the run — but it is reported as
      // what it is, never folded into a charter verdict.
      failures: [...failures, ...errors.map((e) => `call error: ${e}`)],
    };
  },
};
