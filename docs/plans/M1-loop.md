# M1 — The Whole Loop, Thin

*Implementation plan derived from `docs/plans/v5-blueprint.md` (v3-final). Blueprint §12 M1 scope, decomposed into commits. Status: **DRAFT — awaiting directional review.** Every bullet listed under a commit ships in that commit.*

**M1's job in one sentence:** every system the finished product has, standing and wired — SZ conversation through pilot through thirty playable turns, with all nine memory layers written *and* read, the Renderer pressing and the Sakkan measuring — thin everywhere, absent nowhere (axiom 8).

**The exit experience, stated as play:** you sit down, pitch "Cowboy Bebop, but the crew found the money," talk with the conductor for ten minutes while research loads, watch a cold open land in Bebop's register, surface to find the Series Bible in your hands, and play thirty turns across two sessions — combat judged, seeds planted, a pin held, one meta-booth exchange, one recap, one yokoku — and when you check the soak report and `model_calls`, every call is priced and every layer has rows in it.

**What M1 is NOT:** not method-deep (Renderer v2 tuning, anti-repetition, excerpt-anchored Gauge v2 + Voice checklist + reliability calibration → M2); not horizon-deep (organic seed detection, epoch merges, evolution ratification, 100-turn soaks → M3); no hybrids (M4); no billing. No media *work* — but the Compositor's disabled media-trigger seam ships per §9.5's "scaffolded from M1, disabled" (C6). Douga/genga/sakuga contracts run, but sakuga *craft* sharpens at M2.

---

## 0. Structural calls this plan makes (veto here, cheap now)

