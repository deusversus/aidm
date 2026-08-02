import { describe, expect, it, vi } from "vitest";
import { Conte } from "../conte";
import { CommitScene, clampCommitScene } from "../sidecar";

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

  it("an off-count trailer PARSES — the counts are not schema bounds (2026-08-01)", () => {
    // The API grammar strips minItems/maxItems, so a bound here could only
    // ever fail the parse and destroy the scene's own record. Both directions
    // must survive the schema; the clamp below is what enforces the ceiling.
    const base = { decision_point: true, notable_beats: ["a", "b", "c", "d"] };
    expect(() => CommitScene.parse(base)).not.toThrow();
    expect(() => CommitScene.parse({ ...base, suggested_moves: ["only one"] })).not.toThrow();
    expect(() =>
      CommitScene.parse({ ...base, suggested_moves: ["a", "b", "c", "d"] }),
    ).not.toThrow();
    expect(() => CommitScene.parse({ decision_point: false, notable_beats: [] })).not.toThrow();
  });

  it("clampCommitScene slices to the ceilings and keeps the scene", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clamped = clampCommitScene(
      CommitScene.parse({
        decision_point: true,
        suggested_moves: ["a", "b", "c", "d", "e"],
        notable_beats: ["w", "x", "y", "z"],
      }),
    );
    expect(clamped.suggested_moves).toEqual(["a", "b", "c"]);
    expect(clamped.notable_beats).toEqual(["w", "x", "y"]);
    expect(clamped.decision_point).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clampCommitScene passes SHORT lists through — a move cannot be sliced into existence", () => {
    // The chips are optional decoration; the play view and the suggestions
    // route both gate on length >= 2 and render nothing below it.
    const one = clampCommitScene(
      CommitScene.parse({
        decision_point: true,
        suggested_moves: ["only one"],
        notable_beats: ["a beat"],
      }),
    );
    expect(one.suggested_moves).toEqual(["only one"]);

    const none = clampCommitScene(CommitScene.parse({ decision_point: false, notable_beats: [] }));
    expect(none.notable_beats).toEqual([]);
    expect(none.suggested_moves).toBeUndefined();
  });

  it("clampCommitScene drops blanks, and an all-blank move list becomes absent", () => {
    const clamped = clampCommitScene(
      CommitScene.parse({
        decision_point: true,
        suggested_moves: ["  ", ""],
        notable_beats: ["  kept  ", "   "],
      }),
    );
    expect(clamped.notable_beats).toEqual(["kept"]);
    expect(clamped.suggested_moves).toBeUndefined();
    expect("suggested_moves" in clamped).toBe(false);
  });
});
