# M1 Commit 8 — eval harness + 5 golden turns + Haiku judge + CI gate

**Drafted 2026-04-22.** Expands `docs/plans/M1-closure.md §8` to file-level scope. Lands AFTER Commit 9 so the harness can exercise the eval-mode bypass. Consumes MockLLM infrastructure (`docs/plans/mockllm.md`) as its deterministic replay substrate.

---

## Why

ROADMAP §M1 acceptance requires "eval suite green." Without a harness, every prompt or model change becomes trust-the-vibes. Three failure modes this commit prevents:

1. **Silent intent-classifier drift.** A prompt tweak shifts IntentClassifier's output on a canonical social beat; no one notices until play feels off three weeks later.
2. **Voice regressions.** A new Block 1 fragment accidentally dilutes the Bebop register; prose goes generic.
3. **Structural regressions.** Router short-circuits break; WB FLAG paths silently start REJECTing again.

Five golden turns across the intent space + a Haiku-judged narrative rubric + a PR gate catch these before they ship.

Secondary: this harness is the forever-tool. M2 Session Zero evals plug into the same shape. M4 semantic retrieval evals likewise.

---

## Scope

**Lands in this commit:**

1. **5 golden-turn fixtures** at `evals/golden/gameplay/` — YAML, one file per scenario:
   - `bebop-social.yaml` — Spike asks Jet about Julia (intent=SOCIAL, canonical Bebop register).
   - `bebop-combat.yaml` — Vicious ambushes Spike in the church (intent=COMBAT, climactic sakuga trigger).
   - `bebop-exploration.yaml` — Spike drifts through Europa's ice market (intent=EXPLORATION, world-texture test).
   - `solo-leveling-ability.yaml` — Jinwoo summons Igris mid-dungeon (intent=ABILITY, power-display test).
   - `solo-leveling-default.yaml` — low-stakes downtime in the Hunter Association lobby (intent=DEFAULT, trivial-action gate test).
2. **Fixture shape.** Each fixture declares `input` (player_message + campaign fixture + character fixture + last-3-turns summary), `expected_intent` (exact match target: intent + mode + trigger), `expected_outcome_bounds` (`narrative_weight` range, `success_level` set), and `narrative_rubric` (criteria + threshold). Expected pre-pass behavior is asserted directly against the typed output. Expected narrative is scored by the Haiku judge.
3. **Pre-pass MockLLM fixtures** — five scenarios × the pre-pass agents they exercise = ~20 MockLLM fixtures under `evals/fixtures/llm/gameplay/<scenario>/`. Written by hand against the expected JSON shapes so the harness runs deterministically without real API calls. Scenewright / IntentClassifier / OJ / Validator / (selected WB) fixtures per scenario.
4. **KA MockLLM fixtures** — one streaming response per scenario. Hand-authored prose matching the rubric so the Haiku judge scores consistently.
5. **`evals/run.ts`** — harness binary. Loads each golden-turn fixture, loads matching MockLLM fixtures into the registry, seeds a fresh campaign + character in a scratch DB, calls `runTurn({ ..., bypassLimiter: true })`, collects the turn's intent + outcome + narrative. Reports pass/fail per dimension per scenario.
6. **Haiku judge.** `evals/judge.ts` — separate LLM call, real Haiku (not mock) in CI, sends the narrative + rubric + expected criteria, returns 1–5 scores on: *intent_coherence*, *outcome_feasibility*, *narrative_specificity* (named entities present), *voice_adherence* (register matches profile DNA), *causal_logic*. Aggregate `average ≥ 3.5` + no dimension `< 3.0` = pass. Runs once per scenario.
7. **`evals/latest.json`** — canonical output: `{ ranAt, commit, scenarios: [{ id, passed, intentExact: bool, outcomeInBounds: bool, judgeScores: {...}, narrative: "..." }], summary: { passed: N, failed: M, breakdowns: {...} } }`. Committed per run; `.gitignore`-excluded so CI artifacts don't pollute.
8. **`pnpm evals` script.** Package.json entry pointing at `tsx evals/run.ts`. Exits non-zero if any scenario fails.
9. **GitHub Actions workflow** at `.github/workflows/evals.yml` — triggered on PR to master. Spins up a temporary Postgres (via `services: postgres:16` in the workflow), runs migrations, runs `pnpm evals --ci`, posts summary to the PR. Uses real Haiku (a PR-gate sized spend, bounded).
10. **Eval seed fixtures.** `evals/golden/profiles/` already has Cowboy Bebop + Solo Leveling. Ensure each scenario's `input.campaign` references one of them; `input.character` references a scenario-specific character fixture under `evals/golden/characters/`.
11. **Tests on the harness itself.** `evals/run.test.ts` — unit tests on the harness plumbing (fixture loader parses all 5, judge caller respects strict mode, aggregator thresholds correct).

