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
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { INTENT_SYSTEM } from "@/lib/turn/layout";
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
 *  (c) a plain swing raises NO flag (the gate stays shut → zero facts).
 *
 * ~$0.02/run on Haiku; metered cost is summed from model_calls and printed.
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

    // Throwaway campaign so the traced trio's campaignId FK holds and the meter
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
      // (a) the scream through the REAL intent probe.
      const intent = await probe(() =>
        callProbe(SELECTION, {
          name: "eval_authorship_intent",
          schema: IntentOutput,
          campaignId,
          turnNumber: 1,
          system: INTENT_SYSTEM,
          prompt: `PLAYER INPUT: ${SCREAM}`,
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

      // No fact mints a NEW mother: any mother-named entity_name must be the
      // catalog name (a relational reference resolves, never forks).
      const parallelMother = facts.find((f) => {
        const n = f.entity_name?.trim();
        return n && /mother/i.test(n) && identityKey(n) !== MOTHER_KEY;
      });
      if (parallelMother) {
        failures.push(
          `extraction minted a PARALLEL mother "${parallelMother.entity_name}" — should resolve to "The Protagonist's Mother"`,
        );
      } else {
        details.push("mother reference resolved to the catalog name (no parallel mint) ✓");
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
          system: INTENT_SYSTEM,
          prompt: `PLAYER INPUT: ${NEGATIVE}`,
          maxTokens: 1_500,
        }),
      );
      details.push(`negative "${NEGATIVE}": flag=${neg.contains_world_assertion}`);
      if (neg.contains_world_assertion) {
        failures.push("negative case raised contains_world_assertion — the flag over-fires");
      } else {
        details.push("negative: flag false → gate shut, zero facts extracted ✓");
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
