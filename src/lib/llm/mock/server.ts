import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type FixtureRegistry,
  emptyRegistry,
  matchFixture,
  signatureFromAnthropicBody,
} from "./fixtures";
import { synthesizeAnthropicResponse, synthesizeCostUsd } from "./synth";
import type { AnthropicMessageResponse, RequestSignature, StreamingConfig } from "./types";

/**
 * HTTP mock server (Phase B of docs/plans/mockllm.md). Speaks the
 * Anthropic Messages API shape so the real `@anthropic-ai/sdk` client
 * can be pointed at it via `baseURL` and will treat it as a real
 * provider.
 *
 * Endpoints:
 *   POST /v1/messages             — Anthropic completion (Phase B)
 *   POST /v1/messages (streaming) — SSE streaming (Phase C)
 *   GET  /health                  — liveness (returns { ok: true })
 *   GET  /fixtures                — list loaded fixture ids (debug)
 *
 * Startup modes:
 *   - Via `pnpm mockllm` CLI (scripts/mockllm.ts) for dev-server use.
 *   - Via `startMockServer({ port, fixturesDir, strict })` for
 *     integration tests that want a fresh server per suite.
 *
 * `strict: true` makes unknown prompts respond with HTTP 400 + an
 * error body that identifies the missing fixture by request hash —
 * CI can set this via env MOCKLLM_STRICT=1 so fixture gaps surface
 * loudly instead of silently passing with synth.
 */

export interface StartMockServerOptions {
  /** Port to listen on. 0 = OS-assigned random port. */
  port?: number;
  /** Fixture registry (preloaded) or undefined → empty registry. */
  registry?: FixtureRegistry;
  /** If true, unmatched requests return 400 instead of synth. */
  strict?: boolean;
  /** Bind address (default 127.0.0.1 — loopback-only for safety). */
  host?: string;
}

export interface MockServer {
  /** Actual port the server bound to (useful when port: 0 is passed). */
  port: number;
  /** Underlying Node http.Server — for advanced callers who need it. */
  server: Server;
  /** Close the server + release the port. */
  close: () => Promise<void>;
  /** Every request the server has received, in order. For assertions. */
  callLog: ReadonlyArray<ServedCall>;
  /** Swap the fixture registry at runtime (dev hot-reload path). */
  replaceRegistry: (registry: FixtureRegistry) => void;
}

export interface ServedCall {
  endpoint: string;
  method: string;
  model: string;
  signature: RequestSignature;
  matched: "fixture" | "synth" | "error";
  fixtureId: string | null;
  responseStatus: number;
  timestamp: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    type: "error",
    error: {
      type: status === 400 ? "invalid_request_error" : "internal_server_error",
      message,
    },
  });
}

interface ServerState {
  registry: FixtureRegistry;
  strict: boolean;
  calls: ServedCall[];
}

/**
 * Handle POST /v1/messages. Routes to non-streaming JSON response OR
 * SSE streaming based on the request's `stream: true` flag. Streaming
 * (Phase C) chunks the response text over configurable delays per the
 * fixture's `streaming` block, falling back to a heuristic chunker
 * (~40 chars per chunk, 30ms apart) when streaming on a fixture that
 * only defined a non-streaming `response`.
 */
