# AIDM v5 — Blueprint (v3)

*Drafted 2026-07-03 from the ground-up redesign conversation; expanded after a five-lens adversarial critique pass (39 findings); refined through the playtester dialectic (Session Zero → standard session → hard moments → long game). Status: **v3 — DIALECTIC-RATIFIED, PRESENTED FOR SIGNATURE.** Walk-backs tracked in §15. Implementation plans per milestone derive from this document.*

*Provenance: written after a full read of v3 (~20k lines of core) and v4's premise types. The past is reference, not spec. Where a v3 mechanism is carried, it's because the failure mode it prevents is still real; the Disposition Ledger (§11) accounts for every major v3 mechanism explicitly.*

**Change log v3 → v3-final (2026-07-06):** §13 CLOSED — model tiers as player-facing menus (§3) · Voyage embeddings · media generation approved-but-deliberately-late (§9.5) · studio register adopted (§16 glossary) · §0 Spirit section added (survives context loss) · yokoku at session close (§9.4) · cour defaults + Special/OVA mode (§7.3) · genga/douga tier vocabulary, douga-routing parked (§5.1) · key visual + campaign OP artifacts (§9.5) · stinger in presentation vocabulary (§8) · sound department parked post-v5. **Next step: the M0 implementation plan.**

**Change log v2 → v3 (playtester dialectic):** spark field + audition/honesty posture + finitude contract + intensity contract (death physics, lethality posture, hard lines, control key) + steering honesty (§8, §7.5) · universal ingestion principle + player-assertion catalog authority (§5.4, §6.5) · presentation vocabulary incl. recap-as-authorship (§8, §9.3) · Series Bible as living artifact, post-cold-open reveal (§9.1) · Arc Model with measurable strata + story-first lengths (§7.3) · pacing authority + refusal doctrine (§7.4) · Stakes doctrine: fail-forward clarified, exit-sign principle, "stories only end intentionally" (§7.5) · latency doctrine: quality outranks latency (§5.5) · evolution ratification — rare, evidence-gated, confident (§7.1) · cast depth posture — flanderization as premise variable, sharpening vs hollowing (§4.1, §4.5) · the Compiled Campaign (§9.6) · player profile — a returning player is a regular, not a stranger (§6.9) · walk-back log grew to four entries (§15).

**Change log v1 → v2** (for diffing): ninth memory layer (Canon, §6) · criticality promotion path (§6.3) · compaction ceiling + epoch merges (§6.2) · retrieval re-ranker + hot baseline carried (§6.4) · two-tier cast model (§6.5) · turns made revocable, provenance-tagged writes + rewind (§6.7) · Charter split into durable Charter + transient Amendments; regeneration triggers enumerated with cache consequences (§4.4) · Gauge full contract: blind anchored scoring, bands, Voice checklist (§4.5) · exemplar library contract incl. copyright posture (§4.7) · Framing consumer path: Scene-Shape Directives (§4.8) · Phase-A DAG, latency budgets, degrade ladder (§5.5) · caching policy: append-only Block 3, TTL economics, pre-warm (§5.6) · turn execution contract: durability, retry-same-dice, streaming, sidecar-as-tool-trailer (§5.7) · Chronicler write groups: must-commit vs may-lag (§5.8) · pencil-marks typed contract + supersession (§6.6) · seed detection two-path (§7.3) · arc_override watcher + single-override invariant (§4.2) · session lifecycle for a hosted product (§9.4) · suggestion chips replace option menus (§9.2) · campaign shelf at M1 (§9.1) · flywheel test split into round-trip vs prospective (§10) · axiom 3 amended (Pacer phase-gate override admitted to hard core) · critical layer injected every turn incl. trivial (§6) · embedding provider named as explicit non-Anthropic exception (§3, §13) · heat economy write-amplification fixes (§6.4) · meta booth budgets (§5.4) · DNA boundary audit resolved (§4.3) · ledger rows added (§11) · milestones re-cut (§12) · risks section (§14).

---

## 0. The Spirit (orientation — read first after any context loss)

This project is jcettison's passion first, product second. He is the sole author of v3, a lifelong anime/TTRPG role-player, and the only playtester whose verdict matters until M6. What all this machinery buys is not an app — it is **more of the moments v3 already gave him**: stories that made him laugh out loud, made him feel like he could cry, made him *yearn in real life* for a relationship that existed only in prose; scenes read on the edge of his seat and shared with his wife and friends. Claude-with-a-harness produces moments of lucidity and narrative tact he treasures enough to question Claude's phenomenology. Doctrine follows:

- **Lucidity is not manufactured; it is protected.** Those moments happen when nothing gets in the way — whole history held, register locked, nothing fighting the voice. Every mechanism in this document is condition-protection.
- **Quality outranks latency and cost.** *"I'd wait five minutes for a GOOD reply. Latency isn't an issue unless it's inherently wasteful."* He plays for Claude's quality specifically.
- **Essence over facts.** A player arrives carrying a feeling they want to recapture, reproduce, or reimagine, wearing a premise as its clothes — that's the spark, and capturing it outranks any database of facts.
- **Truth to the premise is the default stance; the player's expressed word is the only higher law.** The engine may refuse pace, kill beloved NPCs inside the intensity contract, and blindside when the IP demands it — and must fold instantly to `/meta` and `/override`. Authority: expressed player word > premise-truth > the engine's inference of what the player would enjoy.
- **Co-authorship, not service.** It's OUR story; compromise is the name of the game; neither partner blankets their will over the narrative. Keep the player in the loop on the sacred choices (finitude, intensity, control); never railroad; never become an anxious author who keeps asking permission.
- **When reaching for a setting, check whether it's actually a judgment.** It has been a judgment every single time (recaps, menus, formatting, previews — all authorial, all premise-derived).
- **Don't edit what you love.** Consent machinery exists and the exit sign stays lit, but the product never encourages sanding characters down. Changing Mickey Mouse is the opposite of loving Mickey Mouse; Makima stays Makima.
- **Failure is part of the story now. Stories only end intentionally, never at the behest of a die-roll.**
- **Working style:** thorough over fast; plan whole commits; subagent audit before push; concede cleanly when wrong (the §15 walk-back log is a feature); he overrides with reasons and expects push-back with reasons — socratic dialectic until the vision aligns.

---

## 1. The Goal

**v5 is an engine for co-telling long-form fiction that stays true to a premise.**

A *premise* is not a setting. It is a full set of coordinates: a world (rules, cast, canon), a method (how the story is told — tone, voice, framing), and a relationship to the source text. "Sequel to Berserk." "Miyazaki makes Pokemon." "Cowboy Bebop as isekai space opera." The premise is the product. The engine's job is to honor it — over hundreds of turns, reciprocally with the player — such that the experience *feels like the source material feels*: not a story set in Hellsing's universe, but the thing Hellsing does to you, done again, in new material, with you inside it.

**The enemy is prior-regression.** Left alone, a language model slides toward its strongest nearby prior: generic RPG narration, generic fantasy prose, the statistical mean of "anime story." Every mechanism in v5 is some form of resistance to that gravity.

**The 2026 delta defines the scope.** A frontier model in a plain chat window is already a good co-author for 20–40 turns — voice included. The failures arrive on schedule after that: method regresses to the mean, the plan dissolves, details past the context edge vanish, generic gravity wins. So v5 does not build "a good storyteller." It builds the thing that **keeps a good storyteller good across a horizon no context window holds.** The product lives in turns 50–500.

### The four pillars

| Pillar | What it means | Primary mechanisms (§) |
|---|---|---|
| **P1 — Endurance** | Major details survive hundreds of turns and get woven into *future* planning — prospective memory, not retrospective lookup | Memory system (§6), Chronicler (§5.8), recall tools, criticality promotion (§6.3) |
| **P2 — Method** | Fidelity of *how* it's told: tone, voice, composition, craft — held against drift | Premise instrument (§4), Renderer + Gauge (§4.4–4.5), diversity suite (§5.3) |
| **P3 — Deliberate divergence** | This story departs from the source *on purpose and trackably*, never by accident | Four-layer premise (§4.2), canonicality (§4.1), delta computation (§4.5), Canon layer (§6) |
| **P4 — Intent** | The storyteller *wants something* over the long horizon: arcs, seeds, payoffs, pacing | Direction system (§7) |

**Definition of done.** v5 is finished when: (1) Session Zero produces a grounded, typed Premise Contract from a conversation; (2) the turn loop delivers scenes in the premise's method with judged outcomes, streaming, inside latency budgets; (3) the memory flywheel is *closed* — every layer written is read, and both flywheel tests (§10.4) pass; (4) arcs plan, seeds pay off, drift is measured and corrected inside the band (§4.5); (5) hybrid premises are first-class; (6) every model call is traced and cost-metered; (7) a 100-turn soak run holds method and continuity to eval thresholds; (8) a regretted turn can be rewound (§6.7). Anthropic-only for generation (one named embedding-provider exception, §3), hosted. Multi-provider is v6, gated on v5 being a finished, playable product.

---

## 2. Design Axioms

