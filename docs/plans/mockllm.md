# MockLLM — design plan

**Drafted 2026-04-21.** Goal: run the full app + integration tests + future eval harness against fake LLM providers, so live LLM calls stop burning API $ in dev + CI.

---

## Why now

The Commit 8 eval harness (planned to ship 5 golden turns for regression gating) needs deterministic LLM responses. Beyond that, dev-loop friction today: every `pnpm dev` session playing through a scenario costs real money against real providers. Current tests use four disparate inline mock patterns (`fakeAnthropic`, `anthropicReturning`, `fakeGoogle`, `stubQuery`) duplicated across ~9 test files. No unified infrastructure; no way to run the actual dev server against a fake backend.

## Goals

1. **Dev-server parity.** `pnpm dev` with one env var on turns to a fully-local LLM backend. UI feels alive — KA streams prose, tools execute, state persists. Zero API $.
2. **Integration test gold.** Fixtures → deterministic replays of real scenarios (Bebop combat, Solo Leveling training montage, etc.). Commit 8's eval harness keys into this.
3. **Unified test helpers.** Replace the 4 hand-rolled patterns with one reusable mock surface + fixture registry.
4. **Provider-agnostic.** Works for Anthropic (live), Claude Agent SDK (live), Google (M3.5), OpenAI/OpenRouter (M5.5+). Same fixture format; provider-specific shape adapters.
5. **Record mode.** Capture real responses once → replay forever. Pre-seed golden fixtures without hand-writing.

## Non-goals

- **Not an LLM emulator.** No real generation. We fake responses.
- **Not a proxy for prod traffic.** Mock server only runs in dev/test environments.
- **Not a fine-tuning harness.** Eval scoring lives in Commit 8's Haiku judge, not here.
- **Not token-accurate.** Usage stats are plausible, not exact — good enough for cost-tracking tests.

---

## Architecture

Three layers, shipped in order:

```
┌───────────────────────────────────────────────────────────┐
│ Layer 3: Record mode + golden fixtures                    │
│   capture once from real API → replay forever             │
├───────────────────────────────────────────────────────────┤
│ Layer 2: Env-driven provider swap                         │
│   AIDM_MOCK_LLM=1 → singletons return mock instances      │
│   Anthropic SDK: baseURL override to mock HTTP server     │
│   Agent SDK: queryFn replaced at module load              │
├───────────────────────────────────────────────────────────┤
│ Layer 1: Mock server + fixture registry                   │
│   HTTP server speaking Anthropic/Google/OpenAI shapes     │
│   Fixture match → respond; fallback synth                 │
│   Reusable in unit tests via MockLlmClient helpers        │
└───────────────────────────────────────────────────────────┘
```

### Layer 1 — mock server + fixture registry

**Module:** `src/lib/llm/mock/`
- `server.ts` — HTTP server speaking provider API shapes. Listens on `MOCKLLM_PORT` (default `7777`).
- `fixtures.ts` — fixture loading, hashing, matching.
- `synth.ts` — fallback synthetic responses when no fixture matches.
- `record.ts` — record-mode capture (Layer 3).
- `testing.ts` — test-ergonomic helpers (`useMockLlm()`, `MockLlmClient`).

**Server endpoints:**
- `POST /v1/messages` — Anthropic `messages.create`, streaming + non-streaming
- `POST /v1beta/models/:model:generateContent` — Google Gemini (M3.5 wire-up)
- `POST /v1/chat/completions` — OpenAI (M5.5 wire-up)
- `GET /fixtures` — list loaded fixtures (debug)
- `POST /fixtures/reload` — hot-reload fixture dir (dev convenience)

**Fixture format** (`evals/fixtures/llm/*.yaml`):

