import * as schema from "@/lib/db/schema";
import { callJudgment, callProbe } from "@/lib/llm/calls";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runLayout } from "../layout";

/**
 * §5.3 wiring: with seeded repetitive episodic rows, a genga/sakuga conte
 * must carry the measured style-drift directive; a douga turn must not run the
 * detector at all. Kept in its own file so the shared layout.integration
 * harness stays untouched.
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
if (!url) console.warn("[antirep-layout] DATABASE_URL not set — skipping");
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

function armHarness(script: Record<string, unknown>) {
  const dispatch = (opts: { name: string }) => {
    const entry = script[opts.name];
    if (entry === undefined) throw new Error(`unscripted call: ${opts.name}`);
    return Promise.resolve(entry);
  };
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockProbe.mockImplementation((_sel: any, opts: any) => dispatch(opts) as any);
  // biome-ignore lint/suspicious/noExplicitAny: harness spans generic signatures
  mockJudgment.mockImplementation((_sel: any, opts: any) => dispatch(opts) as any);
}

const GENGA_INTENT = {
  intent: "EXPLORATION",
  action: "search",
  target: "the derelict",
  epicness: 0.4,
  special_conditions: [],
  confidence: 0.9,
};

const ENV = { turnId: 1, provenance: "test_seed", confidence: 0.9 };

describe.skipIf(!url)("Layout ← anti-repetition wiring (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "antirep-layout@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "antirep-layout fixture",
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

    // Three consecutive dialogue-opening scenes — a measurable repetition.
    const scenes = [
      '"Move it," Jet barked, shoving past the crew.',
      '"You again," Faye said, not bothering to look up.',
      '"Bang," Spike whispered, and holstered the empty gun.',
    ];
    for (let i = 0; i < scenes.length; i++) {
      await db.insert(schema.episodicRecords).values({
        campaignId,
        turnNumber: i + 1,
        playerInput: `input ${i + 1}`,
        narration: scenes[i] ?? "",
        ...ENV,
      });
    }
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

  beforeEach(() => {
    mockProbe.mockReset();
    mockJudgment.mockReset();
    mockEmbed.mockReset();
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => basis(0)));
  });

  it("genga conte carries the measured style-drift directive", async () => {
    if (!db) throw new Error("unreachable");
    armHarness({
      intent_triage: GENGA_INTENT,
      pacer_micro: { beat_classification: "investigation", tone: "wary", escalation: false },
      relevance_filter: { scores: [] },
      outcome_judgment: {
        success_level: "failure",
        difficulty_class: 10,
        modifiers: ["+5 Prepared"],
        narrative_weight: "SIGNIFICANT",
        rationale: "scripted",
      },
    });

    const result = await runLayout(
      db,
      campaignId,
      10,
      "I search the derelict for Vicious",
      () => {},
    );
    expect(result.kind).toBe("conte");
    if (result.kind !== "conte") return;
    expect(result.conte.tier).toBe("genga");
    expect(result.conte.style_drift_directive).toBeDefined();
    expect(result.conte.style_drift_directive).toMatch(/scene/i);
  });

  it("douga never runs the detector (no directive, no embedding call)", async () => {
    if (!db) throw new Error("unreachable");
    armHarness({
      intent_triage: { ...GENGA_INTENT, intent: "DEFAULT", epicness: 0.05 },
    });

    const result = await runLayout(db, campaignId, 11, "I pour a coffee", () => {});
    expect(result.kind).toBe("conte");
    if (result.kind !== "conte") return;
    expect(result.conte.tier).toBe("douga");
    expect(result.conte.style_drift_directive).toBeUndefined();
    expect(result.conte.vocab_freshness_advisory).toBeUndefined();
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
