import type { Db } from "@/lib/db";
import type { z } from "zod";

/**
 * The cognitive memory layer (§9.0) or operational surface each tool belongs to.
 * Tools are grouped into MCP servers by this tag — KA calls `aidm-episodic`
 * when it wants to recall a scene, `aidm-entities` when it wants a character
 * sheet, and so on.
 */
export type AidmToolLayer =
  | "ambient" // Block 1 rendering (no callable tools; present for completeness)
  | "working" // Block 3 (sliding window; present by context, not queried via tool)
  | "episodic" // turn transcripts as prose
  | "semantic" // distilled cross-turn facts (pgvector)
  | "voice" // Director's journal
  | "arc" // arc plan + foreshadowing causal graph
  | "critical" // sacred: SZ facts, player overrides
  | "entities"; // active-state: character, world, NPCs

/**
 * Opaque handle to a Langfuse trace or span. Designed to accept the real
 * Langfuse SDK's `trace.span()` return shape without importing Langfuse
 * types into every tool (tools don't need to know about Langfuse).
 */
export interface AidmSpanHandle {
  span(opts: {
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): {
    end(data?: { output?: unknown; metadata?: Record<string, unknown> }): void;
  };
}

/**
 * Execution context threaded through every tool call.
 *
 * - `campaignId` + `userId`: authorization checked before the tool runs.
 *   A tool cannot read state from a campaign that isn't owned by the
 *   calling user.
 * - `db`: the Drizzle client. Tools query directly; no repository layer
 *   abstraction because this stays flat and testable.
 * - `trace` (optional): when a Langfuse trace exists for the parent turn,
 *   the tool wraps its execute in a child span. Null-safe: tools run fine
 *   without a trace.
 */
export interface AidmToolContext {
  campaignId: string;
  userId: string;
  db: Db;
  trace?: AidmSpanHandle;
}

/**
 * Canonical tool specification. Our registry, our Mastra step wrappers,
 * and our Agent SDK MCP server factories all consume this shape — one
 * definition, three surfaces.
 */
export interface AidmToolSpec<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Stable flat name. Becomes the MCP tool name KA sees (e.g. `get_character_sheet`). */
  name: string;
  /** One-sentence description. Surfaced to KA via the MCP tool definition. */
  description: string;
  /** Cognitive memory layer / operational surface. Used for MCP server grouping. */
  layer: AidmToolLayer;
  /** Zod schema for tool input. Must be a `z.object({...})` — MCP requires a ZodRawShape. */
  inputSchema: TInput;
  /** Zod schema for tool output. Validated after execute returns. */
  outputSchema: TOutput;
  /**
   * The actual work. Receives validated input + context, returns unvalidated
   * output that the registry wrapper will validate against outputSchema.
   */
  execute: (input: z.infer<TInput>, ctx: AidmToolContext) => Promise<z.infer<TOutput>>;
}

/**
 * Error thrown when a tool is invoked for a campaign the calling user
 * does not own. Never leak the reason — "not found" shape keeps this from
 * being an enumeration oracle.
 */
export class AidmAuthError extends Error {
  constructor(message = "Campaign not found") {
    super(message);
    this.name = "AidmAuthError";
  }
}
