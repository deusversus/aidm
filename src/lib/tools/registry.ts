import { campaigns } from "@/lib/state/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { AidmAuthError, type AidmToolContext, type AidmToolSpec } from "./types";

/**
 * Runtime registration of every tool the system exposes. Tools are registered
 * once at module load (via `registerTools`) and looked up by name when KA or
 * a Mastra step needs them.
 *
 * Why flat + global instead of passed-around: the MCP server factories need
 * the same list the Mastra tool registry does, and circular-import gymnastics
 * to share a non-global registry hurt more than this does.
 */

const tools = new Map<string, AidmToolSpec>();

export function registerTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  spec: AidmToolSpec<TInput, TOutput>,
): AidmToolSpec<TInput, TOutput> {
  if (tools.has(spec.name)) {
    throw new Error(`Duplicate tool registration: ${spec.name}`);
  }
  tools.set(spec.name, spec as unknown as AidmToolSpec);
  return spec;
}

export function getTool(name: string): AidmToolSpec | undefined {
  return tools.get(name);
}

export function listTools(): AidmToolSpec[] {
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listToolsByLayer(layer: AidmToolSpec["layer"]): AidmToolSpec[] {
  return listTools().filter((t) => t.layer === layer);
}

export function clearRegistryForTesting(): void {
  tools.clear();
}

/**
 * Authorize a campaign access. Throws AidmAuthError if the campaign does
 * not exist, was soft-deleted, or is not owned by the caller. Returns the
 * campaign row on success.
 */
export async function authorizeCampaignAccess(
  ctx: Pick<AidmToolContext, "campaignId" | "userId" | "db">,
): Promise<typeof campaigns.$inferSelect> {
  const [row] = await ctx.db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.id, ctx.campaignId),
        eq(campaigns.userId, ctx.userId),
        isNull(campaigns.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AidmAuthError();
  return row;
}

/**
 * Invoke a tool by name with full validation + auth + span wrapping.
 * Returns the validated output. Throws AidmAuthError on auth failure,
 * ZodError on schema violation, or whatever the tool itself throws.
 *
 * This is what Mastra workflow steps call. It is also what the MCP server
 * factory wraps into `SdkMcpToolDefinition` handlers so KA's tool calls go
 * through the same auth + validation path.
 */
export async function invokeTool(
  name: string,
  rawInput: unknown,
  ctx: AidmToolContext,
): Promise<unknown> {
  const spec = tools.get(name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);

  const input = spec.inputSchema.parse(rawInput);
  await authorizeCampaignAccess(ctx);

  const span = ctx.trace?.span({
    name: `tool:${spec.name}`,
    input,
    metadata: { layer: spec.layer },
  });

  try {
    const rawOutput = await spec.execute(input, ctx);
    const output = spec.outputSchema.parse(rawOutput);
    span?.end({ output });
    return output;
  } catch (err) {
    span?.end({
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
