import { recordModelCall } from "@/lib/observability/meter";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spend attribution reaches the ledger (M3 C1). The 2026-08-01 audit measured
 * 47% of real spend invisible to per-turn telemetry — session opens, recaps,
 * pre-warms, Director cycles — because the row said WHAT ran (tier, model) and
 * never WHY. `phase` is that column; this pins that it survives the write.
 */

const { rows } = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        rows.push(v);
      },
    }),
  }),
}));

beforeEach(() => {
  rows.length = 0;
});

const usage = { input_tokens: 100, output_tokens: 10 };

describe("recordModelCall carries the phase", () => {
  it("writes the phase it was given", async () => {
    await recordModelCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tier: "narration",
      phase: "session_open",
      usage,
      latencyMs: 10,
      campaignId: "c1",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.phase).toBe("session_open");
  });

  it("leaves the column NULL when no phase is known — an honest gap, not a zero", async () => {
    await recordModelCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tier: "judgment",
      usage,
      latencyMs: 10,
    });

    expect(rows[0]?.phase).toBeUndefined();
  });

  it("every other column is untouched by the addition", async () => {
    await recordModelCall({
      provider: "voyage",
      model: "voyage-3.5",
      tier: "embedding",
      phase: "sz",
      usage: { input_tokens: 42, output_tokens: 0 },
      latencyMs: 7,
      campaignId: "c1",
      turnNumber: 3,
    });

    expect(rows[0]).toMatchObject({
      provider: "voyage",
      model: "voyage-3.5",
      tier: "embedding",
      phase: "sz",
      inputTokens: 42,
      outputTokens: 0,
      turnNumber: 3,
    });
  });
});

/**
 * The search fee's zero (M3R3 C2). The column is nullable because rows
 * predating the fallback chain never could search; 0 is a different claim —
 * "this call had eyes and used none of them" — and it only reaches the row if
 * nothing between usageStats and the insert treats it as absence.
 */
describe("recordModelCall carries the web-search count", () => {
  it("writes a reported 0 as 0, not NULL", async () => {
    await recordModelCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tier: "judgment",
      phase: "research",
      usage: { ...usage, web_search_requests: 0 },
      latencyMs: 10,
      campaignId: "c1",
    });

    expect(rows[0]?.webSearchRequests).toBe(0);
  });

  it("bills the searches it is given and leaves the column NULL when the call had no eyes", async () => {
    await recordModelCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tier: "judgment",
      phase: "research",
      usage: { ...usage, web_search_requests: 3 },
      latencyMs: 10,
    });
    await recordModelCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tier: "judgment",
      usage,
      latencyMs: 10,
    });

    expect(rows[0]?.webSearchRequests).toBe(3);
    // 3 searches = $0.03 on top of the token cost, never inside it.
    expect(Number(rows[0]?.costUsd)).toBeCloseTo(Number(rows[1]?.costUsd) + 0.03);
    expect(rows[1]?.webSearchRequests).toBeUndefined();
  });
});
