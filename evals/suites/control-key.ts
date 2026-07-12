import { callJudgment, streamNarration } from "@/lib/llm/calls";
import { FABLE_MODEL } from "@/lib/llm/tiers";
import { DEV_TIER_SELECTION, type TierSelection } from "@/lib/llm/tiers";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { renderSettei } from "@/lib/renderer/settei";
import { KA_CONTRACT } from "@/lib/turn/ka";
import type { PremiseContract } from "@/lib/types/premise";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import type { Suite, SuiteResult } from "../types";

/**
 * §7.5 C8 — the control key honored in play, LIVE. The renderer test proves the
 * Settei renders the bounded permission block; only real narration proves the
 * KA HONORS it — that the key opens a bounded loss of control INSIDE the
 * declared circumstance (arm a), and that WITHOUT a key the writer never seizes
 * the player character's decisions (arm b). Both arms run the SAME mortal-peril
 * scene; only the Settei differs (key vs no key).
 *
 * Narration runs at Sonnet EXPLICITLY (never Fable — standing directive); the
 * judge runs at Sonnet too (the campaign judgment tier). Directional, and
 * honest about single-sample variance: mean-of-2 per arm. The integrator meters
 * this — DO NOT run it in a tuning loop.
 *
 * COST: ~4 narration + ~4 judgment Sonnet calls (~$0.10–0.20/run). Metered
 * through the traced trio; a meter row is best-effort (never blocks the call).
 */

// Narration AND judgment at Sonnet; probe stays DEV-Haiku. Never Fable.
const SELECTION: TierSelection = {
  ...DEV_TIER_SELECTION,
  narration: "claude-sonnet-5",
  judgment: "claude-sonnet-5",
};

const SAMPLES = 2;

/**
 * A berserker premise (loss of control is plausible here) built off the Bebop
 * fixture — the pieces that matter are the power system, the spark, and the
 * intensity contract's control_key. `withKey=false` renders the keyless arm.
 */
function berserkerContract(withKey: boolean): PremiseContract {
  const c = bebopContract();
  const bloodrage = {
    name: "the Bloodrage",
    mechanics:
      "A cursed bloodline: a mortal wound or a bondmate's death can trigger a berserker state of superhuman ferocity.",
    limitations:
      "The rage is indiscriminate while it holds; it passes only when the threat is dead or the wielder collapses.",
    tiers: [],
  };
  c.active.world.power_system = bloodrage;
  c.canonical.world.power_system = structuredClone(bloodrage);
  c.spark =
    "The moment the rage takes him and he becomes something that frightens even his allies — then comes back.";
  c.active.voice.director_personality =
    "A dark-fantasy director who lets the monster in the hero off the leash only when the story has earned the horror, then makes him live with what he did.";
  c.intensity = {
    death_physics: "death is real and permanent; the rage kills friend and foe alike",
    lethality_posture: "a little more intense — the berserker state is genuinely dangerous",
    hard_lines: [],
    ...(withKey
      ? {
          control_key: {
            circumstances:
              "when a bondmate is killed before his eyes or he takes a mortal wound, and the Bloodrage takes him",
          },
        }
      : {}),
  };
  return c;
}

// The player's ONLY stated action — the arms turn on whether the narration
// stays inside it (keyless) or lets the rage take him (keyed).
const PLAYER_ACTION = "I plant my feet between the wounded and the beast and refuse to move.";
const SCENE_BRIEF = [
  "# Storyboard (this scene only)",
  `Player action: ${PLAYER_ACTION}`,
  "The setting: his sworn brother lies dying at his feet, run through by the beast; the beast rears for a final blow; a mortal wound already burns in his own side.",
  "Write the scene.",
].join("\n");

const Judgment = z.object({ verdict: z.boolean(), reason: z.string().min(1) });

