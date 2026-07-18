# AIDM v5 — working agreement

This file is loaded into context on every Claude session in this repo. It's the orientation, not the spec. It deliberately doesn't duplicate what lives in the blueprint, memory, or code — it links.

**The spec-of-record is [`docs/plans/v5-blueprint.md`](docs/plans/v5-blueprint.md) (v3-final, signed 2026-07-06, decision log closed). Read §0 "The Spirit" before any design or architectural work — always, and especially after context loss.** This file's job is to make sure you open it.

---

## Who you're working with

**jcettison.** Sole player, sole developer, author of v3. This is a passion project first, product second. What the machinery buys is not an app — it is more of the moments v3 already gave him: stories that made him laugh out loud, nearly cry, and yearn in real life. Blueprint §0 carries this in full; internalize it before touching anything.

**Model versions (user-confirmed 2026-07-06):** Claude Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5. The player-facing tier menus live in blueprint §3. Do not guess newer models without explicit confirmation.

## Authority ordering

1. **`docs/plans/v5-blueprint.md`** — the signed spec. All §13 decisions are closed; don't relitigate them, and don't quietly deviate. Deviations surface to the user in conversation, never appear first in code.
2. **Memory files** (`project_v5_redesign.md` first) — session-to-session state and the feedback record.
3. **This file** — workflow and substrate discipline.
4. **`reference/aidm_v3/`** — the Python predecessor: the *empirical record* of real failure modes. Never dismiss it, never treat it as plumbing to cut (blueprint axiom 10, §11 ledger) — but it is no longer the design authority; the blueprint is.
5. **`reference/aidm_v4/`** — the shelved TypeScript map. Reference-on-request ONLY. Never import from `reference/` in live code; never recite v4 framings (KA-as-orchestrator, seven MCP memory layers, core-inversion list) as if they were current — they are dead.

## The shape (one-screen map; details in the blueprint §)

- **Premise Instrument** (§4): World · Treatment (24 DNA axes) · Framing (13 enums) · Voice · Canonicality, × four time layers (canonical / active / arc_override / learned). Renderer → **Settei** (Style Charter, Block 1) + Amendments; **Sakkan** (Gauge) measures drift blind against anchors.
- **Turn engine** (§5): **Layout → KeyAnimator → Compositor**. Fixed skeleton, triaged interior; tiers **douga / genga / sakuga**. The KA is the only writer — one creative call per scene; everything else is context compilation. Narration streams free prose + a mandatory `commit_scene` tool trailer; every other model call uses native strict structured output.
- **Memory** (§6): nine campaign layers + the cross-campaign player profile. Every write carries `{turn_id, provenance, confidence}`; tombstones make turns revocable.
- **Direction** (§7): Director (arcs, seeds, dailies), Pacer, Arc Model (Beat < Scene < Episode < Arc < Season < Series), stakes doctrine.
- **Session Zero** (§8): one conductor conversation — the spark, finitude, the intensity contract.
- **The register** (§16): code speaks the studio vocabulary — `Conte`, `Settei`, `Sakkan`, `PencilMark`, yokoku, cour. Plain terms go in docstrings.

## Doctrine (compressed; the full axioms are blueprint §2)

- The engine is a **context compiler**. One writer; distributed judgment, centralized voice. Bookkeeping prose never reaches the player.
- **Quality outranks latency and cost.** *"I'd wait five minutes for a GOOD reply."* Budgets catch waste, never trim deliberate depth.
- **Measured, not vibed.** Corrective pressure is injected only when measurement says so.
- **Whole shape from day one.** A layer with a writer but no reader — or vice versa — is a defect. Empty sets from a live layer are valid; missing layers are not.
- **Player authority:** expressed player word > premise-truth > the engine's inference of what the player would enjoy. Failure is part of the story now; **stories only end intentionally, never at the behest of a die-roll.**
- **The ledger is closed** (§11 + §14 risk 6): new mechanisms require a named failure mode and a pillar, in a plan doc, before code.

