# MockLLM fixtures

Golden responses the MockLLM infrastructure (`src/lib/llm/mock/`)
replays to keep dev + test runs off the real LLM APIs. Full design:
`docs/plans/mockllm.md`.

## Layout

```
evals/fixtures/llm/
├── README.md              # this file
├── seeds/                 # hand-authored demonstration fixtures
│   ├── bebop/             # Cowboy Bebop scenarios
│   └── solo-leveling/     # Solo Leveling scenarios
├── gameplay/              # Commit 8 eval-harness fixtures (one dir per
│                          # scenario under evals/golden/gameplay/).
│                          # Loaded by evals/run.ts into an HTTP mock
│                          # server + the Agent SDK queryFn registry.
└── recorded/              # auto-captured fixtures (gitignored by default)
```

Fixtures under `seeds/` are committed — they're the starter set of
"this is what the system should produce" examples + they double as
golden-turn inputs for Commit 8's eval harness. Fixtures under
`recorded/` are captures from live API calls via `--record` mode;
commit selectively (review + rename to `seeds/<scenario>/<step>.yaml`
if you want a given capture to become a regression-gate fixture).

## Authoring a new fixture by hand

1. Pick a semantic match — system + user substrings unique enough to
   identify the prompt. Avoid `prompt_hash` for hand-authored fixtures;
   the hash changes on any prompt drift.
2. Write the YAML following `MockLlmFixture` (Zod-validated; errors
   surface loudly on `pnpm mockllm` startup).

Example — a minimal non-streaming fixture:

```yaml
id: bebop-social-ask-jet
provider: anthropic
match:
  system_includes:
    - "You are KeyAnimator"
    - "Cowboy Bebop"
  user_includes:
    - "ask Jet about"
response:
  content:
    - type: text
      text: |
        Jet doesn't look up from the engine block. Grease to his elbows.
  stop_reason: end_turn
  usage:
    input_tokens: 1840
    output_tokens: 120
    cache_read_input_tokens: 1600
```

## Authoring by recording a real call

```bash
# 1. Start the mock with record mode (requires ANTHROPIC_API_KEY).
AIDM_MOCK_LLM=1 MOCKLLM_MODE=record pnpm mockllm

# 2. In another terminal, run dev pointed at the mock.
AIDM_MOCK_LLM=1 pnpm dev

# 3. Play through the scenario you want to capture.
#    Every unmatched prompt → real API call → fixture written to
#    evals/fixtures/llm/recorded/.

# 4. Review captures. Rename + move to seeds/ for scenarios you want
#    to become permanent replay fixtures.
mv evals/fixtures/llm/recorded/recorded-20260421T183502-abc12345.yaml \
   evals/fixtures/llm/seeds/bebop/combat-01-intent.yaml
```

⚠  **Record mode hits the real API.** Every recorded call costs real
$. The server logs loudly on each capture so the cost is visible.
CI configs set `MOCKLLM_STRICT=1` which is mutually exclusive with
record — record mode can't accidentally run in CI.

## Match-rule precedence

Implemented in `src/lib/llm/mock/fixtures.ts::matchFixture`:

1. **`prompt_hash` exact match** — unambiguous replay. Recordings use
   this. Hand-authored fixtures usually avoid it because rephrasing a
   prompt breaks the hash.
2. **Semantic match** — highest-scoring non-zero fixture wins.
   Scoring weights: `system_includes` / `user_includes` = 2 points per
   hit; `model_prefix` / `has_tool` = 1 point.
3. **No match** → synth fallback (or strict-mode error if
   `MOCKLLM_STRICT=1`).

## Loading fixtures

The fixture registry is loaded once per process from
`MOCKLLM_FIXTURES_DIR` (defaults to `evals/fixtures/llm/`). The mock
server's `/fixtures` endpoint (GET) lists what's currently loaded.
Call `POST /fixtures/reload` to hot-reload after editing during dev
(not implemented yet — use the server restart loop for now).

## Known gaps

- **Streaming capture** — record mode currently captures non-streaming
  responses only. Streaming captures are future work (would need to
  buffer SSE events per request + reconstruct chunk timing).
- **Google / OpenAI providers** — mock endpoints land with M3.5 / M5.5
  respectively. Today, only Anthropic fixtures are honored.
- **Prompt-cache accuracy** — `cache_read_input_tokens` is emitted
  plausibly (from fixture + synth approximation) but not tied to a
  real cache-hit semantic. Billing-accurate tests for prompt caching
  need a more nuanced fixture format.
