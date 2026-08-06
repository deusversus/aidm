import { assembleForCampaign } from "@/lib/blocks/campaign";
import * as schema from "@/lib/db/schema";
import { applyRecordCorrection } from "@/lib/ingestion/ingest";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { rewindCampaign } from "@/lib/turn/rewind";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeBoothIfOpen, runBoothExchange } from "../booth";

/**
 * The booth corrections channel (M3R2 C4) against real Postgres with scripted
 * models — the FOUNDING INCIDENT as fixture.
 *
 * On 2026-08-03 the player told the booth a hard line had been recorded
 * INVERTED ("the hardline is the opposite of what I'd asked for"). The Writer
 * agreed and promised the fix; the close-time resolution had no write path to
 * the record; the row was corrected by hand in SQL that night. What follows is
 * that conversation with a pen in it: the record changes, the change is
 * revocable, and every path that CANNOT change the record says so instead of
 * promising.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return {
    ...actual,
    callProbe: vi.fn(),
    callJudgment: vi.fn(),
    streamNarration: vi.fn(),
  };
});
vi.mock("@/lib/blocks/campaign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blocks/campaign")>();
  return { ...actual, assembleForCampaign: vi.fn() };
});
// The real correction machinery, wrapped: only the throw test overrides it
// (mockRejectedValueOnce), so every other test still writes to real Postgres.
vi.mock("@/lib/ingestion/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingestion/ingest")>();
  return { ...actual, applyRecordCorrection: vi.fn(actual.applyRecordCorrection) };
});

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockStream = vi.mocked(streamNarration);
const mockAssemble = vi.mocked(assembleForCampaign);
const mockApply = vi.mocked(applyRecordCorrection);

const BLOCKS = { system: [{ type: "text" as const, text: "BLOCK1" }], exchangeMessages: [] };

function narr(prose: string) {
  return {
    stream: { on: () => {} },
    done: async () => ({
      message: {
        content: [{ type: "text", text: prose }],
        stop_reason: "end_turn",
        model: "scripted",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      prose,
      sidecar: null,
      fallbackUsed: false,
      refused: false,
      costUsd: 0,
    }),
  } as unknown as ReturnType<typeof streamNarration>;
}

/** The judgment mock routes by call name — gate, resolution, and block revise all land here. */
type JudgmentScript = {
  gate?: unknown;
  resolution?: unknown;
  revise?: unknown;
  gateError?: Error;
};
function scriptJudgment(script: JudgmentScript) {
  mockJudgment.mockImplementation(async (_sel: unknown, opts: unknown) => {
    const name = (opts as { name?: string }).name;
    if (name === "correction_comprehension") {
      if (script.gateError) throw script.gateError;
      return (script.gate ?? {
        player_states_record_is_wrong: false,
        target_kind: "critical_fact",
        target_hint: "",
        record_text: "",
      }) as never;
    }
    if (name === "block_revise") {
      return (script.revise ?? { revised_block: "revised" }) as never;
    }
    return (script.resolution ?? { marks: [], overrides: [], summary: "nothing settled" }) as never;
  });
}

/** The frame the responder actually received — where FILED / HEARD is stated. */
function responderFrame(nth = 0): string {
  const call = mockStream.mock.calls[nth]?.[0] as { messages: { content: unknown }[] } | undefined;
  return String(call?.messages.at(-1)?.content ?? "");
}

/** How many times a named model call actually ran (the ledger's cost claim). */
function judgmentCalls(name: string): number {
  return mockJudgment.mock.calls.filter((c) => (c[1] as { name?: string })?.name === name).length;
}

const url = process.env.DATABASE_URL;
if (!url) console.warn("[booth-corrections] DATABASE_URL not set — skipping real-DB suite");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const SELECTION: TierSelection = {
  narration: "claude-sonnet-5",
  judgment: "claude-haiku-4-5",
  probe: "claude-haiku-4-5",
};