---

## How we work

### Planning

- **Non-trivial work starts with a plan** at `docs/plans/M<n>-<topic>.md`, written before implementation. Plan the whole milestone's commits, not the first file. Current: [`M0-substrate.md`](docs/plans/M0-substrate.md).
- **Every bullet listed in a commit's deliverables ships in that commit.** Scope cuts surface to the user before the code lands, never in audit softening.
- **Milestones are depth milestones.** The shape at M1 equals the shape at M6; content sharpens. Don't carve scope with "defer to M4" unless the blueprint already does.

### Audit cadence (load-bearing)

**Every commit: work → subagent audit → fix findings → push.** The audit is non-negotiable and runs via a subagent, not inline. The user does directional review of clean, audited work — not audit review.

- Run the audit on the **full commit stack before push**, not after.
- Audit prompts are specific: what to check, what's out of scope, report format, under 800 words.
- Findings get addressed before pushing; structural findings re-run the audit.
- "Clean commit" is a valid outcome. Don't manufacture findings.
- **The push gate is the FULL remote gate**: `pnpm lint && pnpm typecheck && pnpm test && pnpm evals:ci` — CI runs these same gates (plus a db:migrate setup step), and `evals:ci` is NOT part of `pnpm test`. After pushing, confirm the remote run went green (`gh run list --limit 1`). Gate commands run BARE or `&&`-chained on their own exit codes — piping a gate through grep/tail in the same chain as commit/push swallows the failure (it happened: a red vitest run pushed on 2026-07-11; the failure was flaky, the hole was real). (Learned 2026-07-11: CI was red for seven pushes because evals:ci never ran locally.)

### Presentation pass (player-facing changes; C10 discipline)

The soak proves the engine, never the experience (M1 retro). Any change a player can see gets, before its commit:

- **Browser-verify every touched surface** with real campaign data — not a fixture, not "typecheck green." Structural DOM checks count when the screenshot pipe flakes; a claim without either is a violation.
- **The long-turn case:** a deep-tier KA can think minutes before prose streams — check the staging line, elapsed timer, and that the surface doesn't read as hung.
- **The dropped-stream case:** kill or lose the stream mid-turn and confirm the surface recovers honestly (retry affordance, no frozen half-scene presented as done).
- Both themes if the surface styles anything; `pnpm env:parity` if the change adds env keys.

### Commits

- **Thorough over tiny.** Each commit is a substantial, coherent unit — more coverage per audit cycle.
- **Messages explain the why**, referencing blueprint sections and plan commits.
- **Co-author trailer:** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Never amend a pushed commit. Never `--no-verify` or skip hooks. Never force-push master.**

### When to ask before acting

- **Ask before:** destructive git operations, package removals, migrations altering existing data, auth/permissions/env-config changes, external-visible actions (push is covered by the audit cadence; PRs/posting are not), LLM spend above trivial (>$0.10).
- **Don't ask for:** working-tree edits, local builds/tests/dev server, local git operations, read-only research subagents, files the plan calls for.
- When in doubt, surface the action and its reversibility cost in one sentence, then ask.

### Parallelism

- Independent searches/reads/tool calls go in parallel in the same turn.
- Research beyond ~3 queries → spawn an Explore/general-purpose subagent; don't duplicate its work inline.
- Audits may run in background while drafting the next thing; never push before the audit returns.

### Shell and tooling quirks

- **Shell is Git Bash on Windows.** Unix syntax; set `MSYS_NO_PATHCONV=1` when passing literal `/paths` as arguments.
- **Use dedicated tools** (Glob/Grep/Read/Edit/Write) over shell equivalents. Bash is for actual shell operations.
- **Don't `cd`**; use absolute paths.

---

## Stack + structure

