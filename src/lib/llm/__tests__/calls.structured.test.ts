import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION } from "@/lib/llm/tiers";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { type ParseableMessageCreateParams, maybeParseMessage } from "@anthropic-ai/sdk/lib/parser";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The structured path's corrective retry and its metering (M3R4 R-1).
 *
 * THE DEFECT THIS SUITE PINS: `output_config.format` used to carry the SDK's
 * zod `parse` hook, which made `finalMessage()` validate the schema INSIDE
 * stream accumulation and throw `AnthropicError` from the transport — before
 * `recordModelCall`, before the manual parse. So the corrective retry was dead
 * code for every schema violation, and every violating call was billed and
 * never metered. Measured cost, N=50 soak (2026-08-05): 13 seed adjudications
 * and one Pacer beat died there; zero retries, zero ledger rows.
 *
 * The raw SDK client is mocked, so the whole suite is scripted — no live
 * model, no DB, no Langfuse. The last two cases assert against the REAL SDK
 * parser using the params this code actually sends, so an SDK upgrade that
 * re-arms auto-parse fails the gate here rather than in a soak.
 */

const { createMock, recordMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  recordMock: vi.fn(async () => 0),
}));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({
    messages: {
      create: createMock,
      stream: (params: unknown) => ({ finalMessage: () => createMock(params) }),
    },
  }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: recordMock }));

/** A nested enum — the exact shape the soak's failures wore. */
const SCHEMA = z.object({
  verdicts: z.array(z.object({ verdict: z.enum(["mention", "none"]) })),
});

function assistantMessage(text: string, stopReason = "end_turn") {
  return {
    id: "msg_scripted",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}
const VIOLATION = JSON.stringify({ verdicts: [{ verdict: "MENTION" }] });
const VALID = JSON.stringify({ verdicts: [{ verdict: "mention" }] });

/** The params this code actually put on the wire, for the SDK-contract cases. */
function sentParams(index = 0): ParseableMessageCreateParams {
  return createMock.mock.calls[index]?.[0] as ParseableMessageCreateParams;
}
function sentFormat(index = 0): Record<string, unknown> {
  return sentParams(index).output_config?.format as unknown as Record<string, unknown>;
}

const call = () =>
  callJudgment(DEV_TIER_SELECTION, {
    name: "seed_adjudication",
    schema: SCHEMA,
    prompt: "judge",
    campaignId: "c1",
    turnNumber: 6,
  });

beforeEach(() => {
  createMock.mockReset();
  recordMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("callStructured — the corrective retry is live again", () => {
  it("parses a valid response unchanged and meters exactly once", async () => {
    createMock.mockResolvedValueOnce(assistantMessage(VALID));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(call()).resolves.toEqual({ verdicts: [{ verdict: "mention" }] });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a schema-violating first response fires ONE corrective retry and meters BOTH attempts", async () => {
    createMock
      .mockResolvedValueOnce(assistantMessage(VIOLATION))
      .mockResolvedValueOnce(assistantMessage(VALID));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(call()).resolves.toEqual({ verdicts: [{ verdict: "mention" }] });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(recordMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("one corrective retry"));

    // The retry SHOWS the model its own violation — the assistant turn it
    // emitted, then the correction demand.
    const retry = sentParams(1).messages as { role: string; content: string }[];
    expect(retry).toHaveLength(3);
    expect(retry[1]).toEqual({ role: "assistant", content: VIOLATION });
    expect(retry[2]?.content).toContain("failed validation");
    warn.mockRestore();
  });

  it("two schema violations throw — and BOTH billed attempts still reach the ledger", async () => {
    createMock
      .mockResolvedValueOnce(assistantMessage(VIOLATION))
      .mockResolvedValueOnce(assistantMessage(VIOLATION));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(call()).rejects.toThrow(/failed to parse/i);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(recordMock).toHaveBeenCalledTimes(2);
    for (const [row] of recordMock.mock.calls as unknown as [
      { model: string; tier: string; usage: { output_tokens: number } },
    ][]) {
      expect(row.tier).toBe("judgment");
      expect(row.usage.output_tokens).toBe(7);
    }
    warn.mockRestore();
  });

  it("unparseable prose is the same class — retried once, both attempts metered", async () => {
    createMock
      .mockResolvedValueOnce(assistantMessage("Sure! Here are the verdicts:"))
      .mockResolvedValueOnce(assistantMessage(VALID));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(call()).resolves.toEqual({ verdicts: [{ verdict: "mention" }] });
    expect(recordMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("a TRANSPORT failure rethrows with no ledger row — usage never existed to meter", async () => {
    createMock.mockRejectedValueOnce(new Error("connection reset"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(call()).rejects.toThrow("connection reset");
    expect(recordMock).not.toHaveBeenCalled();

    // The one billed-but-unmetered path left in this call: a transport failure
    // can land after the model produced output, and usage never arrives. It
    // cannot be metered — so it is LOUD, the same as streamNarration's catch.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("billed ledger row may be lost"),
      expect.objectContaining({ name: "seed_adjudication", attempt: 1 }),
    );
    error.mockRestore();
  });
});

describe("callStructured — the output format the SDK actually receives", () => {
  it("carries no `parse` hook, so the SDK cannot zod-validate inside stream accumulation", async () => {
    createMock.mockResolvedValueOnce(assistantMessage(VALID));
    await call();

    const format = sentFormat();
    expect(format.type).toBe("json_schema");
    expect("parse" in format).toBe(false);

    // The SDK's own gate: maybeParseMessage keys on `'parse' in format`
    // (sdk/src/lib/parser.ts:53). With our format, a schema-violating message
    // comes back UNVALIDATED instead of throwing out of finalMessage().
    const violating = assistantMessage(VIOLATION) as unknown as Message;
    expect(() => maybeParseMessage(violating, sentParams(), { logger: console })).not.toThrow();
    expect(
      maybeParseMessage(violating, sentParams(), { logger: console }).parsed_output,
    ).toBeNull();
  });

  it("is byte-identical to zodOutputFormat on the wire — only the hook is gone", async () => {
    createMock.mockResolvedValueOnce(assistantMessage(VALID));
    await call();

    expect(JSON.stringify(sentFormat())).toBe(JSON.stringify(zodOutputFormat(SCHEMA)));

    // And the control: the hooked format is what used to throw. If this ever
    // stops throwing the SDK changed, and the comment in calls.ts is stale.
    const hooked = { ...sentParams(), output_config: { format: zodOutputFormat(SCHEMA) } };
    expect(() =>
      maybeParseMessage(assistantMessage(VIOLATION) as unknown as Message, hooked, {
        logger: console,
      }),
    ).toThrow(/Failed to parse structured output/);
  });

  it("enum vocabulary rides as DESCRIPTION, not grammar — why the clamps exist", async () => {
    createMock.mockResolvedValueOnce(assistantMessage(VALID));
    await call();

    const verdict = JSON.parse(JSON.stringify(sentFormat().schema)).properties.verdicts.items
      .properties.verdict;
    expect(verdict.type).toBe("string");
    expect(verdict.enum).toBeUndefined();
    expect(verdict.description).toContain("mention");
  });
});