1. **Commit order follows the data, not the demo.** Renderer before SZ (the conductor's output feeds it, but the Renderer is testable from fixtures now); research before conductor (the conductor needs profiles to ground against); Layout → KA → Compositor in execution order so each commit's tests drive the seam the next commit fills.
2. **The pilot is a normal turn.** No bespoke opening-scene engine: Director startup (reading the Opening State Package) plans the cold open and writes its constraints into the first conte; the KA renders turn 1 through the standard Phase B with `forbidden opening moves` as hard constraints. One path to maintain, and the cold open exercises the real loop on day one. **Named deviation:** §8's handoff wording specifies "a dedicated opening-scene path renders it" — this call bets the standard Phase B with hard constraints suffices; your veto restores the blueprint's wording (and the reversal gets logged §15-style either way).
3. **Universal ingestion ships once, in the Compositor commit, and SZ reuses it.** The extractor→resolver→editor-posture pipeline (§5.4) is one subsystem with two callers (SZ quiet extraction, gameplay world assertions) — built with the gameplay caller first since its tests are cheaper to script, then SZ's caller binds to it.
4. **Session Zero is resumable but single-conversation** (§8): one conductor loop with tools (research, calibration, extraction) — not a staged pipeline. Draft persistence rides the existing campaigns table (`status: draft` + a `szTranscript` jsonb column, migration).
5. **Chat-shaped UI, minimal chrome.** Play view and SZ view are the same streaming-conversation component family; the studio material (bible, ledger) is read-only pages at M1. Browser-tested before any UI commit claims completion (working agreement).
6. **The real compactor replaces `naiveCompactor`** in the Compositor commit (narrated, subtext-first beats per §6.2) — the M0 stub was scaffolding with a named successor, not a keeper.
7. **LLM spend:** research runs, turn-loop development, the 30-turn soak, and eval passes land in the **$20–50** range across the milestone (dominated by the soak and pilot iterations at Sonnet narration). Flagged now; no single script exceeds ~$5 without a note in conversation. **No automated test, eval, smoke, or soak ever calls Fable** (standing user directive): dev traffic runs `DEV_TIER_SELECTION` (Sonnet/Haiku); Fable-path changes needing live re-verification get asked first, price stated. The soak report carries a **spend-attribution line**: engineering total vs. projected per-session play cost at each narration tier.
8. **Two pull-forwards from later milestones, flagged for informed approval:** (a) **recap v1 + yokoku** — §12 stages recap at M3, but §9.4's session-open sequence and the two-session M1 exit experience want thin versions now (recap: compacted beats + arc state, narration-tier; yokoku: vibe-promise from the arc plan). Veto trims C7 and the soak to close-triggers + memo/journal only. (b) Nothing else — the draft's "studio ledger page" was cut for the opposite reason (§9.1 stages studio surfaces at M4; the soak report and `model_calls` answer the cost question at M1).

## Standing dependencies (all green from M0)

Types (C2) · nine-layer schema + provenance/tombstones (C3) · traced trio + tiers + meter + Voyage (C4) · blocks/compaction/pre-warm (C5) · anchors/exemplars + eval harness + NAA judge (C6).

---

## Commit plan

Cadence per the working agreement: work → subagent audit → fix → push, per commit. Ten thorough commits.

### C1 — Renderer v1: the Settei speaks

- `src/lib/renderer/settei.ts`: PremiseContract → **Settei** (Block 1), per §4.4a: identity paragraph → **the spark as a standing note** (§8 reader #1 of 3) → ≤6 rendered axes (extremes ≤3/≥7, ranked by |distance-from-5|; arc-relevance ranking input stubs until the Director lands) each as craft instruction → **2–3 exemplar passages total** pulled from the C6 library for the most extreme axes → one summarizing sentence per non-extreme axis group (7 groups) → Voice fingerprint verbatim → standing pencil marks rendered as craft notes (Learned reader #1). Target 600–900 tokens; budget asserted.
- **Grounding gap rule:** if a golden profile renders an extreme axis outside the v0 ten, its extreme exemplars get authored first (data-only addition through the judge + skim gate; M0 §0.5 explicitly allows the set to grow). No M1 code path may silently score or press an ungrounded axis.
- **The shared blind scorer lands here** (`src/lib/sakkan/score.ts`): axis-definition-prompted, blind to active values — Gauge **v1** scoring per §12 (excerpt-anchoring + reliability calibration are the M2 acquisitions). The efficacy eval and C8's runtime Sakkan consume the SAME function; two diverging scorers would make the eval measure nothing.
- `src/lib/renderer/amendments.ts`: ≤250-token Amendments (§4.4b) from: active arc_override rendered pressure + Sakkan corrective notes (typed input; producer lands C8) + pencil marks newer than the last Settei build.
- `src/lib/renderer/scene-shape.ts`: ≤150-token Scene-Shape Directive (§4.4c) from Framing enums + arc state (arc input typed; producer lands C7).
- World-rules tail for Block 1: power-system limitations + canonicality directives rendered as the hard-core preamble (axiom 3).
- **Renderer-efficacy eval (§10.2) goes live** in the harness: A/B — the same scene brief narrated with and without a target-axis charter, Sakkan-style blind scoring of both outputs on that axis; asserts the pressure moves the needle without collateral drift on two control axes. (Uses the C6 anchors; this is the eval that catches risk §14.4 from day one.)
- Tests: budget bounds, extreme-axis selection math, exemplar pick correctness, marks-shading (render, never mutate), fixture Settei for Bebop golden profile.

### C2 — SZ research: the World loads

- `src/lib/research/anilist.ts`: AniList GraphQL — identity, community tags (primary Treatment signal), franchise graph with season-collapsing disambiguation (§4.6).
- `src/lib/research/wiki.ts`: Fandom scrape → typed pages; page-type classification (character/technique/location/event); quotes → voice-card material.
- `src/lib/research/synthesize.ts`: the bounded synthesis calls (judgment tier): canonical Treatment scoring **anchored against the C6 witness shows**, canonical Framing, power-system synthesis from technique pages, `director_personality` + `author_voice` under the standing test — **every synthesis output gated by the not-another-anime judge before it enters the profile**.
- Canon corpus: wiki pages chunked → `embedTexts` → `canon_chunks` rows (profile-keyed, turnId 0) — Canon layer writer #1.
- Profile persistence: `profiles` table (migration): id, title, ids/aliases, the typed Profile jsonb, research provenance, cached permanently (§8). Scope classifier (micro/standard/complex/epic) sets research depth.
- `pnpm research <title>` CLI; **golden-profile regression**: re-research Cowboy Bebop, diff against `evals/golden/profiles/cowboy_bebop.yaml` shape + spot fields (§10.7 partial).
- Tests: mocked-HTTP unit tests for parsers (fixtures recorded from real responses); one live research run gated behind an env flag (traced, metered, ~$1).

### C3 — SZ conductor: the spark is gathered

- `src/lib/sz/conductor.ts`: the one conversation (§8) — narration-tier persona over the Agent SDK spine with tools: `research_title` (C2), `calibrate_axis` (anchored comparisons: "darker than the show?"), `record_extraction` (universal-ingestion seam; full subsystem binds in C6), `propose_contract`.
- Gathers, as first-class conversation moves (never a form): **the spark** (verbatim; §8's one question), **finitude** (with the plainly-named tension — the Bebop warning), **the intensity contract** (death physics, lethality posture, hard lines, control key opt-in), presentation vocabulary v1, suggestion affordance, **tier selection** (the §3 menus with plain cost/quality framing + the studio-handoff warning).
- The audition + honesty postures (§8): feel-level first reply; existence-validation guard (never confirm an unverifiable season — research validates before calibration proceeds); steering honesty prompt-permission.
- Durable drafts: `campaigns.status='draft'` + `szTranscript` jsonb (migration); resume mid-conversation.
- The compiler: chunked extraction → resolution with merge history → gap verdict (blocking issues halt handoff) → **PremiseContract** (parsed by the C2/M0 zod contract) + **OpeningStatePackage** at §8's full discipline, verbatim list: provenance, confidence, hard/soft constraint tiers, uncertainties with safe assumptions **and degraded-generation guidance**, Director inputs, Animation inputs incl. forbidden opening moves, **cast/world/faction/thread briefs, orphan facts** → critical_facts rows (finitude, intensity, SZ facts) + **the spark seeded as the campaign's first pencil mark** (§8 reader #2) + campaign flips to `active`.
- Player-profile store, thin: SZ writes taste observations; conductor greets a returning player from it (§6.9).
- SZ view: streaming chat UI on the draft campaign; **browser-tested**.
- Tests: compiler unit tests from scripted transcripts; contract round-trip into Renderer C1 (Settei builds from a real SZ output); gap-verdict blocking; **draft-resume round-trip** (transcript + extraction state rehydrate; the conversation continues coherently) incl. the browser resume flow.
- **The C3 user checkpoint, specified:** you run one live SZ conversation yourself (~$1–1.50 at Sonnet narration). The review gates the conductor's *persona and conversation moves only* — the contract schemas are M0-frozen, so a voice rejection reworks a prompt, never cascades into C4–C9.

### C4 — Layout: the conte assembles

- `src/lib/turn/layout.ts` — Phase A as the §5.1 DAG: **intent probe = triage** (one call: intent, epicness, flags, confidence → douga/genga/sakuga contract binding); parallel retrieval fan-out (semantic multi-query ≤3 via Voyage + canon intent-mapped + entity cards + intent-layer callbacks) → **relevance filter** (judgment re-rank, rank floor 0.4, cap 5, v3 skip conditions); parallel Pacer micro-check (timeboxed; full Pacer lands C7 — C4 ships the beat-classification probe); parallel Framing effective-mode compute (code); critical + pins + overrides fetch (code, every tier including douga).
- Outcome judgment with the whole v3 doctrine (§5.1): virtual d20 (code util), anime-logic modifiers, costs-rare-not-default, narrative weight, **power-differential DC floor**. Validation check (sakuga, one retry). **Scale/imbalance selector + context modifiers** (sakuga tier, §11-carried) feeding combat pre-resolution with transactional resource spends.
- Conte assembly (typed, M0 contract) + Phase-A checkpoint write to `turns` (retry-same-dice substrate).
- Heat economy read path (§6.4): query-time decay expression, hot-baseline channel (top-3 ≥60), batched boost accumulation **persisted write-only until C6's batch UPDATE binds** (stated dead-end seam, three commits wide).
- Degrade ladder (§5.5) with per-step trace logging; staging events emitted for the client.
- Tests: triage thresholds, DAG ordering, filter caps, DC-floor cases (the OP-premise table), scale/imbalance cases, degrade ladder order — all with stubbed model calls via a recorded-response harness; one live genga Layout against seeded rows.

### C5 — KA + the durable turn: prose streams

- Turn Runtime (§5.7): `POST /api/campaigns/[id]/turns` enqueues; a worker executes Layout → KA → **G1-minimal** with per-step checkpoint markers; SSE streams staging events + prose deltas; reconnect finds the turn in-progress or complete; queued input during commit.
- **G1-minimal, explicitly here** (the audit-clean split — the rest of Group 1 is C6's): the episodic verbatim record (without it, the M0 block assembler gives turn 2 no window — turns couldn't chain) + per-step checkpoint completion markers (without them, crash-replay has nothing to replay from). C6 owns everything else G1 lists.
- Phase B: `streamNarration` with blocks 1–3 (C5/M0 assembler; Settei from C1) + conte as Block 4; commit_scene trailer parsed; **missing-trailer probe fallback** (§5.7, logged); Phase-B retry reuses the checkpointed conte — same dice; typed player-visible error after one auto-retry.
- **The KA's budgeted research loop** (§5.1 contracts: ≤2 genga / ≤4 sakuga; 0 douga): `search_lore` (canon layer) + `recall_scene` / `get_turn_narrative` (episodic) as Phase-B tools — the recall tools ship here and C7's Director investigation reuses them. These round-trips are §5.6's *guaranteed* within-turn cache reads; the C4 degrade-ladder step ("cap research to 2, then 0") gets its mechanism.
- Sakuga ladder consumes intent flags (M0-carried `selectSakugaMode`); player-agency stop rule in the KA prompt; presentation vocabulary granted in the Settei.
- Play view: streaming prose, staging progress line, decision points + suggestion chips (per affordance setting; dismissible; never in prose), typed error states with retry, queued-input indicator, pin-from-selection; pre-warm fires on input focus after >4min idle (the C5/M0 route's client half). **Browser-tested.**
- Tests: worker checkpoint/crash-replay (kill between phases AND mid-Phase-B-stream — restart, same dice, no double episodic write), trailer fallback, research-budget caps, SSE contract incl. disconnect/reconnect; live: one full douga + genga turn chained end-to-end on the dev DB (turn 2 sees turn 1 via G1-minimal).

### C6 — Compositor: the flywheel writes

- **Group 1, the rest (must-commit, §5.8; C5 shipped the minimal slice):** mechanical-state application with idempotency guards · consequence application · cast-catalog changes from the sidecar (explicit-admission guard — extraction never creates) · override/pin updates.
- **Group 2 (async, each idempotent + checkpointed):** narrated episodic fragments · semantic distillation (facts + embeddings + categories + `is_plot_critical` → **criticality promotion** to critical_facts, `mark_critical` tool) · entity enrichment + relationship analysis incl. **faction-reputation ripple** + interiority thresholds + quest/location bookkeeping · spotlight-debt updates · seed confirmation (declared path: sidecar mentions → one probe) · arc_override transition watcher (§4.2) · pencil-mark writers (probe-detected meta comments; booth and Sakkan writers bind in C8/C9) · **the real compactor** (narrated subtext-first beats; replaces naiveCompactor) · Director trigger evaluation (binds C7; until then evaluates and logs, stated) · heat-boost batch UPDATE (closes C4's stated seam) · **the disabled media-trigger seam** (§9.5/§5.8: a no-op dispatch point + the reference-pipeline scaffold note on visual_style — build knowing it's coming, touch nothing).
- **Universal ingestion subsystem** (§5.4, structural call 3): extractor → resolver (against canon corpus AND campaign state — Bebop's "The Syndicate" links, never duplicates) → editor posture (ACCEPT default / CLARIFY local-physical / FLAG craft) → typed provenance-carrying writes. Gameplay world-assertion channel wired; SZ's `record_extraction` (C3) rebinds to it.
- Rewind, end to end (§6.7): `rewindCampaign(to)` — tombstone layer writes > N, restore nearest snapshot ≤ N + replay G1 forward, snapshot every 5 turns, rewinds log; play-view affordance (≤10 turns). Non-reversible external effects flagged in the response.
- Tests (real DB, the M0 pattern): G1-before-next-Phase-A ordering, G2 catch-up after crash, ingestion resolver against seeded canon, promotion/demotion round-trip, rewind-then-replay (the partial-index case in anger); live: 3-turn sequence with full G2 settling.

### C7 — Direction v1: the story wants something

- **Director** (§7.1): hybrid trigger (≥3 turns AND epicness ≥2.0 / arc events / 8-turn max) in G2; investigation loop (≤6 tool rounds over seeds, spotlight, entities, semantic search, `recall_scene`, canon); dailies v1 (Gauge trend consumption stub until C8; Framing adherence qualitative check; Critical-layer size review); typed output (arc plan, single arc_override latest-wins with transition signal, Scene-Shape base, seeds planted/resolved with wiring, spotlight debt, director notes, voice patterns).
- **Arc objects live** (Episode/Arc strata per §7.3): budget tracked (position = consumed), phase, payoff contract; Season/Series rows exist with defaults (cour) but plan only at Arc granularity at M1. **Genre arc templates read from the rule library as budget/shape priors** (§11-carried; scene-guidance chunks defer to M2's beat craft, stated). **The spark is a standing Director input** for arc planning and dailies (§8 reader #3).
- **Pacer full** (§7.2): beat classification, escalation target, tone, must-reference/avoid, foreshadow hint; phase gates with stall tables deferring to player momentum; tri-level strength with **override admitted only on stall-table threshold** (axiom 3); effort promotion for escalation beats (§3's narratively-trivial-≠-functionally-trivial caveat).
- **Director startup** (campaign open): reads Opening State Package **and the Learned layer** (prior memos + marks — Learned reader #2), plans the pilot, writes cold-open constraints (incl. forbidden opening moves) into turn 1's conte. **Session lifecycle** (§9.4), the full open sequence: recap → Director startup-or-review → **Settei rebuild (batched pending marks — the §4.4a regeneration trigger; without it, in-play marks could never reach Charter v1 and the Amendments set would grow unbounded)** → cache pre-warm. Close: triggers (explicit / 30-min idle / 12-turn rolling checkpoint), memo + voice journal, **yokoku** (vibe-promise discipline). Recap v1 (narration-tier, premise-rendered, sources: compacted+intent+episodic) — recap/yokoku are the flagged §0.8 pull-forwards.
- Seeds: ledger operations (plant/confirm/resolve/abandon, payoff windows, urgency-on-mention, dependency gates, overdue→tension). Organic sweep is M3; the declared path (C6) is the M1 detector.
- Tests: trigger math, stall tables, arc budget arithmetic, startup-reads-memo (Learned round-trip), **a mark written in session 1 appears in session 2's Settei** (the regeneration trigger, asserted), scripted 10-turn run where a planted seed's callback appears in a conte within its window.

### C8 — Sakkan v1: drift is measured

- `src/lib/sakkan/`: cadence (every 8 turns + session close; sakuga-scene trigger too), sample = last 6 KA outputs (KA prose only); scoring via **the C1 shared scorer** — Gauge **v1** per §12: blind to active values, axis-definition-prompted; scored set = currently rendered axes + corrective-note axes; typed output {score, confidence, evidence_span}. (Excerpt-anchored blind protocol, Voice checklist, and reliability calibration are §12's named **M2** acquisitions — Gauge v2; not pulled forward.)
- Drift band (§4.5): |active−observed| ≥ 2 at confidence ≥ 0.6 on **two consecutive samples** → corrective note into Amendments (strong, expiring on an in-band read); degraded turns excluded from samples; trust rule (advisory only, never a regenerate loop).
- Consumers wired: Amendments (C1's typed input now has its producer), Director dailies trend, pencil-mark writer #3 (N=3 consecutive same-axis drift), the per-axis canonical/active/observed record (data only at M1 — its display surface is M4's studio view).
- Tests: band edge cases (1-sample spike ≠ drift; expiry on read-back), excluded-degraded sampling; live: score 6 fixture scenes of deliberately-drifted prose against the Bebop Settei and watch the note fire.

### C9 — Channels + the Bible: co-authorship surfaces

- **Meta booth** (§5.4): probe router → ONE responder (Director for craft/direction, KA for prose/voice; explicit summon for the other), 12-exchange cap with resolution summary, booth calls reuse the cached blocks-1–3 prefix, outcomes write pencil marks (writer #4) and/or overrides.
- **Override ledger + pins UI**: list/add/remove; injected every turn including douga (M0 substrate already reads them); pin add sets `sourceTurn`.
- **World assertions UI**: accept/clarify/flag surfaced honestly in-stream (C6 subsystem's front end).
- **The Series Bible** (§9.1): first edition composed at pilot completion, revealed **after** the cold open; grows via ingestion (player-minted entities appear with provenance); read-only page. (The draft's "studio ledger page" is cut — §9.1 stages studio surfaces at M4; `model_calls` + the soak report answer the cost question at M1.)
- **On-demand suggestions** (§9.2's second half): a player-summonable probe-tier call producing 2–3 chips — the summon affordance in the play view alongside the sidecar-carried chips.
- **Campaign shelf**: list/open/archive/delete (soft), draft-resume entry into SZ.
- All UI **browser-tested**; `/campaigns` placeholder replaced.
- Tests: router single-responder, booth cap, booth-cache prefix reuse (metered cache reads asserted), bible composition from seeded layers.

### C10 — The flywheel proves: playable to turn 30

- **Round-trip flywheel test (§6.8), the M1 gate:** for each of the nine layers + player profile, a scripted probe played through the REAL turn loop plants content; a later scripted turn obliquely references it; the trace must show the layer's reader surfacing it into the conte (or consumer). One named test per layer; all green = the flywheel is closed.
- **30-turn soak** (scripted Bebop run, player side driven by a probe-tier scripted persona; **runs on `DEV_TIER_SELECTION` — never Fable, standing directive**): two "sessions" with a close/reopen (recap + yokoku exercised, per the §0.8 pull-forward), ≥1 combat (sakuga), ≥1 douga, a pin, an override, a booth exchange, a world assertion minting a faction, a rewind of 2 turns, ≥1 compaction event, ≥1 Director cycle + Sakkan sample.
- **Assertions fed real metered usage, denominated honestly:** per-turn cost asserted against ceilings computed at the model *actually used* (`turnCostModel(tier, servedModel)` — not the Fable-denominated worst case, which a Sonnet run passes vacuously); a **minimum within-turn cache-read fraction asserted** (the §5.6 guaranteed reads) with the turn-to-turn rate *reported* vs the 0.7 assumption; **TTFT + total wall-clock captured per turn** and checked against TURN_CONTRACTS targets as waste-flags for review (§5.5 doctrine: budgets catch waste, never trim deliberate depth — breaches flag, they don't hard-fail). The soak report carries the **spend-attribution line**: engineering total vs. projected per-session play cost at each narration tier.
- Golden-turn regression seeds (§10.7): 3 canonical turns' contes + prose captured as fixtures with the mockllm_fixture_dir field finally remapped/dropped.
- Loose ends: CLAUDE.md key-directory updates; docs/retros/M0.md **if requested**; deploy re-verified (play view live on Railway against aidm_v5).
- Exit: the user plays. Turn 30 is a scripted gate; *the user's first real session is the actual one.*

---

## Definition of done (M1 exit gate)

1. A campaign goes SZ-conversation → contract → pilot → turn 30 without a manual DB touch.
2. All nine layers + player profile have BOTH writers and readers exercised by the round-trip flywheel test, per layer, through real play.
3. The Settei renders from a real SZ contract (extremes + exemplars + marks); the Sakkan scores blind on cadence; a manufactured drift produces a corrective Amendment that expires on read-back.
4. Renderer-efficacy eval (§10.2) green; NAA judge green on all synthesis outputs; golden-profile diff green.
5. Turns are durable: kill the worker mid-turn, restart, same dice, no data loss.
6. Rewind works from the play view; a rewound fact never resurfaces in retrieval.
7. Every model call in the soak is in `model_calls` with tier, cache accounting, and cost; per-turn cost asserted at served-model ceilings; within-turn cache-read fraction asserted; TTFT/wall-clock captured with waste-flags; the report states the measured turn-to-turn hit rate against the 0.7 assumption and the spend-attribution split.
8. All UI paths browser-verified; deploy green; CI green (unit + integration + evals:ci).
9. Playable start-to-turn-30 — and then actually played.

## User checkpoints

- [ ] **Plan approval** (this document).
- [ ] **C3:** a short SZ transcript review — the conductor's voice is the product's face; you read one full conversation before it ships.
- [ ] **C10:** the soak report, then **your first real session** — M1 closes on your verdict, not the script's.