async function handleAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, "invalid JSON body");
    return;
  }

  const signature = signatureFromAnthropicBody(body, "/v1/messages");
  const outcome = matchFixture(state.registry, signature);

  // Pick the response shape we'll send — for both streaming + non-streaming.
  let response: AnthropicMessageResponse;
  let matched: ServedCall["matched"];
  let fixtureId: string | null = null;
  let streamingConfig: StreamingConfig | null = null;

  if (outcome.kind === "fixture") {
    fixtureId = outcome.fixture.id;
    matched = "fixture";
    if (outcome.fixture.response) {
      response = outcome.fixture.response;
    } else if (outcome.fixture.streaming) {
      // Fixture only has streaming — synthesize a matching response shape
      // by concatenating chunk texts, so non-streaming callers still get
      // valid JSON.
      const text = outcome.fixture.streaming.chunks.map((c) => c.text).join("");
      response = {
        id: `msg_mock_${outcome.fixture.id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model: signature.model || "claude-mock",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(1, Math.ceil(signature.system.length / 4)),
          output_tokens: Math.max(1, Math.ceil(text.length / 4)),
        },
      };
    } else {
      // Shouldn't happen — loadFixtures rejects this shape. Defensive.
      response = synthesizeAnthropicResponse(signature);
    }
    if (outcome.fixture.streaming) streamingConfig = outcome.fixture.streaming;
  } else if (state.strict) {
    const hash = outcome.kind === "synth" ? outcome.reason : "unknown";
    state.calls.push({
      endpoint: "/v1/messages",
      method: "POST",
      model: signature.model,
      signature,
      matched: "error",
      fixtureId: null,
      responseStatus: 400,
      timestamp: new Date().toISOString(),
    });
    sendError(res, 400, `MockLLM strict: no fixture matched (${hash})`);
    return;
  } else {
    response = synthesizeAnthropicResponse(signature);
    matched = "synth";
  }

  // Attach mock cost so downstream cost-aware assertions still work
  // even when the SDK doesn't surface total_cost_usd on messages.create
  // (it only surfaces on Agent SDK result events). Custom header —
  // non-standard but inspectable.
  const costUsd = synthesizeCostUsd(response);

  state.calls.push({
    endpoint: "/v1/messages",
    method: "POST",
    model: signature.model,
    signature,
    matched,
    fixtureId,
    responseStatus: 200,
    timestamp: new Date().toISOString(),
  });

  if (signature.streaming) {
    await streamAnthropicResponse(res, response, streamingConfig, {
      matched,
      fixtureId,
      costUsd,
    });
    return;
  }

  const payload = JSON.stringify(response);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "x-mockllm-matched": matched,
    "x-mockllm-fixture-id": fixtureId ?? "",
    "x-mockllm-cost-usd": costUsd.toFixed(8),
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Streaming — Anthropic SSE events
// ---------------------------------------------------------------------------

interface StreamingMeta {
  matched: ServedCall["matched"];
  fixtureId: string | null;
  costUsd: number;
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chunk a response text into StreamingChunks using a heuristic (~40
 * chars per chunk, 30ms apart). Used when the fixture only defined a
 * non-streaming `response` but the client requested `stream: true`.
 */
function heuristicChunks(text: string): StreamingConfig {
  const chunkSize = 40;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push({
      delay_ms: i === 0 ? 400 : 30, // ttft ~400ms, subsequent 30ms
      text: text.slice(i, i + chunkSize),
    });
  }
  if (chunks.length === 0) {
    chunks.push({ delay_ms: 400, text: "" });
  }
  return { chunks, end_delay_ms: 100 };
}

/**
 * Write the Anthropic streaming-SSE event sequence for a response.
 * Event shape matches the real API:
 *   message_start → content_block_start → content_block_delta* →
 *     content_block_stop → message_delta → message_stop
 */
async function streamAnthropicResponse(
  res: ServerResponse,
  response: AnthropicMessageResponse,
  streamingConfig: StreamingConfig | null,
  meta: StreamingMeta,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "x-mockllm-matched": meta.matched,
    "x-mockllm-fixture-id": meta.fixtureId ?? "",
    "x-mockllm-cost-usd": meta.costUsd.toFixed(8),
  });

  // Derive chunks — either from fixture.streaming or by chunking the
  // response.content[0] text.
  const config =
    streamingConfig ??
    heuristicChunks(
      response.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(""),
    );

  // message_start
  writeSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 },
    },
  });

  // content_block_start — one text block
  writeSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  // content_block_delta — one per chunk, with delay
  for (const chunk of config.chunks) {
    if (chunk.delay_ms > 0) await sleep(chunk.delay_ms);
    writeSseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk.text },
    });
  }

  // content_block_stop
  writeSseEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });

  // message_delta — final usage + stop_reason
  writeSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
    },
    usage: { output_tokens: response.usage.output_tokens },
  });

  // end_delay_ms before final message_stop
  if (config.end_delay_ms > 0) await sleep(config.end_delay_ms);

  writeSseEvent(res, "message_stop", { type: "message_stop" });

  res.end();
}

export async function startMockServer(opts: StartMockServerOptions = {}): Promise<MockServer> {
  const state: ServerState = {
    registry: opts.registry ?? emptyRegistry(),
    strict: opts.strict ?? false,
    calls: [],
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true, fixtures: state.registry.byId.size });
        return;
      }
      if (req.method === "GET" && req.url === "/fixtures") {
        sendJson(res, 200, {
          fixtures: [...state.registry.byId.values()].map((f) => ({
            id: f.id,
            provider: f.provider,
            match: f.match,
          })),
        });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/messages") {
        await handleAnthropicMessages(req, res, state);
        return;
      }
      sendError(res, 404, `unknown endpoint: ${req.method} ${req.url}`);
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(opts.port ?? 7777, opts.host ?? "127.0.0.1", () => {
      server.off("error", onError);
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        server,
        callLog: state.calls,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
        replaceRegistry: (registry) => {
          state.registry = registry;
        },
      });
    });
  });
}
