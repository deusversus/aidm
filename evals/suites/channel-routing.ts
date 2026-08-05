import { comprehendOverride } from "@/lib/booth/booth";
import { getDb } from "@/lib/db";
import { campaigns, modelCalls, players } from "@/lib/db/schema";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { INTENT_SYSTEM, buildIntentPrompt, intentWorldFrame } from "@/lib/turn/layout";
import { PremiseContract } from "@/lib/types/premise";
import { IntentOutput } from "@/lib/types/turn";
import { eq, sql } from "drizzle-orm";
import type { Suite, SuiteResult } from "../types";

/**
 * §5.4 channel routing — the eaten-reply regression (2026-08-03), LIVE.
 * The channel decision is destructive in both directions: a story action
 * misread as OVERRIDE_COMMAND eats the scene and mints the raw text as a
 * standing rule injected every turn; a real override misread as
 * META_FEEDBACK lands in the booth as chat and binds nothing. Both
 * misroutes happened (the first live on 2026-08-03, the second surfaced by
 * this suite's own A/B battery), so both directions are pinned here against
 * the REAL INTENT_SYSTEM on Haiku (DEV probe, never Fable).
 *
 * The doctrine under test is a PRINCIPLE — addressee (into the fiction vs
 * at the studio) and persistence (across scenes vs this beat) — not keyword
 * matching (user ruling 2026-08-03: no minutia funnels). The cases probe the
 * principle's edges: imperative mood inside the fiction, rule-adjacent scene
 * diction, mixed action+commentary, and real overrides WITHOUT the word
 * "override". Story cases carry the production call shape (scene tail for
 * mid-campaign turns); the probe never classifies context-free in play.
 *
 * ~$0.01/run on Haiku; metered cost summed from model_calls and printed.
 */

const CHANNELS = new Set(["META_FEEDBACK", "OVERRIDE_COMMAND", "OP_COMMAND"]);

/** The live specimen, verbatim (Deus Versus: Unfettered, turn 2): an in-scene
 *  action followed by class-balance lore — eaten as a standing rule. */
const SPECIMEN =
  "Refuse the appeal flatly and let the entry stand. Play the part. A naive boy that didn’t know what he was doing. A poor soul which will experience today’s pity turn into tomorrows ridicule and oppression. Black Mage is a great class, but all the tenants of why this world shunned it are true. It IS weak early on. Low dmg, low hp, low speed. Now isn’t the time to correct them; now is the time to start planning my build and leveling strategy. My sole intent is to leave the ceremony unceremoniously; so that the real work can begin";

/** The specimen's REAL previous-scene tail (turn 1, last 600 chars) — the
 *  byte shape production served the probe when it misrouted (raw; the
 *  assembler adds the PREVIOUS SCENE prefix). */
const SPECIMEN_TAIL =
  'raining debt, but you\'d be alive at the end of them." The stylus paused. "Say nothing and it\'s entered. Entered is forever."\n\nFour hundred people held one breath. Luce\'s hand found Deus\'s sleeve.\n\nAnd Deus Versus looked out at the plaza — at the banners, at the Valdren colors, at every face doing that same funeral arithmetic — with the expression of a man who has just been handed a broken clock at a party and is trying to decide, politely, whether to explain to the host exactly which gear is in backwards.\n\n"May I use the Font?" he asked the curate. "Not to choose again. To show you something."';

const LEDGER_TAIL =
  'The magistrate\'s clerk slides the ledger across the desk, quill hovering. "The record will show you struck first, unless someone appeals it. Your friend already offered to testify on your behalf. Shall I amend the entry?"';

const PARLOR_TAIL =
  "The rain hasn't let up. She stands at the parlor door with no umbrella, looking at the downpour like it owes her money.";

/** Per-case world frames, built inside run() by the REAL frame builder on
 *  fixture contracts (import-time parse would kill the whole harness on
 *  fixture drift — delta-audit NIT). The specimen's world is LitRPG-shaped
 *  with CANONICAL STATS — the diegetic-stats clause keys on
 *  stat_mapping.has_canonical_stats, so Bebop's "mundane combat" frame names
 *  its power system WITHOUT the clause (the contrast under test; build-talk
 *  in Bebop is meta). KNOWN LIMIT, measured 2026-08-03: under a HOLLOW frame
 *  (the incident campaign's real contract at the time — no power system,
 *  has_canonical_stats false) the specimen misroutes 4/5 — the frame is only
 *  as true as the contract behind it, so this suite pins the shapes a
 *  properly-compiled contract emits, and hollow contracts are an SZ
 *  world-extraction defect, not a routing one. */
function buildFrames() {
  const mundane = intentWorldFrame(PremiseContract.parse(bebopContract()));
  const c = PremiseContract.parse(bebopContract());
  c.active.world.world_setting.genre = ["LitRPG", "high fantasy"];
  c.active.world.power_system = {
    name: "the Class System",
    mechanics:
      "Everyone receives a class at the Font; stats, levels, and builds are visible truths of the world.",
    limitations: "A class is once-in-a-lifetime; shunned classes carry social cost.",
    tiers: [],
  };
  c.active.world.stat_mapping.has_canonical_stats = true;
  return { mundane, litrpg: intentWorldFrame(c) };
}

