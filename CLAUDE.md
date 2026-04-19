# AIDM v4 — working agreement

This file is loaded into context on every Claude session in this repo. Read it first; it's the orientation. It deliberately doesn't duplicate information that lives in memory, ROADMAP, or code — it links.

---

## Who you're working with

**jcettison.** Sole player, sole developer, v3 author. This is a passion project first, product second. User-confirmed model versions as of 2026-04: Gemini 3.1, GPT 5.4, Claude Opus 4.7, Claude Haiku 4.5. Do not guess newer without explicit confirmation.

**What the user is building.** Authorship tooling for a premise-respectful long-form fiction engine. *"Sequel to Berserk."* *"Miyazaki makes Pokemon."* *"Cowboy Bebop as isekai space opera."* The premise is the product; the system's job is to honor it over hundreds of turns against generic-narration gravity. Not an AI DM. Not an RPG. **Read [`project_v4_vision.md`](~/.claude/projects/C--Users-admin-Downloads-aidm-v4/memory/project_v4_vision.md) before any architectural work** — it's the load-bearing authority.

**v3 is the spec.** `./reference/aidm_v3/` is the working Python implementation. When in doubt about behavior, read v3 first. Don't frame v3 as a draft, plumbing to cut, or a cautionary tale. It's accumulated empirical wisdom from years of play. 2026 primitives upgrade the substrate; they don't simplify the structure. See [`feedback_v3_respect.md`](~/.claude/projects/C--Users-admin-Downloads-aidm-v4/memory/feedback_v3_respect.md).

---

## Core inversions (the current vision, easy to forget)

- **KA is the orchestrator.** The cascade inverts. KA runs on Claude Agent SDK and invokes IntentClassifier, OutcomeJudge, Validator, Pacing, CombatAgent, etc. as *consultants* via the Agent tool. In v3 the pipeline called KA last; in v4 KA holds orchestration.
- **Memory is seven cognitive layers**, each an MCP server with its own retrieval shape: ambient, working, episodic, semantic, voice, arc, critical. KA chooses which layer to query. Memory is **written narrated** — storyboarded fragments alongside facts.
- **DNA + composition are the instrument**, not configuration. 24 DNA axes + 13 composition axes are prescriptive pressures the agents apply during generation. Don't treat them as form fields.
- **Session Zero is one conductor conversation**, not a pipeline. Subagents on tap; not orchestrated stages.
- **Build the whole shape scaffolded**, not MVP subsets with M4-deferrals. Empty sets from a live layer are a valid state; missing layers are not. The shape at M1 equals the shape at M8; content inside sharpens over time.

---

## How we work

### Planning

- **Non-trivial work starts with a plan.** Write it as `docs/plans/M<n>-<topic>.md` before implementation. The user's "thorough commits" preference applies to plans too — plan the whole commit, not the first file.
- **Milestones are depth milestones, not feature additions.** Don't carve scope with "defer to M4." If something needs to exist, scaffold it now, ramp content over milestones.
- **Before proposing architectural changes, check the core inversions above.** The failure mode that's happened before: defaulting to harness-mode (ship-efficient) framing when the question is vision-level. When the user pushes back on architecture, drop the plan and actually think before replying. See [`feedback_think_dont_manage.md`](~/.claude/projects/C--Users-admin-Downloads-aidm-v4/memory/feedback_think_dont_manage.md).

### Audit cadence (load-bearing)

**Every commit: work → subagent audit → fix findings → push.** The audit is non-negotiable and runs via a subagent (usually Opus), not inline. The user doesn't do audit reviews — that's the subagent's job. The user does directional review of clean, audited work.

- Run the audit on the **full commit stack before push**, not after. Catching HOSTNAME and ARG issues (M0) required auditing on the full stack, not incrementally.
- Audit prompts should be specific: what to check, what's out of scope, what format to report in. Under 800 words of output.
- If findings surface, address them before pushing. Re-run the audit if findings are structural.
- "Clean commit" is a valid audit outcome. Don't manufacture findings.

### Commits

