import { getDb } from "@/lib/db";
import { campaigns, modelCalls, players } from "@/lib/db/schema";
import { identityKey, isProtagonistName } from "@/lib/entity-identity";
import {
  type DossierEntity,
  EXTRACTOR_SYSTEM,
  IngestionExtraction,
  buildExtractorPrompt,
} from "@/lib/ingestion/ingest";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import {
  IN_CHARACTER_FEELINGS,
  MARKED_UNTRUE_ASSERTION,
  RED_SASH_ASSERTION,
  bebopContract,
} from "@/lib/renderer/__tests__/fixtures";
import { INTENT_SYSTEM, buildIntentPrompt, intentWorldFrame } from "@/lib/turn/layout";
import { PremiseContract } from "@/lib/types/premise";
import { IntentOutput } from "@/lib/types/turn";
import { eq, sql } from "drizzle-orm";
import type { Suite, SuiteResult } from "../types";

/**
 * §5.4 C2 acceptance — the battle scream, LIVE. The plumbing tests prove the
 * gate wires and the writes land; only real model calls prove DETECTION
 * quality. This suite drives the REAL intent probe (INTENT_SYSTEM) and the
 * REAL extractor (EXTRACTOR_SYSTEM + the runtime dossier) on Haiku (DEV probe,
 * never Fable), against a fixture dossier with the mother + the monster
 * cataloged.
 *
 * Acceptance:
 *  (a) the scream classifies as COMBAT/ABILITY AND raises contains_world_assertion;
 *  (b) extraction lands the master concept AND resolves "my mother" to the
 *      catalog name (no parallel mother minted);
 *  (c) a plain swing raises NO flag (the gate stays shut → zero facts);
 *  (d) THE RED SASH (M1-soak carry, repaired M3R4 B3): a faction minted inside
 *      QUOTED DIALOGUE reaches the gate and the extractor both. The original
 *      miss is the fixture, verbatim. No fact of that assertion comes back
 *      clarify — checked per fact, so a partial gatekeeper slip fails;
 *  (e) THE EXEMPTIONS (M3R4 B3 audit): the other half of the same clause. An
 *      in-character FEELINGS line and a claim the INPUT itself marks untrue
 *      mint NO world facts. An unmarked bluff is deliberately absent from this
 *      list — see the fixtures for why it is canon, not a miss.
 *
 * ~$0.04/run on Haiku; metered cost is summed from model_calls and printed.
 * `phase: "harness"` on every call: this is a MEASUREMENT, not play — and
 * campaignId is on-delete-set-null, so these rows outlive the throwaway
 * campaign below and would otherwise sit in the global "turn" bucket forever.
 */

const SELECTION = DEV_TIER_SELECTION;

const SCREAM =
  "I WILL NOT LOSE! FOR MY MOTHER! FOR THE CHILDREN THAT DIED! FOR EVERYONE YOUR MASTER KILLED!";
const NEGATIVE = "I grit my teeth and swing again, harder";

// The fixture dossier: the mother is cataloged (a relational reference must
// resolve to her), the monster is cataloged (the new master hangs off it).
const DOSSIER: DossierEntity[] = [
  {
    name: "The Protagonist's Mother",
    entityType: "npc",
    block: "Slain in the massacre that razed the protagonist's village; he fights to avenge her.",
    turnId: 0,
  },
  {
    name: "The Gaunt Warden",
    entityType: "npc",
    block: "The towering monster the crew is battling right now.",
    turnId: 4,
  },
];
const MOTHER_KEY = identityKey("The Protagonist's Mother");

/** One probe call with a single call-error retry (verdict noise, not call flakiness). */
async function probe<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch(fn);
}