```yaml
id: bebop-social-ask-jet-about-julia
provider: anthropic
endpoint: /v1/messages

# Match strategy — all conditions must hold
match:
  # Exact hash match (when you want rigid replay)
  prompt_hash: "sha256:abc123..."
  # OR semantic matchers (when you want prompt-robustness)
  model_prefix: "claude-opus-"
  system_includes:
    - "You are KeyAnimator"
    - "Cowboy Bebop"
  user_includes:
    - "ask Jet about Julia"

# Response emulating the provider's shape
response:
  id: msg_mock_001
  type: message
  role: assistant
  content:
    - type: text
      text: |
        Jet doesn't look up from the engine block. Grease to his elbows.
        "Julia." The word lands flat. "You're finally asking."
  stop_reason: end_turn
  usage:
    input_tokens: 1840
    output_tokens: 120
    cache_read_input_tokens: 1600
    cache_creation_input_tokens: 0

# Optional streaming events (if response should stream)
streaming:
  chunks:
    - delay_ms: 400        # ttft
      text: "Jet doesn't"
    - delay_ms: 60
      text: " look up"
    # ... one chunk per ~30 tokens
  end_delay_ms: 200
```

**Fixture match order:**
1. `prompt_hash` exact → unambiguous replay
2. Semantic matchers (all conditions AND'd) → first match wins, ordered by specificity
3. No match → synth fallback OR strict-mode error (per config)

**Synth fallbacks** (`synth.ts`):
- **JSON / structured output** — parse the system prompt for Zod-hint ("Return the JSON object now" followed by a schema description). Emit a stub that satisfies the schema with placeholders.
- **Narrative text (KA)** — emit "*Mock narrative: intent={X}, epicness={Y}. The scene resolves.*" (detectable in tests).
- **Tool calls** — single `tool_use` block with `{}` inputs unless fixture specifies.
- **Streaming** — chunk the text over 400ms ttft + 30 tokens/sec.

**Usage stats** — synth emits plausible counts (input = prompt length / 4 chars-per-token; output similar). Fixtures override.

**Cost emulation** — `total_cost_usd` computed from model-specific pricing table (`src/lib/llm/pricing.ts` — derived from env-configured rates, defaults to Anthropic's public pricing). Realistic enough for cost-aware tests.

### Layer 2 — env-driven provider swap

**New env vars:**
```bash
AIDM_MOCK_LLM=1                         # master switch
MOCKLLM_PORT=7777                       # server port
MOCKLLM_FIXTURES_DIR=./evals/fixtures/llm  # fixture dir
MOCKLLM_MODE=fixture_or_synth           # fixture_only | synth_only | fixture_or_synth | record
MOCKLLM_RECORD_TO=./evals/fixtures/llm/recorded/  # record destination
MOCKLLM_STRICT=0                        # 1 = error on unknown prompt (CI mode)
```

**Singleton changes:**

`src/lib/llm/anthropic.ts`:
```ts
export function getAnthropic(): Anthropic {
  if (process.env.AIDM_MOCK_LLM === "1") {
    return new Anthropic({
      apiKey: "mock-key",
      baseURL: `http://localhost:${process.env.MOCKLLM_PORT ?? 7777}`,
    });
  }
  // ... existing real path
}
```

Same pattern for `google.ts`, `openai.ts`.

**Agent SDK swap** — the harder case:

`src/lib/llm/mock/agent-sdk.ts`:
```ts
// Mock `query` that matches @anthropic-ai/claude-agent-sdk's signature.
// Issues HTTP requests to the mock server + emits SDKMessage events.
export async function* mockQuery({ prompt, options }): AsyncGenerator<SDKMessage> {
  // 1. Synthesize what the Agent SDK would do: messages.create → tool dispatch loop → final.
  // 2. Route each internal LLM call through the mock server.
  // 3. Emit stream_event / result messages in the same shape the SDK does.
}
```

`src/lib/llm/mock/index.ts` exports a `getQueryFn()` that returns real or mock based on env.

`src/lib/agents/key-animator.ts` + `chronicler.ts` change one line:
```ts
// was:
const queryFn = deps.queryFn ?? query;
// becomes:
const queryFn = deps.queryFn ?? getQueryFn();
```

`getQueryFn()` is `() => process.env.AIDM_MOCK_LLM === "1" ? mockQuery : query`.

Dep injection still wins over env (tests that pass `queryFn` directly bypass both).

### Layer 3 — record mode + golden fixtures

When `MOCKLLM_MODE=record`:
- Every request not matching a fixture proxies to the real provider.
- Response captured + written to `MOCKLLM_RECORD_TO/<timestamp>-<auto-id>.yaml`.
- Request signature (prompt hash + semantic matchers) pre-filled so fixture is reusable.

**Workflow:**
```bash
# Record a Bebop-social-turn fixture:
AIDM_MOCK_LLM=1 MOCKLLM_MODE=record pnpm dev
# ... play through the scenario in the UI ...
# Stop. Inspect evals/fixtures/llm/recorded/. Move or edit to final path.
```

**Seed scenarios for M1:** three Bebop turns + two Solo Leveling turns cover the main registers (combat / social / exploration / training montage / arc-transition). These become the golden-turn fixtures for Commit 8 eval.

---

## Test ergonomics

**Unit tests** — replace the 4 hand-rolled fakes:

```ts
// Before (4 different patterns):
const anthropic = fakeAnthropic([{ text: "..." }]);