- **Thorough over tiny.** Each commit should be a substantial, coherent unit. M0 shipped in 7 thorough commits, not 40 tiny ones. User explicitly prefers this — gives more coverage per audit cycle.
- **Commit messages explain the why**, not the what. Reference ROADMAP sections, spike docs, audit findings when relevant.
- **Co-author trailer:** `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **Never amend a committed-and-pushed commit.** Create a new commit.
- **Never `--no-verify`, `--no-gpg-sign`, or skip hooks** unless the user explicitly asks.
- **Never force-push to master.** Ask first if you think it's needed.

### When to ask before acting

Authorization for an action doesn't generalize. Match scope to what was actually requested.

- **Ask before:** destructive git operations (reset --hard, force push, branch delete), package removals, migrations that alter existing data, changes to auth/permissions/env config, any external-visible action (pushing code, opening PRs, posting anywhere), cost-incurring operations above trivial (LLM calls using >$0.10, image generation, long-running background jobs).
- **Don't ask for:** file edits in the working tree, local builds, running tests, running the dev server, local git operations (add, commit, status), spawning research subagents against read-only tasks, creating new files the plan calls for.
- **When in doubt, surface the action and the reversibility cost in one sentence, then ask.** The cost of pausing is low.

### Parallelism

- Independent searches, reads, or tool calls in the same turn go in parallel. Sequential dependencies block.
- Spawn a subagent (Explore / general-purpose) for any research that would take more than 3 queries. Audit-cadence subagents always run via Task.
- Don't duplicate a spawned subagent's work. If you launched an agent, wait for its result — don't also do its searches inline.
- Running the audit in background while you draft the next thing is fine; just don't push before the audit returns.

### Shell and tooling quirks

- **Shell is Git Bash on Windows.** Use Unix syntax (`/dev/null`, forward slashes). Set `MSYS_NO_PATHCONV=1` when passing literal paths like `/sign-in` as arguments or MSYS will rewrite them to `C:\Program Files\Git\sign-in`.
- **Use the dedicated tools** over Bash: Glob for file search, Grep for content search, Read for files, Edit/Write for edits. Only use Bash for actual shell operations.
- **Never `cat`/`head`/`tail`/`sed`/`awk`/`echo` when a tool exists.** Use Read, Edit, Write.
- **Don't `cd`** unless the user asks. Use absolute paths. The CWD is already set.

---

## Stack + structure

| Area | Tool / location |
|---|---|
| Framework | Next.js 15 App Router |
| Language | TypeScript strict (`noUncheckedIndexedAccess`) |
| Package manager | pnpm 10 |
| Lint/format | Biome 1.9 (`pnpm lint`, `pnpm lint:fix`) |
| Typecheck | `pnpm typecheck` (`tsc --noEmit`) |
| Tests | Vitest (`pnpm test`, `pnpm test:watch`) |
| DB | Postgres 16 + pgvector 0.8 on Railway |
| ORM | Drizzle + drizzle-kit |
| Auth | Clerk v7 (`currentUser()` pattern — no `<SignedIn>/<SignedOut>` in v7) |
| LLM — KA | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) on Opus 4.7 |
| LLM — probe | Haiku 4.5 via raw `@anthropic-ai/sdk` |
| LLM — fast tier | Gemini 3.1 Flash via `@google/genai` |
| Workflow | Mastra (`@mastra/core`) for step composition + tool registry |
| Observability | Langfuse (LLM traces) + PostHog (product analytics) |
| Deploy | Railway (Dockerfile builder, GitHub push-to-deploy) |
| Schema validation | Zod v4 |

### Key directories

- `src/lib/types/` — Zod schemas + TS types (profile, campaign, dna, composition, arc, turn)
- `src/lib/env.ts` — lazy Proxy over `envSchema.parse()`; see the file comment
- `src/lib/client-env.ts` — `NEXT_PUBLIC_*` surface for browser code; never bypass with raw `process.env`
- `src/lib/db.ts` — lazy Drizzle singleton with shutdown handlers
- `src/lib/llm/` — provider SDK singletons (`getAnthropic`, `getGoogle`, `getOpenAI`)
- `src/lib/observability/` — `getLangfuse`, `getPostHog` (null-safe, advisory)
- `src/lib/prompts/` — prompt registry + fragments (lands in M1 Commit 2)
- `src/lib/agents/` — agent implementations
- `src/lib/tools/` — Mastra tool registry + MCP server wrappers
- `evals/golden/profiles/` — hand-scored IP fixtures (Cowboy Bebop, Solo Leveling)
- `evals/golden/gameplay/` — 5 golden turns for PR gate (lands in M1)
- `docs/plans/M<n>-*.md` — implementation plans per milestone
- `docs/retros/M<n>.md` — retros at milestone close
- `docs/spikes/*.md` — de-risking spikes with findings
- `reference/aidm_v3/` — v3 Python source, the spec
- `scripts/` — standalone scripts (Langfuse hello, spikes, seeds)

### Known gotchas

- **Railway Dockerfile + NEXT_PUBLIC_\*:** every `NEXT_PUBLIC_*` env var needs `ARG` + `ENV` in the builder stage or Next inlines `undefined` at build time and the var silently no-ops in the browser. Check `Dockerfile` lines 21–38 for the pattern.
- **HOSTNAME=0.0.0.0** required in runner stage for Next standalone on Railway. Without it the server binds to localhost and Railway's proxy returns 404.
- **Env parsing is lazy.** `env.ts` uses a Proxy that parses on first access. Never call `envSchema.parse(process.env)` at module import time — it breaks Next's build-time page-data collection.
- **`getDb()` is a lazy singleton** — pool construction runs on first access, not module load.
- **Drizzle migrations run from dev machine, not Railway.** No `preDeployCommand` pointing at drizzle-kit (it's a devDep; Railway prunes devDeps at runtime).
- **Clerk v7** does not export `<SignedIn>` / `<SignedOut>` components. Use server-side `currentUser()` from `@clerk/nextjs/server`.
- **zod v4** is required (Agent SDK peer dep). Don't downgrade.
- **Biome's `noDelete`** rule + TS strict mode: use `Reflect.deleteProperty(process.env, "X")` in tests, never raw `delete`.
- **Vitest + env-dependent tests:** use `vi.resetModules()` in `beforeEach` + dynamic `await import("./module")` inside the test. Don't try to cache-bust via `?fresh=...` — esbuild loader breaks.
- **`typedRoutes: false`** in `next.config.ts` — Next 15's typed routes are strict and the types only generate at build. Setting true breaks dev typecheck.

---

## The seven memory MCP servers (quick reference)

Each layer has its own retrieval shape. KA chooses which to query.

| Layer | Surface | Used for |
|---|---|---|
| `aidm-ambient` | Block 1 of KA's cache; manifests via prompt rendering | Profile DNA, rules, author voice |
| `aidm-working` | Block 3 sliding window | Current scene; last N exchanges |
| `aidm-episodic` | `recall_scene`, `get_turn_narrative`, `get_recent_episodes` | Turn transcripts as prose; keyword/tsvector search |
| `aidm-semantic` | `search_memory`, `get_critical_memories` | Distilled cross-turn facts; pgvector + 15-category decay |
| `aidm-voice` | `get_voice_patterns`, `get_voice_exemplars_by_beat_type` | Director's journal of cadences that worked |
| `aidm-arc` | `get_arc_state`, `list_active_seeds`, `plantForeshadowingSeed` | Arc plan + foreshadowing causal graph |
| `aidm-critical` | `get_critical_memories`, `get_overrides` | Session Zero facts, player overrides; never decays |

**Write path:** memory writer (background, post-turn) routes content to the appropriate layer(s) and writes **storyboarded fragments** alongside facts. A scene becomes both a searchable fact and a short prose fragment that preserves voice for recall.

---

## Anti-patterns (do not)

- **Don't simplify v3's complexity because it looks like scaffolding.** The cascade, the 24 DNA axes, the sakuga ladder, the authority gradient, the tiered memory — each exists because the user watched the system fail without it. When instinct says "this isn't needed," ask what failure mode it prevents.
- **Don't frame v3 as plumbing to cut** or "~80% redundant." 2026 primitives upgrade the substrate; they don't delete mechanisms.
- **Don't defer load-bearing structure to later milestones.** "M1 needs only X; defer Y to M4" is the wrong frame unless the user explicitly asks for it. The full shape scaffolds from day one; content sharpens with play.
- **Don't skip the subagent audit before push.** Inline "I checked everything" is not a substitute.
- **Don't mock the database in integration-flavored tests.** If a test verifies state mutations, hit the real Drizzle against a real Postgres (dev DB is fine).
- **Don't add features beyond what the task requires.** No speculative abstractions. No backwards-compat shims when changing unshipped code. Three similar lines beats a premature abstraction.
- **Don't write documentation files or READMEs unless asked.** Plans and retros are requested; `*.md` as a substitute for conversation is not.
- **Don't write comments unless the WHY is non-obvious.** No narration comments. No "// added for issue #123". Well-named identifiers carry what.
- **Don't claim UI work is complete without browser testing** when the change affects UI. Type-check green ≠ feature works.
- **Don't generate URLs the user didn't provide** unless you're confident they're for programming tasks (GitHub, npm, docs).

---

## When in doubt

1. Read [`project_v4_vision.md`](~/.claude/projects/C--Users-admin-Downloads-aidm-v4/memory/project_v4_vision.md).
2. Read the relevant `reference/aidm_v3/` source.
3. Check ROADMAP but treat it as a working design doc — it can be wrong; the memory files are the authority when they diverge.
4. Ask the user.

Memory files that matter most:
- **Authority:** `project_v4_vision.md`, `feedback_v3_respect.md`, `feedback_think_dont_manage.md`
- **Workflow:** `feedback_audit_cadence.md`
- **Context:** `project_aidm_v4.md`, `project_v3_soul.md`, `project_v3_profile_and_sz.md`
- **Gotchas:** `project_railway_next_build_env.md`, `project_model_versions.md`

---

## Tone

The user trusts thoroughness over speed. A slower, deeper reply beats a fast surface one. When the work is ambitious, match the ambition. When it's routine, be terse. Don't perform process; do the work and report what happened. Skip the "I'll now do X" preambles — just do X and tell the user what you found.

When you're wrong, say so cleanly. No "you raise a good point" filler. Concede, correct, continue.
