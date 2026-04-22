# evals

Golden-turn regression harness (Commit 8).

## Layout

```
evals/
├── run.ts              # harness binary; `pnpm evals` invokes this
├── judge.ts            # manual prose review (Haiku); --judge only
├── aggregate.ts        # deterministic checks + latest.json writer
├── types.ts            # Zod: GoldenFixture, EvalResult, EvalSummary
├── db-scratch.ts       # per-run user/profile/campaign/character seeder
├── run.test.ts         # harness plumbing unit tests
├── golden/
│   ├── profiles/       # canonical IP fixtures (Cowboy Bebop, Solo Leveling)
│   └── gameplay/       # 5 golden-turn scenarios (one per intent)
└── fixtures/llm/
    ├── seeds/          # MockLLM demo fixtures (mockllm.md Phase F)
    └── gameplay/       # per-scenario MockLLM fixtures the harness replays
```

## Running locally

```bash
pnpm evals                 # deterministic gate, one run
pnpm evals -- --filter=bebop-combat   # single scenario
```

## CI

`.github/workflows/evals.yml` runs on PRs to `master`. Zero LLM API keys
injected; `AIDM_MOCK_LLM=1` + `MOCKLLM_STRICT=1` ensure every pre-pass
call routes through the MockLLM HTTP server the harness spins up
programmatically. A Postgres 16 service is attached for the turn-pipeline
DB writes.

## Manual prose review (--judge)

```bash
# Only invoke with jcettison's explicit approval per pass. Costs ~$0.01
# in real Haiku spend per scenario.
ANTHROPIC_API_KEY=sk-ant-... pnpm evals -- --judge
```

Output lands in `evals/manual-reviews/<timestamp>.json` (gitignored).
`judge.ts` throws if `process.env.CI === "true"` so accidental CI runs
can't spend.

## Deterministic checks

Per scenario (runs on every CI):

- **intent** exact match against `expected_intent.intent`
- **epicness** within `expected_intent.epicness_min..max`
- **outcome bounds** (when pre-judge fires) — `narrative_weight_one_of`,
  `success_level_one_of`, `rationale_non_empty`
- **narrative** — every `must_include_entity` present (case-insensitive
  substring), no `must_not_include` phrase hit, length within bounds

A scenario passes iff every dimension passes. `evals/latest.json` is
written on every run (gitignored).

## Adding a scenario

1. Write `golden/gameplay/<id>.yaml` matching `GoldenFixture` (Zod will
   reject malformed entries at load time).
2. Write MockLLM fixtures under `fixtures/llm/gameplay/<id>/` — at
   minimum `intent.yaml` + `ka.yaml`, plus `outcome-judge.yaml` +
   `validator.yaml` when the scenario's intent + epicness crosses
   `shouldPreJudgeOutcome`'s threshold (see
   `src/lib/workflow/turn.ts`).
3. Run `pnpm evals -- --filter=<id>` locally. Iterate.
4. Commit. PR → CI gate runs.

See `docs/plans/M1-commit8-eval-harness.md` for the full spec.
