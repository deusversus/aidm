import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeRequestHash,
  emptyRegistry,
  loadFixtures,
  matchFixture,
  signatureFromAnthropicBody,
} from "../fixtures";
import type { MockLlmFixture, RequestSignature } from "../types";

function sig(overrides: Partial<RequestSignature> = {}): RequestSignature {
  return {
    provider: "anthropic",
    endpoint: "/v1/messages",
    model: "claude-opus-4-7",
    system: "",
    messages: [],
    toolNames: [],
    streaming: false,
    rawBody: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadFixtures
// ---------------------------------------------------------------------------

describe("loadFixtures — YAML loading + validation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mockllm-fixtures-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads a well-formed fixture", () => {
    writeFileSync(
      join(tmp, "bebop-social.yaml"),
      `
id: bebop-social
provider: anthropic
match:
  system_includes:
    - "You are KeyAnimator"
response:
  content:
    - type: text
      text: "Jet grunts."
  usage:
    input_tokens: 500
    output_tokens: 40
`,
    );
    const reg = loadFixtures(tmp);
    expect(reg.byId.size).toBe(1);
    const fixture = reg.byId.get("bebop-social");
    expect(fixture?.provider).toBe("anthropic");
    expect(fixture?.response?.content[0]).toEqual({ type: "text", text: "Jet grunts." });
  });

  it("walks subdirectories", () => {
    writeFileSync(
      join(tmp, "a.yaml"),
      `id: a
provider: anthropic
match: { model_prefix: "claude-" }
response:
  content: [{ type: text, text: "A" }]
  usage: { input_tokens: 10, output_tokens: 5 }
`,
    );
    require("node:fs").mkdirSync(join(tmp, "sub"));
    writeFileSync(
      join(tmp, "sub", "b.yaml"),
      `id: b
provider: anthropic
match: { model_prefix: "claude-" }
response:
  content: [{ type: text, text: "B" }]
  usage: { input_tokens: 10, output_tokens: 5 }
`,
    );
    const reg = loadFixtures(tmp);
    expect(reg.byId.size).toBe(2);
    expect(reg.byId.has("a")).toBe(true);
    expect(reg.byId.has("b")).toBe(true);
  });

  it("throws on duplicate id across files", () => {
    writeFileSync(
      join(tmp, "a.yaml"),
      `id: same
provider: anthropic
match: { model_prefix: "claude-" }
response:
  content: [{ type: text, text: "1" }]
  usage: { input_tokens: 10, output_tokens: 5 }
`,
    );
    writeFileSync(
      join(tmp, "b.yaml"),
      `id: same
provider: anthropic
match: { model_prefix: "claude-" }
response:
  content: [{ type: text, text: "2" }]
  usage: { input_tokens: 10, output_tokens: 5 }
`,
    );
    expect(() => loadFixtures(tmp)).toThrow(/Duplicate.*same/i);
  });

  it("throws on Zod validation failure", () => {
    writeFileSync(
      join(tmp, "bad.yaml"),
      `id: bad
provider: not-a-provider
match: { model_prefix: "x" }
`,
    );
    expect(() => loadFixtures(tmp)).toThrow(/failed validation/i);
  });

  it("throws when neither response nor streaming is present", () => {
    writeFileSync(
      join(tmp, "incomplete.yaml"),
      `id: incomplete
provider: anthropic
match: { model_prefix: "claude-" }
`,
    );
    expect(() => loadFixtures(tmp)).toThrow(/must define at least one of response \/ streaming/);
  });

  it("returns empty registry for missing directory", () => {
    const reg = loadFixtures(join(tmp, "does-not-exist"));
    expect(reg.byId.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRequestHash
// ---------------------------------------------------------------------------

describe("computeRequestHash", () => {
  it("returns the same hash for identical signatures", () => {
    const s1 = sig({ system: "sys", messages: [{ role: "user", text: "hi" }] });
    const s2 = sig({ system: "sys", messages: [{ role: "user", text: "hi" }] });
    expect(computeRequestHash(s1)).toBe(computeRequestHash(s2));
  });

  it("returns different hashes for different models", () => {
    const s1 = sig({ model: "claude-opus-4-7" });
    const s2 = sig({ model: "claude-haiku-4-5-20251001" });
    expect(computeRequestHash(s1)).not.toBe(computeRequestHash(s2));
  });

  it("normalizes tool name order (sort before hashing)", () => {
    const s1 = sig({ toolNames: ["a", "b", "c"] });
    const s2 = sig({ toolNames: ["c", "b", "a"] });
    expect(computeRequestHash(s1)).toBe(computeRequestHash(s2));
  });

  it("is insensitive to rawBody content (so max_tokens churn doesn't break matches)", () => {
    const s1 = sig({ rawBody: { max_tokens: 1024 } });
    const s2 = sig({ rawBody: { max_tokens: 2048, temperature: 0.5 } });
    expect(computeRequestHash(s1)).toBe(computeRequestHash(s2));
  });

  it("produces sha256: prefixed 64-char hex", () => {
    const h = computeRequestHash(sig());
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// matchFixture
// ---------------------------------------------------------------------------

function makeFixture(id: string, match: MockLlmFixture["match"], text = "mock"): MockLlmFixture {
  return {
    id,
    provider: "anthropic",
    match,
    response: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-mock",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function regWithFixtures(...fixtures: MockLlmFixture[]) {
  const reg = emptyRegistry();
  for (const f of fixtures) {
    reg.byId.set(f.id, f);
    const bucket = reg.byProvider.get(f.provider) ?? [];
    bucket.push(f);
    reg.byProvider.set(f.provider, bucket);
  }
  return reg;
}

describe("matchFixture — fixture selection", () => {
  it("exact prompt_hash wins over any semantic match", () => {
    const requestSig = sig({ system: "You are KeyAnimator" });
    const hashFixture = makeFixture("hash-winner", {
      prompt_hash: computeRequestHash(requestSig),
    });
    const semFixture = makeFixture("sem-loser", {
      system_includes: ["You are KeyAnimator"],
    });
    const reg = regWithFixtures(semFixture, hashFixture);
    const outcome = matchFixture(reg, requestSig);
    expect(outcome.kind).toBe("fixture");
    if (outcome.kind === "fixture") {
      expect(outcome.fixture.id).toBe("hash-winner");
    }
  });

  it("semantic match succeeds when all substrings are present", () => {
    const f = makeFixture("match-me", {
      system_includes: ["You are KeyAnimator"],
      user_includes: ["draw my sword"],
    });
    const reg = regWithFixtures(f);
    const outcome = matchFixture(
      reg,
      sig({
        system: "You are KeyAnimator — authorship...",
        messages: [{ role: "user", text: "I draw my sword and..." }],
      }),
    );
    expect(outcome.kind).toBe("fixture");
    if (outcome.kind === "fixture") {
      expect(outcome.fixture.id).toBe("match-me");
    }
  });

  it("returns synth when no fixture matches", () => {
    const f = makeFixture("wont-match", {
      system_includes: ["very specific string"],
    });
    const reg = regWithFixtures(f);
    const outcome = matchFixture(reg, sig({ system: "different content" }));
    expect(outcome.kind).toBe("synth");
  });

  it("ANDs all conditions (one missing → no match)", () => {
    const f = makeFixture("strict", {
      system_includes: ["A", "B"],
    });
    const reg = regWithFixtures(f);
    // only A present
    const outcome = matchFixture(reg, sig({ system: "A only" }));
    expect(outcome.kind).toBe("synth");
  });

  it("picks highest-scoring fixture when multiple semantic matches", () => {
    const loose = makeFixture("loose", { model_prefix: "claude-" });
    const specific = makeFixture("specific", {
      model_prefix: "claude-",
      system_includes: ["matches this"],
    });
    const reg = regWithFixtures(loose, specific);
    const outcome = matchFixture(
      reg,
      sig({ model: "claude-opus-4-7", system: "matches this exactly" }),
    );
    expect(outcome.kind).toBe("fixture");
    if (outcome.kind === "fixture") {
      expect(outcome.fixture.id).toBe("specific");
    }
  });

  it("model_prefix filter rejects non-matching models", () => {
    const f = makeFixture("only-haiku", { model_prefix: "claude-haiku" });
    const reg = regWithFixtures(f);
    const outcome = matchFixture(reg, sig({ model: "claude-opus-4-7" }));
    expect(outcome.kind).toBe("synth");
  });

  it("has_tool matches when tool is in toolNames", () => {
    const f = makeFixture("uses-tool", {
      model_prefix: "claude-",
      has_tool: "search_memory",
    });
    const reg = regWithFixtures(f);
    const outcome = matchFixture(reg, sig({ toolNames: ["get_character_sheet", "search_memory"] }));
    expect(outcome.kind).toBe("fixture");
  });
});

// ---------------------------------------------------------------------------
// signatureFromAnthropicBody
// ---------------------------------------------------------------------------

describe("signatureFromAnthropicBody", () => {
  it("extracts string system prompt + user message", () => {
    const s = signatureFromAnthropicBody({
      model: "claude-opus-4-7",
      system: "You are KA.",
      messages: [{ role: "user", content: "I draw my sword." }],
    });
    expect(s.model).toBe("claude-opus-4-7");
    expect(s.system).toBe("You are KA.");
    expect(s.messages).toEqual([{ role: "user", text: "I draw my sword." }]);
    expect(s.toolNames).toEqual([]);
  });

  it("flattens system blocks into joined string", () => {
    const s = signatureFromAnthropicBody({
      model: "x",
      system: [
        { type: "text", text: "Block 1" },
        { type: "text", text: "Block 2" },
      ],
      messages: [],
    });
    expect(s.system).toContain("Block 1");
    expect(s.system).toContain("Block 2");
  });

  it("flattens content block arrays into joined text", () => {
    const s = signatureFromAnthropicBody({
      model: "x",
      system: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ],
    });
    expect(s.messages[0]?.text).toContain("Part 1");
    expect(s.messages[0]?.text).toContain("Part 2");
  });

  it("extracts tool names", () => {
    const s = signatureFromAnthropicBody({
      model: "x",
      system: "",
      messages: [],
      tools: [{ name: "search_memory" }, { name: "get_npc_details" }],
    });
    expect(s.toolNames).toEqual(["search_memory", "get_npc_details"]);
  });

  it("detects streaming", () => {
    const s = signatureFromAnthropicBody({
      model: "x",
      system: "",
      messages: [],
      stream: true,
    });
    expect(s.streaming).toBe(true);
  });
});
