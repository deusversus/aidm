# M1 Commit 8 — eval harness + 5 golden turns + deterministic CI gate + manual prose review

**Drafted 2026-04-22.** Expands `docs/plans/M1-closure.md §8` to file-level scope. Lands AFTER Commit 9 so the harness can exercise the eval-mode bypass. Consumes MockLLM infrastructure (`docs/plans/mockllm.md`) as its deterministic replay substrate.

**Scope correction 2026-04-22.** The earlier draft had the Haiku judge running live in CI on every PR (~$0.01/PR). That's rejected: **no live LLM calls in CI, ever.** Any automated testing with live costs is a cost + security risk. Prose-quality review moves from an automated CI gate to a **manual process I run at strategic intervals with the user's explicit approval.**

---

## Why

ROADMAP §M1 acceptance requires "eval suite green." Without a harness, every prompt or model change becomes trust-the-vibes. Three failure modes this commit prevents:

1. **Silent intent-classifier drift.** A prompt tweak shifts IntentClassifier's output on a canonical social beat.
2. **Structural regressions.** Router short-circuits break; WB paths silently shift behavior.
3. **Output-shape regressions.** Outcome narrative_weight/success_level ranges stop making sense.

Five golden turns + MockLLM fixtures + deterministic CI checks catch these before they ship.

Prose-quality regressions (voice, register, specificity, tonal drift) are a different class — they need LLM-quality judgment. Those are caught by manual reviews I run locally with your approval, not by CI.

Secondary: the harness is the forever-tool. M2 Session Zero evals plug into the same shape. M4 semantic retrieval evals likewise.

---

## Scope

**Lands in this commit:**

1. **5 golden-turn fixtures** at `evals/golden/gameplay/` — YAML, one file per scenario:
   - `bebop-social.yaml` — Spike asks Jet about Julia (intent=SOCIAL, canonical Bebop register).
   - `bebop-combat.yaml` — Vicious ambushes Spike in the church (intent=COMBAT, climactic sakuga trigger).
   - `bebop-exploration.yaml` — Spike drifts through Europa's ice market (intent=EXPLORATION, world-texture test).
   - `solo-leveling-ability.yaml` — Jinwoo summons Igris mid-dungeon (intent=ABILITY, power-display test).
   - `solo-leveling-default.yaml` — low-stakes downtime in the Hunter Association lobby (intent=DEFAULT, trivial-action gate test).

2. **Fixture shape.** Each fixture declares:
   - `input` — player_message + campaign fixture + character fixture + last-3-turns summary
   - `expected_intent` — exact-match target (intent, mode, trigger, special_conditions)
   - `expected_outcome_bounds` — narrative_weight range, success_level enum set, justification_non_empty
   - `expected_narrative_deterministic` — `must_include_entity: [...]`, `must_not_include: [...]`, `min_length_chars`, `max_length_chars`. CI checks these.
   - `manual_rubric` — criteria for *my* prose review (register, tone anchors, voice adherence). NOT checked in CI. Loaded only when `--judge` flag is passed locally, which I only pass with your explicit approval per review.

3. **Pre-pass MockLLM fixtures** — five scenarios × the pre-pass agents they exercise = ~20 MockLLM fixtures under `evals/fixtures/llm/gameplay/<scenario>/`. Hand-authored against the expected JSON shapes so the harness runs deterministically without real API calls. Scenewright / IntentClassifier / OJ / Validator / (selected WB) per scenario.

4. **KA MockLLM fixtures** — one streaming response per scenario. Hand-authored prose matching each scenario's `expected_narrative_deterministic` and `manual_rubric`.

5. **`evals/run.ts`** — harness binary. Loads each golden-turn fixture, loads matching MockLLM fixtures into the registry, seeds a fresh campaign + character in a scratch DB, calls `runTurn({ ..., bypassLimiter: true })`, collects the turn's intent + outcome + narrative. Reports pass/fail per deterministic dimension per scenario. Exits non-zero if any dimension fails.

6. **Deterministic CI gate.** Runs on PR:
   - Intent exact match (IntentClassifier output vs. `expected_intent`)
   - Outcome bounds (narrative_weight in range, success_level in set, justification non-empty)
   - Narrative must-include: every entity in `must_include_entity` appears
   - Narrative must-not-include: no entry in `must_not_include` appears
   - Narrative length within bounds
   - NO LLM calls. Fast (<30s). Zero recurring cost.

7. **Manual prose review tool (opt-in, explicit approval).** `evals/judge.ts` exists but is gated:
   - Runs only when `pnpm evals --judge` is invoked locally
   - Calls real Haiku 4.5 to score each scenario's narrative on the `manual_rubric` (1–5 per dimension: register, tone, specificity, voice adherence, causal logic)
   - Writes output to `evals/manual-reviews/<YYYY-MM-DD>-<commit>.json` (gitignored; I report findings back to user)
   - I only invoke this when you explicitly approve a review pass. Default flow does not run it.
   - CI workflow never runs it. There is no Anthropic key in CI.

