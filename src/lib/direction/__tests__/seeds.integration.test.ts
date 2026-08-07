import * as schema from "@/lib/db/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import {
  DIRECTOR_MAX_INTERVAL,
  DirectorArcPlan,
  DirectorSeedOp,
  ORGANIC_CANDIDATE_THRESHOLD,
  SEED_ADJUDICATION_CAPS,
  SEED_ADJUDICATION_MIN_CONFIDENCE,
  type SeedAdjudication,
  parseCandidates,
} from "@/lib/types/direction";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Arc Model + Seed Ledger (§7.3, §7.6) against real Postgres — the
 * DB-denominated half of C7's direction slice, and M3 C2's two-path detection.
 * NO LIVE MODELS: Voyage is mocked (deterministic vectors, so the 0.55 and 0.7
 * thresholds are exercised exactly) and the batched adjudication's judgment
 * call is scripted. Skipped (loudly) when no DATABASE_URL is configured; the
 * DB-less curve/band math lives in arcs.test.ts and seeds.test.ts.
 */

vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});
vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callJudgment: vi.fn() };
});

import {
  applyArcPlan,
  arcPosition,
  closeEpisode,
  ensureSeriesScaffold,
  getActiveArc,
} from "@/lib/direction/arcs";
import { callJudgment } from "@/lib/llm/calls";
import { embedTexts } from "@/lib/llm/voyage";
import { adjudicateSeeds } from "../adjudication";
import {
  autoResolveSeed,
  callbackReadySeeds,
  overdueSeeds,
  overdueTensionBump,
  plantSeed,
  seedDossier,
  seedsUnderReview,
  settleSeed,
  sweepSeedCandidates,
} from "../seeds";

const mockEmbed = vi.mocked(embedTexts);
const mockJudgment = vi.mocked(callJudgment);

/**
 * A unit vector at `angle` radians in the (0,1) plane of the frozen 1024-dim
 * space. cos(a, b) = cos(angleA − angleB), so a fixture's similarity to any
 * other is exact arithmetic, not a hope about a real embedder.
 */
function unitAt(angle: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    i === 0 ? Math.cos(angle) : i === 1 ? Math.sin(angle) : 0,
  );
}

/**
 * The default vector: a one-hot at a hash of the text, in the dimensions the
 * angle fixtures never touch. Distinct texts are exactly orthogonal, so a
 * suite that does not care about the sweep can never accumulate a candidate by
 * accident — and the same text always embeds the same way (backfill checks).
 */
function unitFromText(text: string): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  const idx = 2 + (h % (EMBEDDING_DIMENSIONS - 2));
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === idx ? 1 : 0));
}

/** Route each embed request through a text→angle table; unknown texts fall back to the one-hot. */
function embedByAngle(angles: Record<string, number>): void {
  mockEmbed.mockImplementation((texts: string[]) =>
    Promise.resolve(
      texts.map((t) => (t in angles ? unitAt(angles[t] as number) : unitFromText(t))),
    ),
  );
}

