import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import jsYaml from "js-yaml";
import { computeRequestHash } from "./fixtures";
import type { AnthropicMessageResponse, MockLlmFixture, RequestSignature } from "./types";

/**
 * Record mode (Phase F of docs/plans/mockllm.md).
 *
 * When the mock server runs with MOCKLLM_MODE=record, requests that
 * don't match an existing fixture proxy through to the real provider
 * API + the response is captured as a YAML fixture file for later
 * replay. Subsequent runs replay from the saved fixture — pay once,
 * test forever.
 *
 * Safety:
 *   - Loud per-call log: "[mockllm RECORD] captured Bebop-social-01
 *     → $0.0083" so the operator sees real API $ being spent.
 *   - Only active when MOCKLLM_MODE=record; default is
 *     fixture_or_synth which never talks to real providers.
 *   - CI configs set MOCKLLM_STRICT=1 which also errors on unknown
 *     prompts → record mode can't accidentally run in CI.
 *
 * Fixture layout — written to MOCKLLM_RECORD_TO directory
 * (default: ./evals/fixtures/llm/recorded/). Filename derived from
 * request hash + timestamp so collisions are impossible:
 *
 *   recorded-20260421T183502-sha256_abc12345.yaml
 */

export interface RecordOptions {
  /** Destination directory for captured fixture YAML files. */
  recordDir: string;
  /** ID prefix for generated fixture ids (default "recorded"). */
  idPrefix?: string;
}

function autoId(prefix: string, hash: string): string {
  const short = hash.replace("sha256:", "").slice(0, 12);
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${prefix}-${ts}-${short}`;
}

function fixtureFilename(dir: string, id: string): string {
  return join(dir, `${id}.yaml`);
}

/**
 * Capture a real provider response as a fixture and write it to disk.
 * Returns the authored MockLlmFixture for immediate use (the mock
 * server calls this AND returns the same response to the client, so
 * the recording is transparent).
 */
export function writeRecordedFixture(
  signature: RequestSignature,
  response: AnthropicMessageResponse,
  options: RecordOptions,
): MockLlmFixture {
  const hash = computeRequestHash(signature);
  const id = autoId(options.idPrefix ?? "recorded", hash);
  const fixture: MockLlmFixture = {
    id,
    provider: signature.provider,
    match: { prompt_hash: hash },
    response,
    recorded_at: new Date().toISOString(),
    notes: [
      `Auto-recorded from ${signature.provider} ${signature.endpoint}`,
      `model=${signature.model}`,
      `system ≈ ${signature.system.length} chars`,
      `${signature.messages.length} message(s)`,
      `tools: ${signature.toolNames.join(", ") || "none"}`,
    ].join("\n"),
  };

  const path = fixtureFilename(options.recordDir, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsYaml.dump(fixture, { lineWidth: 120, noRefs: true }), "utf8");

  // Loud log so the operator sees $ being spent.
  const costEst = response.usage
    ? `in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
    : "usage unknown";
  console.log(`[mockllm RECORD] captured ${id} (${costEst}) → ${path}`);

  return fixture;
}

/**
 * Forward a request to the real Anthropic API and return the parsed
 * response. Used by the mock server when in record mode + no fixture
 * matches. Requires ANTHROPIC_API_KEY in env. Non-streaming only at
 * Phase F; streaming record is future work.
 */
export async function forwardToAnthropic(
  signature: RequestSignature,
  body: unknown,
): Promise<AnthropicMessageResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MOCKLLM_MODE=record requires ANTHROPIC_API_KEY in env (for proxying to real provider).",
    );
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "(no body)");
    throw new Error(
      `Anthropic forward failed: ${res.status} ${res.statusText} — ${errText.slice(0, 300)}`,
    );
  }
  const parsed = (await res.json()) as AnthropicMessageResponse;
  // Silence parameter shadowing: we intentionally match signature's
  // structure without using it past this line.
  void signature;
  return parsed;
}