8. **`evals/latest.json`** — canonical output of the deterministic run: `{ ranAt, commit, scenarios: [{ id, passed, intentExact, outcomeInBounds, narrativeChecks: {...} }], summary: {...} }`. Committed by CI as a workflow artifact; locally gitignored.

9. **`pnpm evals`** script — runs deterministic gate. `pnpm evals --judge` adds the manual rubric scoring (my-use-only-with-approval).

10. **GitHub Actions workflow** `.github/workflows/evals.yml` — triggered on PR to master. Spins up Postgres (workflow `services:` block), runs migrations, sets `AIDM_MOCK_LLM=1 + MOCKLLM_STRICT=1`, runs `pnpm evals` (deterministic only). **No API keys injected. No live LLM calls.** Posts summary comment to PR.

11. **Seed fixtures.** `evals/golden/profiles/` already has Cowboy Bebop + Solo Leveling. Each scenario's `input.campaign` references one; `input.character` references a scenario-specific character fixture under `evals/golden/characters/`.

12. **Tests on harness.** `evals/run.test.ts` — harness plumbing: fixture loader parses all 5, deterministic checks fire correctly on stubbed narratives, aggregator thresholds correct, `--judge` path gated behind the flag.

**Explicitly NOT landing here:**

- Live-LLM CI gate — rejected (no live calls in CI ever).
- SZ evals — M2 deliverable.
- Multi-turn arc evals — Chronicler state persistence across eval calls not yet modeled.
- Adversarial / jailbreak evals — out of scope.
- Cost-budget evals — Commit 9 owns cost tests.
- Automated prose regression — explicitly out of scope per user direction. Prose review is manual, strategic-interval, with user approval.

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

# CI-checked: deterministic
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
expected_narrative_deterministic:
  must_include_entity:
    - Jet
    - Julia
  must_not_include:
    - "exposition dump"
  min_length_chars: 200
  max_length_chars: 2000

# NOT CI-checked: manual review only, run by Claude with user's explicit approval.
manual_rubric:
  register:
    - "restrained"
    - "earned silence"
    - "cowboy-bebop-noir"
  tone_anchors:
    - "mechanical / domestic detail grounding emotion"
    - "lines breaking off rather than resolving"
  forbidden_patterns:
    - "Jet explains at length"
    - "three-paragraph monologue"
  judge_threshold_note: |
    Average ≥ 3.5, min dim ≥ 3.0 is my default acceptance. Raise if
    review session surfaces prose drift.