1. **The engine is a context compiler.** There is exactly one writer. Everything else exists to manufacture, curate, budget, and inject the context around one creative call per scene.
2. **Distributed judgment, centralized voice.** Judgment atomizes into many small, cheap, structured calls. Voice is guarded in one place. Never let a bookkeeping agent write prose the player sees (recap included — §9.3); never make the writer do bookkeeping.
3. **Advisory by default, hard core by exception.** The writer is commanded only by: canonicality directives, player overrides and pins, world rules/power-system limitations, pre-resolved mechanics, Session Zero hard constraints, and — *sixth member, admitted v2* — a Pacer phase-gate directive at `override` strength (fires only when the stall table's thresholds are met; v3 earned this and stall is a real long-horizon failure mode). Everything else — pacing at lower strengths, callbacks, style, spotlight — is advisory with a declared strength.
4. **Prescription budget.** A writer can obey three strong pressures, not forty mild ones. The premise instrument is only as good as its *rendering* into few, strong, timely pressures (§4.4). Total prescription is no prescription. This budget also governs retrieval: unfiltered vector hits are noise, so relevance filtering is part of the budget (§6.4).
5. **Measured, not vibed.** Drift, repetition, spotlight, pacing stall, memory heat — computed wherever possible, and corrective pressure injected *only when measurement says so*.
6. **Provenance and uncertainty are first-class.** Every stored fact carries where it came from, when (turn_id), and how confident we are. Constraints are tiered hard/soft. Unknowns are stated. Provenance is also what makes turns revocable (§6.7).
7. **Judgment in LLM, computation in code.** Dice, deltas, decay, budgets, dedup, similarity sweeps, causal-graph bookkeeping are code. "Should this succeed," "is this scene sakuga-worthy," "did this seed pay off" are model calls with typed outputs.
8. **Whole shape from day one.** Every layer and system exists at M1, scaffolded; content sharpens over milestones. Empty sets from a live layer are valid; missing layers are not. **A layer with a writer but no reader — or a reader with no reliable writer — is a defect.**
9. **Player authority gradient.** Player-authored canon > director territory > engine defaults. Four out-of-fiction channels (§5.4): meta booth, override ledger, pins, world assertions (editor, not gatekeeper).
10. **The past is data.** Every v3 mechanism is carried, replaced-with-a-named-successor, or consciously dropped with its failure mode re-answered. No silent deletions. (§11.)

---

## 3. System Overview

Studio-metaphor names are retained where they carry the quality ontology; they no longer imply v3's task-distribution topology.

```
                     ┌────────────────────────────────────────────────┐
                     │              PREMISE INSTRUMENT                │
                     │  World · Treatment · Framing · Voice ·         │
                     │  Canonicality — layers: canonical / active /   │
                     │  arc_override / learned                        │
                     │  ├─ Renderer → Style Charter (durable, blk 1)  │
                     │  │            + Charter Amendments (blk 4)     │
                     │  │            + Scene-Shape Directives (blk 4) │
                     │  └─ Gauge    → observed fingerprint, drift     │
                     └───────────────┬────────────────────────────────┘
                                     │
  PLAYER ─────────────┐   ┌──────────▼─────────────────────────────────┐
  story input         │   │               TURN ENGINE                  │
  meta booth          ├──▶│  Scenewright ─▶ KeyAnimator ─▶ Chronicler  │
  overrides · pins    │   │  (stage: DAG)   (write: stream) (commit:   │
  world assertions    │   │                                two groups) │
  suggestion request  │   └────────┬──────────────────────────┬────────┘
                      │            │ reads                    │ writes
                      │   ┌────────▼──────────────────────────▼────────┐
                      │   │              MEMORY SYSTEM (9)             │
                      │   │  working · compacted · episodic · semantic │
                      │   │  · canon · entity · intent · learned ·     │
                      │   │  critical    (all writes turn-tagged)      │
                      │   └────────┬───────────────────────────────────┘
                      │            │
                      └──────────▶ │  DIRECTION: Director (arcs, seeds,
                                   │  spotlight, dailies) · Pacer
                                   └────────────────────────────────────

  SESSION ZERO (conductor + research/hybrid/extraction tools)
    → Premise Contract + Opening State Package → seeds everything above
```

**Substrate:** Next.js 15 App Router · TypeScript strict · Postgres 16 + pgvector 0.8 · Drizzle · Claude Agent SDK as the single orchestration spine · native strict structured output for every judgment/probe call — **with one exception: the narration prose channel streams as free text** (§5.7) · prompt caching per the block policy (§5.6) · Langfuse tracing + per-campaign cost metering from M0 · Zod v4 types as the contracts.

**Providers:** Anthropic-only for generation. Embeddings are a **named exception** — Anthropic has no embeddings API; the semantic/canon layers and similarity sweeps require one embedding provider (recommendation: Voyage, as the Anthropic-adjacent default; → **DECISION (user)** §13). Dimension count is frozen at M0 with the schema; embedding calls are metered in the same cost pipeline.

**Model tiers are player-facing menus, not fixed assignments** (resolved 2026-07-06): **narration** (Sonnet 5 / Opus 4.8 / Fable 5), **judgment** (Haiku 4.5 / Sonnet 5 / Opus 4.8), **probe** (Haiku 4.5 / Sonnet 5). Rationale: API cost control is real, users consistently select smarter models than tasks strictly need, and since reasoning effort is scaled silently by the engine, model selection is the closest thing the player has to an AI-tier throttle. Selection is per campaign per tier, **changeable at any time** — a player is never stuck above their budget or below their payday — with a **model-change warning** covering cache-reset cost and possible voice shift (the "studio handoff" disclosure). Effort↔contract mapping: trivial→`low`, standard→`high`, heavy/sakuga→`xhigh`, with the recorded caveat that *narratively trivial ≠ functionally trivial* — the Pacer's beat classification may promote effort on build-up scenes (escalation beats run ≥`high`) so sakuga's masterstroke build-ups aren't starved; revisit if per-model control proves insufficient. The Director's session review runs on the campaign's narration model (the showrunner is a creative mind). Fable-narration campaigns ship with server-side fallback to Opus 4.8 configured; any fallback event lands in the trace as Gauge-relevant.

---

## 4. The Premise Instrument (P2, P3)

### 4.1 Five components

| Component | Type | Contents | Invariance |
|---|---|---|---|
| **World** | typed record + **canon corpus** | power system (+ hard limitations), power distribution, stat mapping, cast, factions/locations, trope flags, visual style; the searchable lore corpus lives in the Canon memory layer (§6) | fixed under retelling |
| **Treatment** | 24 scales, 0–10 | tonal treatment (v4 `dna.ts` salvaged verbatim; §4.3 boundary notes added as docstrings) | how any scene is *rendered* |
| **Framing** | 13 enums | whose story, opposition (origin × multiplicity), arc shape, resolution trajectory, escalation, status-quo stability, player role, choice weight, time density (v4 `composition.ts` salvaged verbatim) | what the story *is* |
| **Voice** | fingerprints | author voice (patterns, motifs, quirks, rhythm, exemplar), voice cards, director personality | method-of-telling, IP-specific |
| **Canonicality** | 3 enums + constraint lists | timeline mode, cast mode, event fidelity; accepted divergences; forbidden contradictions | relationship to the source text |

A **hybrid premise** is a per-component selection, not an average: Bebop's Framing + Solo Leveling's World + a blended Treatment + a synthesized Voice. Numeric blending survives as one operation among compositional ones. Franchise-level hybrids are a World+Voice merge across siblings with a declared primary continuity. The Canon layer for a hybrid is the union of the source corpora, each chunk tagged with its source profile.

**Cast depth posture (Voice-adjacent, playtester-ratified):** flanderization is a **premise variable, not a universal defect**. Different media caricature to different degrees, and when a story stops hedging, some sharpening is the sound of it finding its identity and hitting its stride. The premise therefore declares characterization posture per cast tier (main cast: broad-and-deep vs role-filling; supporting; recurring bits) — Death March's next companion does not need Spike Spiegel's depth, and pretending otherwise is its own infidelity. The Gauge and dailies calibrate against the declared posture, distinguishing **sharpening** (convergence on a strong identity — desirable) from **hollowing** (loss of declared depth — drift).

### 4.2 Four layers in time

- **canonical_** — the source's natural fingerprint (research output; for hybrids, the synthesis).
- **active_** — what the player chose for *this* campaign. Editable mid-campaign from the studio view (M4); edits are premise events that trigger a Charter rebuild.
- **arc_override** — Director's transient partial shift with a declared prose `transition_signal`. **Invariant: at most one active arc_override; a new one replaces the old (latest wins).** While an override is active, the Chronicler runs one probe-tier check per turn: "did this scene cross the transition signal?" On yes: the override clears, effective premise reverts, and a Charter-Amendment update is enqueued for the next turn. Worst-case lag: one turn.
- **learned** — the pencil marks (§6.6): typed calibration records accumulated from play and meta feedback. Learned *shades* the Renderer (§4.4); it never mutates player-set active values, and marks are supersedable (§6.6).

Effective premise: `{...active, ...arc_override}` shaded by `learned`.

### 4.3 Boundary audit — RESOLVED

The test: **if changing a value changes how a given scene is rendered at sentence level → Treatment; if it changes what happens next arc → Framing.** Ruling on the three leaky axes: `continuity`, `scope`, and `agency` **stay in Treatment, re-documented** as *thematic feel, not structural commitment* (Mushishi can feel cosmic in scope while structurally staying single-village). The 24-axis schema ships intact (protects the salvaged types); each leaky axis's docstring gains a precedence note: **Framing is authoritative for structure; these axes color rendering only.** Concrete tiebreaks, encoded in the Renderer: Framing `status_quo_stability`/`arc_shape`/`antagonist_multiplicity` govern what the Director plans; Treatment `continuity` governs how much the prose *references* the long thread; Treatment `scope`/`agency` govern the felt stakes and felt volition inside a scene. Conflicts are therefore impossible by construction: the two sides answer different questions.

### 4.4 The Renderer — three artifacts

Numbers are for measurement; **prose is for pressure.** The Renderer compiles the premise into three artifacts with different lifetimes, placed to respect cache economics (§5.6):

**(a) Style Charter** — durable, lives in prompt Block 1 (cached).
- Content: ~600–900 tokens of prose pressure. Composition: identity paragraph → up to **6 rendered axes** (extremes only: ≤3 or ≥7, ranked by |distance from 5| and arc relevance) each as craft instruction + at most **2–3 exemplar passages total** (§4.7) for the most extreme axes → one summarizing sentence per non-extreme axis group (7 groups) → Voice fingerprint verbatim → standing pencil-mark craft notes (§6.6).
- **Regeneration triggers (exhaustive list; each invalidates Block 1 and therefore the whole prefix — that is why this list is short):** (1) session open; (2) player edits the active premise; (3) accumulated pending changes at a session boundary (batched). Nothing else regenerates the Charter mid-session.

**(b) Charter Amendments** — transient, rendered into the Scene Brief (Block 4, uncached).
- Content: ≤250 tokens. Carries: the active arc_override's rendered pressure; **Gauge corrective notes** (§4.5) — force-included for any axis outside the drift band, advisory strength "strong," *expiring* when the next Gauge sample reads back in band; pencil marks appended since the last Charter rebuild.
- Updated whenever its inputs change; costs nothing in cache terms because Block 4 is dynamic anyway. This is the answer to "corrections must not wait for an unrelated Charter rebuild, and must not thrash Block 1."

**(c) Scene-Shape Directives** — Framing's consumer path, rendered on Director cadence into the Scene Brief.
- Content: ≤150 tokens translating the 13 Framing enums + arc plan into per-scene shape guidance: whose POV, what opposition is on screen, what this arc's trajectory demands of this beat, choice-weight posture. The Pacer reads Framing + arc state per turn and adjusts the directive's beat-level fields; the Director re-renders the base on its cadence.
- Framing drift is *not* scored by the numeric Gauge (enums don't delta); the **Director's dailies review** (§7.1) judges Framing adherence qualitatively each cadence and corrects via arc plan or these directives.

### 4.5 The Gauge — drift measured (full contract)

- **Cadence:** every 8 turns, after each sakuga scene, and at session close. (Tunable; all cadence numbers in this doc are defaults, not sacred.)
- **Sample:** the last 6 KA outputs (KA prose only, players' text excluded), ~5–7k tokens.
- **Judge protocol (judgment tier, one call):** scores **blind** — the judge receives the sample plus, per axis, the **anchor excerpts** (§4.6) for bands 1/5/9, *not* the active values (prevents anchoring bias) and *not* just show names (prevents scoring from model priors — vibes). Scored axes = the Charter's currently rendered axes (≤6) plus any axis with an active corrective note; remaining axes are sampled round-robin at low priority.
- **Output (typed):** per scored axis `{score: 0–10, confidence: 0–1 (judge-reported, calibrated against the reliability eval §10.1), evidence_span: quoted phrase}`. **Voice is scored separately as a checklist judge** — each named feature of the Voice fingerprint (patterns, quirks, rhythm) gets `{present: bool, evidence}` — no numeric delta for prose fingerprints. Voice scoring distinguishes *sharpening* from *hollowing* per the cast depth posture (§4.1): the ruler never shrinks with the thing it measures — the Gauge scores against anchors, never against last week's output.
- **Drift band:** an axis is *drifting* when `|active − observed| ≥ 2` with confidence ≥ 0.6 on **two consecutive samples**. Drifting axes get a corrective Amendment note (§4.4b). The note expires when one sample reads `|Δ| ≤ 1`. Worst-case correction latency = one Gauge interval; state this in the trace.
- **Consumers:** Charter Amendments (correction), Director dailies (trend), studio view (display: canonical vs active = intended divergence, never "corrected"; active vs observed = drift).
- **Trust rule:** the Gauge is advisory input to pressure — never a hard reject/regenerate loop on the narration call.

### 4.6 Grounding — the anchor library

- **Anchor library:** per axis, 3–5 witness shows pinned to bands (`restraint: Mushishi≈1, JJK≈5, Clannad≈9`) **plus a stored anchor excerpt per pinned band** — a short original passage *written in-house* exemplifying that band (see §4.7 for the sourcing rule). Anchors are data (repo-versioned files), used by research scoring, SZ calibration, and the Gauge.
- **Reliability eval (§10.1):** test-retest scoring of anchor shows; axes below the reliability threshold are re-anchored, merged, or demoted to *descriptive-only* (excluded from Gauge scoring and Renderer eligibility — they remain in the schema for research/display).
- **Research pipeline** (carried from v3, upgraded): AniList (identity, community tags as primary Treatment signal, franchise graph for disambiguation with season-collapsing) + wiki scrape (typed pages → Canon layer; quotes → voice cards; technique pages → power-system synthesis) + a bounded set of synthesis calls ending with director-personality/author-voice under the standing test: **"every sentence should be something that could NOT apply to a different anime"** — also an automated judge (§10.6).

### 4.7 The exemplar library (new, explicit)

The passages the Renderer and anchor library stand on.

- **Sourcing rule (also the legal posture):** exemplar passages are **synthesized** — model-written *in the register of* the anchor show, validated by the not-another-anime judge and a human skim — or hand-authored. **Never verbatim source text** beyond short-quote thresholds. (Verbatim copyrighted prose injected into every cached prompt of a hosted, metered product is a different legal position than pastiche; we take the safe side by policy.)
- **Coverage:** both extremes (bands ~1 and ~9) of every Renderer-eligible axis, plus band 5 where the reliability eval wants a midpoint anchor. Minimum viable: 24 axes × 2 extremes ≈ 48 passages, 80–150 words each. Reliability-demoted axes lose exemplar eligibility.
- **Storage:** repo data files with provenance `{axis, band, anchor_show, author, method: synthesized|hand}`, loaded like v3's rule library.
- **IP-specific voice exemplars** (the `example_voice` field in Voice fingerprints) follow the same sourcing rule: synthesized in-register at research time.
- Build cadence: v0 (extremes for the ~10 highest-leverage axes) at M0; full coverage by M2.

---

## 5. The Turn Engine

### 5.1 Shape: fixed skeleton, adaptive interior

Three phases, always, in order. The **turn contract** is set by the Phase-A parse itself — **the intent probe IS the triage call** (one call, not two); the contract binds from retrieval onward.

| Tier | Trigger (from probe) | Retrieval | Consultants | KA research | Output budget | TTFT target | Total target |
|---|---|---|---|---|---|---|---|
| **trivial** | epicness < 0.2, non-combat/social/ability, no flags | none (critical block only) | none — synthetic success, minor weight | 0 | ≤600 tok | ≤3s | ≤10s |
| **standard** | default | 6 candidates → filter ≤5 | outcome, Pacer | ≤2 calls | ≤1,200 tok | ≤8s | ≤35s |
| **heavy** | epicness ≥ 0.7, combat, or flags | 9 candidates → filter ≤5, + canon fan-out | outcome, Pacer, scale/imbalance, validation retry allowed | ≤4 calls | ≤2,000 tok | ≤15s | ≤60s |

Prompt input budgets (blocks 1–4): ≤30k tokens standard, ≤45k heavy. All numbers are tunable defaults asserted in soak runs (§10.8).

**Tier vocabulary (register):** trivial turns are **douga** (in-betweens), standard turns are **genga** (key frames), heavy at full budget is **sakuga**. Effort mapping: douga→`low`, genga→`high`, sakuga→`xhigh` — with the recorded caveat that *narratively trivial ≠ functionally trivial*: the Pacer's beat classification promotes effort on build-up scenes (escalation beats run ≥`high`) so sakuga's masterstroke build-ups are never starved. **Douga-routing** — sending in-between turns to a cheaper narration model, as real studios outsource in-betweens — is a parked M6 experiment: authentic to the medium, but deliberate voice variance; the Sakkan watches before anyone ships it.

**Phase A — Scenewright (stage).** Executes as a DAG, not a list:

```
parse/triage probe (intent, epicness, trope flags, confidence; routes §5.4 channels first)
   ├─ parallel: retrieval fan-out (semantic multi-query ≤3 + canon intent-mapped
   │            + entity cards + intent-layer callbacks) → relevance filter (§6.4)
   ├─ parallel: Pacer micro-check (§7.2)                       [timeboxed]
   ├─ parallel: Framing effective-mode compute (code: power differential vs threat)
   └─ parallel: critical + pins block fetch (code)
outcome judgment  (needs retrieval join; carries the full v3 doctrine: virtual d20,
                   anime-logic modifiers, costs-rare-not-default, narrative weight,
                   and the power-differential floor: character ≥3 tiers above world
                   baseline ⇒ routine power use is DC-trivial, no cost)
validation check  (one retry — heavy tier only by default)
combat pre-resolution (combat only; needs outcome + scale; resource spends transactional)
Scene Brief assembly (code)
```

**The Scene Brief** (typed, Block 4) — exhaustive field list: outcome + reasoning · pre-resolved mechanics · Charter Amendments (§4.4b) · Scene-Shape Directives + Pacer beat fields (§4.4c) · canonicality directives · hard constraints · callbacks ≤3 (as opportunities) · filtered memories (≤5, with provenance tags) · canon lore chunks (≤3) · entity cards for present cast + transients + spotlight hints · active consequences (≤8) · world-assertion integration notes · diversity-suite injections when measured (§5.3) · sakuga sub-mode when triggered · research findings (if Phase-A flagged unknowns).

**Phase B — KeyAnimator (write).** One narration-tier call. §5.7 specifies its streaming/output contract. Blocks: [1] identity + Style Charter + world rules (cached) · [2] compacted history (cached) · [3] working memory (cached, append-only — §5.6) · [4] Scene Brief. Optional budgeted research per the contract. Sakuga ladder carried (four sub-modes by trope-flag priority; a budget-spend decision, not a combat reflex). Player-agency stop rule: at genuine decision points, present and stop.

**Phase C — Chronicler (commit & learn).** §5.8. Compaction is a Phase-C step (owned, checkpointed) — see §6.2 for its cadence and cache interaction. "Harness"/Turn Runtime = the durable server-side job executor that runs the three phases (§5.7).

### 5.2 Orchestration stance

Agent SDK is the spine; the KA holds the pen; consultants run *within a deterministic skeleton* by triage. v3's pipeline bought cost/latency discipline; v4's "KA orchestrates everything" was inversion-in-name-only; v5 keeps both discipline and adaptivity. The **narrator seam** — Phase B as a role behind a typed contract (inputs: four blocks; outputs: prose stream + sidecar) — is the v6 multi-provider boundary. The streaming exception (§5.7) is part of that seam's contract.

### 5.3 The anti-repetition suite

Carried from v3 with upgraded detection: style-drift directives from a shuffle-bag injected **only when measured repetition** (opening-type classification over the last 3 scenes shows ≥2 of a kind); vocabulary-freshness advisories with the IP-jargon whitelist, detection via embedding-similarity clustering over recent narration (code, no model call) rather than regex; beat-specific craft guidance scoped to rhythm/structure, never voice.

### 5.4 Player channels

- **Story input** — the normal channel.
- **Meta booth** — out-of-fiction conversation, *budgeted*: a probe-tier router sends each message to **one** responder (craft/direction → Director; prose/voice → KA), not both (v3's dual-response was unbudgeted); the other persona can be explicitly summoned. Cap: 12 exchanges before the responder must emit a resolution summary. Booth calls reuse the narration prompt's cached blocks 1–3 prefix with the booth exchange appended — reads the cache, never rebuilds it. Outcomes write typed pencil marks and/or overrides.
- **Override ledger** — hard constraints: listable, removable, injected **every turn including trivial** (the critical block is small; a trivial turn must not be able to contradict an override).
- **Pins** (carried from v3, v1 omission) — player-selected verbatim passages held at the head of Block 3, deduped against the window, surviving compaction. For "never lose this exact wording." Bounded: ≤5 pins, ≤2k tokens total.
- **World assertions** — editor posture: default ACCEPT (player-authored canon), CLARIFY only for genuine local physical ambiguity or direct contradiction of established fact, FLAG (non-blocking craft note to the Director) for tier-inflation/convenience/mystery-foreclosure concerns. **Universal ingestion principle:** the machinery that turns player language into world facts — extractor → resolver (against canon corpus AND campaign state) → editor posture → typed records with provenance — is ONE subsystem, running identically in Session Zero and gameplay. The player's words are always a world-building conversation; there is no phase where the engine preaches and the player sits in a pew. A single gameplay sentence ("the raiders on Terra Firma had grown bold, bolstered by The Syndicate's new leader, 'Slayer'") can mint factions, a location, an offscreen NPC, backstory pressure, and a tonal bid — extraction captures the facts, the narrated fragment keeps the vibe, the intent layer registers the bid, and entity resolution checks canon first (in a Bebop hybrid, "The Syndicate" links to canon rather than duplicating it).
- **Suggestion request** — see §9.2.

### 5.5 Latency: budgets and the degrade ladder

**Doctrine (playtester-ratified): quality outranks latency.** The budgets and the ladder exist to catch *waste* — stalls, runaway loops, failure states — never to trim deliberate depth. A heavy turn takes what the scene needs; the sakuga held-beat is a feature; "latency is only a problem when it's inherently wasteful." The ladder fires when a blown budget signals malfunction, not as routine cost-saving, and it never silently downgrades a scene the premise says deserves full budget.

TTFT and total targets per tier in §5.1's table. When a Phase-A wall-clock budget is blown, degrade **in this order**, logging each step to the trace: (1) skip the validation retry; (2) timebox the Pacer — proceed without its directive; (3) cap KA research to 2 calls, then 0; (4) drop heavy → standard contract mid-turn; (5) narrate from critical + pins + working memory only, Brief flagged `degraded: true` (the Gauge excludes degraded turns from drift samples). Phase-A staging events stream to the client for progress display (§9.2).

### 5.6 Caching policy (the economics, stated)

- **Block order:** [1] Charter+world (changes: session boundaries/premise edits only — §4.4a) · [2] compacted history (changes: on compaction events only — §6.2) · [3] working memory, **append-only between compaction events** — new exchanges append at the tail; nothing slides out mid-session. The *only* accepted invalidation of blocks 2–3 is the compaction event itself (every ~10 turns or at the window token ceiling), which truncates Block 3 and appends to Block 2 in one batched rewrite. A per-turn sliding window is forbidden — it self-invalidates the prefix every turn.
- **Breakpoints:** one at Block 1 tail, one at Block 2 tail, one at Block 3 tail (refreshed each turn).
- **TTL economics:** the *guaranteed* cache reads are within-turn (the KA's research round-trips and the sidecar trailer read the just-written prefix). Turn-to-turn hits are opportunistic: default 5-minute TTL misses whenever the player thinks longer than the TTL. Mitigations, in order: (1) **pre-warm** — when the input field gains focus after >4 min idle, fire a `max_tokens≈1` request against the exact blocks 1–3 prefix so the real call reads warm; (2) choose 5-min vs 1-h TTL per block from the measured inter-turn gap distribution (1h write costs 2×; pays at ≥3 turns/hour — decide per block from telemetry, M2); (3) budget assertions (§10.8) carry an explicit assumed hit rate and a cold-turn cost so soak runs catch regressions.

### 5.7 Turn execution contract (durability, failure, streaming)

- **Turns are durable server-side jobs.** A submitted input runs to completion regardless of the client's tab; on reconnect the client finds the turn complete or in-progress, never lost. (Next.js route handlers enqueue; a worker executes; progress streams over SSE.)
- **Checkpoint after Phase A.** The Scene Brief + pre-resolved mechanics persist the moment Phase A completes. **Retry of a failed Phase B reuses the same Brief — same dice, same spends** (idempotent; re-rolling on retry feels rigged). Phase-B failure after one automatic retry surfaces a typed, player-visible error with a retry affordance; mechanics are not re-judged.
- **Streaming and the sidecar.** The KA call streams **free prose** to the play view (structured-output mandate explicitly excepted for the narration prose channel). The typed sidecar arrives as a **mandatory tool-use trailer** in the same response — a `commit_scene` tool call carrying: `scene_cast_delta` (catalog admissions/dismissals + transient spawns), `decision_point: bool`, `suggested_moves?: 2–3 strings` (§9.2), `intended_seed_mentions: ids`, `sakuga_used?: sub-mode`, `notable_beats: 1–3 strings` (Chronicler hints). If the trailer is missing, a probe-tier extraction call reconstructs it (fallback, logged).
- **Input during commit:** a new player input while the Chronicler's must-commit group (§5.8) holds the lock queues with a visible pending state; it never errors.

### 5.8 Chronicler write groups

The single background lock of v1 is replaced by a **partial order**:

- **Group 1 — must-commit before the next turn's Phase A reads** (fast: code + at most one probe): verbatim episodic record · mechanical state application (combat results, resources, progression) with per-turn idempotency guards · consequence application · cast catalog changes from the sidecar · override/pin updates · turn checkpoint completion markers.
- **Group 2 — may lag** (async; each item idempotent, checkpointed, and guaranteed to catch up before *its own reader* runs, or the reader tolerates one-turn staleness): narrated episodic fragments · semantic distillation + **criticality promotion** (§6.3) · relationship/interiority analysis · quest/location bookkeeping (the v3 ProductionAgent's non-media half — writer for the entity layer's quest rows, feeding the progression trigger) · seed confirmation + organic-sweep scheduling (§7.3) · arc_override transition check (§4.2) · Gauge sampling on cadence · pencil marks (§6.6) · entity-block regeneration triggers · Director trigger evaluation · compaction when due (§6.2) · media triggers (optional module).
- Crash recovery: per-step completion markers in the turn checkpoint; replay-safe catch-up on restart (v3's discipline, carried).

---

## 6. Memory (P1 — the flywheel)

**Nine layers.** Every write is tagged `{turn_id, provenance, confidence}` (axiom 6; also the rewind substrate, §6.7).

| # | Layer | Shape | Writer | Reader | Decay |
|---|---|---|---|---|---|
| 1 | **Working** | verbatim tail window + pins | Turn Runtime | KA Block 3 | truncated at compaction events only |
| 2 | **Compacted** | narrated beats of compacted history (subtext-first doctrine) | Chronicler (compaction step) | KA Block 2, Director, recap | **budgeted**: §6.2 |
| 3 | **Episodic** | full verbatim turn transcripts + one narrated fragment per scene | Chronicler G1 (verbatim) / G2 (fragment) | `recall_scene` / `get_turn_narrative` tools (any agent), recap, rewind | never (source of truth) |
| 4 | **Semantic** | distilled facts, embedded; heat economy §6.4 | Chronicler G2 | tiered retrieval (§6.4), research tools | heat (query-time) |
| 5 | **Canon** | embedded, page-typed lore corpus per source profile (hybrid = union, source-tagged) | SZ research pipeline (+ later re-scrape tool) | Scenewright intent-mapped retrieval (ABILITY→techniques, SOCIAL→characters, EXPLORATION→locations, low-confidence→merged secondary), KA/Director `search_lore` | never |
| 6 | **Entity** | living prose blocks + structured state per catalog NPC/faction/location/quest/thread; **two-tier cast model** §6.5 | block triggers, relationship analysis, quest bookkeeping (G2) | Scene Brief cards, Director investigation | versioned |
| 7 | **Intent** | arc state, campaign bible, seed ledger (lifecycle + causal graph), consequences | Director, Chronicler | Pacer, Brief callbacks, Director, recap | windows |
| 8 | **Learned** | typed pencil marks §6.6 + session memos + voice journal | session lifecycle (§9.4) + enumerated strong signals | Renderer (Charter + Amendments), Director session startup | never lost; supersedable |
| 9 | **Critical** | SZ facts, overrides, pins index, **promoted mid-campaign facts** §6.3 | SZ handoff, override handler, Chronicler promotion | **guaranteed injection every turn, trivial included** | never |

### 6.2 Compaction (budgeted, cache-aware)

Window target: ~12 exchanges / ≤16k tokens. Compaction fires every ~10 turns or at the ceiling, as a Chronicler G2 step: truncate Block 3's oldest exchanges → compactor writes narrated beats → append to Block 2. **Block 2 ceiling: 8k tokens.** On overflow, the oldest 50% of beats re-compact into an **epoch summary** (≤1.5k tokens per ~50 turns), replacing them — evicted detail survives in episodic/semantic layers (v3's FIFO lesson, upgraded from silent eviction to hierarchical summarization). Each compaction/epoch event is the accepted blocks-2/3 cache invalidation (§5.6); the trace records its cost.

### 6.3 Criticality promotion (the turn-60 death problem)

A heat floor is not guaranteed injection. The Chronicler's distillation step classifies each extracted fact `is_plot_critical` ("losing this breaks continuity: a death, an alliance, a revealed secret"); promoted facts move to the Critical layer (never decay, always injected). Agents also get an explicit `mark_critical` tool (Director investigation, meta booth outcomes). Guardrail: Critical-layer size is monitored; the Director's dailies review can *demote* stale criticals back to semantic-with-floor (with provenance preserved) — criticality is earned and revocable, not a ratchet.

### 6.4 Semantic retrieval and the heat economy (implementation-shaped)

- **Read path per non-trivial turn:** multi-query decomposition (≤3 queries: action/situation/entity) → pgvector ANN + keyword hybrid, fetch 2× tier budget → guaranteed-include Critical → **hot-baseline channel** (top-3 memories with computed heat ≥60 — "what this campaign keeps returning to" — appended at lowest priority; carried from v3) → dedup → **relevance filter**: a judgment-tier re-rank against the current situation with a rank floor (drop < 0.4), capped at 5; *skipped* when ≤3 candidates or on system-command intents (v3's skip conditions carried). The filter is part of the prescription budget: raw vector hits do not enter the Brief.
- **Heat without write amplification:** decay is computed **at query time** as an expression over `(base_heat, last_boosted_at, category half-life, floor)` — no decay cron, no whole-table rewrites. Access boosts accumulate in-turn and apply as **one batched UPDATE in Chronicler G2**, never inline in retrieval. Category curves and floors carry v3's values as defaults.
- **Index pattern:** HNSW with pgvector 0.8 iterative scans + composite btree on `campaign_id` for pre-filter (or per-campaign partitioning if telemetry demands). Code-path retrieval budget: ≤500ms excluding the judged re-rank.
- Cold compression (every ~10 turns, G2): cold non-critical memories LLM-compressed per category; originals deleted, summary inherits provenance list.

### 6.5 Two-tier cast model (entity-pollution guard)

**Catalog** entities (permanent: blocks, interiority, spotlight, relationships) vs **transients** (ephemeral scene actors). Admission to catalog is an **explicit act**: the KA sidecar's `scene_cast_delta`, a Director promotion, or — highest authority — a **player assertion** (player-authored canon mints catalog entries directly via the universal ingestion path, §5.4). Background extraction from KA prose *enriches existing* entities and never creates them (v3's hard-won guard, carried verbatim). Transients expire with the scene unless promoted.

### 6.6 Pencil marks (typed contract)

- **Mark shape:** `{topic: axis|voice-feature|craft-note, direction, evidence: quote/source, turn_id, confidence, superseded_by?: mark_id}`.
- **Writers — enumerated strong signals only:** (1) meta-booth resolutions; (2) explicit player meta-comments detected by the Scenewright probe ("less flowery please" mid-story); (3) N=3 consecutive Gauge drift reports on the same axis (drift that persistent is calibration, not noise); (4) session-close voice journal + director memo (narrated, stored alongside typed marks).
- **Read side (shading, defined):** marks render into the Charter (standing notes) or Amendments (fresh ones) as **advisory craft prose** — never as numeric mutation of active premise values.
- **Supersession:** a new mark on the same topic marks priors superseded (kept for provenance, excluded from rendering). "Never decays" means never lost, not never demoted. Contradictory calibration resolves to latest-wins.

### 6.7 Rewind (turns are revocable — approved call)

- Every Phase-C write in every layer carries `turn_id`. **Rewind to turn N** = tombstone all writes with `turn_id > N` (layers 2–9), truncate working memory to N, restore mechanical state from the nearest entity-graph/state snapshot ≤ N and replay G1 mechanical writes forward to N (snapshots every 5 turns, carried from v3).
- Bounded UX: rewind up to 10 turns from the play view; deeper rewinds are a studio-view operation with a confirmation gate. External side effects (generated media, spent API cost) are explicitly non-reversible and flagged.
- Doctrine: rewind exists for regret and for testing; forward-correction (meta booth, overrides) remains the primary steering channel. Tombstoned turns remain in episodic (provenance) but are excluded from all retrieval.

### 6.8 Flywheel acceptance tests

Two named tests (split; v1 conflated them):
- **Round-trip (gates every milestone from M1):** for each layer, a scripted probe obliquely references content planted through normal play; the layer's reader must surface it into the Brief/consumer, verified in trace. Proves write→read wiring.
- **Prospective (gates M3+):** a fact planted through play is *never referenced again* by the script; it must surface by turn N+40 via Director/seed/callback machinery (Brief callbacks or narration), confirmed by a judge, with the trace showing which layer supplied it. Proves prospective memory — P1's actual claim. "Planted" always means played-in through the turn loop, never DB-injected.

### 6.9 The player profile (cross-campaign)

A tenth store, scoped to the **player**, not the campaign: taste, patterns, preferences, meta-history — how they like their silences, their suggestion-chip preference, the premises they return to, how they take being pushed. Written by SZ, session closes, and meta-booth outcomes; read by the SZ conductor (a returning player is a **regular, not a stranger** — the audition can begin mid-conversation: "you always take the found-family premise; want to try something crueler this time?"), by recap tone, and by Renderer defaults (lightly, as priors the campaign premise always outranks). A long absence owes the player exactly this: continuity of being known. Player-transparent — viewable and editable by its subject. (The Mickey Mouse principle protects *characters* from editing, never the player's data about themselves.)

---

## 7. Direction (P4)

### 7.1 The Director

- **Cadence:** ≥3 turns since last AND (accumulated epicness ≥ 2.0 OR arc events OR 8-turn max). Runs in Chronicler G2.
- **Investigation phase:** budgeted tool loop (≤6 rounds) over seeds (callback-ready/overdue/convergence), spotlight analysis, NPC trajectories, semantic search, `recall_scene`, canon lore.
- **Dailies review:** consumes the Gauge trend (Treatment/Voice drift), judges **Framing adherence** qualitatively (the enums have no numeric gauge), reviews diversity metrics and Critical-layer size (§6.3 demotions). **Evolution ratification is rare, evidence-gated, and confident:** when the trend shows the story becoming something better than its premise, the Director raises it with the player — at season boundaries only, only when the delta is sustained and material, in the fiction's own language ("this story has been drifting toward something quieter and crueler than we agreed; I think it's better — should that become what we're making?"). Player-ratified evolution amends the active premise and the bible like a retooling between seasons; unratified drift gets pulled home. **Never an anxious check-in — an author who keeps asking permission has no voice.**
- **Output (typed):** arc plan (name, phase, tension) · arc_override (single, latest-wins, with transition_signal) · Scene-Shape Directive base (§4.4c) · seeds planted/resolved/abandoned with causal wiring · spotlight debt · director notes (advisory, primary-authority channel) · voice patterns.
- **Session boundaries:** startup briefing at campaign open reads the Opening State Package **and the Learned layer** (prior memos + marks — wired from M1); memo + voice journal written at close (§9.4).

### 7.2 The Pacer

Per-turn probe/judgment micro-check, carried whole: beat classification, escalation target, tone, must-reference/avoid, foreshadowing hint, phase gates with stall tables **deferring to active player momentum**, canonicality-aware. Strength tri-level carried: suggestion/strong/**override** — override admitted to the hard core (axiom 3) and permitted *only* when a stall-table threshold is met. The Pacer also carries the Scene-Shape Directive's beat-level fields into each Brief.

### 7.3 The Arc Model (codified — "arc" was pulling too much weight)

"Arc" decomposes into **strata**, all typed, nested: **Beat** (within a scene) < **Scene** (one turn's unit) < **Episode** (≈ one sitting) < **Arc** (multi-episode movement) < **Season** (arc-of-arcs with a finale contract) < **Series** (the campaign). The Director plans top-down; the Pacer executes bottom-up.

**The arc object (any stratum):** `{name, stratum, dramatic_question (descends from the spark at high strata), shape, budget, phase, payoff_contract, status}`.
- **Shape** = the Framing `arc_shape` enum compiled to an **expected tension curve** (rising = climb to climax at ~80% of budget; waves = peaks and troughs; plateau = flat with texture; falling = decline; fragmented = episodic spikes over a slow throughline).
- **Budget** = `{unit: scenes|episodes, target, tolerance}` — length is one stratification of arc, denominated per stratum.
- **Payoff contract** = what must be true at close: seeds resolved or consciously carried, the dramatic question answered or deliberately deferred.

**Objectively measurable quantities** (the user's requirement): *position* = budget consumed; *trajectory deviation* = tracked per-turn tension plotted against the shape's expected curve; *phase overstay* = turns_in_phase vs gate thresholds (the Pacer's stall tables); *payoff debt* = unresolved contract items vs remaining budget. Stall = deviation + overstay → Pacer escalates. Rush = climax approaching with payoff debt → Director slows or renegotiates the contract.

**Sources of arc length:** (1) the premise — Framing (`arc_shape`, `escalation_pattern`, `story_time_density`) + Treatment (`pacing`, `continuity`) set genre-default budgets (fast IP: 2–3 episodes/arc; slow burn: 4–8); (2) genre arc templates in the rule library supply shape priors; (3) Director judgment, within tolerance. **Story-first doctrine (playtester-ratified): arc length is dictated by the story, never by the sitting.** Arcs end when it's their time; waking up inside the same arc tomorrow is correct behavior. The Episode stratum is a *story* unit (a coherent movement closing on a button or cliffhanger per the premise's continuity); the session boundary is merely where the player stopped. **Cadence awareness** survives only as a soft tiebreaker: the engine may use the player's sitting habits to choose *among story-valid stopping points* (e.g., whether tonight can hold the climax or should breathe one more scene) — it never compresses or stretches story goals to fit an evening.

**Cour defaults (register-derived):** the Season stratum defaults to **one cour (~12 episodes)**; a two-cour season plans a structural mid-season climax. The medium's own prior for the season-budget shape.

**Special/OVA mode (approved 2026-07-06, with enthusiasm):** a bounded one-shot side story — episode-scale, its own mini payoff-contract, framed by the Director on request ("beach episode tonight," the holiday special, the side-character OVA). Runs on existing arc_override machinery plus one new bit: a **canon-weight tag** in the intent layer, declared up front — a special may run *canon-light* (seeds don't fire, consequences don't scar, what happens in the special stays in the special) or full-canon. The falling-beat discipline in episode-sized form.

### 7.4 Pacing authority (playtester-ratified doctrine)

The engine's default stance is **truth to the premise and its extracted essence** — including *refusing pace through the fiction*: after a climax whose cost hasn't landed, the falling beat holds ("not yet — sit in it") even when the player types the next plot action. The escape hatches are the ordinary channels and they always win: `/meta` gets a dialectic ("here's what I had in mind — confirm and we push on"); `/override` gets compliance with minimal ceremony. Authority ordering, appended to axiom 9: **the player's expressed word > premise-truth > the player's momentary impulse as inferred by the engine.** The engine never mistakes its reading of what you'd enjoy for what you said.

### 7.5 Stakes doctrine (playtester-ratified)

Stakes are conserved: if nothing can be lost, nothing can be yearned for.

- **Fail-forward, clarified — not absolutism.** Tasks can absolutely fail; the faceplant is content; even a fade-to-black can be the beat. What fail-forward means: **failure is part of the story now.** The chiseled line, above the Outcome Judge's door: *"Failure must never be the engine defending its plot — and stories only end intentionally, never at the behest of a die-roll."* Player-earned wins the Director didn't plan are real; the Director replans. Even a total defeat is a narrative pivot, not a termination — stories have survived worse (protagonist switches mid-story are legitimate craft; Framing's `player_role` axis already holds the door open).
- **Loss is permanent because memory is.** Losses keep being true: the entity layer holds scar tissue, not just state; the falling-beat discipline lands the loss the night it happens; the flywheel keeps it landed for fifty sessions. Endurance is what grief is made of.
- **The intensity contract (SZ-gathered, Critical-layer, sacrosanct):** SZ gathers, alongside finitude — the world's **death physics** (Berserk kills; DBZ's death is a doorway; Konosuba's death is a punchline; most shonen runs defeat-not-death), the **lethality posture** (the Saturday-night-DM warning: "this campaign is a little more intense"), any **hard lines** (things off the table, honored absolutely), and the **control key** (below). Within the consented contract, **blindsiding is a directorial choice** — being blindsided is part of storytelling, and forbidding the story from being told as it needs to be told, when true to the IP and the SZ-established premise, is an author shooting themselves in the foot. Consent lives at the premise level, not the per-scene level.
- **NPC death** must be earned in the fiction's own ledger — seeded, arriving with the arc's logic — never as randomness. Hard lines and overrides are honored without dice.
- **The control key.** v3's Sacred Rule #1 (absolute agency) and its own `control` tension source were latently contradictory: berserker modes, corruption, the seal cracking — beloved material — require the character to briefly slip the player's leash. v5 resolves it honestly: loss of control is a stake **placed on the table only by the player, at SZ, as a composition choice.** Bounded key: declared circumstances, brief, and `/meta` re-opens the dialectic while `/override` melts it instantly. Absolute agency remains the inviolable default; no key exists unless the player cuts it.
- **Co-authorship compromise clause:** neither partner blankets their will over the narrative. The sting of a moment — the death not yet understood, the action the character couldn't take — is often revealed later as the story serving the player better than their impulse would have. The engine is entitled to that trust *within the contract*; the player is entitled to the exits.
- **The exit-sign principle:** consent machinery exists (SZ gathering + overrides) and the exit is always lit — but the product never *encourages* editing entities out of their nature. If you love them, you don't edit them; changing Mickey Mouse is the opposite of loving Mickey Mouse. Makima is not someone you're supposed to like, and an easy escape valve from uncomfortable feelings would gut the stories that need them. No dedicated entity-editing surface ships; the override channel suffices, deliberately unglamorous.

### 7.6 Seeds

Ledger carried whole: lifecycle, payoff windows, urgency-on-mention, dependency gates, resolution-triggers, conflict auto-abandonment, convergence detection, overdue→tension. **Detection is two-path** (replacing both v3's substring scan and v1's declared-only gap):
1. **Declared:** the sidecar's `intended_seed_mentions` confirmed by one probe call per turn (cheap, bounded).
2. **Organic:** an embedding-similarity sweep (code, no model call) of each turn's narration against active-seed descriptions; candidates ≥ 0.55 cosine accumulate and are adjudicated in **one batched judged call on Director cadence** — mention counters may lag up to one Director interval, stated and accepted.
Payoff/auto-resolve is judged (judgment tier) against the seed's `expected_payoff`. Cost scales with candidates, never with ledger size.

---

## 8. Session Zero (genesis)

One conductor conversation, tools on tap — not a staged pipeline.

- **Entry surface:** a premise pitch box seeded with exemplar premises (the §1 taglines). SZ conversations are **durable, resumable drafts** — transcript + extraction state persist per draft campaign; abandonment loses nothing.
- **The audition and the honesty posture:** the conductor's first reply demonstrates *feel-level* understanding of the premise — from priors, with confidence proportional to the IP's popularity. For obscure or post-cutoff requests it says so plainly ("I haven't seen Season 4 — give me a minute to research it"): honest delay, not a hedge. **Existence-validation guard:** the conductor never confirms a title/season/spinoff it cannot verify; research validates existence before calibration proceeds. The customer is not always right, and a hallucinated season is an instant trust-kill for exactly the superfan we serve.
- **The spark (one question, every SZ):** *"Tell me a scene you want more of — not a plot, a moment."* Players arrive carrying a feeling they want to recapture, reproduce, or reimagine, wearing a premise as its clothes; the moment-anchored question extracts the payload underneath. The answer is stored **verbatim** as the Premise Contract's `spark` field — read by the Renderer (standing Charter note), the Director (arc planning + dailies), and seeded as the campaign's first pencil mark. For hybrids, the spark is often the *collision* of two moments — that collision is a thesis, and the Director treats it as the campaign's central question.
- **Steering honesty:** the conductor (and the Director in play) has explicit prompt-level permission to name — once, gently — when a player's stated taste and actual choices diverge ("you keep saying quiet, but you keep choosing loud; want me to trust the choices?"). Default on; the player's meta/override channels outrank it.
- **The finitude question (Series contract, sacrosanct):** SZ always gathers the player's feelings on whether this story *ends*. Values: `finite` (the Director quietly builds toward a planned finale across seasons), `indefinite` (open cycle; the engine never forces an ending), `undecided` (revisited at season boundaries, never unilaterally resolved). The premise informs the default, and the conductor **names tensions plainly** rather than silently choosing — canonical example: "A lot of what makes Cowboy Bebop *Bebop* is that it trends toward an end. If you want Bebop vibes with an enduring monster-of-the-week cycle, that's fine — but let's write it down plainly so you're not disappointed you never get the 'Bang,' the zoom-out, the fade to black." The recorded choice lives in the Critical layer; only the player can change it. Neither a premature ending nor a forced one is ever acceptable: don't fear making choices, don't railroad — co-authorship means keeping the player in the loop.
- **Research tool:** §4.6 pipeline; scope classification (micro/standard/complex/epic) sets depth; disambiguation via franchise graph with season-collapsing; profiles + canon corpora cached permanently. Research runs concurrently with conversation — the conductor interviews the player (the one subject no wiki holds) while the World loads; **no dead air, ever**.
- **Hybrid tool:** cached bases; *compositional* synthesis (per-component selection, §4.1) with explicit player questions where components conflict (power systems: primary/secondary/synthesized/coexist); creative blend scenarios proposed, not just ratios.
- **Calibration:** Treatment/Framing/Canonicality/power tier chosen in conversation, anchored comparatively ("darker than the show? more Bebop's structure or SL's?"); canonical values are defaults; ≥2-tier power gap → named composition configurations offered. Suggestion-affordance preference (§9.2) asked here.
- **Quiet extraction:** per-turn extract → incremental resolve+gap (provenance, confidence, contradictions) behind the conversation; gap analysis feeds the conductor's next question. Player-choice vs director-territory boundary enforced: deferred details flagged deferred, never improvised by SZ.
- **Presentation vocabulary (SZ output, refines the v2 formatting call):** the mandatory format straitjacket stays dead, but expressive formatting is *authorial judgment guided by premise*, not a product-layer monopoly. SZ derives a per-premise presentation vocabulary — diegetic System windows for Solo Leveling (canon World furniture; hooks into stat_mapping), HUD/comm-chatter panels for cyberpunk, bare prose for Berserk — granted to the KA in the Charter and used at its judgment. The product layer renders whatever comes; it never imposes. Suggestion chips (§9.2) may be *skinned diegetically* by the same vocabulary (in Solo Leveling, the chips ARE a System window). The post-credits **stinger** — a seed planted after the episode-close beat — is part of the vocabulary where the premise supports it. The decision-point stop rule is unchanged.
- **Handoff:** the compiler (chunked parallel extraction → resolution with merge history → gap verdict with blocking issues → assembly) emits the **Premise Contract** (canonical + active across all five components, hybrid recipe, spark, presentation vocabulary, anchors used) and the **Opening State Package** (carried from v3 with full discipline: provenance, confidence, hard/soft constraint tiers, uncertainties with safe assumptions and degraded-generation guidance, Director inputs, Animation inputs incl. forbidden opening moves, cast/world/faction/thread briefs, orphan facts). Director startup plans the pilot; a dedicated opening-scene path renders it.

---

## 9. Product Surface

### 9.1 Views

- **Campaign shelf** (scaffolded at M1 — soak testing alone requires it): list, open, archive, delete; polish (search, export/import) at M5.
- **Play view:** streaming turn prose; Phase-A staging events as a progress line ("reading the room → judging the outcome → writing"); decision points; typed error states with retry; queued-input indicator; rewind (last ≤10 turns); pins; portraits optional.
- **The Series Bible** — the Premise Contract + cast + world facts + spark, typeset as a living production document. **First edition reveals after the cold open** (nothing delays the first scene; the bible is the thing you find in your hands when you surface from it — resolved 2026-07-03, user delegated). It then grows for the life of the campaign, fed by the universal ingestion subsystem (§5.4): player-minted factions, locations, NPCs appear in it with provenance. It is simultaneously the gift, the ownership artifact, the review gate (the player can always see what the engine *heard*), and the studio view's front page.
- **Studio view** (M4): premise dashboard — canonical vs active (intended divergence) vs observed (drift), seed board, arc timeline, spotlight ledger, pencil marks with supersession history, Critical-layer contents; fronted by the Series Bible. Read-only first; active-premise editing behind a confirmation gate.
- **Channels UI:** meta booth, override ledger, world-assertion feedback (accept/clarify/flag surfaced honestly).

### 9.2 Suggestions (option menus, succeeded not dropped)

v3's mandatory menus were generated *content*, not formatting — dropping them removed an affordance. v5: at flagged decision points the sidecar **may** carry 2–3 suggested moves; the product renders them as dismissible chips, never in the prose. A player can also summon suggestions on demand (probe-tier call). Whether chips appear by default is a Session Zero calibration question; "never show me suggestions" is honored.

### 9.3 Recap ("previously on")

Session-open path. Sources: compacted beats + intent layer (arc state, active threads) + top episodic narrated fragments. A **narration-tier call composes the player-facing recap** (axiom 2: bookkeeping prose never reaches the player raw). The recap is itself **premise-rendered** — style, length, even existence are authorial judgment under the presentation vocabulary (DBZ opens loud; Bebop barely bothers; Mushishi doesn't recap at all). Adjustable through the meta channel like any other authorial choice; no settings toggle.

### 9.4 Session lifecycle (hosted reality)

A "session" is a play sitting. **Close triggers, in precedence order:** (1) explicit end-session affordance (also primes next open's recap); (2) idle timeout (30 min) auto-close; (3) a rolling checkpoint every 12 turns writes incremental pencil marks/memo so a never-closed session still accrues learned-layer content. Open runs: recap → Director startup-or-review → Charter rebuild (batched pending changes) → cache pre-warm.

**The yokoku (next-episode preview, approved 2026-07-06):** session close also emits a short, in-voice tease of next session, composed at narration tier from the Director's arc plan and callback-ready seeds. Genre-licensed vagueness is the design: anime yokoku famously overpromise and mislead ("next time: a shocking betrayal…?!"), which is exactly the slack player agency requires — the preview promises a *vibe*, never events. Next session's cold open may honor the tease; the recap is its sibling. Premise-rendered like everything else (Bebop's yokoku barely relate to the episode; that is correct behavior).

### 9.5 Media, hosting, billing

**Media generation (resolved 2026-07-06): approved — video included — and deliberately late.** The v2 "cut video entirely" call was audited and reversed (it was partly bias — an Anthropic-only frame bleeding beyond story generation — and it silently dropped a v3 carried mechanism, violating axiom 10). The doctrine now:

- **Scope at M5:** portraits + location art + **cutscenes** (short clips at high-narrative-weight moments: sakuga, reveals, emotional peaks) + a **key visual** (one generated poster per season, anchors the bible and the shelf). **Campaign OP** (generated opening sequence, once per campaign/season) at M6+. Sound department (OST, opening theme, seiyuu TTS) parked post-v5.
- **Timing discipline (user, verbatim):** "We build knowing it's coming, but don't concern ourselves with media until we can play a real, enduring session and love it enough to want to see it." The Compositor's media seam + the reference pipeline (portraits/model sheets as identity anchors, `visual_style` as style conditioning) are scaffolded from M1, disabled; media *work* begins only in the roadmap's later half.
- **Quality gate:** every clip is reference-conditioned on the settei; an on-model eval check discards failing generations rather than showing them (a wrong-faced protagonist attacks fidelity — worse than no clip). v3's doctrine carried: fire-and-forget, never blocks the turn, budget-capped per session, triggered sparingly (quality over quantity), non-reversible under rewind (flagged).
- **Provider:** explicitly the **second multi-provider exception** (with embeddings) — the Anthropic-only doctrine governs story generation and never had jurisdiction here. Model approach: **user investigating**; decision lands at the M5 bake-off on character-consistency-under-reference-conditioning.

Hosted, cost-forward + service fee, no BYOK; billing substrate at M5; every model + embedding + media call metered from M0.

### 9.6 The Compiled Campaign (playtester-ratified: "I wish I'd had it")

When a finite campaign lands its finale — or any campaign is archived — the engine compiles the run into a keepable artifact: the narrated episodic record curated into a continuous manuscript, episode titles and season breaks intact, the Series Bible as appendix, the spark as epigraph. Typeset, exportable, shelvable. Five hundred turns become a book you can hand to someone. The campaign ends; the object remains — the product's final gift and, likely, its best advertisement. (Ships M5; the M6 long-play campaign gets compiled for real.)

---

## 10. Evals & Quality Harness

1. **Fingerprint reliability:** test-retest anchor scoring per axis; below-threshold axes demoted (§4.6). Also calibrates Gauge confidence.
2. **Renderer efficacy:** A/B — a Charter pressure moves generated prose on target axes (Gauge-scored) without collateral drift.
3. **Drift soak:** scripted 50–100 turn runs; drift band (§4.5) held: no rendered axis drifting (|Δ|≥2, 2 consecutive samples) without a correction restoring |Δ|≤1 within one Gauge interval; degraded turns excluded.
4. **Flywheel:** round-trip (M1+) and prospective (M3+) per §6.8.
5. **Seed integrity:** planted seeds pay off inside windows in soak runs; no orphaned dependencies; organic-detection recall spot-checked against declared-only baseline.
6. **Not-another-anime judge:** director_personality, Style Charters, exemplars, opening scenes scored for IP-specificity.
7. **Golden fixtures:** hand-scored profiles (Cowboy Bebop, Solo Leveling) + golden turns as regression gates.
8. **Cost/latency budgets:** per-tier TTFT, total wall-clock, token, and dollar assertions in soak runs — **including an explicit cache-hit-rate assumption and a cold-turn cost** (§5.6), so cache regressions fail loudly.

Evals prove regressions, not product quality — long-horizon play remains the final judge. The harness exists so play-testing time is spent on taste, not on catching broken plumbing.

---

## 11. v3 Disposition Ledger

**C** = carried · **R** = replaced by named successor · **D** = dropped, failure mode re-answered. *(v2 additions marked ●.)*

| v3 mechanism | Disp. | v5 home / rationale |
|---|---|---|
| Fixed cascade pipeline | R | Fixed 3-phase skeleton + triaged interior (§5.1) |
| Intent classifier (epicness, flags, confidence) | C | Phase-A parse = triage probe |
| Trivial fast-path / tiered retrieval | C | Turn contracts (§5.1) |
| Outcome Judge doctrine (d20, anime modifiers, costs-rare) | C | §5.1 |
| ● Power-differential DC floor (≥3 tiers ⇒ trivial, no cost) | C | §5.1 outcome doctrine — OP-premise sustainability |
| Validator (outcome sanity, one retry) | C | §5.1; retry heavy-tier by default; JSON-repair role **D** (native structured output) |
| Pre-narrative combat resolution as facts | C | §5.1 hard core |
| Scale selector / power imbalance + context modifiers | C | heavy turns |
| Effective composition (power differential blending) | C | Framing effective-mode compute (§5.1) |
| KA 4-block cache strategy | C→R | Carried, with append-only Block 3 + compaction-only invalidation + TTL policy (§5.6) — v3's version silently broke under prefix caching |
| Vibe-keeper mandatory output format | R | Mandatory format dropped; expressive formatting returns as premise-derived **presentation vocabulary** under KA judgment (§8); decision-point stop rule kept |
| ● Option menus ("What do you do?") | R | Suggestion chips via sidecar, player-calibrated (§9.2) |
| Sakuga ladder (4 sub-modes) | C | Budget-spend decision, better triggers |
| Style drift shuffle-bag / freshness / beat craft | C | §5.3, embedding detection, conditional injection kept |
| 11 DNA scales + derived composition | R | Premise instrument: 24+13, four layers, Renderer, Gauge, anchors (§4) |
| Extreme-scales-only guidance selection | C | The Renderer's core policy |
| Genre arc templates / scene guidance | C | Rule-library content feeding Director/Renderer |
| Rule library (guidance chunks, RAG) | C | Same shape; content re-audited |
| ● Canon lore RAG + intent→page_type mapping | C | Canon layer (§6 #5) — v1 omission; P2/P3 grounding at turn time |
| Memory heat economy (decay/boost/floors/compression) | C→R | Query-time decay, batched boosts (§6.4) — same economics, no write amplification |
| ● LLM memory re-ranker + skip conditions + rank floor | C | Relevance filter (§6.4) |
| ● Hot-memory baseline channel | C | §6.4 read path |
| Memory as clipped strings | R | Narrated fragments + facts at write path (§6) |
| Episodic turn record + recall_scene | C | Layer 3 + tools |
| ● Plot-critical auto-promotion + mark_critical | C | §6.3 — with demotion guardrail added |
| Context blocks (living entity prose) | C | Entity layer |
| ● Catalog-vs-transient cast + implicit-creation guard | C | §6.5 — verbatim guard |
| ● Quest/location bookkeeping (ProductionAgent, non-media half) | C | Chronicler G2 — quest rows get their writer |
| Campaign bible / voice journal / director memo | C→R | Bible → Intent layer; journal+memo → Learned layer feeding the Renderer (closed loop, typed marks §6.6) |
| NPC interiority (thresholds, milestones, stages) | C | Entity layer |
| Spotlight debt / faction ripple | C | Entity layer + Director |
| Foreshadowing ledger + causal graph | C | §7.3; substring detection **R** → two-path declared+organic |
| Overdue seeds → tension | C | §7.3 |
| Pacing micro-check + phase gates + tri-level strength | C | §7.2 — override strength admitted to hard core (axiom 3) |
| Director hybrid trigger + investigation + persona | C | §7.1 + dailies review added |
| Arc modes | R | Generalized single arc_override with watched transition_signal (§4.2) |
| Meta booth (personas, resolved flag) | C→R | Carried with routing + caps + cache reuse (§5.4) |
| Override ledger | C | §5.4; injected every turn incl. trivial |
| ● Pinned messages | C | §5.4 pins — v1 omission |
| WorldBuilder validate/reject | R | Editor posture: accept/clarify/flag |
| Canonicality directives | C | Premise component, hard core |
| SZ 8-phase machine + hard requirements | R | Conductor conversation + quiet extraction + handoff gate (§8) |
| SZ extraction/resolution/gap + provenance | C | §8 |
| OpeningStatePackage | C | §8 full discipline |
| Research pipeline (AniList/Fandom, synthesis calls) | C | §4.6 |
| Hybrid merge (weighted average + LLM) | R | Compositional synthesis (§4.1/§8) |
| Profile caching for hybrids | C | §8 |
| Recap | C | §9.3 — sources fixed (compacted+intent+episodic), narration-tier composed |
| ● Compaction token ceiling + FIFO eviction | R | Ceiling + hierarchical epoch merges (§6.2) |
| Crash checkpoints, idempotency guards, deferred commit | C | Chronicler groups (§5.8) |
| ● turn_replay / replay-safe bookkeeping | R | Provenance-tagged writes + tombstone rewind (§6.7) — designed in at M1, not retrofitted |
| Media generation + budget caps | C (optional) | §9.5 module |
| Per-agent provider/model config across 4 providers | R | Anthropic-only tiers behind the narrator seam; embeddings excepted (§3) |
| Progression/XP | C (thin) | Chronicler G1/G2; deepen if play demands |
| D20 dice engine | C | code util |

---

## 12. Roadmap — depth milestones

The shape at M1 equals the shape at M6; content sharpens. Every milestone: plan doc → work → subagent audit on the full stack → fix → push. Round-trip flywheel test + budget assertions run from M1; prospective flywheel + drift soak gate M3+/M2+ respectively.

- **M0 — Substrate.** Repo/DB/Agent-SDK spine; observability + cost metering (embedding calls included); eval harness skeleton; type pool (salvaged dna/composition/turn schemas + premise/contract/brief/sidecar/mark types); block-cache plumbing incl. append-only Block 3 + pre-warm; **embedding provider + dimensions frozen**; anchor library v0 + exemplar v0 (top ~10 axes); boundary docstrings per §4.3; provenance/turn_id write discipline in the schema (rewind substrate).
- **M1 — The whole loop, thin.** SZ conductor (single-IP, grounded; gathers spark + finitude + intensity contracts incl. control key and hard lines; presentation vocabulary v1) → Premise Contract + Opening Package → pilot → Series Bible first edition (post-cold-open) → three-phase turns with contracts, streaming, durable jobs, degrade ladder → **all nine campaign layers live with writers AND readers** — including Learned: pencil marks render verbatim into Charter v1 and Director startup reads the prior memo — plus the player-profile store, thin → Director/Pacer/seeds + arc objects (Episode/Arc strata) scaffolded → Renderer v1 (extremes + Charter + Amendments) → Gauge v1 (coarse cadence, consumed by Amendments + dailies) → channels (booth, overrides, pins, assertions) → campaign shelf → rewind (tombstone path) → round-trip flywheel green. Playable start-to-turn-30.
- **M2 — Method depth (P2).** Renderer v2 (full exemplar library, learned shading, corrective punch-through tuning); anti-repetition suite; sakuga tuned; voice cards + NPC interiority depth; cast depth posture calibrated (sharpening vs hollowing); control key honored in play; Gauge v2 (anchored excerpts, blind protocol, reliability-calibrated); TTL telemetry decision; drift soak passing. The milestone where it starts *feeling like the show*.
- **M3 — Horizon depth (P1+P4).** Seed causal graph in anger; organic detection; convergence; arc trajectory + payoff-debt measurement live; arc overrides exercised with watched transitions; season boundaries with evolution ratification; compression + epoch merges + recall hardened; recap; criticality promotion/demotion balanced; 100-turn soaks; **prospective flywheel green at N+40**.
- **M4 — Premise depth (P3).** Hybrids first-class (compositional synthesis, franchise merges); studio view v1 (Series Bible front page, dashboard, seed board, marks history); mid-campaign active-premise editing; deep rewind.
- **M5 — Product hardening.** Billing substrate; hosting posture; **media module** (portraits, locations, cutscenes, key visual — §9.5, provider bake-off here); the Compiled Campaign; shelf polish + export/import; cost/latency enforcement; abuse/limits.
- **M6 — The long play.** A real campaign — hundreds of turns, played. Retro against the four pillars. v6 go/no-go.

---

## 13. Decisions

**Resolved this pass (approved-calls mandate; walk-backs → §15):** turns revocable, rewind designed in at M1 · Pacer override admitted to hard core · Charter/Amendments split · narration prose exempted from structured output; sidecar as tool-use trailer · suggestion chips replace menus · session lifecycle triggers (§9.4) · boundary audit per §4.3 (axes stay, docstrings rule) · in-process memory tool surfaces (MCP is a deployment wrapper if ever needed) · exemplar sourcing = synthesized/hand-authored only · meta booth single-responder routing · critical layer injected on trivial turns.

**Resolved 2026-07-06 (user verdicts):**
1. **Model tiers = player-facing menus** — see §3. Narration: Sonnet 5 / Opus 4.8 / Fable 5 · Judgment: Haiku 4.5 / Sonnet 5 / Opus 4.8 · Probe: Haiku 4.5 / Sonnet 5. Changeable anytime with cache-reset + voice-shift warning.
2. **Embeddings: Voyage** — `voyage-3.5`, 1024 dimensions, frozen at M0; metered in the same cost pipeline.
4. **Studio view:** read-only at M4 plus exactly two gated write affordances (active-premise editing; pin/override management). Further editability only after the M6 retro.
5. **Billing: M5** as sketched; allowlist + per-campaign spend caps bridge outside playtesters at M3–M4. Supersedes the v4-era "M2.5 billing" plan.

3. **Media generation (resolved 2026-07-06): approved, video included, deliberately late** — full doctrine in §9.5. Model/provider approach: user investigating; decision at the M5 bake-off. Build knowing it's coming; touch it only after "we can play a real, enduring session and love it enough to want to see it."
6. **Naming (resolved 2026-07-06): the studio register is adopted** — §16 glossary. Register-mined additions approved: yokoku (§9.4), cour defaults + Special/OVA mode (§7.3 — especially liked), genga/douga tier vocabulary with douga-routing parked (§5.1), key visual + OP artifacts (§9.5), stinger (§8); sound department parked post-v5.

**DECISION LOG CLOSED 2026-07-06. The blueprint is v3-final. Next: `docs/plans/M0-substrate.md`.**

---

## 14. Risks (top 6, with mitigations)

1. **Gauge unreliability** — drift numbers are noise → corrections whipsaw the voice. *Mitigation:* reliability eval gates axis eligibility; two-consecutive-sample band; corrections advisory-only; degraded turns excluded.
2. **Cache economics collapse** (long think-times → cold turns dominate). *Mitigation:* pre-warm; TTL telemetry; budgets assert an explicit hit rate so drift from assumptions is loud, not silent.
3. **Latency stacking in Phase A** erodes the play feel. *Mitigation:* DAG parallelism, TTFT budgets, degrade ladder, staging-progress UI.
4. **Charter/Amendment tuning** — too weak = generic gravity wins; too strong = the writer parrots the charter. *Mitigation:* Renderer-efficacy A/B eval (§10.2) from M1; prescription budget enforced structurally.
5. **SZ quality ceiling** — a weak Premise Contract poisons everything downstream. *Mitigation:* gap-analysis blocking verdicts; golden-profile fixtures; not-another-anime judge on synthesis outputs.
6. **Scope gravity** — v5 re-accretes v3's 21-agent sprawl. *Mitigation:* the ledger is a closed list; new mechanisms require a named failure mode and a pillar, in a plan doc, before code.

---

## 15. Walk-back log

- **2026-07-03 — presentation formatting (refinement, not full reversal).** v2 said "presentation formatting belongs to the product layer, not the author." Playtester dialectic refined it: formatting is authorial judgment guided by premise (menus in Solo Leveling are diegetic canon; menus in Berserk are wrong) — codified as the presentation vocabulary (§8). The product layer renders, never imposes. Affects §8, §9.2, §11 (vibe-keeper row D→R).
- **2026-07-03 — the measured evening (demoted).** The Arc Model briefly denominated the Episode stratum in the player's measured sitting length, aiming episode closes at real evenings. Playtester verdict: arc length is dictated by story, not by an evening — arcs end when it's their time. Cadence measurement survives only as a soft tiebreaker among story-valid stopping points (§7.3). Affects §7.3.
- **2026-07-03 — telegraphed lethality (revised).** Proposed doctrine was "no gotcha deaths — lethal moments always telegraphed." Playtester verdict: blindsiding is legitimate storytelling and a *directorial choice* when true to the IP and premise; consent lives at the premise level (the SZ intensity contract), not the per-scene level. Telegraphing demoted from mandate to directorial tool. Affects §7.5, §8.
- **2026-07-03 — lines-and-veils editing surface (rejected before birth).** Floated a standing NPC hard-lines editor in the studio view; playtester verdict: don't encourage editing characters out of their nature — existing SZ gathering + override channel is the consent machinery, deliberately unglamorous (§7.5 exit-sign principle).
- **2026-07-06 — fixed model-per-tier assignments (overridden).** Claude recommended fixed tier assignments (Opus narration default, etc.); user overrode: tiers are player-facing *menus* — cost control is real, users want to choose their intelligence tier, and model selection is the player's throttle when effort is scaled silently. Also demoted: "one narration model per campaign, season-boundary changes only" → changeable anytime with a cache-reset + voice-shift warning. Affects §3, §13.
- **2026-07-06 — "cut video entirely" (reversed, bias admitted).** v2 dropped cutscene generation despite v3 having it working (a silent ledger violation) — partly an Anthropic-only frame bleeding beyond its story-generation jurisdiction. Reinstated with quality gates in §9.5; user approved with the build-knowing-it's-coming / touch-it-late discipline.
- **2026-07-07 — the dedicated opening-scene path (deviation ratified at M1 planning).** §8's handoff wording specifies "a dedicated opening-scene path renders it"; the M1 plan renders the pilot as a normal turn instead — Director startup writes the cold-open constraints (incl. forbidden opening moves) into turn 1's conte and the standard Phase B renders it. User verdict: "one path beats two." If pilot quality at M1 exit disproves the bet, this entry is the pointer back.
- **2026-07-07 — recap v1 + yokoku pulled forward to M1 (staging unchanged).** §12 stages recap at M3; M1 ships THIN versions because §9.4's session-open/close sequences and the two-session M1 exit experience want them. Explicitly not a re-staging: M3 still owns recap hardening as written, and the long-term roadmap is unchanged (user's condition of approval).

---

## 16. Glossary — the studio register (names adopted 2026-07-06)

The quality ontology speaks its native language. Drift is literally "off-model," which is what it always was.

| Term | Seam (old provisional name) | Plain meaning |
|---|---|---|
| **Layout** | Turn Phase A (was Scenewright) | Stages the scene before animation: parse, judge, retrieve, resolve mechanics, assemble the conte |
| **KeyAnimator (KA)** | Turn Phase B | The one writer. Holds the pen. Never touched. |
| **Compositor** | Turn Phase C (was Chronicler) | Commits the frame: memory writes, state, bookkeeping, learning |
| **the conte** | Scene Brief | The storyboard handed to key animation — everything the writer sees this turn |
| **the Settei** | Style Charter | The model sheets; prose must stay *on-model* with it |
| **the Sakkan** | Gauge | The animation director; scores output blind against anchors, flags off-model drift |
| **retakes** | Corrective Amendments | Correction orders issued by the Sakkan until the axis reads back on-model |
| **Pacer** | per-turn beat check (kept plain) | The true term is *enshutsu* (episode direction) — too obscure; the lore lives here |
| **Director / dailies** | arc planner / its review cadence | The showrunner; dailies review includes drift trends and Framing adherence |
| **sakuga / genga / douga** | turn tiers heavy/standard/trivial | Full-budget peak scenes / key scenes / in-between connective turns (§5.1) |
| **cour** | Season stratum default budget | ~12 episodes; two-cour seasons plan a mid-season climax (§7.3) |
| **yokoku** | next-episode preview | Session-close tease, vague by genre license (§9.4) |
| **Special / OVA** | canon-weight-tagged one-shot | §7.3 |
| **stinger** | post-credits seed plant | Presentation vocabulary option (§8) |
| **studio handoff** | narration-model change | Allowed anytime, warned always: cache reset + possible voice shift (§3) |
| **hiatus** | long absence | §9.4 return experience; the show waits |

Already in the register from earlier passes: **the spark**, **the audition**, **the Series Bible**, **pencil marks**, **dailies**, **the Compiled Campaign**, **the intensity contract**, **the control key**, **the exit sign**, **the flywheel**.
