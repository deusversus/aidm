import { callSearch } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, type TierSelection } from "@/lib/llm/tiers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * callSearch — the fourth traced call (M3R3 C2). The raw SDK client is mocked
 * so the server's pause/resume loop is driven by scripted rounds: no live
 * model, no search spend, no DB, no Langfuse. What this pins is everything the
 * C2 audit found unguarded — that a FAILED search surfaces instead of
 * vanishing into a sourceless "research" result, that refusal and truncation
 * are not returned as ordinary success, that the per-call search ceiling holds
 * across resumes, and that every round's per-search fee reaches the meter
 * (including the zero the schema documents as meaningful).
 */

const { createMock, recordMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  // Typed by its argument so the captured ledger row is readable, not `never`.
  recordMock: vi.fn(async (_record: { tier: string; usage: Record<string, unknown> }) => 0),
}));
vi.mock("@/lib/llm/anthropic", () => ({
  getAnthropic: () => ({
    messages: {
      create: createMock,
      // Search rides streaming transport (SDK 10-minute guard); the same
      // fixture answers finalMessage().
      stream: (params: unknown) => ({ finalMessage: () => createMock(params) }),
    },
  }),
}));
vi.mock("@/lib/observability/langfuse", () => ({ getLangfuse: () => null }));
vi.mock("@/lib/observability/meter", () => ({ recordModelCall: recordMock }));

/** Research pins judgment to Sonnet — the rung that actually has effort control. */
const SONNET_SELECTION: TierSelection = { ...DEV_TIER_SELECTION, judgment: "claude-sonnet-5" };

interface ScriptedUsage {
  input_tokens: number;
  output_tokens: number;
  server_tool_use?: { web_search_requests: number };
}

function assistantMessage(
  content: unknown[],
  stopReason: string,
  usage: ScriptedUsage = { input_tokens: 10, output_tokens: 20 },
) {
  return {
    id: "msg_scripted",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

const usageWithSearches = (n: number): ScriptedUsage => ({
  input_tokens: 10,
  output_tokens: 20,
  server_tool_use: { web_search_requests: n },
});

const text = (t: string) => ({ type: "text", text: t, citations: null });
const citedText = (t: string, url: string) => ({
  type: "text",
  text: t,
  citations: [
    {
      type: "web_search_result_location",
      url,
      title: "Source page",
      cited_text: t.slice(0, 12),
      encrypted_index: "idx",
    },
  ],
});
const searchResults = (...urls: string[]) => ({
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: urls.map((url) => ({
    type: "web_search_result",
    url,
    title: `Title for ${url}`,
    encrypted_content: "enc",
    page_age: null,
  })),
});
/** The failure shape the audit found dropped: an error OBJECT, on a 200. */
const searchError = (code: string) => ({
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: { type: "web_search_tool_result_error", error_code: code },
});

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  createMock.mockReset();
  recordMock.mockClear();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const warnedWith = (needle: string) =>
  warnSpy.mock.calls.some((c) => String(c[0]).includes(needle));

describe("callSearch — the happy path", () => {
  it("collects prose, citations and consulted URLs, and meters the per-search fee", async () => {
    createMock.mockResolvedValueOnce(
      assistantMessage(
        [
          text("Looking into it. "),
          searchResults("https://a.example/one", "https://b.example/two"),
          citedText("The work aired in 2019.", "https://a.example/one"),
        ],
        "end_turn",
        usageWithSearches(2),
      ),
    );

    const out = await callSearch(DEV_TIER_SELECTION, {
      name: "research_search_identity",
      prompt: "who",
    });

    expect(out.text).toBe("Looking into it. The work aired in 2019.");
    expect(out.citations).toEqual([
      { url: "https://a.example/one", title: "Source page", cited_text: "The work air" },
    ]);
    expect(out.searchedUrls.map((u) => u.url)).toEqual([
      "https://a.example/one",
      "https://b.example/two",
    ]);
    expect(out.searchCount).toBe(2);
    expect(out.errors).toEqual([]);
    expect(out.truncated).toBe(false);

    expect(recordMock).toHaveBeenCalledTimes(1);
    const recorded = recordMock.mock.calls[0]?.[0];
    expect(recorded?.tier).toBe("judgment");
    expect(recorded?.usage.web_search_requests).toBe(2);
  });

  it("sends effort alongside the search tool when the model supports it", async () => {
    createMock.mockResolvedValue(assistantMessage([text("done")], "end_turn"));

    await callSearch(SONNET_SELECTION, { name: "s", prompt: "p", effort: "low", maxUses: 4 });
    const sonnetReq = createMock.mock.calls[0]?.[0];
    expect(sonnetReq.output_config).toEqual({ effort: "low" });
    expect(sonnetReq.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 4 },
    ]);

    // Haiku has no effort control — the param is omitted, not defaulted.
    createMock.mockClear();
    await callSearch(DEV_TIER_SELECTION, { name: "s", prompt: "p", effort: "low" });
    expect(createMock.mock.calls[0]?.[0].output_config).toBeUndefined();
  });
});