**Explicitly NOT landing here:**

- SZ evals — `M2` deliverable.
- Multi-turn arc evals — requires Chronicler state to persist across calls in a way the harness doesn't yet model. Single-turn scenarios only.
- Adversarial / jailbreak evals — out of scope.
- Cost-budget evals — Commit 9 owns cost tests.
- Per-agent (non-turn) evals — harness is turn-level.
- CI spend cap on the workflow itself — monitored by hand at M1; tune after first 10 runs.

---

## Fixture format

```yaml
# evals/golden/gameplay/bebop-social.yaml
id: bebop-social-ask-jet-about-julia
description: |
  Social beat from the Europa hangar. Spike asks Jet about Julia after
  the whisperer mission. Expected register: restrained, earned silence,
  Jet reveals nothing standing up.
profile_slug: cowboy-bebop
character_fixture: spike-spiegel
last_turns_summary: |
  Turn 1: whisperer mission ended; Spike limping, Jet stitching him.
  Turn 2: crew silent dinner; Faye asleep.
input:
  player_message: "I want to ask Jet about Julia."
expected_intent:
  intent: SOCIAL
  mode: direct
  trigger: player_question
  special_conditions: []
expected_outcome_bounds:
  narrative_weight:
    min: 0.35
    max: 0.65
  success_level:
    one_of: [PARTIAL, FULL]
  justification_non_empty: true
mockllm_fixture_dir: evals/fixtures/llm/gameplay/bebop-social/
narrative_rubric:
  must_include_entity:
    - Jet
    - Julia
  must_not_include:
    - "exposition dump"
    - "Jet explains at length"
  register:
    - "restrained"
    - "earned silence"
    - "cowboy-bebop-noir"
  tone_anchors:
    - "mechanical / domestic detail grounding emotion"
    - "lines breaking off rather than resolving"
  judge_threshold:
    average: 3.5
    min_dimension: 3.0
```

Pre-pass MockLLM fixtures under `mockllm_fixture_dir` use the existing shape from `docs/plans/mockllm.md`, one per agent invocation (scenewright → intent → oj → validator → ka streaming).

---

## File-level breakdown

### New files

- `evals/run.ts` — harness binary.
- `evals/judge.ts` — Haiku-judge caller.
- `evals/aggregate.ts` — per-dimension scoring + latest.json writer.
- `evals/types.ts` — Zod schemas: `GoldenFixture`, `EvalResult`, `JudgeScore`, `EvalSummary`.
- `evals/db-scratch.ts` — seed a throwaway campaign + character in the current DB (or dedicated eval DB via env var `EVAL_DB_URL`).
- `evals/run.test.ts` — harness plumbing tests.
- `evals/golden/gameplay/*.yaml` — 5 scenarios.
- `evals/golden/characters/*.yaml` — character fixtures per scenario.
- `evals/fixtures/llm/gameplay/<scenario>/*.yaml` — ~20 MockLLM fixtures (pre-pass + KA per scenario).
- `.github/workflows/evals.yml` — CI workflow.

### Modified files