const url = process.env.DATABASE_URL;
if (!url) console.warn("[direction] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const arcPlan = (over: Partial<DirectorArcPlan> = {}): DirectorArcPlan =>
  DirectorArcPlan.parse({
    name: "An Arc",
    dramatic_question: "Can the past stay buried?",
    shape: "rising",
    budget: { unit: "episodes", target: 3, tolerance: 1 },
    phase: "setup",
    status: "active",
    ...over,
  });

const seedOp = (over: Partial<DirectorSeedOp>): DirectorSeedOp =>
  DirectorSeedOp.parse({ op: "plant", ...over });

describe.skipIf(!url)("Direction: arcs + seeds (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "direction fixture",
        status: "active",
        premiseContract: bebopContract(),
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  const arcsFor = (campaignId: string) =>
    db
      ? db.select().from(schema.arcs).where(eq(schema.arcs.campaignId, campaignId))
      : Promise.reject(new Error("unreachable"));

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "direction@example.com" });
  });

  beforeEach(() => {
    mockEmbed.mockReset();
    mockJudgment.mockReset();
    mockEmbed.mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map((t) => unitFromText(t))),
    );
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      for (const id of campaignIds) {
        await db.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
      }
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  // -------------------------------------------------------------------------
  // Arc Model
  // -------------------------------------------------------------------------

  describe("arc strata", () => {
    it("ensureSeriesScaffold is idempotent — twice yields the same two rows", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const contract = bebopContract();

      const first = await ensureSeriesScaffold(db, campaignId, contract);
      const second = await ensureSeriesScaffold(db, campaignId, contract);
      expect(second).toEqual(first);

      const rows = await arcsFor(campaignId);
      const series = rows.filter((r) => r.stratum === "series");
      const season = rows.filter((r) => r.stratum === "season");
      expect(series).toHaveLength(1);
      expect(season).toHaveLength(1);

      // Series descends the dramatic question from the spark verbatim; shape
      // comes from the premise's Framing arc_shape (Bebop = fragmented).
      expect(series[0]?.dramaticQuestion).toBe(contract.spark);
      expect(series[0]?.shape).toBe("fragmented");
      expect(series[0]?.budget).toEqual({ unit: "episodes", target: 24, tolerance: 12 });
      expect(series[0]?.status).toBe("active");
      expect(series[0]?.turnId).toBe(0);
      expect(series[0]?.provenance).toBe("director");
      expect(series[0]?.confidence).toBeCloseTo(0.9);

      // Season is one cour under the series.
      expect(season[0]?.budget).toEqual({ unit: "episodes", target: 12, tolerance: 4 });
      expect(season[0]?.parentId).toBe(first.seriesId);
    });

    it("applyArcPlan updates in place on name match, succeeds on name change, tracks phaseChanged", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { seasonId } = await ensureSeriesScaffold(db, campaignId, bebopContract());

      // First arc → always a phase change; parented to the season.
      const a1 = await applyArcPlan(
        db,
        campaignId,
        1,
        arcPlan({ name: "The Blue Crow", phase: "setup" }),
      );
      expect(a1.phaseChanged).toBe(true);
      let active = await getActiveArc(db, campaignId);
      expect(active?.name).toBe("The Blue Crow");
      expect(active?.parentId).toBe(seasonId);
      expect(active?.status).toBe("active");

      // Same name, new phase → update in place, same row id, phaseChanged.
      const a2 = await applyArcPlan(
        db,
        campaignId,
        2,
        arcPlan({ name: "the blue crow", phase: "rising" }),
      );
      expect(a2.arcId).toBe(a1.arcId);
      expect(a2.phaseChanged).toBe(true);
      active = await getActiveArc(db, campaignId);
      expect(active?.phase).toBe("rising");

      // Same name, same phase → no phase change.
      const a3 = await applyArcPlan(
        db,
        campaignId,
        3,
        arcPlan({ name: "The Blue Crow", phase: "rising" }),
      );
      expect(a3.arcId).toBe(a1.arcId);
      expect(a3.phaseChanged).toBe(false);

      // Still exactly one active arc.
      let rows = await arcsFor(campaignId);
      expect(rows.filter((r) => r.stratum === "arc" && r.status === "active")).toHaveLength(1);

      // Different name → succession: old closes, new mints under the season.
      const a4 = await applyArcPlan(
        db,
        campaignId,
        4,
        arcPlan({ name: "The Syndicate", phase: "escalation" }),
      );
      expect(a4.arcId).not.toBe(a1.arcId);
      expect(a4.phaseChanged).toBe(true); // escalation ≠ rising
      rows = await arcsFor(campaignId);
      expect(rows.find((r) => r.id === a1.arcId)?.status).toBe("closed");
      active = await getActiveArc(db, campaignId);
      expect(active?.name).toBe("The Syndicate");
      expect(active?.parentId).toBe(seasonId);
      expect(rows.filter((r) => r.stratum === "arc" && r.status === "active")).toHaveLength(1);

      // Explicit close, no successor.
      const a5 = await applyArcPlan(
        db,
        campaignId,
        5,
        arcPlan({ name: "The Syndicate", status: "closed" }),
      );
      expect(a5.arcId).toBe(a4.arcId);
      expect(a5.phaseChanged).toBe(false);
      expect(await getActiveArc(db, campaignId)).toBeNull();
    });

    it("arcPosition counts closed episodes (episode budget) and turns elapsed (scene budget)", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      await ensureSeriesScaffold(db, campaignId, bebopContract());

      // Episode-denominated arc, minted at turn 5.
      await applyArcPlan(
        db,
        campaignId,
        5,
        arcPlan({ name: "Position Arc", budget: { unit: "episodes", target: 3, tolerance: 1 } }),
      );
      const epArc = await getActiveArc(db, campaignId);
      if (!epArc) throw new Error("no active arc");

      const pos0 = await arcPosition(db, campaignId, epArc, 5);
      expect(pos0).toEqual({ consumed: 0, target: 3, fraction: 0 });

      await closeEpisode(db, campaignId, 6, { name: "Ep 1", dramatic_question: "?" }, epArc.id);
      await closeEpisode(db, campaignId, 7, { name: "Ep 2", dramatic_question: "?" }, epArc.id);
      const pos2 = await arcPosition(db, campaignId, epArc, 8);
      expect(pos2.consumed).toBe(2);
      expect(pos2.target).toBe(3);
      expect(pos2.fraction).toBeCloseTo(2 / 3);

      // Scene-denominated arc, minted at turn 5 → position = turns elapsed.
      await applyArcPlan(
        db,
        campaignId,
        5,
        arcPlan({ name: "Scene Arc", budget: { unit: "scenes", target: 10, tolerance: 2 } }),
      );
      const scArc = await getActiveArc(db, campaignId);
      if (!scArc) throw new Error("no active scene arc");
      const scPos = await arcPosition(db, campaignId, scArc, 12);
      expect(scPos.consumed).toBe(7); // 12 − 5
      expect(scPos.fraction).toBeCloseTo(0.7);
    });
  });

  // -------------------------------------------------------------------------
  // Seed Ledger
  // -------------------------------------------------------------------------

  describe("seed ledger", () => {
    it("plantSeed stores matched dependency ids and notes the unmatched ones", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();

      const a = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the locked briefcase in the cargo hold" }),
        "director",
      );
      expect(a.notes).toEqual([]);

      const b = await plantSeed(
        db,
        campaignId,
        2,
        seedOp({
          description: "the briefcase is finally opened",
          expected_payoff: "its contents change everything",
          dependencies: ["locked briefcase", "a contact who was never real"],
        }),
        "director",
      );
      // One dependency matched by containment, one dropped with a note.
      expect(b.notes).toHaveLength(1);
      expect(b.notes[0]).toContain("a contact who was never real");

      const [row] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, b.seedId));
      expect(row?.dependencies).toEqual([a.seedId]);
      expect(row?.status).toBe("planted");
      expect(row?.urgency).toBeCloseTo(0.5);
      expect(row?.mentionCount).toBe(0);
      expect(row?.payoffWindow).toEqual({ from: 7, to: 52 }); // plantedTurn 2 + [5, 50]
      expect(row?.expectedPayoff).toBe("its contents change everything");
      expect(row?.turnId).toBe(2);
      expect(row?.provenance).toBe("director");
      expect(row?.confidence).toBeCloseTo(0.9);
    });

    it("plantSeed never binds a dependency to an ABANDONED seed (permanent-gate hazard)", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();

      // An abandoned "the mole" would out-match the open, longer seed on the
      // length tie-break — the dependency pool must exclude it (C7 audit:
      // abandoned never reaches "resolved", so the gate would hold forever).
      const abandoned = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the mole" }),
        "director",
      );
      await settleSeed(db, campaignId, 2, {
        op: "abandon",
        seed_description: "the mole",
        dependencies: [],
      });
      const open = await plantSeed(
        db,
        campaignId,
        3,
        seedOp({ description: "the mole inside the crew" }),
        "director",
      );

      const gated = await plantSeed(
        db,
        campaignId,
        4,
        seedOp({ description: "the mole is unmasked", dependencies: ["the mole"] }),
        "director",
      );
      const [row] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, gated.seedId));
      expect(row?.dependencies).toEqual([open.seedId]);
      expect(row?.dependencies).not.toContain(abandoned.seedId);
    });

    it("callbackReadySeeds gates on resolved dependencies", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();

      const dep = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the ISSP mole inside the crew" }),
        "director",
      );
      const gated = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the mole is unmasked", dependencies: ["ISSP mole"] }),
        "director",
      );
      const independent = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "an unpaid debt to the Red Dragon" }),
        "director",
      );

      // Past window.from (turn 1 + 5 = 6); the gated seed is held back.
      const ready = (await callbackReadySeeds(db, campaignId, 10)).map((s) => s.id);
      expect(ready).toContain(dep.seedId);
      expect(ready).toContain(independent.seedId);
      expect(ready).not.toContain(gated.seedId);

      // Resolve the dependency → the gate opens; the resolved dep drops out.
      const settled = await settleSeed(
        db,
        campaignId,
        8,
        seedOp({ op: "resolve", seed_description: "ISSP mole" }),
      );
      expect(settled.seedId).toBe(dep.seedId);

      const ready2 = (await callbackReadySeeds(db, campaignId, 10)).map((s) => s.id);
      expect(ready2).toContain(gated.seedId);
      expect(ready2).toContain(independent.seedId);
      expect(ready2).not.toContain(dep.seedId); // now resolved
    });

    it("overdueSeeds detects seeds past their window.to; tension bump scales with count", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();

      const overdue = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "a promise to visit the grave",
          payoff_window_from: 1,
          payoff_window_to: 3,
        }),
        "director",
      );
      // Still inside its default window — not overdue.
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "a debt not yet called in" }),
        "director",
      );

      const past = await overdueSeeds(db, campaignId, 10);
      expect(past.map((s) => s.id)).toEqual([overdue.seedId]);
      expect(overdueTensionBump(past.length)).toBeCloseTo(0.05);
      expect(overdueTensionBump(3)).toBeCloseTo(0.15);
      expect(overdueTensionBump(0)).toBe(0);
    });

    it("settleSeed resolves/abandons by containment and reports no-match", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();

      const s = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the bounty on Vicious" }),
        "director",
      );
      const resolved = await settleSeed(
        db,
        campaignId,
        5,
        seedOp({ op: "resolve", seed_description: "bounty on Vicious" }),
      );
      expect(resolved.seedId).toBe(s.seedId);
      const [sRow] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, s.seedId));
      expect(sRow?.status).toBe("resolved");
      expect(sRow?.resolvedTurn).toBe(5);

      const t = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the derelict ship on Europa" }),
        "director",
      );
      const abandoned = await settleSeed(
        db,
        campaignId,
        7,
        seedOp({ op: "abandon", seed_description: "derelict ship" }),
      );
      expect(abandoned.seedId).toBe(t.seedId);
      const [tRow] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, t.seedId));
      expect(tRow?.status).toBe("abandoned");
      expect(tRow?.resolvedTurn).toBeNull();

      const miss = await settleSeed(
        db,
        campaignId,
        8,
        seedOp({ op: "abandon", seed_description: "a thread that never was" }),
      );
      expect(miss.seedId).toBeUndefined();
      expect(miss.note).toBeTruthy();
    });

    /**
     * The settle channel's own repair (M3R4 R-2). The dossier used to print
     * every description clipped to 60 chars with an ellipsis, and the Director
     * settles by quoting that line back — so `bestMatch`'s containment test was
     * being handed a string the ledger did not hold. The 19 descriptions in the
     * N=50 soak ran 48–250 chars (mean 125): 18 of the 19 were clipped.
     */
    it("settles a REAL-LENGTH description — the dossier prints it whole, the op matches it", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const long =
        "the courier's second ledger, sewn into the lining of her coat, and the three names written in it that nobody has said aloud since the crossing";
      expect(long.length).toBeGreaterThan(60);
      const planted = await plantSeed(db, campaignId, 1, seedOp({ description: long }), "director");

      const dossier = await seedDossier(db, campaignId, 4);
      expect(dossier).toContain(long);

      const settled = await settleSeed(
        db,
        campaignId,
        5,
        seedOp({ op: "resolve", seed_description: long }),
      );
      expect(settled.seedId).toBe(planted.seedId);
      expect(settled.note).toBeUndefined();
    });

    it("a clipped-with-ellipsis quote still lands — the belt under the dossier fix", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const long =
        "the debt owed to the harbourmaster, which he has never named out loud and never once forgotten";
      const planted = await plantSeed(db, campaignId, 1, seedOp({ description: long }), "director");

      // Exactly what the old 60-char dossier rendering handed the Director.
      const clipped = `${long.slice(0, 59)}…`;
      const settled = await settleSeed(
        db,
        campaignId,
        6,
        seedOp({ op: "abandon", seed_description: clipped }),
      );
      expect(settled.seedId).toBe(planted.seedId);
      const [row] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, planted.seedId));
      expect(row?.status).toBe("abandoned");
    });

    it("marks CLOSING seeds in the dossier and names the three ways out", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const at = 12;
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "the promise made at the dock",
          payoff_window_from: 2,
          payoff_window_to: at + DIRECTOR_MAX_INTERVAL,
        }),
        "director",
      );
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "the letter that has not arrived",
          payoff_window_from: 2,
          payoff_window_to: at + DIRECTOR_MAX_INTERVAL + 1,
        }),
        "director",
      );

      const dossier = await seedDossier(db, campaignId, at);
      const closingLine = dossier
        .split("\n")
        .find((l) => l.includes("the promise made at the dock"));
      expect(closingLine).toContain("CLOSING");
      const notYet = dossier.split("\n").find((l) => l.includes("the letter that has not arrived"));
      expect(notYet).not.toContain("CLOSING");
      expect(dossier).toContain("1 CLOSING");
      expect(dossier).toContain("adjust_window");
      // CLOSING is not OVERDUE: nothing is broken yet, so no tension bump.
      expect(dossier).not.toContain("overdue → tension");
    });

    it("seedDossier renders open seeds with counts and stays compact", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the recurring dream of Mars" }),
        "director",
      );
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the woman in the photograph" }),
        "director",
      );
      await settleSeed(
        db,
        campaignId,
        6,
        seedOp({ op: "resolve", seed_description: "woman in the photograph" }),
      );

      const dossier = await seedDossier(db, campaignId, 12);
      expect(dossier).toContain("SEED LEDGER (turn 12)");
      expect(dossier).toContain("the recurring dream of Mars");
      expect(dossier).toContain("1 resolved");
      expect(dossier).not.toContain("the woman in the photograph"); // resolved → not an open line
      expect(dossier.split("\n").length).toBeLessThanOrEqual(31);
    });
  });

  // -------------------------------------------------------------------------
  // §7.6 two-path detection (M3 C2)
  // -------------------------------------------------------------------------

  describe("organic detection (code only — no model call)", () => {
    it("plantSeed embeds the description once, at plant time", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      embedByAngle({ "a coffin waiting on Ganymede": 0 });

      const { seedId } = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "a coffin waiting on Ganymede" }),
        "director",
      );
      expect(mockEmbed).toHaveBeenCalledTimes(1);
      expect(mockEmbed.mock.calls[0]?.[1]).toMatchObject({ inputType: "document" });

      const [row] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, seedId));
      expect(row?.embedding).toHaveLength(1024);
      expect(row?.embedding?.[0]).toBeCloseTo(1, 4);
      expect(row?.candidates).toEqual([]);
    });

    it("a failed embed costs the embedding, never the plant", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      mockEmbed.mockRejectedValueOnce(new Error("voyage down"));

      const { seedId, notes } = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "an unpaid favour" }),
        "director",
      );
      expect(notes.join(" ")).toContain("could not be embedded");
      const [row] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, seedId));
      expect(row?.description).toBe("an unpaid favour");
      expect(row?.embedding).toBeNull();
    });

    it("the sweep accumulates hits ≥ 0.55 and ignores everything below", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const narration = "The coffin came up out of the ice, and nobody spoke.";
      // near ≈ cos(0.2) ≈ 0.98 (a hit); far ≈ cos(1.4) ≈ 0.17 (not a hit).
      embedByAngle({
        "the buried coffin": 0.2,
        "a debt to the Red Dragon": 1.4,
        [narration]: 0,
      });
      const near = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the buried coffin" }),
        "director",
      );
      const far = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "a debt to the Red Dragon" }),
        "director",
      );

      const swept = await sweepSeedCandidates(db, campaignId, 6, narration);
      expect(swept).toMatchObject({ swept: 2, candidates: 1, backfilled: 0 });

      const [nearRow] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, near.seedId));
      const [farRow] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, far.seedId));
      const hits = parseCandidates(nearRow?.candidates);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.t).toBe(6);
      expect(hits[0]?.s).toBeGreaterThanOrEqual(ORGANIC_CANDIDATE_THRESHOLD);
      expect(hits[0]?.adj).toBeUndefined();
      expect(parseCandidates(farRow?.candidates)).toEqual([]);

      // A candidate is NOT a mention: the counters and status are untouched.
      expect(nearRow?.mentionCount).toBe(0);
      expect(nearRow?.status).toBe("planted");

      // Replay (G2 catch-up) must not double-count the same turn.
      await sweepSeedCandidates(db, campaignId, 6, narration);
      const [again] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, near.seedId));
      expect(parseCandidates(again?.candidates)).toHaveLength(1);
    });

    it("backfills a seed that predates the column, lazily, on its first sweep", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const narration = "She said his name like it still cost her something.";
      embedByAngle({ "the name she never says": 0.1, [narration]: 0 });

      // An M0-era row: no embedding, exactly as the migration leaves it.
      const [legacy] = await db
        .insert(schema.seeds)
        .values({
          campaignId,
          description: "the name she never says",
          status: "planted",
          plantedTurn: 1,
          urgency: 0.5,
          turnId: 1,
          provenance: "director",
          confidence: 0.8,
        })
        .returning({ id: schema.seeds.id });
      if (!legacy) throw new Error("legacy seed insert failed");

      const swept = await sweepSeedCandidates(db, campaignId, 4, narration);
      expect(swept.backfilled).toBe(1);
      expect(swept.candidates).toBe(1);

      const [row] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, legacy.id));
      expect(row?.embedding).toHaveLength(1024);
      expect(parseCandidates(row?.candidates)).toHaveLength(1);
    });

    it("a seed the declared probe just confirmed sits the sweep out — no double billing", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const narration = "He said the name, and the room got smaller.";
      embedByAngle({ "the name he owes": 0.1, [narration]: 0 });
      const declared = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the name he owes" }),
        "director",
      );

      const swept = await sweepSeedCandidates(db, campaignId, 7, narration, {
        alreadyMentioned: [declared.seedId],
      });
      expect(swept).toMatchObject({ candidates: 0 });
      const [row] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, declared.seedId));
      // Without the exclusion the batched adjudication would later count this
      // same scene as a SECOND mention of the seed the probe already confirmed.
      expect(parseCandidates(row?.candidates)).toEqual([]);
    });

    it("no open seeds and empty narration are both zero-cost no-ops", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      expect(await sweepSeedCandidates(db, campaignId, 3, "some prose")).toMatchObject({
        candidates: 0,
      });
      await plantSeed(db, campaignId, 1, seedOp({ description: "a seed" }), "director");
      mockEmbed.mockClear();
      expect(await sweepSeedCandidates(db, campaignId, 3, "   ")).toMatchObject({ candidates: 0 });
      expect(mockEmbed).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle ops (adjust_window, auto_resolve)", () => {
    it("adjust_window UPDATES the window in place — never a duplicate row", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { seedId } = await plantSeed(
        db,
        campaignId,
        2,
        seedOp({ description: "the promise to visit the grave" }),
        "director",
      );

      const settled = await settleSeed(db, campaignId, 20, {
        op: "adjust_window",
        seed_description: "promise to visit the grave",
        payoff_window_to: 60,
        dependencies: [],
      });
      expect(settled.seedId).toBe(seedId);

      const rows = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.campaignId, campaignId));
      // The C1 slip made concrete: ONE row, a moved window, still open.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(seedId);
      expect(rows[0]?.payoffWindow).toEqual({ from: 7, to: 60 });
      expect(rows[0]?.status).toBe("planted");
      expect(rows[0]?.plantedTurn).toBe(2);
    });

    it("auto_resolve ends the seed under its own provenance, distinct from a Director resolve", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const auto = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the bounty on Vicious" }),
        "director",
      );
      const chosen = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the derelict on Europa" }),
        "director",
      );

      // The adjudicator's end is id-targeted (autoResolveSeed) — auto_resolve
      // is deliberately NOT a settleSeed op: a model-emitted Director op must
      // never wear the adjudicator's provenance (stack audit, 2026-08-01).
      await autoResolveSeed(db, auto.seedId as string, 9);
      await settleSeed(db, campaignId, 9, {
        op: "resolve",
        seed_description: "derelict on Europa",
        dependencies: [],
      });

      const [autoRow] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, auto.seedId));
      const [chosenRow] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, chosen.seedId));
      expect(autoRow?.status).toBe("resolved");
      expect(autoRow?.resolvedTurn).toBe(9);
      expect(autoRow?.resolvedBy).toBe("adjudicator_payoff");
      expect(chosenRow?.resolvedBy).toBe("director");
      // The PLANT's envelope is untouched — resolvedBy is a separate channel.
      expect(autoRow?.provenance).toBe("director");
      expect(autoRow?.turnId).toBe(1);
    });
  });

  describe("batched adjudication (one judged call per Director cycle)", () => {
    /** Four seeds: one candidate, one callback-ready, one overdue, one untouched. */
    async function ledger(campaignId: string) {
      if (!db) throw new Error("unreachable");
      const narration = "He set the bounty poster down and said the name out loud.";
      embedByAngle({ "the bounty poster": 0.1, [narration]: 0 });

      const candidate = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the bounty poster" }),
        "director",
      );
      const ready = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "the ledger the syndicate keeps",
          expected_payoff: "the ledger is opened and a name is found in it",
        }),
        "director",
      );
      const overdue = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "the storm that never came",
          payoff_window_from: 2,
          payoff_window_to: 4,
        }),
        "director",
      );
      const untouched = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "a letter posted to a dead address",
          payoff_window_from: 90,
          payoff_window_to: 200,
        }),
        "director",
      );
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber: 10,
        playerInput: "I read the poster",
        narration,
        narratedFragment: "He finally let himself say the name.",
        turnId: 10,
        provenance: "chronicler_g1",
        confidence: 1,
      });
      await sweepSeedCandidates(db, campaignId, 10, narration);
      return { candidate, ready, overdue, untouched };
    }

    /** Script the batch's TWO answers (M3R4 R-2): the settle verdicts and the
     *  mention findings. Both arrays are required by the schema, so a fixture
     *  that omits one is not a shape the parse could ever hand the engine. */
    function scriptAdjudication(emit: Partial<SeedAdjudication>): void {
      const payload: SeedAdjudication = {
        verdicts: emit.verdicts ?? [],
        mentions: emit.mentions ?? [],
      };
      // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
      mockJudgment.mockImplementation((_s: any, opts: any) =>
        opts.name === "seed_adjudication"
          ? (Promise.resolve(payload) as never)
          : (Promise.reject(new Error(`unscripted judgment ${opts.name}`)) as never),
      );
    }

    const scriptVerdicts = (verdicts: SeedAdjudication["verdicts"]): void =>
      scriptAdjudication({ verdicts });

    it("renders only seeds under review — cost scales with candidates, not ledger size", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { untouched } = await ledger(campaignId);

      const review = await seedsUnderReview(db, campaignId, 11);
      expect(review.map((r) => r.seed.description).sort()).toEqual([
        "the bounty poster",
        "the ledger the syndicate keeps",
        "the storm that never came",
      ]);
      expect(review.find((r) => r.seed.id === untouched.seedId)).toBeUndefined();

      scriptVerdicts([]);
      await adjudicateSeeds(db, campaignId, 11);
      const prompt = String(mockJudgment.mock.calls[0]?.[1]?.prompt);
      expect(prompt).toContain("the bounty poster");
      expect(prompt).toContain("the ledger the syndicate keeps");
      expect(prompt).not.toContain("a letter posted to a dead address");
      // Judgment tier, filed to the cycle, one call.
      expect(mockJudgment.mock.calls[0]?.[1]?.phase).toBe("director_cycle");
      expect(mockJudgment).toHaveBeenCalledTimes(1);
    });

    it("applies mention / payoff / conflict / extend and spends the candidates", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { candidate, ready, overdue } = await ledger(campaignId);
      const review = await seedsUnderReview(db, campaignId, 11);
      const refOf = (id: string) => review.findIndex((r) => r.seed.id === id);

      scriptVerdicts([
        { seed_ref: refOf(candidate.seedId), verdict: "mention", confidence: 0.9, evidence: "e" },
        { seed_ref: refOf(ready.seedId), verdict: "payoff", confidence: 0.85, evidence: "e" },
        { seed_ref: refOf(overdue.seedId), verdict: "conflict", confidence: 0.8, evidence: "e" },
      ]);
      const result = await adjudicateSeeds(db, campaignId, 11);
      expect(result).toMatchObject({ reviewed: 3, mentions: 1, payoffs: 1, conflicts: 1 });

      const [mentioned] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, candidate.seedId));
      expect(mentioned?.mentionCount).toBe(1);
      expect(mentioned?.urgency).toBeCloseTo(0.6, 3);
      expect(mentioned?.status).toBe("confirmed");
      // The candidate is SPENT — the next cycle must not pay to re-judge it.
      expect(parseCandidates(mentioned?.candidates).every((c) => c.adj)).toBe(true);
      expect(await seedsUnderReview(db, campaignId, 11)).toHaveLength(0);

      const [paid] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, ready.seedId));
      expect(paid?.status).toBe("resolved");
      expect(paid?.resolvedTurn).toBe(11);
      expect(paid?.resolvedBy).toBe("adjudicator_payoff");

      const [dropped] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, overdue.seedId));
      expect(dropped?.status).toBe("abandoned");
      expect(dropped?.resolvedBy).toBe("adjudicator_conflict");
    });

    it("extend moves the window in place; a hedged verdict is recorded and NOT acted on", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { candidate, overdue } = await ledger(campaignId);
      const review = await seedsUnderReview(db, campaignId, 11);
      const refOf = (id: string) => review.findIndex((r) => r.seed.id === id);

      scriptVerdicts([
        {
          seed_ref: refOf(overdue.seedId),
          verdict: "extend",
          confidence: 0.9,
          evidence: "e",
          new_window_to: 40,
        },
        {
          seed_ref: refOf(candidate.seedId),
          verdict: "payoff",
          confidence: SEED_ADJUDICATION_MIN_CONFIDENCE - 0.1,
          evidence: "maybe",
        },
      ]);
      const result = await adjudicateSeeds(db, campaignId, 11);
      expect(result).toMatchObject({ windowAdjustments: 1, payoffs: 0, lowConfidence: 1 });

      const rows = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.campaignId, campaignId));
      expect(rows).toHaveLength(4); // no duplicate plant for the push-out
      const pushed = rows.find((r) => r.id === overdue.seedId);
      expect(pushed?.payoffWindow).toEqual({ from: 2, to: 40 });
      expect(pushed?.status).toBe("planted");
      // The hedged payoff never ended a thread.
      const hedged = rows.find((r) => r.id === candidate.seedId);
      expect(hedged?.status).toBe("planted");
      expect(hedged?.resolvedBy).toBeNull();
    });

    /**
     * QUESTION ONE, reachable (M3R4 R-2). The soak's adjudicator never once
     * chose "mention": the verdict competed with payoff and conflict for a
     * single slot on seeds that wore callback-ready and overdue tags in the
     * same line, and it was judging 240-char fragments of 3,525-char scenes.
     * These prove the WIRE — that a mention finding reaches the row. Whether a
     * live judge now says yes is a soak question, not a deterministic one.
     */
    it("a mention finding records the mention — the question has its own slot now", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { candidate } = await ledger(campaignId);
      const review = await seedsUnderReview(db, campaignId, 11);
      const ref = review.findIndex((r) => r.seed.id === candidate.seedId);

      scriptAdjudication({
        // The SETTLE answer is "none" — nothing ended — and the mention still lands.
        verdicts: [{ seed_ref: ref, verdict: "none", confidence: 0.9, evidence: "not settled" }],
        mentions: [
          {
            seed_ref: ref,
            surfaced: "YES",
            turn: 10,
            confidence: 0.9,
            evidence: "he sets the poster down and says the name",
          },
        ],
      });
      const result = await adjudicateSeeds(db, campaignId, 11);
      expect(result.mentions).toBe(1);

      const [row] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, candidate.seedId));
      expect(row?.mentionCount).toBe(1);
      expect(row?.status).toBe("confirmed");
      expect(row?.urgency).toBeCloseTo(0.6, 3);
      expect(parseCandidates(row?.candidates).every((c) => c.adj)).toBe(true);
    });

    it("surfaced=no writes nothing, and a hedged finding is recorded but not acted on", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { candidate } = await ledger(campaignId);
      const review = await seedsUnderReview(db, campaignId, 11);
      const ref = review.findIndex((r) => r.seed.id === candidate.seedId);

      scriptAdjudication({
        mentions: [{ seed_ref: ref, surfaced: "no", turn: 0, confidence: 0.95, evidence: "mood" }],
      });
      expect((await adjudicateSeeds(db, campaignId, 11)).mentions).toBe(0);

      scriptAdjudication({
        mentions: [
          {
            seed_ref: 0,
            surfaced: "yes",
            turn: 10,
            confidence: SEED_ADJUDICATION_MIN_CONFIDENCE - 0.1,
            evidence: "maybe",
          },
        ],
      });
      // The candidates were spent by the first batch, so re-render before the
      // second: the cost law means a spent candidate never returns.
      const after = await adjudicateSeeds(db, campaignId, 12);
      expect(after.mentions).toBe(0);

      const [row] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, candidate.seedId));
      expect(row?.mentionCount).toBe(0);
      expect(row?.status).toBe("planted");
    });

    it("a seed answered in BOTH slots is credited ONCE", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const { candidate } = await ledger(campaignId);
      const review = await seedsUnderReview(db, campaignId, 11);
      const ref = review.findIndex((r) => r.seed.id === candidate.seedId);

      scriptAdjudication({
        // The legacy verdict word is still in the vocabulary, and still acts —
        // but it must not double-count a seed the mention slot already credited.
        verdicts: [{ seed_ref: ref, verdict: "mention", confidence: 0.9, evidence: "e" }],
        mentions: [{ seed_ref: ref, surfaced: "yes", turn: 10, confidence: 0.9, evidence: "e" }],
      });
      const result = await adjudicateSeeds(db, campaignId, 11);
      expect(result.mentions).toBe(1);

      const [row] = await db
        .select()
        .from(schema.seeds)
        .where(eq(schema.seeds.id, candidate.seedId));
      expect(row?.mentionCount).toBe(1);
    });

    it("renders the ACTUAL narration of a candidate's scene, not a summary fragment", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      await ledger(campaignId);
      scriptAdjudication({});
      await adjudicateSeeds(db, campaignId, 11);

      const prompt = String(mockJudgment.mock.calls[0]?.[1]?.prompt);
      expect(prompt).toContain("### turn 10");
      expect(prompt).toContain("He set the bounty poster down and said the name out loud.");
      // The fragment is what the judge USED to get — 4% of the page.
      expect(prompt).not.toContain("He finally let himself say the name.");
      // …and the seed line points at the scene the mention question is about.
      expect(prompt).toContain("candidate scenes 10");
      expect(prompt).toContain("QUESTION ONE");
    });

    it("bounds the evidence: a long scene clips, an unaffordable one degrades to its fragment", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      await ledger(campaignId);
      const caps = SEED_ADJUDICATION_CAPS;
      // Enough whole scenes to overrun the batch budget, each longer than one
      // scene may be — so both bounds are exercised by the same fixture.
      const sceneCount = Math.ceil(caps.evidence_total_chars / caps.evidence_scene_chars) + 2;
      for (let i = 0; i < sceneCount; i++) {
        await db.insert(schema.episodicRecords).values({
          campaignId,
          turnNumber: 20 + i,
          playerInput: "onward",
          narration: `SCENEHEAD${i} ${"the rain kept on. ".repeat(400)} SCENETAIL${i}`,
          narratedFragment: `fragment ${i}`,
          turnId: 20 + i,
          provenance: "chronicler_g1",
          confidence: 1,
        });
      }

      scriptAdjudication({});
      await adjudicateSeeds(db, campaignId, 40);
      const prompt = String(mockJudgment.mock.calls[0]?.[1]?.prompt);
      const evidence = prompt.split("## Seeds under review")[0] ?? "";
      expect(evidence.length).toBeLessThanOrEqual(caps.evidence_total_chars + 2000);
      // The newest scene is rendered and CLIPPED; its tail did not fit.
      expect(prompt).toContain(`SCENEHEAD${sceneCount - 1}`);
      expect(prompt).not.toContain(`SCENETAIL${sceneCount - 1}`);
      // The recency tail reaches back evidence_turns scenes and no further —
      // anything older is not fetched at all, so it cannot appear in any form.
      expect(prompt).not.toContain("SCENEHEAD0");
      expect(prompt).not.toContain("fragment 0");
      // The OLDEST scene the tail does reach is the one the budget could not
      // hold whole: it falls back to its summary fragment — present, and
      // honestly labelled as a fragment — never silently absent, never unbounded.
      const oldestInTail = sceneCount - caps.evidence_turns;
      expect(prompt).toContain("only this scene's summary fragment fit the evidence budget");
      expect(prompt).not.toContain(`SCENEHEAD${oldestInTail}`);
      expect(prompt).toContain(`fragment ${oldestInTail}`);
      // And the scene a candidate names is rendered FIRST out of the budget,
      // whatever else is competing for it (§7.6: the mention question is about
      // those scenes).
      expect(prompt).toContain("He set the bounty poster down and said the name out loud.");
    });

    it("puts a CLOSING seed in front of the adjudicator, tagged for the push-out", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const at = 12;
      const closing = await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "the promise made at the dock",
          payoff_window_from: 2,
          payoff_window_to: at + DIRECTOR_MAX_INTERVAL,
        }),
        "director",
      );
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "the letter that has not arrived",
          payoff_window_from: 2,
          payoff_window_to: at + DIRECTOR_MAX_INTERVAL + 1,
        }),
        "director",
      );

      const review = await seedsUnderReview(db, campaignId, at);
      expect(review.map((r) => r.seed.id)).toEqual([closing.seedId]);
      expect(review[0]?.closing).toBe(true);

      // …and the push-out it is offered actually moves the window.
      scriptAdjudication({
        verdicts: [
          {
            seed_ref: 0,
            verdict: "extend",
            confidence: 0.9,
            evidence: "alive, not reached",
            new_window_to: at + 25,
          },
        ],
      });
      const result = await adjudicateSeeds(db, campaignId, at);
      expect(result.windowAdjustments).toBe(1);
      const prompt = String(mockJudgment.mock.calls[0]?.[1]?.prompt);
      expect(prompt).toContain("CLOSING");

      const [row] = await db.select().from(schema.seeds).where(eq(schema.seeds.id, closing.seedId));
      expect(row?.payoffWindow).toEqual({ from: 2, to: at + 25 });
      expect(row?.status).toBe("planted");
    });

    it("an empty under-review set costs nothing — no judged call at all", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "a seed nobody has touched",
          payoff_window_from: 90,
          payoff_window_to: 200,
        }),
        "director",
      );
      const result = await adjudicateSeeds(db, campaignId, 5);
      expect(result.reviewed).toBe(0);
      expect(mockJudgment).not.toHaveBeenCalled();
    });
  });

  describe("the dossier surfaces overdue→tension and convergence", () => {
    it("marks overdue lines, states the tension pressure, and names converging pairs", async () => {
      if (!db) throw new Error("unreachable");
      const campaignId = await makeCampaign();
      const narration = "Two threads pulled at once and neither of them let go.";
      embedByAngle({
        "the coffin in the hold": 0.1,
        "the coffin's second key": 0.15,
        [narration]: 0,
      });

      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({
          description: "the coffin in the hold",
          payoff_window_from: 2,
          payoff_window_to: 5,
        }),
        "director",
      );
      await plantSeed(
        db,
        campaignId,
        1,
        seedOp({ description: "the coffin's second key" }),
        "director",
      );
      await sweepSeedCandidates(db, campaignId, 9, narration);

      const dossier = await seedDossier(db, campaignId, 30);
      expect(dossier).toContain("OVERDUE");
      expect(dossier).toContain("overdue → tension +0.05");
      expect(dossier).toContain("adjust_window");
      expect(dossier).toContain("CONVERGENCE");
      expect(dossier).toContain("shared scenes 9");
      expect(dossier).toContain("the coffin's second key");

      const overdue = await overdueSeeds(db, campaignId, 30);
      expect(overdue).toHaveLength(1);
    });
  });
});
