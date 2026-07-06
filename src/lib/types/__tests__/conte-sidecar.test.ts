import { describe, expect, it } from "vitest";
import { Conte } from "../conte";
import { CommitScene } from "../sidecar";

const memory = (n: number) => ({
  content: `memory ${n}`,
  layer: "semantic",
  turn_id: n,
  provenance: "compositor_distill",
  confidence: 0.8,
});

describe("Conte (§5.1 prescription budget caps)", () => {
  const minimal = { turn_id: 7, tier: "genga" } as const;

  it("parses a minimal douga-shaped conte with defaults", () => {
    const parsed = Conte.parse({ turn_id: 1, tier: "douga" });
    expect(parsed.callbacks).toEqual([]);
    expect(parsed.memories).toEqual([]);
    expect(parsed.degraded).toBe(false);
    expect(parsed.charter_amendments).toBe("");
  });

  it("enforces callbacks ≤ 3", () => {
    expect(() => Conte.parse({ ...minimal, callbacks: ["a", "b", "c", "d"] })).toThrow();
  });

  it("enforces memories ≤ 5 with provenance tags intact", () => {
    const five = [1, 2, 3, 4, 5].map(memory);
    const parsed = Conte.parse({ ...minimal, memories: five });
    expect(parsed.memories).toHaveLength(5);
    expect(parsed.memories[0]?.provenance).toBe("compositor_distill");
    expect(() => Conte.parse({ ...minimal, memories: [...five, memory(6)] })).toThrow();
  });

  it("enforces active_consequences ≤ 8 and canon_chunks ≤ 3", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `consequence ${i}`);
    expect(() => Conte.parse({ ...minimal, active_consequences: nine })).toThrow();
    const chunk = { source_profile_id: "bebop", page_type: "location", content: "Ganymede docks" };
    expect(() => Conte.parse({ ...minimal, canon_chunks: [chunk, chunk, chunk, chunk] })).toThrow();
  });

  it("pacer override strength is representable (axiom 3 hard-core admission)", () => {
    const parsed = Conte.parse({
      ...minimal,
      pacer_beat: { beat_classification: "escalation", strength: "override" },
    });
    expect(parsed.pacer_beat?.strength).toBe("override");
    expect(parsed.pacer_beat?.must_reference).toEqual([]);
  });
});

describe("CommitScene sidecar (§5.7)", () => {
  it("parses a full trailer", () => {
    const parsed = CommitScene.parse({
      scene_cast_delta: [{ name: "Slayer", action: "admit_to_catalog" }],
      decision_point: true,
      suggested_moves: ["Chase the shuttle", "Let him go and tail the money"],
      intended_seed_mentions: ["seed_syndicate_leader"],
      sakuga_used: "aftermath",
      notable_beats: ["Slayer named as the Syndicate's new leader"],
    });
    expect(parsed.scene_cast_delta[0]?.action).toBe("admit_to_catalog");
  });

  it("suggested_moves must be 2–3 when present, and may be absent", () => {
    const base = { decision_point: false, notable_beats: ["quiet beat"] };
    expect(CommitScene.parse(base).suggested_moves).toBeUndefined();
    expect(() => CommitScene.parse({ ...base, suggested_moves: ["only one"] })).toThrow();
    expect(() => CommitScene.parse({ ...base, suggested_moves: ["a", "b", "c", "d"] })).toThrow();
  });

  it("notable_beats requires 1–3 entries", () => {
    expect(() => CommitScene.parse({ decision_point: false, notable_beats: [] })).toThrow();
    expect(() =>
      CommitScene.parse({ decision_point: false, notable_beats: ["a", "b", "c", "d"] }),
    ).toThrow();
  });
});
