import * as schema from "@/lib/db/schema";
import type { TierSelection } from "@/lib/llm/tiers";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { DirectionState } from "@/lib/types/direction";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Sakkan drift band (§4.5, C8) against real Postgres with a MOCKED scorer.
 * scoreAxes (the C1 shared blind scorer) is the only model surface `runSakkanSample`
 * touches, so mocking it directly keeps the suite honest — NEVER a live model call —
 * while loadDirectionState/saveDirectionState and every layer write hit real dev
 * Postgres per the working agreement (state-mutation tests never mock the DB).
 */

vi.mock("@/lib/sakkan/score", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sakkan/score")>();
  return { ...actual, scoreAxes: vi.fn() };
});

import {
  DRIFT_CONSECUTIVE,
  MARK_CONSECUTIVE,
  SAKKAN_PROVENANCE,
  activeSakkanNotes,
  gaugeTrend,
  runSakkanSample,
  sakkanDue,
} from "@/lib/sakkan/sakkan";
import { scoreAxes } from "@/lib/sakkan/score";
import type { AxisScore } from "@/lib/sakkan/score";

const mockScore = vi.mocked(scoreAxes);

const url = process.env.DATABASE_URL;
if (!url) console.warn("[sakkan] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

function axisScore(
  axis: string,
  score: number,
  confidence: number,
  evidence = "the neon guttered",
): AxisScore {
  return { axis, score, confidence, evidence_span: evidence };
}

/** Minimal parseable SetteiSnapshot carrying the rendered-axes set the sample scores. */
function settei(renderedAxes: string[]) {
  return {
    text: "settei charter (fixture)",
    charter_tokens: 500,
    rendered_axes: renderedAxes,
    uncovered_extremes: [],
    rebuilt_at_turn: 0,
    rebuilt_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — no DB required, so they run in every environment.
// ---------------------------------------------------------------------------

describe("Sakkan pure helpers", () => {
  it("sakkanDue: interval boundary, sakuga, sessionClose, turn 0", () => {
    const fresh = DirectionState.parse({});
    // last_sample_turn defaults to 0.
    expect(sakkanDue(fresh, 7)).toBe(false); // 7 - 0 = 7 < 8
    expect(sakkanDue(fresh, 8)).toBe(true); // 8 - 0 = 8 ≥ 8
    expect(sakkanDue(fresh, 3, { sakuga: true })).toBe(true);
    expect(sakkanDue(fresh, 3, { sessionClose: true })).toBe(true);
    // Turn 0 is never due — no prose exists yet — whatever the trigger.
    expect(sakkanDue(fresh, 0)).toBe(false);
    expect(sakkanDue(fresh, 0, { sakuga: true, sessionClose: true })).toBe(false);

    const sampled = DirectionState.parse({
      sakkan: { last_sample_turn: 10, readings: {}, active_notes: [] },
    });
    expect(sakkanDue(sampled, 17)).toBe(false); // 17 - 10 = 7 < 8
    expect(sakkanDue(sampled, 18)).toBe(true); // 18 - 10 = 8 ≥ 8
  });

  it("activeSakkanNotes maps to the Amendments SakkanNote shape and drops uncovered axes", () => {
    const state = DirectionState.parse({
      sakkan: {
        last_sample_turn: 16,
        readings: {},
        active_notes: [
          { axis: "darkness", active: 7, observed: 3, since_turn: 16 },
          // Not a grounded axis — must be filtered before reaching renderAmendments.
          { axis: "not_a_real_axis", active: 5, observed: 2, since_turn: 10 },
        ],
      },
    });
    expect(activeSakkanNotes(state)).toEqual([{ axis: "darkness", active: 7, observed: 3 }]);
  });

  it("gaugeTrend renders observed-vs-wanted with the retake line; empty readings → ''", () => {
    expect(gaugeTrend(DirectionState.parse({}))).toBe("");

    const state = DirectionState.parse({
      sakkan: {
        last_sample_turn: 16,
        readings: {
          darkness: {
            observed: 3,
            confidence: 0.9,
            at_turn: 16,
            consecutive_drift: 2,
            evidence: "the neon guttered",
          },
        },
        active_notes: [{ axis: "darkness", active: 7, observed: 3, since_turn: 16 }],
      },
    });
    const trend = gaugeTrend(state);
    expect(trend).toContain("darkness");
    expect(trend).toContain("observed 3");
    expect(trend).toContain("wanted 7");
    expect(trend).toContain("RETAKE ACTIVE since turn 16");
    expect(trend.split("\n").length).toBeLessThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// The sample loop — real Postgres, scripted scorer.
// ---------------------------------------------------------------------------

describe.skipIf(!url)("Sakkan sample (real Postgres, scripted scorer)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(
    extra: Partial<typeof schema.campaigns.$inferInsert> = {},
  ): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "sakkan fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SELECTION,
        ...extra,
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  async function seedProse(
    campaignId: string,
    turns: Array<{ n: number; degraded?: boolean; text?: string }>,
  ): Promise<void> {
    if (!db) throw new Error("unreachable");
    for (const t of turns) {
      await db.insert(schema.turns).values({
        campaignId,
        turnNumber: t.n,
        tier: "genga",
        status: "complete",
        playerInput: `input ${t.n}`,
        narration: t.text ?? `KA prose for turn ${t.n}. The neon hummed over wet asphalt.`,
        degraded: t.degraded ?? false,
        completedAt: new Date(),
      });
    }
  }

  /** Six clean, complete, non-degraded turns — the standard fixture sample. */
  function cleanSix(): Array<{ n: number }> {
    return [1, 2, 3, 4, 5, 6].map((n) => ({ n }));
  }

  async function readState(campaignId: string): Promise<DirectionState> {
    if (!db) throw new Error("unreachable");
    const [row] = await db
      .select({ d: schema.campaigns.directionState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    return DirectionState.parse(row?.d ?? {});
  }

  async function sakkanMarks(campaignId: string, topic: string) {
    if (!db) throw new Error("unreachable");
    return db
      .select()
      .from(schema.pencilMarks)
      .where(
        and(
          eq(schema.pencilMarks.campaignId, campaignId),
          eq(schema.pencilMarks.provenance, SAKKAN_PROVENANCE),
          eq(schema.pencilMarks.kind, "axis"),
          eq(schema.pencilMarks.topic, topic),
        ),
      );
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "sakkan@example.com" });
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

  beforeEach(() => {
    mockScore.mockReset();
  });

  // Bebop active darkness = 7; with no override, effective darkness = 7.

  it("band edges: one drift is a spike (no note); a second fires the retake; an in-band read lifts it", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({ directionState: { settei: settei(["darkness"]) } });
    await seedProse(campaignId, cleanSix());

    // Sample 1 — |7 − 3| = 4 ≥ 2 at conf 0.9: a drift read, but a single spike.
    mockScore.mockResolvedValueOnce([axisScore("darkness", 3, 0.9)]);
    expect(await runSakkanSample(db, campaignId, 8)).toEqual({ scored: 1, notesActive: 0 });
    let st = await readState(campaignId);
    expect(st.sakkan?.readings.darkness?.consecutive_drift).toBe(1);
    expect(st.sakkan?.active_notes).toHaveLength(0);
    expect(st.sakkan?.last_sample_turn).toBe(8);

    // Sample 2 — the second consecutive drift: the retake fires with the right values.
    mockScore.mockResolvedValueOnce([axisScore("darkness", 3, 0.9)]);
    expect(await runSakkanSample(db, campaignId, 16)).toEqual({ scored: 1, notesActive: 1 });
    st = await readState(campaignId);
    expect(st.sakkan?.readings.darkness?.consecutive_drift).toBe(DRIFT_CONSECUTIVE);
    expect(st.sakkan?.active_notes).toEqual([
      { axis: "darkness", active: 7, observed: 3, since_turn: 16 },
    ]);

    // Sample 3 — |7 − 7| = 0 ≤ 1: one in-band read resets the counter and expires the note.
    mockScore.mockResolvedValueOnce([axisScore("darkness", 7, 0.9)]);
    expect(await runSakkanSample(db, campaignId, 24)).toEqual({ scored: 1, notesActive: 0 });
    st = await readState(campaignId);
    expect(st.sakkan?.readings.darkness?.consecutive_drift).toBe(0);
    expect(st.sakkan?.active_notes).toHaveLength(0);
  });

  it("a low-confidence drift read holds the counter and leaves the note untouched", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({ directionState: { settei: settei(["darkness"]) } });
    await seedProse(campaignId, cleanSix());

    mockScore.mockResolvedValueOnce([axisScore("darkness", 3, 0.9)]);
    await runSakkanSample(db, campaignId, 8);
    mockScore.mockResolvedValueOnce([axisScore("darkness", 3, 0.9)]);
    await runSakkanSample(db, campaignId, 16); // note fires: observed 3, since 16

    // |7 − 2| = 5 ≥ 2 but conf 0.4 < 0.6 → the BETWEEN band: neither advance nor reset.
    mockScore.mockResolvedValueOnce([axisScore("darkness", 2, 0.4)]);
    expect(await runSakkanSample(db, campaignId, 24)).toEqual({ scored: 1, notesActive: 1 });

    const st = await readState(campaignId);
    // Counter held at 2 — a low-confidence read is not evidence either way.
    expect(st.sakkan?.readings.darkness?.consecutive_drift).toBe(2);
    // The reading itself recorded the fresh (low-confidence) observation…
    expect(st.sakkan?.readings.darkness?.observed).toBe(2);
    // …but the note did NOT refresh: still the turn-16 fire, still observed 3.
    expect(st.sakkan?.active_notes).toEqual([
      { axis: "darkness", active: 7, observed: 3, since_turn: 16 },
    ]);
  });

  it("degraded turns are excluded from the sample string", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({ directionState: { settei: settei(["darkness"]) } });
    // 6 turns; turns 1 and 3 are degraded — 4 clean survive the filter.
    await seedProse(campaignId, [
      { n: 1, degraded: true, text: "DEGRADED turn 1 — ladder output." },
      { n: 2, text: "CLEAN turn 2 — rain on the canal." },
      { n: 3, degraded: true, text: "DEGRADED turn 3 — ladder output." },
      { n: 4, text: "CLEAN turn 4 — a cigarette, unlit." },
      { n: 5, text: "CLEAN turn 5 — the elevator hummed." },
      { n: 6, text: "CLEAN turn 6 — she did not turn around." },
    ]);

    mockScore.mockResolvedValueOnce([axisScore("darkness", 6, 0.5)]);
    await runSakkanSample(db, campaignId, 8);

    const sample = mockScore.mock.calls[0]?.[1]?.sample ?? "";
    expect(sample).toContain("CLEAN turn 2");
    expect(sample).toContain("CLEAN turn 4");
    expect(sample).toContain("CLEAN turn 5");
    expect(sample).toContain("CLEAN turn 6");
    expect(sample).not.toContain("DEGRADED");
    // Oldest→newest, joined with the scene separator.
    expect(sample).toContain("--- scene break ---");
    expect(sample.indexOf("turn 2")).toBeLessThan(sample.indexOf("turn 6"));
  });

  it("writer #3 fires exactly once at MARK_CONSECUTIVE, not on every later drift", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({ directionState: { settei: settei(["darkness"]) } });
    await seedProse(campaignId, cleanSix());

    for (const turn of [8, 16]) {
      mockScore.mockResolvedValueOnce([axisScore("darkness", 3, 0.9)]);
      await runSakkanSample(db, campaignId, turn);
    }
    expect(await sakkanMarks(campaignId, "darkness")).toHaveLength(0);

    // Third consecutive same-axis drift → the pencil mark lands.
    mockScore.mockResolvedValueOnce([axisScore("darkness", 3, 0.9)]);
    await runSakkanSample(db, campaignId, 24);
    const afterThird = await sakkanMarks(campaignId, "darkness");
    expect(afterThird).toHaveLength(1);
    const mark = afterThird[0];
    expect(mark?.kind).toBe("axis");
    expect(mark?.topic).toBe("darkness");
    expect(mark?.turnId).toBe(24);
    expect(mark?.confidence).toBe(0.85);
    // observed 3 < wanted 7 → pull up.
    expect(mark?.direction).toContain("pull it up");
    expect(mark?.evidence).toContain("the neon guttered");

    // Fourth consecutive drift — still exactly one mark (=== MARK_CONSECUTIVE, not ≥).
    mockScore.mockResolvedValueOnce([axisScore("darkness", 3, 0.9)]);
    await runSakkanSample(db, campaignId, 32);
    expect(await sakkanMarks(campaignId, "darkness")).toHaveLength(1);
    const st = await readState(campaignId);
    expect(st.sakkan?.readings.darkness?.consecutive_drift).toBe(MARK_CONSECUTIVE + 1);
  });

  it("skip: zero scoreable axes returns null and never advances last_sample_turn", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({
      directionState: {
        settei: settei([]),
        sakkan: { last_sample_turn: 5, readings: {}, active_notes: [] },
      },
    });
    await seedProse(campaignId, cleanSix());

    expect(await runSakkanSample(db, campaignId, 20)).toBeNull();
    expect(mockScore).not.toHaveBeenCalled();
    const st = await readState(campaignId);
    expect(st.sakkan?.last_sample_turn).toBe(5);
  });

  it("skip: a scoreAxes rejection returns null and leaves the counters untouched", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign({
      directionState: {
        settei: settei(["darkness"]),
        sakkan: {
          last_sample_turn: 5,
          readings: {
            darkness: {
              observed: 3,
              confidence: 0.9,
              at_turn: 4,
              consecutive_drift: 1,
              evidence: "prior",
            },
          },
          active_notes: [],
        },
      },
    });
    await seedProse(campaignId, cleanSix());

    mockScore.mockRejectedValueOnce(new Error("scripted scorer failure"));
    expect(await runSakkanSample(db, campaignId, 12)).toBeNull();

    const st = await readState(campaignId);
    expect(st.sakkan?.last_sample_turn).toBe(5);
    expect(st.sakkan?.readings.darkness?.consecutive_drift).toBe(1);
  });

  it("compares against the EFFECTIVE premise (active ⊕ arc_override), not raw active", async () => {
    if (!db) throw new Error("unreachable");
    // Active darkness 7; an override lifts it to 9. Observed 9 reads IN BAND vs the
    // effective 9 (|9 − 9| = 0) — but would read as drift vs raw active 7 (|7 − 9| = 2).
    const campaignId = await makeCampaign({
      directionState: { settei: settei(["darkness"]) },
      arcOverride: {
        arc_name: "the reckoning",
        started_turn: 5,
        transition_signal: "the debt is called in",
        dna: { darkness: 9 },
      },
    });
    await seedProse(campaignId, cleanSix());

    for (const turn of [8, 16]) {
      mockScore.mockResolvedValueOnce([axisScore("darkness", 9, 0.9)]);
      await runSakkanSample(db, campaignId, turn);
    }

    const st = await readState(campaignId);
    // In band against the effective premise → no drift accrues, no retake fires.
    expect(st.sakkan?.readings.darkness?.consecutive_drift).toBe(0);
    expect(st.sakkan?.active_notes).toHaveLength(0);
  });
});
