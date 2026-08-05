import { CompactBeats, EpochSummary } from "@/lib/blocks/compaction";
import { ArcTransitionCheck, DistillOutput, SeedMentionCheck } from "@/lib/compositor/g2";
import { getDb } from "@/lib/db";
import { campaigns, modelCalls, players } from "@/lib/db/schema";
import { StartupPlan } from "@/lib/direction/director";
import { PairVerdict } from "@/lib/entity/janitor";
import { IngestionExtraction, RevisedBlock } from "@/lib/ingestion/ingest";
import { callJudgment, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { GroundingVerdicts, NarrativeSynthesis, VoiceCards } from "@/lib/research/synthesize";
import { WebIdentity } from "@/lib/research/websearch";
import { ScrapePlan } from "@/lib/research/wiki";
import { ScoreSheet } from "@/lib/sakkan/score";
import { VoiceChecklistSheet } from "@/lib/sakkan/voice";
import {
  OriginalTreatmentDraft,
  OriginalWorldDraft,
  OspDraft,
  VoiceTransposition,
} from "@/lib/sz/compiler";
import { ValidationOutput } from "@/lib/turn/outcome";
import { RankOutput } from "@/lib/turn/retrieval";
import { ScaleJudgment } from "@/lib/turn/scale";
import { KA_TOOLS } from "@/lib/turn/tools";
import { BoothResolution, BoothRoute, OverrideComprehension } from "@/lib/types/booth";
import {
  AttributionResult,
  DirectorEmitOps,
  DirectorEmitPlan,
  PacerDirective,
  SeedAdjudication,
} from "@/lib/types/direction";
import { PowerSystem, StatMapping } from "@/lib/types/profile";
import { CommitScene } from "@/lib/types/sidecar";
import { IntentOutput, OutcomeOutput } from "@/lib/types/turn";
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Suite, SuiteResult } from "../types";

/**
 * The grammar canary (M3R2 C1). The structured-output grammar compiles
 * SERVER-SIDE and the cliff is MODEL-DEPENDENT: Haiku compiled the full
 * DirectorOutput that Sonnet 5 rejected with 400 "the compiled grammar is too
 * large" — so every DEV-tier test passed while the live Sonnet-judgment
 * campaign burned 37 dead Director cycles and lost its whole §7 layer for a
 * day of play. Local Zod never compiles a grammar; ONLY a live call catches
 * this class.
 *
 * Sweep: every production structured schema (turn engine, direction, sakkan,
 * booth, ingestion, compositor, SZ, research, suggestions) at the TIGHTEST
 * menu compiler (Sonnet 5); the two largest grammars (the Director's halves)
 * at Opus 5 as well; and commit_scene in its PRODUCTION SHAPE — a strict
 * TOOL on the narration tier (review: an output-format probe alone guards
 * the trailer-fallback path, not the tool grammar the KA compiles every
 * turn) — at both non-Fable narration models.
 *
 * Verdict semantics are THREE-way (review: a canary that greens on a
 * transport error is the vacuous-green failure the harness roll-up exists to
 * prevent):
 *   - grammar rejection      → FAIL
 *   - compiled (success, or parse/truncation noise at the probe budget) → PASS
 *   - anything else (auth, rate limit, overload, network) → UNPROVEN = FAIL
 *     (the suite must never read green on evidence it did not collect).
 *
 * ~$0.15/run; metered cost summed and printed.
 */

const SONNET: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-sonnet-5",
  probe: "claude-sonnet-5",
};
const OPUS: TierSelection = {
  narration: "claude-opus-5",
  judgment: "claude-opus-5",
  probe: "claude-sonnet-5",
};

// biome-ignore lint/suspicious/noExplicitAny: a canary sweeps heterogeneous schemas
const LIVE_PLAY_SCHEMAS: Array<{ name: string; schema: z.ZodType<any> }> = [
  // Turn engine
  { name: "IntentOutput", schema: IntentOutput },
  { name: "OutcomeOutput", schema: OutcomeOutput },
  { name: "ValidationOutput", schema: ValidationOutput },
  { name: "PacerDirective", schema: PacerDirective },
  { name: "ScaleJudgment", schema: ScaleJudgment },
  { name: "RankOutput", schema: RankOutput },
  // The trailer's PROBE-fallback path emits CommitScene as an output format
  // at the probe tier (M3 C1 ladder) — this probes that shape; the KA's
  // strict-TOOL shape is probed separately below.
  { name: "CommitScene (probe fallback)", schema: CommitScene },
  // Ingestion + compositor
  { name: "IngestionExtraction", schema: IngestionExtraction },
  { name: "RevisedBlock", schema: RevisedBlock },
  { name: "DistillOutput", schema: DistillOutput },
  { name: "ArcTransitionCheck", schema: ArcTransitionCheck },
  { name: "SeedMentionCheck", schema: SeedMentionCheck },
  { name: "CompactBeats", schema: CompactBeats },
  { name: "EpochSummary", schema: EpochSummary },
  // Direction
  { name: "DirectorEmitPlan", schema: DirectorEmitPlan },
  { name: "DirectorEmitOps", schema: DirectorEmitOps },
  { name: "StartupPlan", schema: StartupPlan },
  { name: "SeedAdjudication", schema: SeedAdjudication },
  // Sakkan + janitor
  { name: "AttributionResult", schema: AttributionResult },
  { name: "ScoreSheet", schema: ScoreSheet },
  { name: "VoiceChecklistSheet", schema: VoiceChecklistSheet },
  { name: "PairVerdict", schema: PairVerdict },
  // Booth + override channel
  { name: "BoothRoute", schema: BoothRoute },
  { name: "BoothResolution", schema: BoothResolution },
  { name: "OverrideComprehension", schema: OverrideComprehension },
  // SZ + research (player-facing at SZ time; judgment/probe tiers)
  { name: "OspDraft", schema: OspDraft },
  { name: "NarrativeSynthesis", schema: NarrativeSynthesis },
  { name: "VoiceCards", schema: VoiceCards },
  { name: "ScrapePlan", schema: ScrapePlan },
  { name: "PowerSystem", schema: PowerSystem },
  { name: "StatMapping", schema: StatMapping },
  // M3R3: the research desk's C2/C3 additions + C4a's transposition. Small
  // grammars belong in the sweep too — the discipline is EVERY production
  // schema, because the cliff's location is model-dependent and unknowable
  // from local Zod (the Director 400 shipped through exactly this gap).
  { name: "WebIdentity", schema: WebIdentity },
  { name: "GroundingVerdicts", schema: GroundingVerdicts },
  { name: "VoiceTransposition", schema: VoiceTransposition },
  // C4b's true-original path. OriginalTreatmentDraft is the largest grammar SZ
  // compiles (24 numeric axes + 13 enums in one object) — the split that keeps
  // it off the cliff is the split from the world call, and only a live compile
  // can prove the remaining half fits.
  { name: "OriginalTreatmentDraft", schema: OriginalTreatmentDraft },
  { name: "OriginalWorldDraft", schema: OriginalWorldDraft },
];

