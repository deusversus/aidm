import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../counters", () => ({
  incrementRateCounter: vi.fn(),
  getCurrentDayCost: vi.fn(),
  getUserDailyCap: vi.fn(),
}));

vi.mock("../config", async () => {
  const real = await vi.importActual<typeof import("../config")>("../config");
  return {
    ...real,
    getTurnRateCap: vi.fn(() => 6),
  };
});

const NOW = new Date(Date.UTC(2026, 3, 22, 15, 42, 30, 0));

describe("checkBudget (atomic rate increment + cost cap)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bypass skips everything — no reads, no increment", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    const result = await checkBudget("user-1", { bypass: true, now: NOW });
    expect(result).toEqual({ ok: true });
    expect(counters.incrementRateCounter).not.toHaveBeenCalled();
    expect(counters.getCurrentDayCost).not.toHaveBeenCalled();
    expect(counters.getUserDailyCap).not.toHaveBeenCalled();
  });

  it("returns ok when cost gate skipped (null cap) and post-increment rate < cap", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(null);
    vi.mocked(counters.incrementRateCounter).mockResolvedValue(3);
    const result = await checkBudget("user-1", { now: NOW });
    expect(result).toEqual({ ok: true });
    // cost read skipped when cap is null
    expect(counters.getCurrentDayCost).not.toHaveBeenCalled();
    expect(counters.incrementRateCounter).toHaveBeenCalledTimes(1);
  });

  it("rejects with rate reason when post-increment count equals cap+1 (over cap)", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(null);
    vi.mocked(counters.incrementRateCounter).mockResolvedValue(7);
    const result = await checkBudget("user-1", { now: NOW });
    expect(result).toMatchObject({
      ok: false,
      reason: "rate",
      rateCount: 7,
      rateCap: 6,
    });
    if (!result.ok && result.reason === "rate") {
      // 15:42:30 → 30 seconds until :43:00
      expect(result.retryAfterSec).toBe(30);
    }
  });

  it("accepts post-increment count at the cap (newCount === cap is OK; only > cap rejects)", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(null);
    vi.mocked(counters.incrementRateCounter).mockResolvedValue(6);
    const result = await checkBudget("user-1", { now: NOW });
    // The 6th call of the minute is permitted; the 7th is rejected.
    expect(result).toEqual({ ok: true });
  });

  it("rejects with cost_cap when used equals cap — does NOT increment rate counter", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getCurrentDayCost).mockResolvedValue(10);
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(10);
    const result = await checkBudget("user-1", { now: NOW });
    expect(result).toMatchObject({
      ok: false,
      reason: "cost_cap",
      usedUsd: 10,
      capUsd: 10,
      nextResetAt: "2026-04-23T00:00:00.000Z",
    });
    // Cost cap short-circuits before the rate increment, so the user
    // who hit cost_cap doesn't also burn a minute-counter slot.
    expect(counters.incrementRateCounter).not.toHaveBeenCalled();
  });

  it("rejects with cost_cap when used exceeds cap", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getCurrentDayCost).mockResolvedValue(12.5);
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(10);
    const result = await checkBudget("user-1", { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cost_cap");
  });

  it("cap = 0 is distinct from null — gates every turn (no rate increment)", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getCurrentDayCost).mockResolvedValue(0);
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(0);
    const result = await checkBudget("user-1", { now: NOW });
    expect(result).toMatchObject({
      ok: false,
      reason: "cost_cap",
      usedUsd: 0,
      capUsd: 0,
    });
    expect(counters.incrementRateCounter).not.toHaveBeenCalled();
  });

  it("cap = null passes through even with non-zero spend", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(null);
    vi.mocked(counters.incrementRateCounter).mockResolvedValue(1);
    const result = await checkBudget("user-1", { now: NOW });
    expect(result).toEqual({ ok: true });
  });

  it("cost gate fires before rate gate when both would trigger", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getCurrentDayCost).mockResolvedValue(100);
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(10);
    // Rate would also trigger, but cost's non-mutating short-circuit
    // wins — the user doesn't burn a minute slot they can't use anyway.
    const result = await checkBudget("user-1", { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cost_cap");
    expect(counters.incrementRateCounter).not.toHaveBeenCalled();
  });

  it("atomic increment closes the TOCTOU gap: two concurrent calls with new counts 6 and 7 produce one OK + one rate-rejection", async () => {
    const { checkBudget } = await import("../gate");
    const counters = await import("../counters");
    vi.mocked(counters.getUserDailyCap).mockResolvedValue(null);
    // Simulate atomic ON CONFLICT DO UPDATE returning a monotonically
    // increasing count across two near-simultaneous calls.
    let nextCount = 6;
    vi.mocked(counters.incrementRateCounter).mockImplementation(async () => nextCount++);
    const results = await Promise.all([
      checkBudget("user-1", { now: NOW }),
      checkBudget("user-1", { now: NOW }),
    ]);
    const oks = results.filter((r) => r.ok).length;
    const rates = results.filter((r) => !r.ok && r.reason === "rate").length;
    expect(oks).toBe(1);
    expect(rates).toBe(1);
  });
});
