import * as schema from "@/lib/db/schema";
import {
  applyArcPlan,
  arcPosition,
  closeEpisode,
  ensureSeriesScaffold,
  getActiveArc,
} from "@/lib/direction/arcs";
import {
  callbackReadySeeds,
  overdueSeeds,
  overdueTensionBump,
  plantSeed,
  seedDossier,
  settleSeed,
} from "@/lib/direction/seeds";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { DirectorArcPlan, DirectorSeedOp } from "@/lib/types/direction";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Arc Model + Seed Ledger (§7.3, §7.6) against real Postgres — the
 * DB-denominated half of C7's direction slice. No models: everything here is
 * pure code + SQL. Skipped (loudly) when no DATABASE_URL is configured; the
 * DB-less curve/band math lives in arcs.test.ts.
 */

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
});
