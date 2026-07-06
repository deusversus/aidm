# M0 — Substrate

*Implementation plan derived from `docs/plans/v5-blueprint.md` (v3-final, signed 2026-07-06). Blueprint §12 M0 scope, decomposed into commits. Status: **DRAFT — awaiting directional review.** Every bullet listed under a commit ships in that commit.*

**M0's job in one sentence:** build the stage floor — repo, DB, model spine, cache plumbing, grounding data, eval skeleton — so that M1 can build the whole loop on ground that never has to be re-poured.

**What M0 is NOT:** no Session Zero, no turn loop, no Renderer/Sakkan logic, no Director/Pacer, no memory writers/readers. Those are M1+. M0 ships zero player-facing behavior beyond a building app shell. Axiom 8 applies to *shape*, and M0's shape is: every contract typed, every table standing with the write discipline baked, every model call routed through one metered choke point.

---

## 0. Structural calls this plan makes (veto here, cheap now)

These are the decisions the blueprint left to the implementation plan. Each is stated once with rationale; approval of this plan approves them.

1. **Rebuild in place, in this repo.** v5 lives here; v4's code moves to the reference shelf as `reference/aidm_v4/` beside `reference/aidm_v3/`. Rationale: this repo already carries the spec (`reference/aidm_v3/`), the signed blueprint, the golden fixtures, the memory pointers, the Railway deploy plumbing with its hard-won Dockerfile gotchas, and the salvage-verbatim files. A fresh repo strands all of it for a cosmetic win. The past stays reference-on-request — now literally, as two shelved directories. (The `aidm_v4` directory name is cosmetic; rename anytime, nothing in the plan depends on it.)

2. **Fresh v5 database.** v4's ten migrations describe v4's schema; v5 does not migrate *from* it, ever. New database (e.g. `CREATE DATABASE aidm_v5` on the existing Railway Postgres instance), fresh `drizzle/` history starting at 0000, v4's migrations shelved with its source. **Env-config change → needs your go-ahead before C3 executes** (per working agreement).

3. **Dependency prunes** (package removals — listed for informed approval): `@google/genai`, `openai`, `@mastra/core`. The blueprint has no consumer for any of them: Anthropic-only generation, Agent SDK as the single spine, in-process tool surfaces (§13: MCP is a deployment wrapper if ever needed). Removing them now is the §14 scope-gravity guard in action. **Added:** `voyageai` (official Voyage TS client). **Kept:** Clerk + svix (working auth substrate), PostHog (product analytics, already wired), Langfuse, Tailwind.

4. **Code speaks the register.** The §16 glossary is the naming authority for v5 code: `layout/`, `ka/`, `compositor/` for the three phases; `Conte` (the Scene Brief type), `Settei` (Style Charter), `Sakkan` (Gauge), `PencilMark`, `commit_scene` (the sidecar tool). Plain-term aliases go in docstrings, not identifiers. Adopting it at M0 avoids a rename sweep later.

5. **Anchor/exemplar v0 axis set (the "top ~10 highest-leverage").** Criterion: axes whose extremes are (a) most often rendered into the Settei across plausible premises and (b) most legible in a 6-scene prose sample — the sentence-level pressure carriers. Proposed ten: `pacing`, `darkness`, `comedy`, `emotional_register`, `intimacy`, `interiority`, `register`, `cruelty`, `epistemics`, `moral_complexity`. This is data, not schema — swap any at skim time without churn.