mockllm_fixture_dir: evals/fixtures/llm/gameplay/bebop-social/
```

The `manual_rubric` block is parsed only when `--judge` is passed. CI parses only `expected_intent`, `expected_outcome_bounds`, `expected_narrative_deterministic`.

---

## File-level breakdown

### New files

- `evals/run.ts` — harness binary.
- `evals/judge.ts` — manual prose reviewer; reads `manual_rubric`; calls real Haiku; writes report. Only runs with `--judge` flag.
- `evals/aggregate.ts` — per-dimension scoring + latest.json writer.
- `evals/types.ts` — Zod schemas: `GoldenFixture`, `EvalResult`, `DeterministicChecks`, `ManualRubric`, `JudgeScore`, `EvalSummary`.
- `evals/db-scratch.ts` — seed a throwaway campaign + character in the current DB (or dedicated eval DB via env var `EVAL_DB_URL`).
- `evals/run.test.ts` — harness plumbing tests.
- `evals/README.md` — brief usage note (how to invoke; why CI never runs `--judge`; prose-review cadence is user-approved).
- `evals/golden/gameplay/*.yaml` — 5 scenarios.
- `evals/golden/characters/*.yaml` — character fixtures per scenario.
- `evals/fixtures/llm/gameplay/<scenario>/*.yaml` — ~20 MockLLM fixtures.
- `.github/workflows/evals.yml` — CI workflow (deterministic only; zero API keys).

### Modified files

- `package.json` — `"evals": "tsx evals/run.ts"`, `"evals:ci": "tsx evals/run.ts --ci"`. No `:judge` script entry — invoked by hand.
- `docs/plans/M1-closure.md` — mark §8 shipped once CI gate runs green on first PR.
- `.gitignore` — add `evals/latest.json`, `evals/manual-reviews/`.
- `evals/fixtures/llm/README.md` — append section describing the harness consumes the same format under `evals/fixtures/llm/gameplay/`.

### No changes needed

- `src/lib/workflow/turn.ts` — `bypassLimiter` already threaded by Commit 9.
- `src/lib/llm/mock/*` — already able to load directory of fixtures per the registry shape.

---

## Manual prose review — the approval-gated path

When I detect or you request a prose review:

1. I tell you: "I'd like to run a prose review pass. This will call real Haiku 4.5 against 5 scenarios. Estimated cost: ~$0.01. Proceed?"
2. You say yes (or no).
3. On yes, I invoke `pnpm evals --judge` locally (my machine, with my Anthropic key). Outputs land at `evals/manual-reviews/<timestamp>.json`.
4. I read the judge output, summarize findings, and report back. We discuss whether any fixture's rubric needs tightening / loosening, or whether the narrative needs adjustment.
5. No file committed automatically. Review artifacts gitignored.

Review cadence (suggested, subject to your input):
- Before M1 ship.
- After any prompt-registry or Block 1 fragment change.
- After a model version bump.
- On user request ("let's do a prose pass").

Not automated. Not scheduled. Explicit approval each time.

---

## CI gate mechanics

Workflow on PRs to master. Steps:

1. Checkout + pnpm install.
2. Start Postgres service (`postgres:16` image + pgvector init).
3. `pnpm drizzle-kit migrate:up` against the throwaway DB.
4. Set `AIDM_MOCK_LLM=1` + `MOCKLLM_STRICT=1`. **No `ANTHROPIC_API_KEY` injected.**
5. `pnpm evals:ci` — harness loads golden fixtures, seeds DB, runs turn pipeline against MockLLM, runs deterministic checks, emits `latest.json`.
6. Post summary comment to PR with per-scenario pass/fail.
7. Exit non-zero on any failure.

Cost per run: **$0.** No LLM calls in the pipeline (everything mocked); no judge calls (gated behind `--judge` which CI never passes).

Runtime target: <30s for all 5 scenarios.

---

## Audit focus

- **No live LLM in CI.** Audit the workflow file directly. No API keys referenced. Workflow does not pass `--judge`. Fixtures load only MockLLM; strict mode on.
- **Fixtures span the intent space.** DEFAULT / COMBAT / SOCIAL / EXPLORATION / ABILITY all represented; no two collapse.
- **Deterministic checks are defensible.** Not too loose (passes on generic prose), not too tight (flakes on small edits). `must_include_entity` + `must_not_include` + length bounds — verify with one intentional narrative tweak that should fail, confirm it does.
- **`--judge` is truly gated.** Running `pnpm evals` without the flag does zero LLM work. Running with the flag requires a local Anthropic key.
- **Bypass plumbed correctly.** Harness sets `bypassLimiter: true`; route handler can never.
- **MockLLM fixtures match real prompts.** Each pre-pass fixture's match rules (system_includes, user_includes) match what the real agent sends.
- **CI reproducibility.** Two runs on same commit land identical `latest.json` (modulo timestamps). Non-determinism source = bug.

---

## Risks

1. **MockLLM fixture drift.** If KA's Block 1 fragment changes, the scenario's expected narrative (and the KA MockLLM fixture) goes stale. Mitigations: semantic-includes matching is robust to small prompt edits; record-mode regenerates on structural changes; fixture drift surfaces during manual review sessions.
2. **Deterministic narrative checks feel shallow.** `must_include_entity` + `must_not_include` catches gross regressions but misses voice/tone drift. That's why manual review exists — deliberately split labor.
3. **Flaky DB seed.** Concurrent PRs fighting over the same scratch DB. Mitigation: per-run randomized campaign slug; `EVAL_DB_URL` points at dedicated CI DB.
4. **Fixture maintenance burden.** 5 scenarios × 4–5 fixtures each = ~20 fixtures. Re-record after any Block 1 / prompt-registry change.
5. **`--judge` accidentally run in CI.** Mitigation: the workflow file is audited for the flag's absence; `evals/judge.ts` itself logs loudly on entry ("MANUAL REVIEW MODE — real LLM calls; estimated cost ~$0.01"); a CI env guard in judge.ts (`if (process.env.CI === "true") throw new Error("--judge disallowed in CI")`) makes accidental invocation impossible.
6. **Manual review cadence slippage.** If prose review gets skipped, voice drift lands undetected. Mitigation: milestone-close checklist includes "prose review pass complete with user approval." Not technical, process.

---

## Scope estimate

~2–3 days. Most of the time is golden-fixture prose-drafting + MockLLM fixture authoring. Harness + deterministic aggregator is straightforward.

---

## Delivery order (within this commit)

1. `evals/types.ts` + `evals/golden/gameplay/bebop-social.yaml` as reference.
2. MockLLM fixtures for bebop-social (pre-pass + KA).
3. `evals/run.ts` skeleton — load + seed DB + run one scenario + print result.
4. Deterministic aggregator + thresholds (`evals/aggregate.ts`).
5. `evals/judge.ts` — manual tool, CI-guard, Haiku caller. Logs loudly.
6. Four more scenarios + their MockLLM fixtures.
7. `evals/latest.json` writer + `--ci` mode + `--judge` mode.
8. `pnpm evals` script + local green run (no `--judge`).
9. GitHub Actions workflow + CI-green verification.
10. Subagent audit on full stack.
11. Fix findings. Commit. Push.

Close M1's §8 line in `M1-closure.md`.

---

*Revised 2026-04-22 after user scope correction: no live LLM in CI ever. Prose-quality review becomes a manual, explicit-approval, strategic-interval process Claude runs with the user's permission. Original draft committed as `3cf3d98` prior to correction.*
