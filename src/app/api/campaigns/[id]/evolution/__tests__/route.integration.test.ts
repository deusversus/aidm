import { getCurrentUser } from "@/lib/auth";
import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { rewindCampaign } from "@/lib/turn/rewind";
import { DirectionState } from "@/lib/types/direction";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

/**
 * The §7.1 season-boundary ratification answers (M3 C4). Real Postgres; auth
 * mocked, never the DB (working agreement). No model call is reachable from
 * this route — the Settei rebuild it triggers is pure Renderer code.
 *
 * The load-bearing property under test: SILENCE NEVER AMENDS. Only the two
 * explicit answers clear the proposal, and everything else — a rejected caller,
 * a malformed body, a second answer — leaves the question exactly as it stood.
 */

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
const mockUser = vi.mocked(getCurrentUser);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[evolution-route] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request("http://test/evolution", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const CASE =
  "We set out to make a caper and we have been making a wake. I think the wake is the better show.";

/** BEBOP_DNA: darkness 7, cruelty 5 — the proposal moves both. */
const PROPOSAL = {
  season_id: "season-1",
  season_name: "Season 1",
  proposed_at_turn: 46,
  director_case: CASE,
  axes: [
    { axis: "darkness", from: 7, to: 10 },
    { axis: "cruelty", from: 5, to: 8 },
  ],
};

/** A Sakkan state carrying the findings both answers must settle. */
const SAKKAN = {
  last_sample_turn: 44,
  readings: {},
  active_notes: [{ axis: "optimism", active: 3, observed: 7, since_turn: 20 }],
  player_driven: {
    darkness: { axis: "darkness", observed: 10, wanted: 7, evidence: "e", at_turn: 30 },
    cruelty: { axis: "cruelty", observed: 8, wanted: 5, evidence: "e", at_turn: 32 },
    optimism: { axis: "optimism", observed: 7, wanted: 3, evidence: "e", at_turn: 34 },
  },
};

describe.skipIf(!url)("evolution ratification route (M3 C4, real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "evolve@example.com" });
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.playerId, playerId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockUser.mockResolvedValue({ id: playerId, email: "evolve@example.com" });
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "evolution fixture",
        status: "active",
        premiseContract: bebopContract(),
        directionState: { sakkan: SAKKAN, evolution_proposal: PROPOSAL },
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignId = c.id;
  });

  async function readState(): Promise<DirectionState> {
    if (!db) throw new Error("unreachable");
    const [row] = await db
      .select({ d: schema.campaigns.directionState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    return DirectionState.parse(row?.d ?? {});
  }

  async function readTreatment(): Promise<Record<string, number>> {
    if (!db) throw new Error("unreachable");
    const [row] = await db
      .select({ c: schema.campaigns.premiseContract })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    return (row?.c as { active: { treatment: Record<string, number> } }).active.treatment;
  }

  it("ratify amends the ACTIVE premise axes, dates the bible note, and clears the proposal", async () => {
    if (!db) throw new Error("unreachable");
    expect((await readTreatment()).darkness).toBe(7);

    const res = await POST(req({ action: "ratify" }), params(campaignId));
    expect(res.status).toBe(200);

    // §4.2: the ACTIVE layer moved, permanently — no arc_override involved.
    const treatment = await readTreatment();
    expect(treatment.darkness).toBe(10);
    expect(treatment.cruelty).toBe(8);
    // Untouched axes stay exactly where the contract had them.
    expect(treatment.optimism).toBe(3);
    const [c] = await db
      .select({ arcOverride: schema.campaigns.arcOverride })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(c?.arcOverride).toBeNull();

    // The bible's source material, with the provenance envelope (§6).
    const notes = await db
      .select()
      .from(schema.criticalFacts)
      .where(
        and(
          eq(schema.criticalFacts.campaignId, campaignId),
          eq(schema.criticalFacts.category, "evolution"),
        ),
      );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.provenance).toBe("player_ratified");
    expect(notes[0]?.turnId).toBe(46);
    expect(notes[0]?.confidence).toBe(1);
    expect(notes[0]?.content).toContain(CASE);
    expect(notes[0]?.tombstonedAt).toBeNull();

    const state = await readState();
    expect(state.evolution_proposal).toBeUndefined();
    // The Sakkan's baseline follows automatically (it reads the active layer),
    // so the ratified axes' player-driven exemptions and retakes are settled.
    expect(Object.keys(state.sakkan?.player_driven ?? {})).toEqual(["optimism"]);
    expect(state.sakkan?.active_notes).toEqual([
      { axis: "optimism", active: 3, observed: 7, since_turn: 20 },
    ]);
    // §4.4a trigger (2): the frozen Charter re-rendered against the new premise.
    expect(state.settei?.text).toBeTruthy();

    // ONE review per season, whatever the answer (C4 audit MUST-FIX): the
    // stamp lands, and the undo ledger carries the FROM values for §6.7.
    expect(state.last_evolution_review).toEqual({ season_id: "season-1", turn: 46 });
    expect(state.evolution_history).toEqual([
      {
        season_id: "season-1",
        turn: 46,
        axes: [
          { axis: "darkness", from: 7, to: 10 },
          { axis: "cruelty", from: 5, to: 8 },
        ],
      },
    ]);

    // §6.7: the amendment is REVOCABLE — a rewind past the ratification
    // restores the FROM values, drops the ledger entry, and clears the frozen
    // Charter so the next assembly re-renders from the restored premise
    // (record-gone-effect-kept was the C4 audit's asymmetry).
    await rewindCampaign(db, campaignId, 45, "test: unwind the retooling");
    const restored = await readTreatment();
    expect(restored.darkness).toBe(7);
    expect(restored.cruelty).toBe(5);
    const rewound = await readState();
    expect(rewound.evolution_history).toEqual([]);
    expect(rewound.last_evolution_review).toBeUndefined();
    expect(rewound.settei).toBeUndefined();
    const notesAfter = await db
      .select()
      .from(schema.criticalFacts)
      .where(
        and(
          eq(schema.criticalFacts.campaignId, campaignId),
          eq(schema.criticalFacts.category, "evolution"),
        ),
      );
    expect(notesAfter[0]?.tombstonedAt).not.toBeNull();
  });

  it("ratify is idempotent about its bible note (the documented resurrection race)", async () => {
    if (!db) throw new Error("unreachable");
    await POST(req({ action: "ratify" }), params(campaignId));
    // A Director cycle that loaded state before the answer re-persists it.
    const state = await readState();
    await db
      .update(schema.campaigns)
      .set({ directionState: { ...state, evolution_proposal: PROPOSAL } })
      .where(eq(schema.campaigns.id, campaignId));
    const res = await POST(req({ action: "ratify" }), params(campaignId));
    expect(res.status).toBe(200);

    const notes = await db
      .select()
      .from(schema.criticalFacts)
      .where(
        and(
          eq(schema.criticalFacts.campaignId, campaignId),
          eq(schema.criticalFacts.category, "evolution"),
        ),
      );
    expect(notes).toHaveLength(1);
  });

  it("pull home plants a retake on every proposed axis and leaves the premise alone", async () => {
    if (!db) throw new Error("unreachable");
    const res = await POST(req({ action: "pull_home" }), params(campaignId));
    expect(res.status).toBe(200);

    // The premise the player kept is untouched, and nothing entered the bible.
    const treatment = await readTreatment();
    expect(treatment.darkness).toBe(7);
    expect(treatment.cruelty).toBe(5);
    const notes = await db
      .select({ id: schema.criticalFacts.id })
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
    expect(notes).toHaveLength(0);

    const state = await readState();
    expect(state.evolution_proposal).toBeUndefined();
    // A retake per proposed axis, at the premise's own value — the drift band's
    // Amendments pull the prose back (§4.5).
    const byAxis = Object.fromEntries((state.sakkan?.active_notes ?? []).map((n) => [n.axis, n]));
    expect(byAxis.darkness).toMatchObject({ active: 7, observed: 10, since_turn: 46 });
    expect(byAxis.cruelty).toMatchObject({ active: 5, observed: 8, since_turn: 46 });
    // The pre-existing unrelated retake survives untouched.
    expect(byAxis.optimism).toMatchObject({ active: 3, since_turn: 20 });
    // The player said hold the line, so the player-driven exemption lifts on
    // the answered axes — the band is free to strain against them again.
    expect(Object.keys(state.sakkan?.player_driven ?? {})).toEqual(["optimism"]);
  });

  it("409s when no proposal is pending — and a second answer cannot amend twice", async () => {
    const first = await POST(req({ action: "ratify" }), params(campaignId));
    expect(first.status).toBe(200);
    const second = await POST(req({ action: "ratify" }), params(campaignId));
    expect(second.status).toBe(409);
  });

  it("silence persists: a rejected caller, a bad body, and an unauthenticated call all leave it standing", async () => {
    mockUser.mockResolvedValue({ id: "someone_else", email: "nope@example.com" });
    expect((await POST(req({ action: "ratify" }), params(campaignId))).status).toBe(404);

    mockUser.mockResolvedValue(null);
    expect((await POST(req({ action: "ratify" }), params(campaignId))).status).toBe(401);

    mockUser.mockResolvedValue({ id: playerId, email: "evolve@example.com" });
    expect((await POST(req({ action: "dismiss" }), params(campaignId))).status).toBe(400);
    expect((await POST(req({}), params(campaignId))).status).toBe(400);

    // The card is still up, unamended, waiting for a word.
    expect((await readState()).evolution_proposal).toMatchObject(PROPOSAL);
    expect((await readTreatment()).darkness).toBe(7);
  });
});
