import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsYaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRecordedFixture } from "../record";
import type { AnthropicMessageResponse, MockLlmFixture, RequestSignature } from "../types";

/**
 * Record-mode tests. `forwardToAnthropic` actually hits the real API,
 * so we can't exercise it here without spending $ / requiring an API
 * key in CI — that path is covered by docs + manual workflow in the
 * README. We test the fixture-writing side (writeRecordedFixture) +
 * server config validation (strict XOR record) which is pure logic.
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mockllm-record-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function signature(): RequestSignature {
  return {
    provider: "anthropic",
    endpoint: "/v1/messages",
    model: "claude-opus-4-7",
    system: "You are KeyAnimator.",
    messages: [{ role: "user", text: "I draw my sword." }],
    toolNames: ["search_memory"],
    streaming: false,
    rawBody: {},
  };
}

function response(): AnthropicMessageResponse {
  return {
    id: "msg_real_abc",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Spike's hand finds the grip." }],
    model: "claude-opus-4-7",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1500,
      output_tokens: 85,
      cache_read_input_tokens: 1200,
    },
  };
}

describe("writeRecordedFixture", () => {
  it("writes a valid YAML fixture file with prompt_hash match rule", () => {
    const fixture = writeRecordedFixture(signature(), response(), { recordDir: tmp });
    expect(fixture.match.prompt_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fixture.provider).toBe("anthropic");
    expect(fixture.response?.content[0]).toMatchObject({
      type: "text",
      text: "Spike's hand finds the grip.",
    });
    // File exists on disk
    const files = readdirSync(tmp);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.yaml$/);
  });

  it("produces a parseable YAML that round-trips through MockLlmFixture schema", () => {
    writeRecordedFixture(signature(), response(), { recordDir: tmp });
    const files = readdirSync(tmp);
    const written = readFileSync(join(tmp, files[0] as string), "utf8");
    const parsed = jsYaml.load(written);
    // Shape-check — don't re-validate the full Zod schema here (tested
    // separately). Verify key fields survived YAML round-trip.
    expect((parsed as MockLlmFixture).id).toMatch(/^recorded-/);
    expect((parsed as MockLlmFixture).match.prompt_hash).toMatch(/^sha256:/);
    expect((parsed as MockLlmFixture).recorded_at).toBeDefined();
    expect((parsed as MockLlmFixture).notes).toContain("Auto-recorded");
  });

  it("uses custom idPrefix when provided", () => {
    const fixture = writeRecordedFixture(signature(), response(), {
      recordDir: tmp,
      idPrefix: "bebop-combat",
    });
    expect(fixture.id).toMatch(/^bebop-combat-/);
  });

  it("creates nested directories as needed", () => {
    const nested = join(tmp, "scenarios", "bebop");
    const fixture = writeRecordedFixture(signature(), response(), { recordDir: nested });
    expect(fixture.id).toBeDefined();
    expect(readdirSync(nested).length).toBeGreaterThan(0);
  });

  it("captures usage breakdown including cache tokens", () => {
    const fixture = writeRecordedFixture(signature(), response(), { recordDir: tmp });
    expect(fixture.response?.usage.input_tokens).toBe(1500);
    expect(fixture.response?.usage.cache_read_input_tokens).toBe(1200);
  });
});

describe("startMockServer — record mode config", () => {
  it("throws when both strict and record are set (mutually exclusive)", async () => {
    const { startMockServer } = await import("../server");
    await expect(
      startMockServer({
        strict: true,
        record: { recordDir: tmp },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});