- `package.json` — `"evals": "tsx evals/run.ts"`, `"evals:ci": "tsx evals/run.ts --ci"`.
- `docs/plans/M1-closure.md` — mark §8 shipped once the CI gate runs green on the first PR.
- `.gitignore` — add `evals/latest.json`.
- `README.md` (only if one exists — per CLAUDE.md don't create) — skip.
- `evals/fixtures/llm/README.md` — append a section describing the harness consumes the same format under `evals/fixtures/llm/gameplay/`.

### No changes needed

- `src/lib/workflow/turn.ts` — `bypassLimiter` already threaded by Commit 9.
- `src/lib/llm/mock/*` — already able to load a directory of fixtures per the registry shape.

---

## Haiku judge design

Single LLM call per scenario. Input:
```
You are a narrative evaluator. Score the narrative on five dimensions,
1–5 each. Return JSON matching the schema.

Rubric criteria:
  must_include_entity: [...]
  must_not_include: [...]
  register: [...]
  tone_anchors: [...]

Narrative:
  <the turn's narrative_text>

Expected intent + outcome (for reference only, don't score these):
  intent: SOCIAL
  outcome: { narrative_weight: 0.48, success_level: PARTIAL, ... }
```

Output Zod schema:
```ts
z.object({
  intent_coherence: z.number().min(1).max(5),
  outcome_feasibility: z.number().min(1).max(5),
  narrative_specificity: z.number().min(1).max(5),
  voice_adherence: z.number().min(1).max(5),
  causal_logic: z.number().min(1).max(5),
  rationale: z.string(),
})
```

Aggregation per scenario: `average = sum / 5`. Pass iff `average ≥ 3.5` AND `min(dims) ≥ 3.0`. Hard threshold; tune after first 3 PR cycles if too tight.

**Stability check.** `evals/run.test.ts` includes a "stability" test that calls the judge 3× with the same narrative and asserts max dim variance < 0.7. If unstable, set temperature to 0 + add a seed.

---

## CI gate mechanics

Workflow runs on PRs to master. Steps:

1. Checkout + pnpm install.
2. Start Postgres service (workflow `services:` block, `postgres:16` image, pgvector init script).
3. `pnpm drizzle-kit migrate:up` against the throwaway DB.
4. Set `ANTHROPIC_API_KEY` from repo secret (judge only; the turn pipeline runs against MockLLM).
5. Set `AIDM_MOCK_LLM=1` + `MOCKLLM_STRICT=1`.
6. `pnpm evals:ci` — harness loads golden fixtures, seeds DB, runs turn pipeline against MockLLM, feeds narratives to Haiku judge, emits `latest.json` to the Actions artifact.
7. Post a summary comment to the PR with per-scenario pass/fail + aggregated dim scores.
8. Exit non-zero on any failure.

Cost estimate per run: 5 scenarios × ~500 tokens narrative × Haiku rate ≈ **well under $0.01 per PR run**. No budget concern.

---

## Audit focus

- **Fixtures span the intent space.** DEFAULT / COMBAT / SOCIAL / EXPLORATION / ABILITY all represented; no two scenarios collapse to the same intent.
- **Judge rubric produces stable scores.** Test the stability case; variance < 0.7 across repeated runs.
- **PR gate thresholds defensible.** Not too loose (passes when it shouldn't), not too tight (fails on prose nuance). Document chosen thresholds with rationale in the fixture file.
- **Bypass plumbed correctly.** Harness sets `bypassLimiter: true`; route handler never does.
- **Mock fixtures match shape.** Each pre-pass fixture matches the system prompt + user shape the real agent sends, so fixture-match-by-includes doesn't spuriously miss.
- **Judge fixture doesn't leak expected JSON into the prompt.** The judge scores what's given, not what should be; audit the judge prompt.
- **CI workflow reproducibility.** Two consecutive runs on the same commit land identical `latest.json` (modulo timestamps). If not, track down non-determinism (fixture ordering, DB seeding, judge temp).
- **Cost of judge calls logged.** Each judge call's cost captured; visible in the PR summary.

---

## Risks

1. **MockLLM fixture drift.** If KA's Block 1 fragment changes, the scenario's expected narrative (and therefore the KA fixture) goes stale. Mitigation: MockLLM's match-by-semantic-includes is robust to small prompt edits; record-mode regenerates when structural changes happen. Document the re-record cadence in `evals/README.md`.
2. **Judge instability.** If Haiku scores vary >0.7 across runs on identical input, the gate becomes flaky. Mitigations in order: temperature 0, explicit seed, rubric tightening, fall through to "rubric-only" deterministic scoring (regex over narrative for `must_include_entity` etc.) with judge only scoring register/tone.
3. **Flaky DB seed.** Two concurrent PR runs fighting over the same scratch DB. Mitigation: per-run randomized campaign slug; `EVAL_DB_URL` points at a dedicated DB in CI.
4. **Real Haiku in CI surprises.** If the Anthropic key hits a rate limit, the gate fails spuriously. Mitigation: judge runs scenarios sequentially (not parallel); single key should handle the rate.
5. **Fixture maintenance burden.** 5 scenarios × 4–5 fixtures each = ~20 fixtures. If they go stale, audit-fix-commit becomes expensive. Mitigation: set a reminder to re-record after any Block 1 / prompt-registry change.

---

## Scope estimate

~2–3 days of focused work. Golden-turn fixture authoring is the slowest part — 5 scenarios × careful prose drafting. The harness + judge plumbing is straightforward. CI workflow + rerun verification ~½ day.

---

## Delivery order (within this commit)

1. `evals/types.ts` + `evals/golden/gameplay/bebop-social.yaml` (first scenario end-to-end as the reference shape).
2. MockLLM fixtures for bebop-social (pre-pass + KA).
3. `evals/run.ts` skeleton — load + seed DB + run one scenario + print result.
4. `evals/judge.ts` + Zod schema + threshold aggregation.
5. Iterate: four more scenarios, their MockLLM fixtures, harness handles all.
6. `evals/latest.json` writer + `--ci` mode.
7. `pnpm evals` script + local green run.
8. GitHub Actions workflow + first CI run to master-compatible PR.
9. Subagent audit on full stack.
10. Fix findings. Commit. Push.

Close M1's §8 line in `M1-closure.md`.

---

*Drafted 2026-04-22 from `docs/plans/M1-closure.md §8`. Commit depends on Commit 9 (bypass flag) + MockLLM (fixtures). Lands before M1 acceptance ritual.*