/** One tool-less narration call at Sonnet against the given Settei. */
async function narrate(setteiText: string): Promise<string> {
  const system: TextBlockParam[] = [
    { type: "text", text: setteiText },
    { type: "text", text: KA_CONTRACT },
  ];
  const { done } = streamNarration({
    name: "eval_control_key_narration",
    selection: SELECTION,
    system,
    messages: [{ role: "user", content: SCENE_BRIEF }],
    // Adaptive thinking bills against maxTokens BEFORE prose (the M1 class,
    // sixth sighting: 1_200 here returned zero prose — thinking ate it all).
    maxTokens: 6_000,
    effort: "high",
    tools: [], // prose only — the sidecar trailer is not what we measure here
  });
  const { prose } = await done();
  if (!prose.trim()) {
    throw new Error("control-key eval: narration returned empty prose (thinking ate the budget?)");
  }
  return prose;
}

/** Judge one narration against one boolean question (Sonnet). */
async function judge(
  question: string,
  prose: string,
): Promise<{ verdict: boolean; reason: string }> {
  return callJudgment(SELECTION, {
    name: "eval_control_key_judge",
    schema: Judgment,
    system: [
      "You are judging a single narrated scene from an anime TTRPG.",
      `The player's ONLY stated action was: "${PLAYER_ACTION}".`,
      question,
      "Answer with a boolean verdict and one sentence of reason.",
    ].join(" "),
    prompt: prose,
    maxTokens: 500,
  });
}

const Q_SLIP =
  "Question: does the narration depict the player character BRIEFLY losing control of himself — a berserker/bloodrage beat where he acts autonomously (lunging, attacking, moving to kill) BEYOND simply holding his ground? verdict=true if he is taken over and acts on his own; false if he only does what he stated.";
const Q_SEIZE =
  "Question: does the narration SEIZE the player character's agency — making decisions, taking actions, or committing him to a course beyond holding his ground, without leaving his next choice to the player? verdict=true if the narration acts or decides FOR him; false if it advances only the world (the beast, the surroundings) and leaves his next decision open.";

export const controlKey: Suite = {
  name: "control-key",
  gate: "M2 C8 (§7.5 — the control key honored in play)",
  requiresLlm: true,
  async run(): Promise<SuiteResult> {
    const details: string[] = [];
    const failures: string[] = [];

    // Standing directive: no automated run ever calls Fable.
    if (
      (SELECTION.narration as string) === FABLE_MODEL ||
      (SELECTION.judgment as string) === FABLE_MODEL
    ) {
      throw new Error("control-key eval must never select Fable (standing directive)");
    }

    const keyedSettei = renderSettei({ contract: berserkerContract(true), marks: [] }).text;
    const keylessSettei = renderSettei({ contract: berserkerContract(false), marks: [] }).text;

    // Arm (a): WITH a key → expect the character to briefly slip control.
    let slips = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const prose = await narrate(keyedSettei);
      const v = await judge(Q_SLIP, prose);
      if (v.verdict) slips += 1;
      details.push(`arm a (key) sample ${i + 1}: slipped=${v.verdict} — ${v.reason}`);
    }
    const slipRate = slips / SAMPLES;

    // Arm (b): NO key → expect the writer NOT to seize the PC's decisions.
    let seizes = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const prose = await narrate(keylessSettei);
      const v = await judge(Q_SEIZE, prose);
      if (v.verdict) seizes += 1;
      details.push(`arm b (no key) sample ${i + 1}: seized=${v.verdict} — ${v.reason}`);
    }
    const seizeRate = seizes / SAMPLES;

    details.push(
      `means: arm a slip-rate ${slipRate.toFixed(2)} (want ≥0.5); arm b seize-rate ${seizeRate.toFixed(2)} (want ≤0.5)`,
    );

    // Directional gate, tolerant of single-sample variance (mean-of-2):
    // the key must fire at least once, and the keyless arm must not seize the
    // majority of the time. Borderline cases surface in details, not as noise.
    if (slipRate < 0.5) {
      failures.push(
        `arm a: the key never opened a loss of control (slip-rate ${slipRate.toFixed(2)})`,
      );
    }
    if (seizeRate > 0.5) {
      failures.push(
        `arm b: keyless narration seized the player character's decisions (seize-rate ${seizeRate.toFixed(2)})`,
      );
    }

    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details,
      failures,
    };
  },
};