6. **`rule_library/` is the grounding-data home.** Anchors and exemplars land as `rule_library/anchors/*.yaml` and `rule_library/exemplars/*.yaml`, loaded by the same loader pattern as the carried rule library (v3's shape, §11 C).

**LLM spend in this milestone** (flagged per working agreement): C4 smoke scripts (~cents), C6 exemplar generation (20 passages, narration tier) + not-another-anime judging — estimate **under $5 total**, all traced and metered by the very pipeline being built.

---

## Commit plan

Cadence per the working agreement: work → subagent audit (Opus) → fix findings → push, with the full stack audited before the final push. Six thorough commits.

### C1 — Repo posture: v4 to the reference shelf, v5 skeleton stands

- Move to `reference/aidm_v4/`: `src/`, `tests/`, `drizzle/` (v4 migrations), `ROADMAP.md` (superseded by the blueprint), and v4-specific scripts (`seed-campaign`, `migrate-campaign-providers`, `prompts-dump`, `prompts-graph`, `mockllm`, `spike-mastra-sdk`). Shelved code is reference-on-request — never imported by v5 code (enforced by tsconfig excludes).
- Keep at root, carried live: `rule_library/`, `evals/` (golden fixtures are the regression seed corpus), `scripts/langfuse-hello.ts`, `scripts/langfuse-latest.ts` (the `pnpm langfuse:latest` diagnostic), `scripts/rules-index.ts`, Dockerfile, railway.json, biome/tsconfig/vitest configs.
- Fresh minimal `src/`: app shell (landing page, Clerk auth pages, health/ready routes, Clerk webhook) + `lib/env.ts` (lazy-Proxy pattern carried; vars pruned to match the new dep list; `VOYAGE_API_KEY` added) + `lib/client-env.ts` + `lib/db.ts` (lazy singleton carried). The app must build and deploy green on Railway at the end of this commit — the shell is the deploy canary.
- `package.json`: prunes + adds per §0.3; description updated; script list pruned to what exists.
- **Rewrite `CLAUDE.md` for v5.** The current file preaches v4's core inversions (KA-as-orchestrator, seven MCP memory layers) as authority — actively wrong since the reset, and it's loaded into every session. New CLAUDE.md: the blueprint is the spec-of-record (read §0 Spirit first), register glossary pointer, corrected stack table (no Mastra/Google/OpenAI; Voyage exception; model-tier menus), audit cadence + commit discipline carried verbatim, gotchas carried (Dockerfile ARG, HOSTNAME, lazy env, Clerk v7, Biome noDelete, Vitest env pattern), anti-patterns updated to cite blueprint axioms + §14 risk 6 instead of v4 inversions.
- `.env.example` updated (new DB URL var name unchanged, Voyage key, removed provider keys).

### C2 — The type pool (the contracts)

All Zod v4, under `src/lib/types/`. Salvage is verbatim-with-docstrings; new types transcribe the blueprint's field lists — no invention.

- **Carried verbatim:** `dna.ts` (24 axes + `dnaDelta`) — plus the §4.3 boundary docstrings added to `continuity`, `scope`, `agency`: *"Framing is authoritative for structure; this axis colors rendering only"* with the per-axis tiebreak note. `composition.ts` (13 enums). From v4 `ka/`: `sakuga.ts`, `diversity.ts` + their tests, landed at `src/lib/ka/` (consumed at M1; carried now because they're salvage-verbatim and self-contained).
- **`premise.ts` — the Premise Instrument** (§4): the five components (World reusing the carried profile shapes; Treatment = DNAScales; Framing = Composition; Voice fingerprints; Canonicality = 3 enums + accepted-divergences/forbidden-contradictions lists) × the four time layers (`canonical_`/`active_`/`arc_override`/`learned`-by-reference); `effectivePremise()` = `{...active, ...arc_override}` (learned shades at render time, never mutates — §4.2); the **Premise Contract** (components + hybrid recipe + `spark` verbatim + presentation vocabulary + anchors used) and the SZ sacrosanct records: finitude (`finite`/`indefinite`/`undecided`), the intensity contract (death physics, lethality posture, hard lines, control key), suggestion-affordance preference.
- **`arc.ts`** — carried `ArcOverride` (partials + `transition_signal`) + the §7.3 arc object: `{name, stratum: beat|scene|episode|arc|season|series, dramatic_question, shape, budget: {unit, target, tolerance}, phase, payoff_contract, status}` + canon-weight tag (Special/OVA).
- **`conte.ts`** — the Conte (Scene Brief), exhaustive per §5.1: outcome + reasoning · pre-resolved mechanics · Settei Amendments · Scene-Shape Directives + Pacer beat fields · canonicality directives · hard constraints · callbacks ≤3 · filtered memories ≤5 with provenance · canon chunks ≤3 · entity cards · active consequences ≤8 · world-assertion notes · diversity injections · sakuga sub-mode · research findings · `degraded` flag.
- **`sidecar.ts`** — the `commit_scene` trailer (§5.7): `scene_cast_delta`, `decision_point`, `suggested_moves?`, `intended_seed_mentions`, `sakuga_used?`, `notable_beats`.
- **`marks.ts`** — PencilMark (§6.6): `{topic, direction, evidence, turn_id, confidence, superseded_by?}`.
- **`turn.ts`** — turn tiers (douga/genga/sakuga) with the §5.1 contract table as typed constants (retrieval/consultant/output/TTFT budgets — tunable defaults, one home); effort mapping (douga→`low`, genga→`high`, sakuga→`xhigh`).
- **`provenance.ts`** — the universal write envelope: `{turn_id, provenance, confidence}` (+ tombstone semantics), the axiom-6 substrate every layer table and every typed record reuses.
- Tests: schema round-trips, `dnaDelta`, `effectivePremise` merge, tier-table sanity.

### C3 — DB substrate: nine layers standing, provenance discipline, rewind bones

Fresh Drizzle schema; migration 0000. **Gate: fresh v5 database provisioned (see §0.2).**

- **Spine tables:** `players` (the cross-campaign profile store, §6.9 — thin), `campaigns` (premise contract JSONB, tier→model selections, status), `turns` (input, tier, status, checkpoint markers — the durable-job substrate §5.7), `state_snapshots` (every-5-turns mechanical state, §6.7), `rewinds` (event log), `model_calls` (the cost meter: provider, model, tier, tokens in/out, **cache_read/cache_creation tokens**, dollars, campaign_id, turn_id — Anthropic and Voyage rows in the same table).
- **Layer tables** (one per campaign layer; Working is *not* a table — it's the Block 3 store assembled from the episodic tail + pins, stated in schema docs): `compacted_beats` (+ epoch flag), `episodic_records` (verbatim transcript + narrated fragment), `semantic_memories` (vector(1024), heat columns: base_heat, last_boosted_at, category, floor), `canon_chunks` (vector(1024), page_type, source_profile tag), `entities` + `entity_versions` (catalog; transients never persist — §6.5) + `quests`, `arcs` + `seeds` (+ causal edges) + `consequences` (intent layer), `pencil_marks` + `session_records` (memos, voice journal — learned layer), `critical_facts` (SZ facts, promoted facts), `overrides`, `pins`.
- **The discipline (the actual M0 deliverable):** every layer table carries `turn_id`, `provenance`, `confidence`, `tombstoned_at` — no exceptions; a shared column helper makes omission impossible to do silently. A `notTombstoned()` query helper is the only sanctioned read path.
- **Dimension frozen:** `EMBEDDING_DIMENSIONS = 1024` (voyage-3.5) exported from `src/lib/llm/embedding-config.ts`; the schema imports it; a test asserts schema ↔ constant agreement. Changing it after M0 is a re-embed migration, by design.
- Indexes per §6.4: HNSW on the two vector columns, composite btree on `campaign_id` pre-filters.
- Tests against the **real dev Postgres** (no mocks, per working agreement): round-trip per table, tombstone-exclusion behavior, snapshot write/read.
- Stated caveat: layers 4–8 will gain columns in M1 migrations as writers land; what M0 freezes is the table-per-layer shape, the envelope discipline, and the dimension.

### C4 — Model spine, observability, cost metering

The choke point: after this commit, **every model call in the codebase flows through three functions**, and each is traced and metered or it doesn't exist.

- `lib/llm/anthropic.ts` (raw SDK singleton, carried) + Agent SDK dependency retained as the orchestration spine (exercised at M1; its smoke lives here).
- `lib/llm/tiers.ts` — §3 as code: the three player-facing menus (narration: `claude-sonnet-5` / `claude-opus-4-8` / `claude-fable-5`; judgment: `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-4-8`; probe: `claude-haiku-4-5` / `claude-sonnet-5`), per-campaign selection type (changeable anytime; the "studio handoff" warning is M1 UI, the data shape lands now), effort mapping from `turn.ts`. **Fable narration always configures server-side fallback to Opus 4.8** (`betas: ["server-side-fallback-2026-06-01"]`, `fallbacks: [{model: "claude-opus-4-8"}]`); fallback events land in the trace flagged Sakkan-relevant (§3).
- `lib/llm/calls.ts` — the trio: `streamNarration()` (free prose stream + mandatory `commit_scene` tool trailer; structured-output exemption per §5.7), `callJudgment()` (native strict structured output, Zod-derived schema), `callProbe()` (same, cheap). Adaptive thinking config; effort per tier mapping.
- `lib/llm/voyage.ts` — voyage-3.5 @1024, batched, metered through the same pipeline.
- `lib/observability/` — Langfuse wrapper (every call: campaign, turn, tier, model, latency, tokens, cache stats, dollars) + the pricing table (Fable $10/$50, Opus 4.8 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5 per MTok; Voyage per its sheet) + `model_calls` writer. `pnpm langfuse:latest` adapted to the v5 trace shape.
- Smoke scripts (traced, metered, ~cents): `spike-narration-stream.ts` (streams prose, receives the tool trailer, exercises Fable→Opus fallback config), `spike-judgment-structured.ts`, `spike-embed.ts` (embed → cosine → meter row).
- Tests: tier registry (menu membership, effort mapping, Fable-implies-fallback), pricing math, meter-row correctness against fixture responses.

### C5 — Block-cache plumbing

§5.6 as a module, `src/lib/blocks/`:

- Four-block prompt assembler with breakpoints at the tails of B1/B2/B3 (B3's refreshed each turn).
- **Block 3 store is append-only by construction:** the module's surface offers `appendExchange()` and `compact()` — no other mutation exists, so a per-turn sliding window is unrepresentable, not merely forbidden. Pins hold at B3's head, deduped against the window, ≤5 / ≤2k tokens enforced.
- Compaction *seam*: the event contract (truncate B3 oldest → append beats to B2 → single batched rewrite = the only accepted B2/B3 invalidation) with a stub compactor M1 fills; the trace records each event's cache cost now.
- Pre-warm: server route firing `max_tokens≈1` against the exact B1–3 prefix; proven by script at M0 (the on-input-focus client hook lands with the M1 play view).
- Cache accounting: `cache_read_input_tokens` / `cache_creation_input_tokens` from every response flow into `model_calls` — the substrate for §10.8's explicit hit-rate assertions.
- Tests: append-only invariant, breakpoint placement, pin dedup + budgets, invalidation accounting.

### C6 — Grounding data v0 + eval harness skeleton

- **Anchor library v0** (§4.6): `rule_library/anchors/` — for each of the ten §0.5 axes: 3–5 witness shows pinned to bands + a stored anchor excerpt per pinned band (synthesized in-register per the §4.7 sourcing rule, never verbatim source text). Format: YAML with provenance.
- **Exemplar library v0** (§4.7): `rule_library/exemplars/` — ten axes × two extremes = 20 passages, 80–150 words, provenance `{axis, band, anchor_show, author, method}`. Generation script (narration tier, traced) → **not-another-anime judge** → **your skim** → commit. Nothing lands unjudged or unskimmed.
- Loaders for both, following the carried rule-library pattern; `rules:index` extended.
- **Eval harness skeleton** (§10): runner adapted from `evals/run.ts`; suites scaffolded for all eight §10 evals with two *live* at M0: (a) budget-assertion utilities carrying an explicit cache-hit-rate assumption + cold-turn cost (consumed by soak runs from M1), (b) the not-another-anime judge (§10.6) — live because C6's own exemplar data is its first customer. Reliability eval (§10.1) scaffolded, runs at M2 with the Sakkan. Golden fixtures carried as the regression corpus. (C1 audit note: `evals/golden/gameplay/*.yaml` carry a `mockllm_fixture_dir` field pointing at the v4 MockLLM path now shelved under `reference/aidm_v4/evals/` — remap or drop that field when the harness is rebuilt here.)

---

## Definition of done (M0 exit gate)

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` green; DB tests ran against the real dev Postgres.
2. Railway deploy green (app shell builds, serves, health/ready respond).
3. The three smoke scripts each produce a Langfuse trace and a `model_calls` row with cache accounting — narration stream shows the `commit_scene` trailer; judgment shows native strict structured output; embed shows a Voyage row in the same meter.
4. `EMBEDDING_DIMENSIONS = 1024` frozen: constant, schema, and agreement test.
5. Block 3 append-only invariant tested; no non-compaction truncation path exists in the module surface.
6. Every layer table carries the provenance envelope; `notTombstoned()` helper tested.
7. Boundary docstrings present on `continuity`/`scope`/`agency`.
8. Anchor v0 + exemplar v0 loadable for the ten axes; all 20 exemplars passed the not-another-anime judge and your skim.
9. CLAUDE.md orients a fresh session to the v5 blueprint (§0 Spirit first), not to v4.
10. Full-stack subagent audit run and findings addressed before push.

## User checkpoints (blocking, in order)

- [ ] **Plan approval** — including the §0 structural calls (repo posture, dep prunes, axis set, register naming).
- [ ] **Before C3:** fresh v5 database provisioned / `CREATE DATABASE aidm_v5` approved on the Railway instance.
- [ ] **During C6:** exemplar skim (20 short passages — one sitting).