describe("callSearch — the server's pause/resume loop", () => {
  it("resumes a paused turn with the assistant content unchanged and collects both rounds once", async () => {
    const pausedContent = [
      text("First half. "),
      searchResults("https://a.example/one"),
      citedText("A cited fact. ", "https://a.example/one"),
    ];
    createMock
      .mockResolvedValueOnce(assistantMessage(pausedContent, "pause_turn", usageWithSearches(1)))
      .mockResolvedValueOnce(
        assistantMessage(
          [searchResults("https://a.example/one", "https://c.example/three"), text("Second half.")],
          "end_turn",
          usageWithSearches(1),
        ),
      );

    const out = await callSearch(DEV_TIER_SELECTION, {
      name: "research_search_world",
      prompt: "p",
    });

    expect(out.text).toBe("First half. A cited fact. Second half.");
    expect(out.text.match(/First half\./g)).toHaveLength(1);
    expect(out.searchCount).toBe(2);
    // The duplicate URL across rounds is one consulted source, not two.
    expect(out.searchedUrls.map((u) => u.url)).toEqual([
      "https://a.example/one",
      "https://c.example/three",
    ]);
    expect(out.truncated).toBe(false);

    expect(createMock).toHaveBeenCalledTimes(2);
    const resumeMessages = createMock.mock.calls[1]?.[0].messages;
    expect(resumeMessages).toHaveLength(2);
    expect(resumeMessages[0]).toEqual({ role: "user", content: "p" });
    // Re-sent UNCHANGED — no closing nudge, no reshaping; the API detects the
    // trailing server_tool_use and continues its own loop.
    expect(resumeMessages[1]).toEqual({ role: "assistant", content: pausedContent });

    // One ledger row per billed round, never one per call.
    expect(recordMock).toHaveBeenCalledTimes(2);
  });

  it("stops resuming once the per-call search ceiling is spent", async () => {
    createMock.mockResolvedValue(
      assistantMessage([text("partial")], "pause_turn", usageWithSearches(1)),
    );

    const out = await callSearch(DEV_TIER_SELECTION, {
      name: "research_search_identity",
      prompt: "p",
      maxUses: 1,
    });

    // The cap is per CALL: each resume would carry a fresh server-side budget.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(out.searchCount).toBe(1);
    expect(out.truncated).toBe(true);
    expect(warnedWith("search budget exhausted mid-pause")).toBe(true);
  });

  it("flags a turn still paused when MAX_ROUNDS runs out", async () => {
    createMock.mockResolvedValue(assistantMessage([text("more. ")], "pause_turn"));

    const out = await callSearch(DEV_TIER_SELECTION, {
      name: "research_search_story",
      prompt: "p",
    });

    expect(createMock).toHaveBeenCalledTimes(5);
    expect(out.truncated).toBe(true);
    expect(warnedWith("cut off mid-pause")).toBe(true);
  });
});

describe("callSearch — the failure surfaces", () => {
  it("collects error codes from failed searches instead of returning a sourceless answer", async () => {
    createMock.mockResolvedValueOnce(
      assistantMessage(
        [
          searchError("too_many_requests"),
          searchError("unavailable"),
          text("From what I recall, the series ran for two cours."),
        ],
        "end_turn",
        usageWithSearches(0),
      ),
    );

    const out = await callSearch(DEV_TIER_SELECTION, {
      name: "research_search_identity",
      prompt: "p",
    });

    expect(out.errors).toEqual(["too_many_requests", "unavailable"]);
    expect(out.searchedUrls).toEqual([]);
    expect(out.citations).toEqual([]);
    // The prose survives — but errors + no sources is recall, and it now SAYS so.
    expect(out.text).toContain("From what I recall");
    expect(warnedWith("web search errors")).toBe(true);
  });

  it("throws on a refusal rather than reporting it as 'nothing found'", async () => {
    createMock.mockResolvedValueOnce(assistantMessage([], "refusal"));

    await expect(
      callSearch(DEV_TIER_SELECTION, { name: "research_search_identity", prompt: "p" }),
    ).rejects.toThrow(/research_search_identity: model declined \(stop_reason=refusal\)/);
    // The round was billed before the throw — the ledger keeps its row.
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it("flags a clipped turn as truncated and warns", async () => {
    createMock.mockResolvedValueOnce(
      assistantMessage([text("half a sente")], "max_tokens", usageWithSearches(1)),
    );

    const out = await callSearch(DEV_TIER_SELECTION, {
      name: "research_search_stats",
      prompt: "p",
    });

    expect(out.truncated).toBe(true);
    expect(out.text).toBe("half a sente");
    expect(warnedWith("TRUNCATED at max_tokens")).toBe(true);
  });
});

describe("callSearch — metering the zero", () => {
  it("writes web_search_requests 0 when a search-capable round fired nothing", async () => {
    createMock.mockResolvedValueOnce(
      assistantMessage([text("I already know this one.")], "end_turn", usageWithSearches(0)),
    );

    const out = await callSearch(DEV_TIER_SELECTION, {
      name: "research_search_identity",
      prompt: "p",
    });

    expect(out.searchCount).toBe(0);
    const recorded = recordMock.mock.calls[0]?.[0];
    // 0, not absent: NULL would be indistinguishable from every pre-feature row.
    expect(Object.hasOwn(recorded?.usage ?? {}, "web_search_requests")).toBe(true);
    expect(recorded?.usage.web_search_requests).toBe(0);
  });

  it("omits the field entirely when the round had no server tool use at all", async () => {
    createMock.mockResolvedValueOnce(assistantMessage([text("plain")], "end_turn"));

    await callSearch(DEV_TIER_SELECTION, { name: "research_search_identity", prompt: "p" });

    const recorded = recordMock.mock.calls[0]?.[0];
    expect(Object.hasOwn(recorded?.usage ?? {}, "web_search_requests")).toBe(false);
  });
});
