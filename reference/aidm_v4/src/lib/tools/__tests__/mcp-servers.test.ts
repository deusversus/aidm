import { describe, expect, it } from "vitest";
import type { AidmToolContext } from "../index";
import { LAYER_TO_MCP_ID, buildMcpServers } from "../mcp-servers";

function makeCtx(): AidmToolContext {
  return {
    campaignId: "c-1",
    userId: "u-1",
    db: {
      // Not exercised in these tests — we're verifying registration, not execution.
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    } as unknown as AidmToolContext["db"],
  };
}

describe("buildMcpServers", () => {
  it("returns exactly eight servers, keyed by aidm-<layer>", () => {
    const servers = buildMcpServers(makeCtx());
    expect(Object.keys(servers).sort()).toEqual(
      [
        "aidm-ambient",
        "aidm-working",
        "aidm-episodic",
        "aidm-semantic",
        "aidm-voice",
        "aidm-arc",
        "aidm-critical",
        "aidm-entities",
      ].sort(),
    );
  });

  it("LAYER_TO_MCP_ID exposes every layer → id mapping", () => {
    expect(Object.keys(LAYER_TO_MCP_ID).sort()).toEqual(
      ["ambient", "working", "episodic", "semantic", "voice", "arc", "critical", "entities"].sort(),
    );
  });

  it("aidm-ambient and aidm-working are empty but present (§9.0 ambient/working manifest via blocks)", () => {
    const servers = buildMcpServers(makeCtx());
    expect(servers["aidm-ambient"]).toBeDefined();
    expect(servers["aidm-working"]).toBeDefined();
  });

  it("each server has the expected MCP config shape", () => {
    const servers = buildMcpServers(makeCtx());
    for (const [id, cfg] of Object.entries(servers)) {
      expect(cfg.type).toBe("sdk");
      expect(cfg.name).toBe(id);
      expect(cfg.instance).toBeDefined();
    }
  });
});