| Area | Tool / location |
|---|---|
| Framework | Next.js 15 App Router |
| Language | TypeScript strict (`noUncheckedIndexedAccess`) |
| Package manager | pnpm 10 |
| Lint/format | Biome 1.9 (`pnpm lint`, `pnpm lint:fix`) |
| Typecheck / tests | `pnpm typecheck` · Vitest (`pnpm test`) |
| DB | Postgres 18 + pgvector 0.8 on Railway (`aidm_v5` database — **never the v4 one**; blueprint says 16, instance is actually 18.3) |
| ORM | Drizzle + drizzle-kit (schema at `src/lib/db/schema.ts`, lands C3) |
| Auth | Clerk v7 (`currentUser()` pattern — no `<SignedIn>/<SignedOut>` in v7) |
| LLM | Anthropic-only for generation, via Claude Agent SDK spine + raw SDK. Player-facing tier menus (§3): narration Sonnet 5 / Opus 4.8 / Fable 5 · judgment Haiku 4.5 / Sonnet 5 / Opus 4.8 · probe Haiku 4.5 / Sonnet 5. Fable narration always configures server-side fallback to Opus 4.8 |
| Embeddings | **Voyage `voyage-3.5` @ 1024 dims — the named exception, frozen at M0** |
| Observability | Langfuse (every model call traced + cost-metered; `pnpm langfuse:latest` for trace questions) + PostHog |
| Deploy | Railway (Dockerfile builder, GitHub push-to-deploy) |
| Schema validation | Zod v4 (Agent SDK peer dep — don't downgrade) |

### Key directories

- `src/lib/types/` — the type pool: salvaged `dna.ts`/`composition.ts` + premise/conte/sidecar/marks/turn/provenance contracts (C2)
- `src/lib/db/` — nine-layer schema + provenance envelope (C3)
- `src/lib/llm/` — `anthropic.ts` singleton; tiers/calls/voyage land C4 (the metered choke point)
- `src/lib/observability/` — Langfuse wrapper + cost meter (C4)
- `src/lib/blocks/` — four-block cache plumbing, append-only Block 3 (C5)
- `src/lib/turn/` — the turn engine: Layout DAG, KA + durable runtime, retrieval/heat, Pacer, rewind (M1 C4–C7)
- `src/lib/compositor/` — Chronicler write groups G1/G2 (M1 C6)
- `src/lib/ingestion/` — §5.4 universal ingestion: extractor → resolver → editor posture (M1 C6)
- `src/lib/sz/` — Session Zero conductor + compiler (M1 C3)
- `src/lib/direction/` — Director, arcs/seeds, session lifecycle (M1 C7)
- `src/lib/sakkan/` — the shared blind scorer (M1 C1) + the §4.5 drift band (M1 C8)
- `src/lib/booth/` — meta booth + override channel responders (M1 C9)
- `src/lib/bible/` — Series Bible composition (M1 C9)
- `src/lib/ka/` — salvaged sakuga/diversity craft logic
- `rule_library/` — guidance chunks + `anchors/` + `exemplars/` grounding data (C6)
- `evals/golden/` — hand-scored profile fixtures (Bebop, Solo Leveling); harness returns C6
- `docs/plans/` — blueprint + milestone plans · `docs/retros/` — milestone retros
- `reference/aidm_v3/`, `reference/aidm_v4/` — the shelved past; read-only

## Substrate disciplines (v5-specific; violations are defects)

- **Every model call flows through the traced trio** in `src/lib/llm/` (from C4): `streamNarration` / `callJudgment` / `callProbe`. No raw SDK calls elsewhere; if it isn't traced and metered, it doesn't ship.
- **`EMBEDDING_DIMENSIONS = 1024` is frozen.** Changing it is a re-embed migration, by design.
- **Block 3 is append-only between compaction events.** Never add a mutation path to the block store; a sliding window silently destroys prefix caching (§5.6).
- **Every layer-table write carries `{turn_id, provenance, confidence, tombstoned_at}`.** Reads go through the `notTombstoned()` helper — it's the rewind substrate.
- **Narration prose streams as free text** (the one structured-output exemption, §5.7); its sidecar arrives as the `commit_scene` tool trailer. Everything else: native strict structured output.
- **Never import from `reference/`.**
- **Automated tests/evals/smokes/soaks never call Fable.** Dev traffic runs Sonnet/Haiku (`DEV_TIER_SELECTION`); Fable spend is player-facing only. A Fable-path change needing live re-verification: ask first, price stated.

## Known gotchas

- **Railway Dockerfile + NEXT_PUBLIC_\*:** every new `NEXT_PUBLIC_*` var needs `ARG` + `ENV` in the builder stage or Next inlines `undefined` and it silently no-ops in the browser (Dockerfile lines 21–38).
- **HOSTNAME=0.0.0.0** required in the runner stage for Next standalone on Railway.
- **Env parsing is lazy** (`env.ts` Proxy). Never call `envSchema.parse(process.env)` at module import — it breaks Next's build-time page-data collection.
- **`getDb()` is a lazy singleton** — pool construction on first access, never module load.
- **Drizzle migrations run from the dev machine**, not Railway (drizzle-kit is a devDep; Railway prunes devDeps).
- **Biome `noDelete`:** use `Reflect.deleteProperty(process.env, "X")` in tests.
- **Vitest + env-dependent tests:** `vi.resetModules()` in `beforeEach` + dynamic `await import()` inside the test.
- **`typedRoutes: false`** in `next.config.ts` — Next 15 typed routes break dev typecheck.
- **Agent SDK native binary:** the Dockerfile's runner stage installs `@anthropic-ai/claude-agent-sdk-linux-x64-musl` by hand (standalone tracing can't follow optional deps) — keep its version pinned to the SDK version.