/** 400s whose message names the grammar/schema — the canary's one true FAIL. */
const GRAMMAR_REJECTION =
  /compiled grammar|too large.*grammar|grammar.*too large|reduce the number of strict tools|optional parameters|simplify your tool schemas/i;
/** Transport/quota failures — evidence NOT collected; must not read green. */
const UNPROVEN =
  /401|403|429|5\d{2}|overloaded|rate.?limit|api.?key|ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|network/i;

type Verdict = "pass" | "fail" | "unproven";

function classify(msg: string): Verdict {
  if (GRAMMAR_REJECTION.test(msg)) return "fail";
  if (UNPROVEN.test(msg)) return "unproven";
  // Anything else at the tiny probe budget (zod parse noise, truncation)
  // means the grammar COMPILED — which is all the canary asserts.
  return "pass";
}

export const schemaGrammar: Suite = {
  name: "schema-grammar",
  gate: "M3R2 C1 (the grammar cliff is model-dependent — live compile or bust)",
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
    const playerId = `eval_grammar_${crypto.randomUUID()}`;
    await db.insert(players).values({ id: playerId, email: `${playerId}@example.com` });
    const [campaign] = await db
      .insert(campaigns)
      .values({
        playerId,
        title: "Grammar canary",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SONNET,
      })
      .returning({ id: campaigns.id });
    const campaignId = campaign?.id;
    if (!campaignId) throw new Error("schema-grammar eval: campaign insert failed");

    const record = (name: string, tag: string, verdict: Verdict, msg?: string) => {
      if (verdict === "pass") details.push(`✓ ${name} @ ${tag} — compiled`);
      else if (verdict === "fail")
        failures.push(`${name} @ ${tag}: GRAMMAR REJECTED — ${(msg ?? "").slice(0, 140)}`);
      else
        failures.push(
          `${name} @ ${tag}: UNPROVEN (transport, evidence not collected) — ${(msg ?? "").slice(0, 120)}`,
        );
    };

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous sweep
    async function probe(name: string, schema: z.ZodType<any>, sel: TierSelection, tag: string) {
      try {
        await callJudgment(sel, {
          name: "eval_grammar_canary",
          schema,
          campaignId: campaignId as string,
          turnNumber: 1,
          maxTokens: 700,
          system: "Grammar canary. Emit a minimal valid object; empty arrays, empty strings.",
          prompt: "Emit the minimal object.",
        });
        record(name, tag, "pass");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        record(name, tag, classify(msg), msg);
      }
    }

    /** commit_scene in its production shape: a strict TOOL on narration. */
    async function probeKaTools(sel: TierSelection, tag: string) {
      try {
        const run = streamNarration({
          name: "eval_grammar_canary_tools",
          selection: sel,
          system: [{ type: "text", text: "Grammar canary." }],
          messages: [{ role: "user", content: "Say: ok. Do not use any tool." }],
          maxTokens: 64,
          tools: KA_TOOLS,
          campaignId: campaignId as string,
          turnNumber: 1,
        });
        await run.done();
        record("KA_TOOLS (strict tool shape)", tag, "pass");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        record("KA_TOOLS (strict tool shape)", tag, classify(msg), msg);
      }
    }

    try {
      for (const { name, schema } of LIVE_PLAY_SCHEMAS) {
        await probe(name, schema, SONNET, "sonnet-5");
      }
      // The two largest live grammars also sweep the top judgment tier.
      await probe("DirectorEmitPlan", DirectorEmitPlan, OPUS, "opus-5");
      await probe("DirectorEmitOps", DirectorEmitOps, OPUS, "opus-5");
      // The KA's tool grammar at both non-Fable narration models (never Fable
      // in automated runs).
      await probeKaTools(SONNET, "narration sonnet-5");
      await probeKaTools(OPUS, "narration opus-5");
    } finally {
      const [{ total } = { total: "0" }] = await getDb()
        .select({ total: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)` })
        .from(modelCalls)
        .where(eq(modelCalls.campaignId, campaignId));
      details.push(`metered cost: $${Number(total).toFixed(4)}`);
      console.log(`[schema-grammar] metered cost: $${Number(total).toFixed(4)}`);
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
