import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyRegistry } from "../fixtures";
import { type MockServer, startMockServer } from "../server";
import type { MockLlmFixture } from "../types";

/**
 * HTTP mock server integration tests. Spins up the real Node server
 * (no SDK mocking) + hits it through the real `@anthropic-ai/sdk`
 * client pointed at localhost via `baseURL`. Proves the shape is
 * compatible with the real SDK's expectations.
 */

const fixture: MockLlmFixture = {
  id: "test-bebop-social",
  provider: "anthropic",
  match: {
    system_includes: ["You are KeyAnimator"],
    user_includes: ["ask Jet about Julia"],
  },
  response: {
    id: "msg_mock_abc",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Jet doesn't look up from the engine block. Grease to his elbows.",
      },
    ],
    model: "claude-opus-4-7",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1840,
      output_tokens: 120,
      cache_read_input_tokens: 1600,
    },
  },
};

let server: MockServer;
let client: Anthropic;

beforeAll(async () => {
  const registry = emptyRegistry();
  registry.byId.set(fixture.id, fixture);
  const bucket = registry.byProvider.get("anthropic") ?? [];
  bucket.push(fixture);
  registry.byProvider.set("anthropic", bucket);

  server = await startMockServer({ port: 0, registry });
  client = new Anthropic({
    apiKey: "mock-key",
    baseURL: `http://127.0.0.1:${server.port}`,
  });
});

afterAll(async () => {
  await server.close();
});

describe("MockLLM HTTP server — Anthropic /v1/messages", () => {
  it("returns the fixture response through the real Anthropic SDK client", async () => {
    const result = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 512,
      system: "You are KeyAnimator — authorship tool.",
      messages: [{ role: "user", content: "I ask Jet about Julia." }],
    });
    expect(result.id).toBe("msg_mock_abc");
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toMatch(/engine block/);
    }
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(1840);
  });

  it("falls back to synth when no fixture matches", async () => {
    const result = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 256,
      system: "Something totally different.",
      messages: [{ role: "user", content: "Nothing to match here." }],
    });
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toMatch(/mock narrative/);
    }
  });

  it("synth returns valid structured-output '{}' when prompt includes the marker", async () => {
    const result = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 256,
      system: "You are Validator.",
      messages: [{ role: "user", content: "Validate this.\n\nReturn the JSON object now." }],
    });
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toBe("{}");
    }
  });

  it("records every served call in the callLog for assertions", async () => {
    const before = server.callLog.length;
    await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 128,
      messages: [{ role: "user", content: "Ping." }],
    });
    expect(server.callLog.length).toBe(before + 1);
    const last = server.callLog[server.callLog.length - 1];
    expect(last?.endpoint).toBe("/v1/messages");
    expect(last?.method).toBe("POST");
    expect(last?.model).toBe("claude-opus-4-7");
  });

  it("returns 501 on streaming requests (Phase C scope)", async () => {
    // Use raw fetch since the SDK consumes the stream differently.
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 128,
        messages: [{ role: "user", content: "x" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(501);
  });

  it("responds to /health liveness", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fixtures: number };
    expect(body.ok).toBe(true);
    expect(body.fixtures).toBe(1);
  });

  it("lists fixtures via /fixtures debug endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/fixtures`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fixtures: Array<{ id: string }> };
    expect(body.fixtures.map((f) => f.id)).toContain("test-bebop-social");
  });

  it("returns 404 on unknown endpoints", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/completions`);
    expect(res.status).toBe(404);
  });
});

describe("MockLLM HTTP server — strict mode", () => {
  let strictServer: MockServer;
  let strictClient: Anthropic;

  beforeAll(async () => {
    strictServer = await startMockServer({ port: 0, strict: true });
    strictClient = new Anthropic({
      apiKey: "mock-key",
      baseURL: `http://127.0.0.1:${strictServer.port}`,
    });
  });
  afterAll(async () => {
    await strictServer.close();
  });

  it("errors with 400 when no fixture matches", async () => {
    await expect(
      strictClient.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 128,
        messages: [{ role: "user", content: "anything" }],
      }),
    ).rejects.toThrow();
    // Error surface includes the strict-mode message
    const call = strictServer.callLog[strictServer.callLog.length - 1];
    expect(call?.matched).toBe("error");
    expect(call?.responseStatus).toBe(400);
  });
});

describe("MockLLM HTTP server — replaceRegistry hot-reload", () => {
  it("swaps fixtures at runtime", async () => {
    const initial = await startMockServer({ port: 0 });
    try {
      // Before swap, no fixtures.
      const before = await fetch(`http://127.0.0.1:${initial.port}/health`);
      const body = (await before.json()) as { fixtures: number };
      expect(body.fixtures).toBe(0);

      // Swap in a registry with one fixture.
      const registry = emptyRegistry();
      registry.byId.set("hot-reload-test", {
        ...fixture,
        id: "hot-reload-test",
      });
      const bucket = registry.byProvider.get("anthropic") ?? [];
      bucket.push({ ...fixture, id: "hot-reload-test" });
      registry.byProvider.set("anthropic", bucket);
      initial.replaceRegistry(registry);

      const after = await fetch(`http://127.0.0.1:${initial.port}/health`);
      const afterBody = (await after.json()) as { fixtures: number };
      expect(afterBody.fixtures).toBe(1);
    } finally {
      await initial.close();
    }
  });
});