// After (one pattern):
import { useMockLlm } from "@/lib/llm/mock/testing";
const mock = useMockLlm();
mock.anthropicResponds({ content: [{ type: "text", text: "..." }] });
// or mock.fromFixture("bebop-social-ask-jet-about-julia");
```

The `useMockLlm` helper:
- Starts an in-memory mock (no HTTP — intercepts at SDK level via dep injection)
- Registers fixtures scoped to the describe block
- Cleans up after each test
- Returns a handle with `.anthropicResponds`, `.googleResponds`, `.agentSdkResponds`, `.fromFixture`, `.expectCalled`, `.callLog`

**Integration tests** — spin up the real HTTP server:

```ts
// evals/scenarios/bebop-combat.test.ts
import { startMockServer } from "@/lib/llm/mock/server";

describe("Bebop combat scenario", () => {
  let server: MockServer;
  beforeAll(async () => {
    server = await startMockServer({
      port: 0, // random
      fixtures: ["evals/fixtures/llm/bebop-combat/"],
      strict: true,
    });
    process.env.AIDM_MOCK_LLM = "1";
    process.env.MOCKLLM_PORT = String(server.port);
  });
  afterAll(() => server.close());

  it("Spike engages Vicious at climactic stakes", async () => {
    // ... runTurn with real deps; mock server intercepts provider calls
    // Assert narrative + state mutations + cost.
  });
});
```

**Dev server**:
```bash
# Start mock in one terminal:
pnpm mockllm                      # reads MOCKLLM_FIXTURES_DIR env, serves on :7777
# Dev server in another:
AIDM_MOCK_LLM=1 pnpm dev
# Open http://localhost:3000 and play — zero API $.
```

---

## Delivery plan

**6 commits, ~2–3 days** of focused work. Each commit audit-clean per CLAUDE.md cadence.

### A. Layer 1 scaffold + fixture format (~4hr, 1 commit)
- `src/lib/llm/mock/` module structure
- Zod schema for `MockLlmFixture` + validator
- Fixture loader (walks dir, parses YAML/JSON)
- Matcher (prompt_hash exact + semantic includes)
- Synth fallbacks (structured + narrative + tool_use)
- Unit tests for fixture matching + synth generation (no server yet)

### B. HTTP server — non-streaming (~6hr, 1 commit)
- Node `http` server speaking Anthropic's `/v1/messages`
- Fixture match → respond
- Synth fallback
- `pnpm mockllm` CLI (scripts/mockllm.ts) to start standalone
- Integration test: spin up server, hit it with real Anthropic SDK pointing at mock `baseURL`

### C. HTTP server — streaming (~4hr, 1 commit)
- SSE response shape for `stream: true`
- Chunk scheduling (configurable delays, simulates ttft + tokens/sec)
- Integration test: real KA streaming through the mock

### D. Agent SDK `queryFn` swap (~4hr, 1 commit)
- `mockQuery` function matching `@anthropic-ai/claude-agent-sdk` signature
- Routes internal LLM calls through the mock server
- `getQueryFn()` helper reading env
- `key-animator.ts` + `chronicler.ts` use the helper (one-line change each)
- Integration test: runKeyAnimator against mock

### E. Unified test helpers + migration (~4hr, 1 commit)
- `useMockLlm()` in `src/lib/llm/mock/testing.ts` — in-memory SDK-layer intercept, no HTTP
- Migrate the 4 inline fake patterns to the unified helper
- Add `callLog` + `expectCalled` for assertion ergonomics
- Goal: zero hand-rolled fakes remain in tests

### F. Record mode + seed fixtures (~6hr, 1 commit)
- `MOCKLLM_MODE=record` in server
- Captures real responses (proxies to real provider, writes fixture)
- Pre-seed: record 5 Bebop scenarios + 2 Solo Leveling. Commit fixtures.
- Document workflow in README (`evals/fixtures/llm/README.md`).

**Deferred to post-M1:**
- Google `/v1beta/models/.../generateContent` endpoint (lands with M3.5)
- OpenAI `/v1/chat/completions` (M5.5)
- Prompt-cache emulation refinement (current: plausible stub; refine if billing-test regressions)
- UI indicator when mock is active (e.g. yellow banner in dev)

---

## Integration with existing work

**Ties to Commit 8 eval harness** — the golden-turn fixtures from this plan's Phase F become the eval suite's inputs. One format, two consumers:
- Mock server replays in dev / CI.
- Eval harness compares mock responses against Haiku-judged oracles for regression gating.

**Ties to Commit 9 rate limiter / cost cap** — mock's cost emulation lets rate-limiter tests run without real spend.

**Ties to Phase 8.2 portrait resolver** — when image gen joins the mock (M4+), same pattern: separate endpoint (`/v1/generations`), same fixture format.

---

## Risks + open questions

1. **Fixture drift.** Provider updates shift responses; fixtures go stale. Mitigations:
   - Version fixtures by `recorded_at` + `model` fields.
   - Periodic re-record cadence (quarterly or on model snapshot change).
   - Strict-mode CI catches stale fixtures (unknown prompts error).

2. **Prompt-cache semantics.** Anthropic's prompt caching affects latency + billing. Mock emits `cache_read_input_tokens` from fixture OR plausible synth. Billing-accuracy tests might need a dedicated "cache-aware" fixture format (date-anchored, TTL-aware). Defer until a real regression demands it.

3. **Agent SDK subprocess.** The real Agent SDK spawns a Claude process. Our `mockQuery` synthesizes the stream event shape WITHOUT spawning anything — so fidelity on edge cases (interruption, thinking tokens, tool-dispatch retry) depends on how faithfully we replicate the event shape. Start narrow: happy-path streaming + tool dispatch + result. Expand as edge cases surface.

4. **Fixture organization.** 5 golden scenarios × ~10 turns = 50+ fixtures. Plus router pre-pass fixtures (intent / OJ / WB / etc.) per turn. Fixtures could explode. Mitigations:
   - Hierarchical directory layout (`fixtures/llm/scenarios/bebop-combat/turn-01/*.yaml`)
   - Fixture-group loading (load a scenario dir, not individual files)
   - Naming convention: `{scenario}/{turn_num}/{agent}.yaml`

5. **Dev-server realism.** If synth responses feel unrealistically generic, devs playing against mock start mistaking it for broken reality. Mitigations: synth clearly marks itself (`*Mock narrative...*`), strict mode makes unknown prompts explode so dev sees a fixture gap early.

6. **Record mode safety.** Recording against real API in a dev loop accidentally burns $ if left on. Mitigations: `MOCKLLM_MODE=record` logs loudly on every recorded call; CI lint blocks the flag.

---

## Decisions (locked 2026-04-21)

1. **Scope:** all 6 phases. ~2–3 days total, audited per-commit per CLAUDE.md.
2. **Fixture format:** **YAML.** Matches existing data-storage convention in the repo (Profile fixtures + 156-entry rule library are both YAML). `js-yaml` is already a dependency.
3. **Fixture location:** `evals/fixtures/llm/`. Shared with Commit 8 eval harness.
4. **Strict mode:** two env vars. `AIDM_MOCK_LLM=1` turns on routing; `MOCKLLM_STRICT=1` makes unknown prompts error. CI sets both; local dev sets only the first + falls through to synth.
5. **Cost emulation:** hardcoded pricing table in `src/lib/llm/pricing.ts`. Env-configurable is future work if billing regressions demand it.

---

*Drafted 2026-04-21. Decisions locked by jcettison same day. Starting implementation in commit order A → B → C → D → E → F.*