/** The record as it stood on 2026-08-03 — the inversion, verbatim in shape. */
const INVERTED_HARD_LINE = `HARD LINE (absolute): no "nah id win" energy — the protagonist never shrugs off a real threat`;
const CORRECTED_HARD_LINE = `HARD LINE (absolute): the protagonist keeps "nah id win" energy — unshaken in the face of a real threat`;
const PLAYER_WORDS =
  "the hardline is the opposite of what I'd asked for — I WANT 'nah id win' energy";

const SEEDED_BLOCK = [
  "- A junk dealer with a story for every piece on the shelf.",
  "- He fell at the siege of Duncairn.",
  "- Keeps a standing debt with the Ashen Circle.",
].join("\n");
const REVISED_BLOCK = [
  "- A junk dealer with a story for every piece on the shelf.",
  "- He survived the siege of Duncairn.",
  "- Keeps a standing debt with the Ashen Circle.",
].join("\n");

describe.skipIf(!url)("Booth corrections channel (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  const campaignIds: string[] = [];

  async function makeCampaign(): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [c] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "corrections fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: SELECTION,
      })
      .returning({ id: schema.campaigns.id });
    if (!c) throw new Error("campaign insert failed");
    campaignIds.push(c.id);
    return c.id;
  }

  /** The SZ compiler's own shape for a hard line: a layer-9 contract fact at turn 0. */
  async function seedHardLine(campaignId: string, content = INVERTED_HARD_LINE): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [row] = await db
      .insert(schema.criticalFacts)
      .values({
        campaignId,
        content,
        category: "contract",
        turnId: 0,
        provenance: "sz_resolution",
        confidence: 1,
      })
      .returning({ id: schema.criticalFacts.id });
    if (!row) throw new Error("critical fact seed failed");
    return row.id;
  }

  /** A lived-in dossier block: corrections are surgical, and the revise's own
   *  sanity gate (M2 C3) reads the surviving lines to prove it wasn't a reroll. */
  async function seedEntity(campaignId: string): Promise<string> {
    if (!db) throw new Error("unreachable");
    const [ent] = await db
      .insert(schema.entities)
      .values({
        campaignId,
        name: "Casimir Thoss",
        entityType: "npc",
        block: SEEDED_BLOCK,
        turnId: 0,
        provenance: "sz_resolution",
        confidence: 1,
      })
      .returning({ id: schema.entities.id });
    if (!ent) throw new Error("entity seed failed");
    await db.insert(schema.entityVersions).values({
      entityId: ent.id,
      version: 1,
      block: SEEDED_BLOCK,
      turnId: 0,
      provenance: "sz_resolution",
      confidence: 1,
    });
    return ent.id;
  }

  function factsFor(campaignId: string) {
    if (!db) throw new Error("unreachable");
    return db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
  }

  function liveFactsFor(campaignId: string) {
    if (!db) throw new Error("unreachable");
    return db
      .select()
      .from(schema.criticalFacts)
      .where(
        and(
          eq(schema.criticalFacts.campaignId, campaignId),
          isNull(schema.criticalFacts.tombstonedAt),
        ),
      );
  }

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "corrections@example.com" });
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
    mockProbe.mockReset();
    mockJudgment.mockReset();
    mockStream.mockReset();
    mockAssemble.mockReset();
    mockAssemble.mockResolvedValue(BLOCKS as never);
    mockStream.mockImplementation(() => narr("Filed — that hard line reads the other way now."));
    mockProbe.mockResolvedValue({
      responder: "director",
      reason: "record",
      record_correction_signal: true,
    } as never);
    scriptJudgment({});
  });

  // -------------------------------------------------------------------------

  it("THE FOUNDING INCIDENT: the inverted hard line is retired and replaced under player_correction", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const originalId = await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: INVERTED_HARD_LINE,
        record_text: CORRECTED_HARD_LINE,
      },
    });

    await runBoothExchange(db, campaignId, 12, PLAYER_WORDS, () => {});

    const rows = await factsFor(campaignId);
    expect(rows).toHaveLength(2);

    // The wrong line is RETIRED — tombstoned in place, never deleted, and
    // anchored on the timeline so a rewind can undo the retirement itself.
    const original = rows.find((r) => r.id === originalId);
    expect(original?.tombstonedAt).not.toBeNull();
    expect(original?.retiredAtTurn).toBe(12);

    // The replacement is the player's word: confidence 1, at THIS turn.
    const [live] = await liveFactsFor(campaignId);
    expect(live?.content).toBe(CORRECTED_HARD_LINE);
    expect(live?.category).toBe("contract"); // inherited from the retired row
    expect(live?.turnId).toBe(12);
    expect(live?.provenance).toBe("player_correction");
    expect(Number(live?.confidence)).toBeCloseTo(1);
    expect(live?.retiredAtTurn).toBeNull();
  });

  it("the replacement INHERITS the retired line's register when the gate drops the prefix", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    // The gate is TOLD "a hard line stays 'HARD LINE (absolute): ...'" and is
    // not held to it — free text from a model. A bare replacement is still a
    // live critical fact (the pen sees it), but it stops reading as absolute
    // and drops out of the Series Bible's hard-lines section, which finds them
    // BY the prefix. The record's register is the record's, not player prose.
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: INVERTED_HARD_LINE,
        record_text: `the protagonist keeps "nah id win" energy`,
      },
    });

    await runBoothExchange(db, campaignId, 21, PLAYER_WORDS, () => {});

    const [live] = await liveFactsFor(campaignId);
    expect(live?.content).toBe(`HARD LINE (absolute): the protagonist keeps "nah id win" energy`);
    expect(live?.category).toBe("contract");
    // Inherited, never doubled: a gate that DID keep the register is untouched.
    expect(live?.content.match(/HARD LINE/g)).toHaveLength(1);
    // And what the responder is told to quote is what the record now reads.
    expect(responderFrame()).toContain(
      `FILED — the record now reads: "HARD LINE (absolute): the protagonist keeps`,
    );
  }, 20_000);

  it("the responder is told the write LANDED before it speaks — the acknowledgement names the record", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: INVERTED_HARD_LINE,
        record_text: CORRECTED_HARD_LINE,
      },
    });

    await runBoothExchange(db, campaignId, 5, PLAYER_WORDS, () => {});

    const frame = responderFrame();
    expect(frame).toContain("Record changes on this message");
    expect(frame).toContain("FILED — the record now reads");
    expect(frame).toContain(CORRECTED_HARD_LINE);
    // The standing discipline rides every booth frame, filed or not: the
    // 2026-08-03 failure was a promise, not a missing field.
    expect(frame).toContain("Never say a record was fixed");
  });

  it("REVOCABILITY: rewinding past the correction restores the record the player retired", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const originalId = await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: INVERTED_HARD_LINE,
        record_text: CORRECTED_HARD_LINE,
      },
    });
    // A turn must exist past the target for the rewind to have something to undo.
    await db.insert(schema.turns).values({
      campaignId,
      turnNumber: 12,
      tier: "genga",
      status: "complete",
      playerInput: PLAYER_WORDS,
    });

    await runBoothExchange(db, campaignId, 12, PLAYER_WORDS, () => {});
    expect((await liveFactsFor(campaignId))[0]?.content).toBe(CORRECTED_HARD_LINE);

    await rewindCampaign(db, campaignId, 11, "correction revocability");

    // The correction is gone AND the retirement is undone: the record the
    // player corrected away is live again, not merely un-replaced.
    const live = await liveFactsFor(campaignId);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(originalId);
    expect(live[0]?.content).toBe(INVERTED_HARD_LINE);
    expect(live[0]?.retiredAtTurn).toBeNull();

    const all = await factsFor(campaignId);
    const replacement = all.find((r) => r.id !== originalId);
    expect(replacement?.tombstonedAt).not.toBeNull(); // the write stays for provenance
  });

  it("an unresolvable target files NOTHING and says why — never a silent guess", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: "a line the record has never contained",
        record_text: "HARD LINE (absolute): something else entirely",
      },
    });

    await runBoothExchange(db, campaignId, 6, PLAYER_WORDS, () => {});

    // The record is untouched — no retire, no replacement.
    const rows = await factsFor(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tombstonedAt).toBeNull();

    const frame = responderFrame();
    expect(frame).toContain("HEARD, NOT FILED");
    expect(frame).toContain("no live record matches");
    expect(frame).not.toContain("FILED — the record now reads");
  });

  it("the gate bounces musing: signalled, judged false, nothing written", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: false,
        target_kind: "critical_fact",
        target_hint: "",
        record_text: "",
      },
    });

    await runBoothExchange(db, campaignId, 7, "I've been wondering about that hard line", () => {});

    const rows = await factsFor(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tombstonedAt).toBeNull();
    expect(responderFrame()).toContain("HEARD, NOT FILED");
  });

  it("a gate that THROWS files nothing and the booth still answers (fail-open, honest)", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    scriptJudgment({ gateError: new Error("scripted gate failure") });

    const res = await runBoothExchange(db, campaignId, 8, PLAYER_WORDS, () => {});

    expect(res.reply).toBeTruthy(); // the booth never wedges on a gate failure
    expect((await factsFor(campaignId))[0]?.tombstonedAt).toBeNull();
    expect(responderFrame()).toContain("HEARD, NOT FILED");
    warn.mockRestore();
  });

  it("no correction signal → the gate never runs (the ladder's cost discipline)", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    mockProbe.mockResolvedValue({
      responder: "ka",
      reason: "prose",
      record_correction_signal: false,
    } as never);

    await runBoothExchange(db, campaignId, 9, "why is the prose so terse lately?", () => {});

    expect(mockJudgment).not.toHaveBeenCalled();
    // No outcome section at all (the standing discipline still rides the frame,
    // which is why the heading, not the phrase, is what's asserted).
    expect(responderFrame()).not.toContain("## Record changes");
  });

  it("re-filing the same correction is a no-op: the retired text is no longer live", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: INVERTED_HARD_LINE,
        record_text: CORRECTED_HARD_LINE,
      },
    });

    await runBoothExchange(db, campaignId, 12, PLAYER_WORDS, () => {});
    // A crash-replay at a LATER turn re-runs the same correction: the target
    // it names is retired, so it resolves to nothing and writes nothing.
    await runBoothExchange(db, campaignId, 13, PLAYER_WORDS, () => {});

    expect(await factsFor(campaignId)).toHaveLength(2);
    expect(await liveFactsFor(campaignId)).toHaveLength(1);
    warn.mockRestore();
  });

  it("the entity path corrects the living dossier and stacks a revocable version row", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const ent = await seedEntity(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "entity",
        target_hint: "casimir thoss", // identity-key match, not exact spelling
        record_text: "Casimir Thoss survived the siege of Duncairn.",
      },
      revise: { revised_block: REVISED_BLOCK },
    });

    await runBoothExchange(db, campaignId, 14, "no — Casimir lived through Duncairn", () => {});

    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, ent));
    expect(row?.block).toBe(REVISED_BLOCK);

    const versions = await db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, ent));
    expect(versions).toHaveLength(2);
    const v2 = versions.find((v) => v.version === 2);
    expect(v2?.provenance).toBe("player_correction");
    expect(Number(v2?.confidence)).toBeCloseTo(1);
    expect(v2?.turnId).toBe(14);
    expect(responderFrame()).toContain("FILED — the record now reads");
  });

  it("a hint that QUOTES the wrong dossier line resolves the entity and names the retired line", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    await seedEntity(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "entity",
        // No name at all — the player quoted the line that is wrong.
        target_hint: "He fell at the siege of Duncairn.",
        record_text: "Casimir Thoss survived the siege of Duncairn.",
      },
      revise: { revised_block: REVISED_BLOCK },
    });

    await runBoothExchange(db, campaignId, 15, "no — he lived through Duncairn", () => {});

    const reviseCall = mockJudgment.mock.calls.find(
      (c) => (c[1] as { name?: string })?.name === "block_revise",
    );
    // The quoted line rides into the revise as THE line being retired — that
    // is what keeps the rewrite surgical instead of a whole-block reroll.
    expect(String((reviseCall?.[1] as { prompt?: string })?.prompt)).toContain(
      "THE LINE BEING RETIRED",
    );
    expect(responderFrame()).toContain("FILED — the record now reads");
  });

  // --- The ledger: an entity correction files ONCE ---------------------------

  const ENTITY_GATE = {
    player_states_record_is_wrong: true,
    target_kind: "entity",
    target_hint: "casimir thoss",
    record_text: "Casimir Thoss survived the siege of Duncairn.",
  };
  const ENTITY_WORDS = "no — Casimir lived through Duncairn";

  function versionsFor(entityId: string) {
    if (!db) throw new Error("unreachable");
    return db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, entityId));
  }

  it("LEDGER (replay): re-running the same ENTITY correction revises the dossier exactly once", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const ent = await seedEntity(campaignId);
    scriptJudgment({ gate: ENTITY_GATE, revise: { revised_block: REVISED_BLOCK } });

    await runBoothExchange(db, campaignId, 14, ENTITY_WORDS, () => {});
    // The crash-replay case the critical_fact path gets for free: an entity
    // revision NEVER tombstones its row, so the same hint resolves the same
    // live dossier again and the record gets revised on top of itself.
    await runBoothExchange(db, campaignId, 15, ENTITY_WORDS, () => {});

    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, ent));
    expect(row?.block).toBe(REVISED_BLOCK);
    // v1 (seed) + v2 (the one correction). A third row is the double-file.
    expect(await versionsFor(ent)).toHaveLength(2);
    // The second pass paid for its gate (the hint is the gate's own output at
    // this site) but not for the revise, and not for the write.
    expect(judgmentCalls("block_revise")).toBe(1);
    expect(responderFrame(1)).toContain("FILED (already)");
  });

  it("LEDGER (close-time sweep): the net skips what the exchange already filed, before the gate", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const ent = await seedEntity(campaignId);
    scriptJudgment({
      gate: ENTITY_GATE,
      revise: { revised_block: REVISED_BLOCK },
      resolution: {
        marks: [],
        overrides: [],
        summary: "fixed Casimir's dossier",
        corrections: [
          {
            target_kind: "entity",
            target_hint: "casimir thoss",
            corrected_content: "Casimir Thoss survived the siege of Duncairn.",
            player_words: ENTITY_WORDS,
          },
        ],
      },
    });

    await runBoothExchange(db, campaignId, 16, ENTITY_WORDS, () => {});
    await closeBoothIfOpen(db, campaignId, 17);

    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, ent));
    expect(row?.block).toBe(REVISED_BLOCK);
    expect(await versionsFor(ent)).toHaveLength(2);
    // One gate (the exchange's) — the close-time proposal carries the target up
    // front, so the ledger answers it without a model call at all.
    expect(judgmentCalls("correction_comprehension")).toBe(1);
    expect(judgmentCalls("block_revise")).toBe(1);
    const [campaign] = await db
      .select({ b: schema.campaigns.boothState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(campaign?.b).toBeNull(); // the booth still closed
  });

  it("ATOMICITY: a version-insert failure rolls the revised block back — filed:false MEANS nothing changed", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    const ent = await seedEntity(campaignId);
    scriptJudgment({ revise: { revised_block: REVISED_BLOCK } });

    // A real, forced failure of the SECOND write: turn_id is int4, so the
    // version row cannot land while the block update (issued first) can.
    const outcome = await applyRecordCorrection(db, SELECTION, {
      campaignId,
      turnNumber: 3_000_000_000,
      targetKind: "entity",
      targetHint: "casimir thoss",
      correctedContent: "Casimir Thoss survived the siege of Duncairn.",
    });

    expect(outcome.filed).toBe(false);
    const [row] = await db.select().from(schema.entities).where(eq(schema.entities.id, ent));
    expect(row?.block).toBe(SEEDED_BLOCK); // rolled back, not half-written
    expect(await versionsFor(ent)).toHaveLength(1);
    warn.mockRestore();
  });

  it("a THROWING record write files nothing and the booth still answers (the exchange survives)", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: INVERTED_HARD_LINE,
        record_text: CORRECTED_HARD_LINE,
      },
    });
    mockApply.mockRejectedValueOnce(new Error("pool timeout mid-write"));

    const res = await runBoothExchange(db, campaignId, 18, PLAYER_WORDS, () => {});

    // The whole point: a DB error on the write is a SENTENCE, not a dead
    // exchange whose player message never reached booth_state.
    expect(res.reply).toBeTruthy();
    const frame = responderFrame();
    expect(frame).toContain("HEARD, NOT FILED");
    expect(frame).toContain("the record write failed");
    expect(frame).toContain("pool timeout mid-write");
    expect(frame).not.toContain("FILED — the record now reads");
    expect((await factsFor(campaignId))[0]?.tombstonedAt).toBeNull();

    const [campaign] = await db
      .select({ b: schema.campaigns.boothState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    const exchanges = (campaign?.b as { exchanges?: unknown[] } | null)?.exchanges ?? [];
    expect(exchanges).toHaveLength(2);
    warn.mockRestore();
  });

  // --- The hint floor: an ambiguous bind is a bounce, never a coin flip ------

  it("a hint matching MORE THAN ONE live record files nothing and asks for the exact line", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId, "HARD LINE (absolute): no bleak endings");
    await seedHardLine(campaignId, "HARD LINE (absolute): no gratuitous cruelty");
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        // Long enough to clear the floor, generic enough to be BOTH lines.
        target_hint: "HARD LINE (absolute):",
        record_text: "HARD LINE (absolute): bleak endings are welcome",
      },
    });

    await runBoothExchange(db, campaignId, 19, PLAYER_WORDS, () => {});

    // Both rows live, untouched: the select has no ORDER BY, so binding to the
    // first hit made a destructive retire depend on physical row order.
    const rows = await factsFor(campaignId);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.tombstonedAt).toBeNull();
    const frame = responderFrame();
    expect(frame).toContain("matches 2 live records");
    expect(frame).toContain("quote the exact line as it stands");
    warn.mockRestore();
  });

  it("a degenerate hint is refused on length alone — it would have matched anything", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    scriptJudgment({
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: "the", // contained in essentially every record line
        record_text: "HARD LINE (absolute): something else entirely",
      },
    });

    await runBoothExchange(db, campaignId, 20, PLAYER_WORDS, () => {});

    const rows = await factsFor(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tombstonedAt).toBeNull();
    expect(responderFrame()).toContain("too short to name a record line");
    warn.mockRestore();
  });

  // --- The close-time net --------------------------------------------------

  it("close-time: a correction settled across exchanges files through the same machinery", async () => {
    if (!db) throw new Error("unreachable");
    const campaignId = await makeCampaign();
    const originalId = await seedHardLine(campaignId);
    await db
      .update(schema.campaigns)
      .set({
        boothState: {
          opened_at_turn: 3,
          exchanges: [
            { role: "player", text: "wait, that hard line is backwards", at_turn: 3 },
            { role: "studio", text: "backwards how?", responder: "director", at_turn: 3 },
            { role: "player", text: PLAYER_WORDS, at_turn: 4 },
            { role: "studio", text: "got it", responder: "director", at_turn: 4 },
          ],
        },
      })
      .where(eq(schema.campaigns.id, campaignId));
    scriptJudgment({
      resolution: {
        marks: [],
        overrides: [],
        summary: "the hard line was inverted",
        corrections: [
          {
            target_kind: "critical_fact",
            target_hint: INVERTED_HARD_LINE,
            corrected_content: CORRECTED_HARD_LINE,
            player_words: PLAYER_WORDS,
          },
        ],
      },
      gate: {
        player_states_record_is_wrong: true,
        target_kind: "critical_fact",
        target_hint: INVERTED_HARD_LINE,
        record_text: CORRECTED_HARD_LINE,
      },
    });

    await closeBoothIfOpen(db, campaignId, 5);

    const live = await liveFactsFor(campaignId);
    expect(live).toHaveLength(1);
    expect(live[0]?.content).toBe(CORRECTED_HARD_LINE);
    expect(live[0]?.provenance).toBe("player_correction");
    expect(live[0]?.turnId).toBe(5);
    const [original] = await db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.id, originalId));
    expect(original?.retiredAtTurn).toBe(5);
  });

  it("close-time: a correction quoting the STUDIO'S words is dropped — the gate never even runs", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    await seedHardLine(campaignId);
    await db
      .update(schema.campaigns)
      .set({
        boothState: {
          opened_at_turn: 3,
          exchanges: [
            { role: "player", text: "the pacing feels off in the back half", at_turn: 3 },
            {
              role: "studio",
              text: "you're right that the hard line reads inverted — I'll fix it",
              responder: "ka",
              at_turn: 3,
            },
          ],
        },
      })
      .where(eq(schema.campaigns.id, campaignId));
    scriptJudgment({
      resolution: {
        marks: [],
        overrides: [],
        summary: "discussed the hard line",
        corrections: [
          {
            target_kind: "critical_fact",
            target_hint: INVERTED_HARD_LINE,
            corrected_content: CORRECTED_HARD_LINE,
            // The RESPONDER's sentence, not the player's — inference, not authority.
            player_words: "the hard line reads inverted",
          },
        ],
      },
    });

    await closeBoothIfOpen(db, campaignId, 6);

    const rows = await factsFor(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tombstonedAt).toBeNull();
    // One judgment call only — the resolution. The ungrounded correction never
    // reached the gate, let alone the record.
    expect(mockJudgment).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("close-time: surplus corrections clamp at the ceiling, the resolution still lands", async () => {
    if (!db) throw new Error("unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaignId = await makeCampaign();
    await db
      .update(schema.campaigns)
      .set({
        boothState: {
          opened_at_turn: 3,
          exchanges: [
            { role: "player", text: "several things in the record are wrong", at_turn: 3 },
            { role: "studio", text: "walk me through them", responder: "director", at_turn: 3 },
          ],
        },
      })
      .where(eq(schema.campaigns.id, campaignId));
    scriptJudgment({
      resolution: {
        marks: [],
        overrides: [],
        summary: "record clean-up",
        corrections: Array.from({ length: 5 }, (_, i) => ({
          target_kind: "critical_fact",
          target_hint: `nothing matches this ${i}`,
          corrected_content: `replacement ${i}`,
          // Ungrounded on purpose: the clamp is what this test pins, and a
          // dropped-at-the-words-gate correction still proves the count.
          player_words: "several things in the record are wrong",
        })),
      },
      gate: {
        player_states_record_is_wrong: false,
        target_kind: "critical_fact",
        target_hint: "",
        record_text: "",
      },
    });

    await closeBoothIfOpen(db, campaignId, 7);

    // 1 resolution + BOOTH_CORRECTIONS_MAX gate calls — the surplus two were
    // discarded unread, and the booth still closed.
    expect(mockJudgment).toHaveBeenCalledTimes(4);
    const [row] = await db
      .select({ b: schema.campaigns.boothState })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(row?.b).toBeNull();
    warn.mockRestore();
  });
});