type Case = {
  id: string;
  input: string;
  /** "story" = any non-channel intent is correct. */
  want: "story" | "OVERRIDE_COMMAND" | "OP_COMMAND" | "META_FEEDBACK";
  /** Every case carries a world frame (production always sends one). */
  frame: "mundane" | "litrpg";
  /** Production shape: mid-campaign turns always carry the scene tail. */
  tail?: string;
  wantAssertionFlag?: boolean;
  /** Majority-of-N verdict for boundary anchors (default 1). */
  reps?: number;
  /** ADVISORY: measured and always printed, never a failure. The specimen —
   *  the hardest real input in the corpus — is ~70-75% story at Haiku under
   *  the right frame (pooled reps, 2026-08-03; ~0% in production the night it
   *  was eaten). A gate red on residual model noise trains ignoring, so the
   *  eight stable cases carry the hard pin and this line carries the trend;
   *  the destructive TAIL is the override channel's comprehension floor's to
   *  close, not this probe's. */
  advisory?: boolean;
};

const CASES: Case[] = [
  {
    id: "specimen (mixed action+lore)",
    input: SPECIMEN,
    want: "story",
    frame: "litrpg",
    tail: SPECIMEN_TAIL,
    wantAssertionFlag: true,
    reps: 3,
    advisory: true,
  },
  {
    id: "pure imperative direction",
    input: "Refuse the appeal flatly and let the entry stand. Play the part.",
    want: "story",
    frame: "litrpg",
    tail: SPECIMEN_TAIL,
    // Action + manner, zero lore: the mixed-text doctrine must not leak
    // opinion/plans into the assertion flag (the doctrine-contradiction
    // finding — over-flagging runs ingestion at confidence 1).
    wantAssertionFlag: false,
    // Majority-of-3 (2026-08-05 flake forensics): this is the corpus's
    // hardest family on the specimen's truncated head, and a single Haiku
    // sample under a hard pin red-flagged a boundary that 3/3 re-runs and a
    // byte-compare of everything the probe reads proved never moved. Same
    // pin, same doctrine — a coin flip just isn't a measurement (~+$0.004).
    reps: 3,
  },
  {
    id: "rule-diction trap (in context)",
    input: "Let the record stand as written, and tell the clerk nothing.",
    want: "story",
    frame: "mundane",
    tail: LEDGER_TAIL,
  },
  {
    id: "'always' inside the fiction",
    input: "Always the gentleman, I bow and offer her my coat before we step into the rain.",
    want: "story",
    frame: "mundane",
    tail: PARLOR_TAIL,
    wantAssertionFlag: false,
  },
  {
    id: "canonical override",
    input: "override: never harm the dog",
    want: "OVERRIDE_COMMAND",
    frame: "mundane",
  },
  {
    id: "real override, no keyword",
    input: "From now on, keep combat scenes short and don't ever describe gore in detail.",
    want: "OVERRIDE_COMMAND",
    frame: "mundane",
  },
  {
    id: "narrator rule, no markers",
    input: "New rule for you as narrator: my character's dreams are always prophetic.",
    want: "OVERRIDE_COMMAND",
    frame: "mundane",
  },
  {
    // The LitRPG frame must not swallow REAL meta about game mechanics — the
    // frame grounds the character's own speech, not a request to the studio.
    id: "mechanical cheat (LitRPG frame)",
    input: "Set my HP back to full and give me 500 gold.",
    want: "OP_COMMAND",
    frame: "litrpg",
  },
  {
    id: "pacing feedback",
    input: "Hey, this scene is dragging — can we pick up the pace a little?",
    want: "META_FEEDBACK",
    frame: "mundane",
  },
];

/** One probe call with a single call-error retry (call flakiness, not verdict noise). */
async function probe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch(fn);
}

