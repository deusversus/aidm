import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import "./all"; // ensure tools register before factories run
import { authorizeCampaignAccess, listTools, listToolsByLayer } from "./registry";
import type { AidmToolContext, AidmToolLayer, AidmToolSpec } from "./types";

/**
 * Builds the eight MCP servers KA mounts on its Agent SDK session. One
 * per cognitive-memory layer (§9.0) plus `aidm-entities` for the active
 * state tools (character, world, NPCs) that span layers.
 *
 * `aidm-critical` contains `get_critical_memories` AND the overrides
 * tool. The critical layer also surfaces `get_critical_memories` because
 * semantic exposes it too — two discovery surfaces, one implementation
 * (see semantic/get-critical-memories.ts).
 *
 * MCP servers are **rebuilt per turn**. Each server closes over the
 * turn's {campaignId, userId, trace} context — no async-local-storage
 * globals, no mutable registry state. Cheap (8 small object graphs);
 * simple to reason about; KA's Agent SDK session receives fresh bindings
 * each turn.
 *
 * The handler validates input against the tool's Zod schema, enforces
 * campaign ownership, runs the tool, validates output, and wraps the
 * whole thing in a Langfuse span if the turn's trace handle was passed
 * in. Same path as the Mastra-step invocation — one tool, three surfaces.
 */

const LAYER_TO_MCP_ID: Record<AidmToolLayer, string> = {
  ambient: "aidm-ambient",
  working: "aidm-working",
  episodic: "aidm-episodic",
  semantic: "aidm-semantic",
  voice: "aidm-voice",
  arc: "aidm-arc",
  critical: "aidm-critical",
  entities: "aidm-entities",
};

/**
 * Which tool names to surface in each MCP server. Most tools live in one
 * layer, but `get_critical_memories` surfaces in both `aidm-semantic`
 * (as "always-present memories") and `aidm-critical` (as "the sacred
 * set"). Cross-layer surfacing is declared explicitly here rather than
 * inferred from the tool spec.
 */
const CROSS_LAYER_SURFACES: Partial<Record<AidmToolLayer, string[]>> = {
  semantic: ["get_critical_memories"],
};

function toSdkTool(spec: AidmToolSpec, ctx: AidmToolContext): ReturnType<typeof sdkTool> {
  // MCP requires a ZodRawShape, not a full Zod schema.
  // `inputSchema` on every AidmToolSpec is a z.object — extract its shape.
  const shape = (spec.inputSchema as unknown as { shape: z.ZodRawShape }).shape;

  return sdkTool(spec.name, spec.description, shape, async (args) => {
    const input = spec.inputSchema.parse(args);
    await authorizeCampaignAccess(ctx);

    const span = ctx.trace?.span({
      name: `tool:${spec.name}`,
      input,
      metadata: { layer: spec.layer },
    });

    // Match `invokeTool`'s logging shape so KA-driven MCP calls and
    // turn-workflow direct calls both emit the same `tool: ok` / `tool:
    // failed` lines. Without this wrapper, the MCP path (KA's tool
    // calls against search_memory, recall_scene, get_character_sheet,
    // etc.) was silent in prod — only the handful of WB-reshape
    // direct-invokeTool calls showed up.
    const start = Date.now();
    const logMeta = { ...ctx.logContext, tool: spec.name, layer: spec.layer };
    try {
      const rawOutput = await spec.execute(input, ctx);
      const output = spec.outputSchema.parse(rawOutput);
      span?.end({ output });
      ctx.logger?.("info", "tool: ok", {
        ...logMeta,
        durationMs: Date.now() - start,
      });
      // MCP tool return shape: text-content payload carrying the JSON.
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span?.end({ metadata: { error: errMsg } });
      ctx.logger?.("warn", "tool: failed", {
        ...logMeta,
        durationMs: Date.now() - start,
        error: errMsg,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: errMsg }) }],
        isError: true,
      };
    }
  });
}

/**
 * Build all eight MCP servers for a specific turn context.
 * Returns the shape Claude Agent SDK expects as its `mcpServers` config
 * (keyed by server id).
 *
 * `aidm-ambient` and `aidm-working` currently have no callable tools
 * (§9.0 — they manifest via Block 1 rendering and Block 3 window
 * respectively). They're still returned for completeness so KA's Agent
 * SDK session enumerates the same eight layers the rest of the codebase
 * references — empty-server is a valid state.
 */
export function buildMcpServers(
  ctx: AidmToolContext,
): Record<string, McpSdkServerConfigWithInstance> {
  const all = listTools();
  const result: Record<string, McpSdkServerConfigWithInstance> = {};

  for (const [layer, serverId] of Object.entries(LAYER_TO_MCP_ID) as Array<
    [AidmToolLayer, string]
  >) {
    const native = listToolsByLayer(layer);
    const crossNames = CROSS_LAYER_SURFACES[layer] ?? [];
    const cross = all.filter((t) => crossNames.includes(t.name) && t.layer !== layer);
    const tools = [...native, ...cross].map((spec) => toSdkTool(spec, ctx));

    result[serverId] = createSdkMcpServer({
      name: serverId,
      version: "0.1.0",
      tools,
    });
  }

  return result;
}

export { LAYER_TO_MCP_ID };
