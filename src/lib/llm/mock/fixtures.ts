import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import jsYaml from "js-yaml";
import {
  type MatchOutcome,
  type MockLlmFixture,
  MockLlmFixture as MockLlmFixtureSchema,
  type MockProvider,
  type RequestSignature,
} from "./types";

/**
 * Fixture loader + matcher (Phase A of docs/plans/mockllm.md).
 *
 * Two concerns:
 *   1. Discovery — walk a directory, parse YAML, validate each file
 *      against `MockLlmFixture`, return a `FixtureRegistry`.
 *   2. Matching — given a `RequestSignature` from an incoming mock
 *      request, find the best-matching fixture. `prompt_hash` exact
 *      match wins unambiguously; semantic matchers are first-specific-
 *      match. No match → synth fallback (caller's call).
 *
 * Fixture YAML shape lives in `docs/plans/mockllm.md` — see Layer 1.
 */

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface FixtureRegistry {
  /** All fixtures indexed by id. */
  byId: Map<string, MockLlmFixture>;
  /** Fixtures bucketed by provider for O(n_provider) match. */
  byProvider: Map<MockProvider, MockLlmFixture[]>;
  /** Source paths for debugging + record mode. */
  paths: Map<string, string>;
}

export function emptyRegistry(): FixtureRegistry {
  return {
    byId: new Map(),
    byProvider: new Map(),
    paths: new Map(),
  };
}

function walkYaml(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkYaml(p));
    } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Load every fixture under a directory tree. Throws if any file fails
 * Zod validation or if two fixtures share an id — partial registries
 * hide regressions.
 */
export function loadFixtures(rootDir: string): FixtureRegistry {
  const registry = emptyRegistry();
  for (const path of walkYaml(rootDir)) {
    const raw = readFileSync(path, "utf8");
    const parsed = jsYaml.load(raw);
    let fixture: MockLlmFixture;
    try {
      fixture = MockLlmFixtureSchema.parse(parsed);
    } catch (err) {
      const rel = relative(process.cwd(), path);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MockLLM fixture ${rel} failed validation:\n${msg}`);
    }
    // Neither response nor streaming is invalid — caller can't replay.
    if (!fixture.response && !fixture.streaming) {
      throw new Error(
        `MockLLM fixture ${fixture.id} (${path}) must define at least one of response / streaming`,
      );
    }
    if (registry.byId.has(fixture.id)) {
      const other = registry.paths.get(fixture.id);
      throw new Error(`Duplicate MockLLM fixture id "${fixture.id}": ${path} and ${other}`);
    }
    registry.byId.set(fixture.id, fixture);
    registry.paths.set(fixture.id, path);
    const bucket = registry.byProvider.get(fixture.provider) ?? [];
    bucket.push(fixture);
    registry.byProvider.set(fixture.provider, bucket);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Compute the canonical request signature hash. Used for exact `prompt_hash`
 * matching — so a fixture recorded from a specific scenario will replay
 * bit-perfectly.
 *
 * Hash inputs (in order): provider | endpoint | model | system | each
 * message's role+text | tool names (sorted, to normalize order churn).
 *
 * Note: we deliberately EXCLUDE `max_tokens`, `temperature`, `stream`,
 * and other tuning params. A fixture should match regardless of whether
 * the caller bumped max_tokens; the response is the response.
 */
export function computeRequestHash(sig: RequestSignature): string {
  const canonical = [
    sig.provider,
    sig.endpoint,
    sig.model,
    "---system---",
    sig.system,
    "---messages---",
    ...sig.messages.map((m) => `${m.role}::${m.text}`),
    "---tools---",
    [...sig.toolNames].sort().join(","),
  ].join("\n");
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Score a fixture against a signature. Higher = more specific match.
 * Zero = no match. Used to tiebreak when multiple semantic fixtures
 * could match the same request (prefer the more-constrained one).
 */
function scoreSemantic(fixture: MockLlmFixture, sig: RequestSignature): number {
  const rules = fixture.match;
  let score = 0;

  if (rules.model_prefix) {
    if (!sig.model.startsWith(rules.model_prefix)) return 0;
    score += 1;
  }

  if (rules.system_includes?.length) {
    for (const substr of rules.system_includes) {
      if (!sig.system.includes(substr)) return 0;
      score += 2; // system matches are high-signal
    }
  }

  if (rules.user_includes?.length) {
    const userTexts = sig.messages
      .filter((m) => m.role === "user")
      .map((m) => m.text)
      .join("\n");
    for (const substr of rules.user_includes) {
      if (!userTexts.includes(substr)) return 0;
      score += 2;
    }
  }

  if (rules.has_tool) {
    if (!sig.toolNames.includes(rules.has_tool)) return 0;
    score += 1;
  }

  return score;
}

/**
 * Match an incoming request signature against the loaded fixtures.
 *
 * Precedence:
 *   1. Exact `prompt_hash` match on the computed signature hash.
 *   2. Semantic match — highest-scoring semantic fixture.
 *   3. No match — caller decides synth vs strict-mode error.
 */
export function matchFixture(registry: FixtureRegistry, sig: RequestSignature): MatchOutcome {
  const bucket = registry.byProvider.get(sig.provider) ?? [];
  if (bucket.length === 0) {
    return {
      kind: "synth",
      reason: `no fixtures loaded for provider="${sig.provider}"`,
    };
  }

  // 1. Exact hash match (precedence 1).
  const sigHash = computeRequestHash(sig);
  for (const fixture of bucket) {
    if (fixture.match.prompt_hash === sigHash) {
      return { kind: "fixture", fixture, score: 1000 };
    }
  }

  // 2. Semantic match — score all, pick highest-scoring non-zero.
  let best: { fixture: MockLlmFixture; score: number } | null = null;
  for (const fixture of bucket) {
    if (fixture.match.prompt_hash) continue; // skip hash-only fixtures
    const score = scoreSemantic(fixture, sig);
    if (score > 0 && (!best || score > best.score)) {
      best = { fixture, score };
    }
  }
  if (best) {
    return { kind: "fixture", fixture: best.fixture, score: best.score };
  }

  return { kind: "synth", reason: `no fixture matched signature hash=${sigHash}` };
}

// ---------------------------------------------------------------------------
// Request signature extraction from provider bodies
// ---------------------------------------------------------------------------

interface AnthropicRequestBody {
  model: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
  tools?: Array<{ name: string }>;
  stream?: boolean;
}

/**
 * Flatten Anthropic's `messages.create` request body into a signature
 * we can match + hash on. Supports string + block array content shapes.
 */
export function signatureFromAnthropicBody(
  body: unknown,
  endpoint = "/v1/messages",
): RequestSignature {
  const b = body as AnthropicRequestBody;
  const system =
    typeof b.system === "string"
      ? b.system
      : Array.isArray(b.system)
        ? b.system.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n\n")
        : "";
  const messages = (b.messages ?? []).map((m) => ({
    role: m.role,
    text:
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n")
          : "",
  }));
  return {
    provider: "anthropic",
    endpoint,
    model: b.model ?? "",
    system,
    messages,
    toolNames: (b.tools ?? []).map((t) => t.name),
    streaming: !!b.stream,
    rawBody: body,
  };
}