export const channelRouting: Suite = {
  name: "channel-routing",
  gate: "§5.4 channels (the eaten-reply regression, 2026-08-03)",
  requiresLlm: true,
  async run(): Promise<SuiteResult> {
    const details: string[] = [];
    const failures: string[] = [];

    if (!process.env.DATABASE_URL) {
      return {
        name: this.name,
        gate: this.gate,
        status: "skipped",
        details: ["DATABASE_URL not set"],
        failures: [],
      };
    }

    const db = getDb();
    const playerId = `eval_channels_${crypto.randomUUID()}`;
    await db.insert(players).values({ id: playerId, email: `${playerId}@example.com` });
    const [campaign] = await db
      .insert(campaigns)
      .values({
        playerId,
        title: "Channel routing eval",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: DEV_TIER_SELECTION,
      })
      .returning({ id: campaigns.id });
    const campaignId = campaign?.id;
    if (!campaignId) throw new Error("channel-routing eval: campaign insert failed");

    try {
      const frames = buildFrames();
      for (const [i, cs] of CASES.entries()) {
        const reps = cs.reps ?? 1;
        const votes: IntentOutput[] = [];
        for (let r = 0; r < reps; r++) {
          votes.push(
            await probe(() =>
              callProbe(DEV_TIER_SELECTION, {
                name: "eval_channel_routing",
                schema: IntentOutput,
                campaignId,
                turnNumber: i + 1,
                system: INTENT_SYSTEM,
                prompt: buildIntentPrompt({
                  worldFrame: frames[cs.frame],
                  sceneTail: cs.tail,
                  playerInput: cs.input,
                }),
                maxTokens: 1_500,
              }),
            ),
          );
        }
        const hits = votes.filter((v) =>
          cs.want === "story" ? !CHANNELS.has(v.intent) : v.intent === cs.want,
        ).length;
        const ok = hits * 2 > reps;
        const intent = {
          intent: votes.map((v) => v.intent).join("/"),
          contains_world_assertion:
            votes.filter((v) => v.contains_world_assertion).length * 2 > reps,
        };
        details.push(
          `${ok ? "✓" : cs.advisory ? "ADVISORY MISS" : "✗"} ${cs.id} → ${intent.intent}${cs.wantAssertionFlag !== undefined ? ` flag=${intent.contains_world_assertion}` : ""}`,
        );
        if (!ok && !cs.advisory) {
          failures.push(
            `${cs.id}: got ${intent.intent}, wanted ${cs.want === "story" ? "a story intent (non-channel)" : cs.want}`,
          );
        }
        // Explicit comparison — a truthiness check made flag=false pins
        // structurally inexpressible (review finding), and the false pins are
        // the over-flagging tripwire.
        if (
          !cs.advisory &&
          cs.wantAssertionFlag !== undefined &&
          intent.contains_world_assertion !== cs.wantAssertionFlag
        ) {
          failures.push(
            cs.wantAssertionFlag
              ? `${cs.id}: contains_world_assertion false — the lore rides nothing`
              : `${cs.id}: contains_world_assertion TRUE on a no-lore input — over-flagging runs ingestion at confidence 1`,
          );
        }
      }

      // --- The comprehension FLOOR (M3R1, §7.4): the probe's advisory tail is
      // closed structurally — the mint fires only when this second instrument
      // agrees. Two live pins at the DEV judgment tier: the specimen (the
      // ~25%-misroute input) must BOUNCE, and a real keyword-less override
      // must extract a standing restatement.
      const bounce = await probe(() =>
        comprehendOverride(DEV_TIER_SELECTION, campaignId, 90, SPECIMEN),
      );
      details.push(
        `floor: specimen → contains_standing_rule=${bounce.contains_standing_rule} scope=${bounce.scope}`,
      );
      if (bounce.contains_standing_rule && bounce.scope === "standing") {
        failures.push(
          "floor: the specimen read as a STANDING RULE — the bounce floor would mint the eaten reply",
        );
      }
      const extract = await probe(() =>
        comprehendOverride(
          DEV_TIER_SELECTION,
          campaignId,
          91,
          "From now on, keep combat scenes short and don't ever describe gore in detail.",
        ),
      );
      details.push(
        `floor: real override → contains_standing_rule=${extract.contains_standing_rule} rule="${extract.rule.slice(0, 80)}"`,
      );
      if (!extract.contains_standing_rule || extract.scope !== "standing") {
        failures.push(
          "floor: a real keyword-less override failed to extract — §7.4 compliance lost",
        );
      }
      // The over-bounce direction for CANON-CONTENT rules (M3R1 review): the
      // process-rule pin above doesn't cover a rule about the fiction's own
      // content laid on the studio — the class the when-in-doubt-false
      // default is most tempted to bounce.
      const canonRule = await probe(() =>
        comprehendOverride(
          DEV_TIER_SELECTION,
          campaignId,
          92,
          "New rule for you as narrator: my character's dreams are always prophetic.",
        ),
      );
      details.push(
        `floor: canon-content rule → contains_standing_rule=${canonRule.contains_standing_rule} rule="${canonRule.rule.slice(0, 80)}"`,
      );
      if (!canonRule.contains_standing_rule || !canonRule.rule.trim()) {
        failures.push(
          "floor: a canon-content rule failed to extract — when-in-doubt-false is over-bouncing real law",
        );
      }
      if (extract.contains_standing_rule && !extract.rule.trim()) {
        failures.push(
          "floor: extraction returned an empty rule — the mint would fall back to raw bytes",
        );
      }
    } finally {
      const [{ total } = { total: "0" }] = await getDb()
        .select({ total: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)` })
        .from(modelCalls)
        .where(eq(modelCalls.campaignId, campaignId));
      details.push(`metered cost: $${Number(total).toFixed(4)} (${DEV_TIER_SELECTION.probe})`);
      console.log(`[channel-routing] metered cost: $${Number(total).toFixed(4)}`);
      await getDb().delete(campaigns).where(eq(campaigns.id, campaignId));
      await getDb().delete(players).where(eq(players.id, playerId));
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
