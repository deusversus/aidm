import * as schema from "@/lib/db/schema";
import { callJudgment, callProbe } from "@/lib/llm/calls";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runLayout } from "../layout";

/**
 * §5.4 authorship gate (M2 C2, ratified 2026-07-10): the widened ingestion
 * gate is intent OR the orthogonal `contains_world_assertion` flag. These
 * layout-level tests pin the wiring the golden case needs:
 *  - flag orthogonality: a COMBAT scream carrying the flag RUNS ingestion; the
 *    same COMBAT beat without the flag does NOT (the plumbing, not detection —
 *    detection quality is the live-probe eval's job);
 *  - the Red Sash regression: an assertion inside a SOCIAL action (the M1 miss
 *    class, narrower intent-typed gate) now reaches ingestion and mints.
 *
 * Empty catalog + no memories keep the sakuga/genga call set minimal to script.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn(), callJudgment: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[authorship-gate] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const mockProbe = vi.mocked(callProbe);
const mockJudgment = vi.mocked(callJudgment);
const mockEmbed = vi.mocked(embedTexts);

function basis(i: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  return v;
}

/** Recorded-response harness: answers by call `name`, records the order. */
function armHarness(script: Record<string, unknown>) {
  const calls: string[] = [];
  const dispatch = (opts: { name: string }) => {
    calls.push(opts.name);
    const entry = script[opts.name];
    if (entry === undefined) throw new Error(`unscripted call: ${opts.name}`);
    return Promise.resolve(entry);
  };
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockProbe.mockImplementation((_sel: any, opts: any) => dispatch(opts) as any);
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockJudgment.mockImplementation((_sel: any, opts: any) => dispatch(opts) as any);
  return calls;
}

// A fully-scripted sakuga COMBAT turn; only the intent varies per test. A
// superset is safe — armHarness errors on UNSCRIPTED calls, never on unused.
function sakugaScript(contains_world_assertion: boolean) {
  return {
    intent_triage: {
      intent: "COMBAT",
      action: "strike",
      target: "the warden",
      epicness: 0.8,
      special_conditions: [],
      confidence: 0.9,
      contains_world_assertion,
    },
    world_assertion_extract: { facts: [] },
    pacer_micro: { beat_classification: "clash", tone: "grim", escalation: true },
    outcome_judgment: {
      success_level: "success",
      difficulty_class: 12,
      modifiers: [],
      narrative_weight: "SIGNIFICANT",
      rationale: "scripted",
    },
    outcome_validation: { is_valid: true },
    scale_imbalance: {
      context_modifiers: [],
      primary_scale: "tactical",
      threat_tier: 5,
      rationale: "scripted",
    },
  };
}

describe.skipIf(!url)("Authorship gate (real Postgres, scripted models)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "authorship@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "Authorship gate fixture",
        status: "active",
        premiseContract: bebopContract(),
        tierModels: {
          narration: "claude-sonnet-5",
          judgment: "claude-sonnet-5",
          probe: "claude-haiku-4-5",
        },
      })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockProbe.mockReset();
    mockJudgment.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => basis(0)));
    // Empty catalog every test (some mint entities).
    await db.delete(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    await db
      .delete(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
  });

  it("orthogonality: COMBAT + contains_world_assertion true RUNS the ingestion probe", async () => {
    if (!db) throw new Error("unreachable");
    const calls = armHarness(sakugaScript(true));
    const result = await runLayout(db, campaignId, 1, "I WILL NOT LOSE! FOR EVERYONE YOU KILLED!");
    expect(result.kind).toBe("conte");
    // The flag — not the COMBAT intent — opened the gate.
    expect(calls).toContain("world_assertion_extract");
    expect(calls.indexOf("world_assertion_extract")).toBeGreaterThan(
      calls.indexOf("intent_triage"),
    );
  });

  it("orthogonality: COMBAT + contains_world_assertion false does NOT run ingestion", async () => {
    if (!db) throw new Error("unreachable");
    const calls = armHarness(sakugaScript(false));
    const result = await runLayout(db, campaignId, 2, "I swing again, harder");
    expect(result.kind).toBe("conte");
    // Same COMBAT beat, flag down → the gate stays closed.
    expect(calls).not.toContain("world_assertion_extract");
  });

  it("Red Sash regression: an assertion inside a SOCIAL action reaches ingestion and mints", async () => {
    if (!db) throw new Error("unreachable");
    const calls = armHarness({
      // SOCIAL, moderate epicness, no flags → genga; the M1 gate would have
      // dropped this (intent-typed, not WORLD_BUILDING). The flag reopens it.
      intent_triage: {
        intent: "SOCIAL",
        action: "declare",
        target: "the crowd",
        epicness: 0.4,
        special_conditions: [],
        confidence: 0.9,
        contains_world_assertion: true,
      },
      world_assertion_extract: {
        facts: [
          {
            kind: "faction",
            entity_name: "The Red Sash",
            content: "The Red Sash is a syndicate-aligned gang that runs the harbor district.",
            posture: "accept",
          },
        ],
      },
      pacer_micro: { beat_classification: "confrontation", tone: "tense", escalation: false },
      outcome_judgment: {
        success_level: "partial_success",
        difficulty_class: 10,
        modifiers: [],
        narrative_weight: "SIGNIFICANT",
        rationale: "scripted",
      },
    });

    const result = await runLayout(
      db,
      campaignId,
      3,
      "I tell them the Red Sash already owns this harbor",
    );
    expect(result.kind).toBe("conte");
    expect(calls).toContain("world_assertion_extract");

    const [faction] = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "The Red Sash")),
      );
    expect(faction).toBeDefined();
    expect(faction?.entityType).toBe("faction");
    if (result.kind === "conte") {
      expect(result.assertion?.writes.some((w) => w.includes("Red Sash"))).toBe(true);
    }
  });
});