## Anti-patterns (do not)

- **Don't relitigate closed decisions.** §13 is closed. Model menus, Voyage, media-late, register naming — done. New evidence goes to the user, not into divergent code.
- **Don't simplify carried v3 mechanisms because they look like scaffolding.** Each §11 "C" row exists because the user watched the system fail without it. When instinct says "this isn't needed," ask what failure mode it prevents.
- **Don't add mechanisms beyond the ledger** without a named failure mode + pillar in a plan doc first (§14 risk 6 — v3's 21-agent sprawl is the cautionary tale).
- **Don't defer load-bearing structure.** Axiom 8: whole shape, scaffolded, from M1.
- **Don't mock the database in integration-flavored tests.** State-mutation tests hit the real dev Postgres.
- **Don't write documentation files or READMEs unless asked.** Plans and retros are requested; `*.md` as a substitute for conversation is not.
- **Don't write comments unless the WHY is non-obvious.** No narration comments, no changelog comments.
- **Don't claim UI work is complete without browser testing.** Type-check green ≠ feature works.
- **Don't push before the subagent audit.** Inline "I checked everything" is not a substitute.

## When in doubt

1. Read blueprint **§0**, then the section owning the system you're touching.
2. Read the relevant `reference/aidm_v3/` source for empirical behavior.
3. Check memory — `project_v5_redesign.md` is the session-state anchor.
4. Ask the user.

Memory files that matter most: **authority** `project_v5_redesign.md` · **conduct** `feedback_think_dont_manage.md`, `feedback_no_scope_ducking.md`, `feedback_user_selects_models.md`, `feedback_v3_respect.md`, `feedback_audit_cadence.md` · **context** `user_profile.md`, `project_business_model.md` · **gotchas** `project_railway_next_build_env.md`, `project_langfuse_trace_tool.md`.

## Tone

The user trusts thoroughness over speed. A slower, deeper reply beats a fast surface one. When the work is ambitious, match the ambition. When it's routine, be terse. Don't perform process; do the work and report what happened. Skip the "I'll now do X" preambles — just do X and tell the user what you found.

When you're wrong, say so cleanly. No "you raise a good point" filler. Concede, correct, continue. The blueprint's §15 walk-back log exists because he'd rather see the reversal recorded than papered over.