export const authorshipDetection: Suite = {
  name: "authorship-detection",
  gate: "M2 C2 (§5.4 authorship — the battle scream)",
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

    // Throwaway campaign so the traced calls' campaignId FK holds and the meter
    // rows are summable. Campaign deletes first, then player (players FK has no cascade); model_calls
    // rows survive with campaignId set null — so we sum BEFORE cleanup.
    const db = getDb();
    const playerId = `eval_authorship_${crypto.randomUUID()}`;
    await db.insert(players).values({ id: playerId, email: `${playerId}@example.com` });
    const [campaign] = await db
      .insert(campaigns)
      .values({
        playerId,
        title: "Authorship eval",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SELECTION,
      })
      .returning({ id: campaigns.id });
    const campaignId = campaign?.id;
    if (!campaignId) throw new Error("authorship eval: campaign insert failed");

    try {
      // The production prompt shape (2026-08-03): every intent probe carries
      // the contract's world frame — this suite assembles through the real
      // builder, never a drifting copy.
      const worldFrame = intentWorldFrame(PremiseContract.parse(bebopContract()));
      // (a) the scream through the REAL intent probe.
      const intent = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_authorship_intent",
          schema: IntentOutput,
          campaignId,
          turnNumber: 1,
          phase: "harness",
          system: INTENT_SYSTEM,
          prompt: buildIntentPrompt({ worldFrame, playerInput: SCREAM }),
          maxTokens: 1_500,
        }),
      );
      details.push(
        `scream intent: ${intent.intent} (epicness ${intent.epicness.toFixed(2)}), flag=${intent.contains_world_assertion}`,
      );
      const intentOk = intent.intent === "COMBAT" || intent.intent === "ABILITY";
      if (!intentOk) failures.push(`scream intent ${intent.intent} — expected COMBAT or ABILITY`);
      if (!intent.contains_world_assertion) {
        failures.push("scream did NOT raise contains_world_assertion — the gate never opens");
      }

      // (b) the scream through the REAL extractor with the fixture dossier.
      const extraction = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_authorship_extract",
          schema: IngestionExtraction,
          campaignId,
          turnNumber: 1,
          phase: "harness",
          system: EXTRACTOR_SYSTEM,
          prompt: buildExtractorPrompt({
            criticalFacts: [],
            entityRows: DOSSIER,
            arcLine: "The Reckoning — will he avenge the fallen?",
            turnNumber: 1,
            text: SCREAM,
          }),
          maxTokens: 2_000,
        }),
      );
      const facts = extraction.facts;
      details.push(
        `extraction (${facts.length} facts): ${facts.map((f) => `${f.entity_name ?? "—"}${f.related_to_entity ? ` →${f.related_to_entity}` : ""}`).join(" | ")}`,
      );

      // ≥1 fact lands the master concept (content OR entity_name mentions master).
      const masterHit = facts.some(
        (f) => /master/i.test(f.content) || /master/i.test(f.entity_name ?? ""),
      );
      if (!masterHit)
        failures.push("extraction did not land the master concept (new canon missed)");

      // The relational reference RESOLVES, and never forks. Both halves are
      // required: a fact must CARRY the exact catalog name, and no fact may
      // carry a rival mother name. The presence check is not optional — until
      // M3R4 this read "if a mother name is present it must match", so an
      // extraction with NO entity_names at all passed vacuously, and that is
      // precisely how an extractor over-suppression hides (the scream's
      // third-party reference silently stops resolving and the suite still
      // reports green).
      const resolvedMother = facts.find((f) => {
        const n = f.entity_name?.trim();
        return !!n && identityKey(n) === MOTHER_KEY;
      });
      const parallelMother = facts.find((f) => {
        const n = f.entity_name?.trim();
        return n && /mother/i.test(n) && identityKey(n) !== MOTHER_KEY;
      });
      if (parallelMother) {
        failures.push(
          `extraction minted a PARALLEL mother "${parallelMother.entity_name}" — should resolve to "The Protagonist's Mother"`,
        );
      } else if (!resolvedMother) {
        failures.push(
          'the scream\'s "FOR MY MOTHER" resolved to NO entity — expected a fact carrying the catalog name "The Protagonist\'s Mother". A third party named in expressive speech must still resolve; extracting nothing is a loss, not a clean pass',
        );
      } else {
        details.push(
          `mother reference resolved to the catalog name ("${resolvedMother.entity_name}", no parallel mint) ✓`,
        );
      }
      // A newly-minted entity that is a self-insert placeholder would be a
      // regression too (the protagonist is not re-minted by an assertion).
      if (facts.some((f) => f.entity_name && isProtagonistName(f.entity_name))) {
        failures.push("extraction minted a protagonist placeholder from the scream");
      }

      // (c) NEGATIVE: a plain swing raises no flag → gate shut → zero facts.
      const neg = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_authorship_negative",
          schema: IntentOutput,
          campaignId,
          turnNumber: 2,
          phase: "harness",
          system: INTENT_SYSTEM,
          prompt: buildIntentPrompt({ worldFrame, playerInput: NEGATIVE }),
          maxTokens: 1_500,
        }),
      );
      details.push(`negative "${NEGATIVE}": flag=${neg.contains_world_assertion}`);
      if (neg.contains_world_assertion) {
        failures.push("negative case raised contains_world_assertion — the flag over-fires");
      } else {
        details.push("negative: flag false → gate shut, zero facts extracted ✓");
      }

      // (d) THE RED SASH: the soak's beat 5, verbatim. A world claim spoken in
      // character, in quotation marks, with an action wrapped around it.
      const sashIntent = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_red_sash_intent",
          schema: IntentOutput,
          campaignId,
          turnNumber: 3,
          phase: "harness",
          system: INTENT_SYSTEM,
          prompt: buildIntentPrompt({ worldFrame, playerInput: RED_SASH_ASSERTION }),
          maxTokens: 1_500,
        }),
      );
      const sashGateOpen =
        sashIntent.intent === "WORLD_BUILDING" || sashIntent.contains_world_assertion;
      details.push(
        `red sash intent: ${sashIntent.intent}, flag=${sashIntent.contains_world_assertion}`,
      );
      if (!sashGateOpen) {
        failures.push(
          "the Red Sash line opened NO ingestion gate — dialogue-embedded authorship invisible again",
        );
      }

      const sashExtraction = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_red_sash_extract",
          schema: IngestionExtraction,
          campaignId,
          turnNumber: 3,
          phase: "harness",
          system: EXTRACTOR_SYSTEM,
          // A bare campaign: the Red Sash is NEW canon, exactly as at soak turn 5.
          prompt: buildExtractorPrompt({
            criticalFacts: [],
            entityRows: [],
            turnNumber: 5,
            text: RED_SASH_ASSERTION,
          }),
          maxTokens: 2_000,
        }),
      );
      const sashFacts = sashExtraction.facts;
      details.push(
        `red sash extraction (${sashFacts.length} facts): ${sashFacts.map((f) => `${f.kind}:${f.entity_name ?? "—"}`).join(" | ")}`,
      );
      const sashHit = sashFacts.some(
        (f) => /red sash/i.test(f.content) || /red sash/i.test(f.entity_name ?? ""),
      );
      if (!sashHit) {
        failures.push(
          "extraction missed the Red Sash — the quoted-dialogue claim never became a world fact (the M1-soak miss)",
        );
      }
      // Nothing may be clarified away: the player asserted, they did not ask.
      // PER-FACT, not all-or-nothing (M3R4 B3 audit): the `every` form passed a
      // partial slip silently — the faction accepted, the piers clarified — and
      // one clarified fact from an input holding no local physical ambiguity is
      // already the gatekeeper posture the doctrine forbids.
      const clarifiedSash = sashFacts.filter((f) => f.posture === "clarify");
      if (clarifiedSash.length > 0) {
        failures.push(
          `${clarifiedSash.length}/${sashFacts.length} Red Sash facts came back clarify ("${clarifiedSash[0]?.content}") — the editor posture turned gatekeeper on a plain assertion`,
        );
      }

      // (e) THE EXEMPTIONS. The clause's positive half is pinned above and in
      // the deterministic suite; its negative half — feelings/plans/questions,
      // and a claim the INPUT marks untrue — had no coverage anywhere. An
      // over-firing extractor mints canon from a character's fear or from a lie
      // the player explicitly retracts in the same breath.
      const feelings = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_feelings_extract",
          schema: IngestionExtraction,
          campaignId,
          turnNumber: 4,
          phase: "harness",
          system: EXTRACTOR_SYSTEM,
          prompt: buildExtractorPrompt({
            criticalFacts: [],
            entityRows: DOSSIER,
            turnNumber: 4,
            text: IN_CHARACTER_FEELINGS,
          }),
          maxTokens: 2_000,
        }),
      );
      details.push(
        `feelings exemption (${feelings.facts.length} facts): ${feelings.facts.map((f) => `${f.kind}:${f.entity_name ?? "—"}`).join(" | ") || "none"}`,
      );
      // The speaker's own interior is not a world claim: nothing may enter the
      // CATALOG, and no world-shaped fact may be minted from it. (A bare
      // cast_fact naming no entity is the speaker describing themselves — the
      // one tolerated read.)
      const WORLD_KINDS = new Set(["world_fact", "faction", "location", "thread", "backstory"]);
      const feelingsMinted = feelings.facts.filter(
        (f) => (f.entity_name ?? "").trim().length > 0 || WORLD_KINDS.has(f.kind),
      );
      if (feelingsMinted.length > 0) {
        failures.push(
          `a feelings-only line minted ${feelingsMinted.length} world fact(s) (${feelingsMinted.map((f) => `${f.kind}:${f.entity_name ?? "—"}`).join(", ")}) — the exemption for the speaker's own feelings is not holding`,
        );
      } else {
        details.push("feelings line minted no world facts ✓");
      }

      const bluff = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_marked_untrue_extract",
          schema: IngestionExtraction,
          campaignId,
          turnNumber: 5,
          phase: "harness",
          system: EXTRACTOR_SYSTEM,
          prompt: buildExtractorPrompt({
            criticalFacts: [],
            entityRows: [],
            turnNumber: 5,
            text: MARKED_UNTRUE_ASSERTION,
          }),
          maxTokens: 2_000,
        }),
      );
      details.push(
        `marked-untrue exemption (${bluff.facts.length} facts): ${bluff.facts.map((f) => `${f.kind}:${f.entity_name ?? "—"}`).join(" | ") || "none"}`,
      );
      // The Iron Choir must not reach the catalog: no entity may carry its
      // name, and no faction may be minted at all. (A fact RECORDING the bluff
      // — the protagonist lied to the fixer — is honest and allowed; what is
      // forbidden is the invented faction becoming a row.)
      const choirMinted = bluff.facts.filter(
        (f) => /iron choir/i.test(f.entity_name ?? "") || f.kind === "faction",
      );
      if (choirMinted.length > 0) {
        failures.push(
          `the retracted lie minted canon (${choirMinted.map((f) => `${f.kind}:${f.entity_name ?? "—"}`).join(", ")}) — an input-marked-untrue claim became a world fact`,
        );
      } else {
        details.push("input-marked-untrue claim minted no catalog entity ✓");
      }
    } finally {
      // Sum the metered cost of this run's calls before cleanup.
      const [{ total } = { total: "0" }] = await getDb()
        .select({ total: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)` })
        .from(modelCalls)
        .where(eq(modelCalls.campaignId, campaignId));
      const cost = Number(total);
      details.push(`metered cost: $${cost.toFixed(4)} (${SELECTION.probe})`);
      console.log(`[authorship-detection] metered cost: $${cost.toFixed(4)}`);
      // Campaign first (its players FK has no cascade); model_calls survive with
      // campaignId set null (already summed above).
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
