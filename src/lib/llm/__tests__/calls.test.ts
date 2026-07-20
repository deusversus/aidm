import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { COMMIT_SCENE_TOOL, extractCommitScene } from "../calls";

function fixtureMessage(content: Message["content"]): Message {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 } as Message["usage"],
  } as Message;
}

describe("COMMIT_SCENE_TOOL", () => {
  it("derives its schema from the CommitScene contract", () => {
    expect(COMMIT_SCENE_TOOL.name).toBe("commit_scene");
    const schema = COMMIT_SCENE_TOOL.input_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "scene_cast_delta",
        "decision_point",
        "intended_seed_mentions",
        "notable_beats",
      ]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["decision_point", "notable_beats"]));
  });

  it("field descriptions survive into the tool schema — the KA's only view of field meaning (M2R R1)", () => {
    const schema = COMMIT_SCENE_TOOL.input_schema as {
      properties?: Record<string, { description?: string }>;
    };
    const moves = schema.properties?.suggested_moves?.description ?? "";
    expect(moves).toContain("decision_point is true");
    expect(moves).toContain("chips");
    expect(schema.properties?.decision_point?.description).toContain("genuine fork");
  });
});

describe("extractCommitScene (§5.7 trailer)", () => {
  it("parses a valid trailer from the tool_use block", () => {
    const message = fixtureMessage([
      { type: "text", text: "The beers were cold.", citations: null },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "commit_scene",
        caller: { type: "direct" },
        input: {
          decision_point: true,
          suggested_moves: ["Take the beer", "Ask what he wants"],
          notable_beats: ["The guard knows Spike bluffed him and came anyway"],
        },
      },
    ]);
    const sidecar = extractCommitScene(message);
    expect(sidecar?.decision_point).toBe(true);
    expect(sidecar?.scene_cast_delta).toEqual([]);
    expect(sidecar?.notable_beats).toHaveLength(1);
  });

  it("returns null when the trailer is missing (probe-fallback path, §5.7)", () => {
    const message = fixtureMessage([{ type: "text", text: "prose only", citations: null }]);
    expect(extractCommitScene(message)).toBeNull();
  });

  it("returns null (not throw) on an unparseable trailer", () => {
    const message = fixtureMessage([
      {
        type: "tool_use",
        id: "toolu_2",
        name: "commit_scene",
        caller: { type: "direct" },
        input: { decision_point: "not-a-bool", notable_beats: [] },
      },
    ]);
    expect(extractCommitScene(message)).toBeNull();
  });
});
