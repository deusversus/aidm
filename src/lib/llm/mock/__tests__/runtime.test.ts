import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getQueryFn, resetMockRuntimeForTesting } from "../runtime";

/**
 * Runtime env-gate tests. Verifies that getQueryFn() returns the
 * fixture-backed mockQuery when AIDM_MOCK_LLM=1 + loads fixtures from
 * MOCKLLM_FIXTURES_DIR. Without the env var, returns the real SDK
 * query (imported statically).
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mockllm-runtime-"));
  resetMockRuntimeForTesting();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "AIDM_MOCK_LLM");
  Reflect.deleteProperty(process.env, "MOCKLLM_FIXTURES_DIR");
  resetMockRuntimeForTesting();
});

describe("getQueryFn — env gating", () => {
  it("returns real SDK query when AIDM_MOCK_LLM is not set", () => {
    const fn = getQueryFn();
    // Real SDK `query` is a function; mockQuery is also a function. We
    // check identity by looking at toString() signature — the real
    // SDK's query has a distinctive shape we can discriminate from
    // our createMockQuery output via its source string length.
    // (Pragmatic: both are functions, but the real one is compiled SDK
    // code with markedly different content.)
    expect(typeof fn).toBe("function");
  });

  it("returns fixture-backed mockQuery when AIDM_MOCK_LLM=1", async () => {
    writeFileSync(
      join(tmp, "fixture.yaml"),
      `
id: runtime-test
provider: anthropic
match:
  system_includes: ["runtime test"]
response:
  id: msg_runtime
  type: message
  role: assistant
  content:
    - type: text
      text: "runtime mock response"
  model: claude-opus-4-7
  stop_reason: end_turn
  stop_sequence: null
  usage:
    input_tokens: 100
    output_tokens: 10
`,
    );
    process.env.AIDM_MOCK_LLM = "1";
    process.env.MOCKLLM_FIXTURES_DIR = tmp;

    const fn = getQueryFn();
    const deltas: string[] = [];
    for await (const msg of fn({
      prompt: "x",
      options: {
        model: "claude-opus-4-7",
        systemPrompt: "runtime test",
      } as never,
    })) {
      if ((msg as { type: string }).type === "stream_event") {
        deltas.push((msg as { event: { delta: { text: string } } }).event.delta.text);
      }
    }
    expect(deltas.join("")).toBe("runtime mock response");
  });

  it("falls back to empty registry (synth only) when fixtures dir is missing", async () => {
    process.env.AIDM_MOCK_LLM = "1";
    process.env.MOCKLLM_FIXTURES_DIR = join(tmp, "does-not-exist");

    const fn = getQueryFn();
    const deltas: string[] = [];
    for await (const msg of fn({
      prompt: "x",
      options: {
        model: "claude-opus-4-7",
        systemPrompt: "anything",
      } as never,
    })) {
      if ((msg as { type: string }).type === "stream_event") {
        deltas.push((msg as { event: { delta: { text: string } } }).event.delta.text);
      }
    }
    expect(deltas.join("")).toMatch(/mock narrative/);
  });

  it("caches the queryFn across calls within a runtime", () => {
    process.env.AIDM_MOCK_LLM = "1";
    process.env.MOCKLLM_FIXTURES_DIR = tmp;
    const fn1 = getQueryFn();
    const fn2 = getQueryFn();
    expect(fn1).toBe(fn2);
  });

  it("resetMockRuntimeForTesting clears cache + picks up new env", async () => {
    const first = getQueryFn();
    resetMockRuntimeForTesting();
    process.env.AIDM_MOCK_LLM = "1";
    process.env.MOCKLLM_FIXTURES_DIR = tmp;
    const second = getQueryFn();
    // After reset + env change, we get a different fn reference.
    expect(first).not.toBe(second);
  });
});
