import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type FixtureRegistry,
  emptyRegistry,
  matchFixture,
  signatureFromAnthropicBody,
} from "./fixtures";
import { synthesizeAnthropicResponse, synthesizeCostUsd } from "./synth";
import type { AnthropicMessageResponse, RequestSignature } from "./types";

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
 * Handle POST /v1/messages. Streaming path (req body `stream: true`)
 * is Phase C — today returns a 501 for that case.
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

  // Phase B is non-streaming only; Phase C adds SSE.
  if (signature.streaming) {
    sendError(res, 501, "MockLLM streaming endpoint lands in Phase C");
    return;
  }

  const outcome = matchFixture(state.registry, signature);
  let response: AnthropicMessageResponse;
  let matched: ServedCall["matched"];
  let fixtureId: string | null = null;

  if (outcome.kind === "fixture" && outcome.fixture.response) {
    response = outcome.fixture.response;
    matched = "fixture";
    fixtureId = outcome.fixture.id;
  } else if (outcome.kind === "fixture") {
    // fixture matched but only defined streaming — treat as not applicable
    if (state.strict) {
      const errMsg = `MockLLM fixture "${outcome.fixture.id}" has streaming but request is non-streaming`;
      state.calls.push({
        endpoint: "/v1/messages",
        method: "POST",
        model: signature.model,
        signature,
        matched: "error",
        fixtureId: outcome.fixture.id,
        responseStatus: 400,
        timestamp: new Date().toISOString(),
      });
      sendError(res, 400, errMsg);
      return;
    }
    response = synthesizeAnthropicResponse(signature);
    matched = "synth";
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
