# M2 — Method Depth + The Record

*Implementation plan derived from `docs/plans/v5-blueprint.md` (v3-final) §12 M2, plus the live-play ledger from `docs/retros/M1.md`. Status: **RATIFIED 2026-07-11** — user verdict, verbatim: "Fuck it, we ball." Two tracks under one milestone stand; every bullet listed under a commit ships in that commit.*

**M2's job in one sentence:** the milestone where it starts *feeling like the show* (blueprint §12) — and where the record underneath the show becomes something the engine keeps true without a developer's hands in the database.

**The exit experience, stated as play:** you scream something mid-battle that quietly asserts new canon, and the engine catches it, resolves "your master" to the right entity, and the Director builds on it three turns later; you say "actually, that's wrong" and the record gets *cleaner*, not longer; your protagonist has been exactly one row since Session Zero asked his name; you change narration tier mid-campaign because the conductor promised you could; and a 30-turn drift soak ends with the register measurably where the premise put it.

**What M2 is NOT:** not horizon-deep (organic seed detection, epoch merges, 100-turn soaks, prospective flywheel → M3); no hybrids and **no active-premise editing** — the settings surface in C5 is deliberately narrow so it cannot swallow M4's studio view; no billing (M5); douga *routing* stays parked per §13.6 — C9 calibrates the triage thresholds that already exist, nothing more.

---

## 0. Structural calls this plan makes (veto here, cheap now)

1. **Two tracks under one milestone.** Track R ("the record", C1–C5) is the live-play integrity ledger; Track M ("the method", C6–C10) is §12's M2 as written. The blueprint's M2 headline is P2-only, so this is a **named scope addition** — justified by the depth-milestone doctrine (the shape sharpens everywhere) and by dependency: method tuning measures what the KA sees, and what the KA sees is entity cards and retrieval over a record that live play proved it can pollute (three protagonist rows by turn 3). Polishing the voice on top of a corrupted record tunes against noise. Your veto splits this into M1.5 (record) + M2 (method) as two smaller review units; the content is identical either way.
2. **Record before method, gate at the end.** C1–C5 land first so C6–C9's tuning and C10's drift soak run against the repaired substrate. The drift soak is the milestone gate (§12: "drift soak passing").
3. **Every Track R mechanism enters through the ledger door** (§14 risk 6): each commit below names its failure mode (all observed live, 2026-07-10) and its pillar. No mechanism ships without one.
4. **Repair actors, not repair scripts.** The design insight from the live session: provenance/tombstones/versions made manual repair *possible*; M2 adds the *actors* — janitor judgment for mechanical cases, player-facing affordances where player authority owns the call. Automated merges must be reversible by construction (tombstones, never deletes).
5. **The settings surface implements only already-decided capabilities.** Tier change is §13 decision 1, verbatim: "changeable anytime with cache-reset + voice-shift warning." Suggestion-affordance toggle is the same class (a §9.2 calibration the player owns). Anything touching DNA, framing, canonicality, or voice waits for M4's gated write affordances (§13 decision 4).
6. **LLM spend: ~$12–15 central, $10–25 band** (revised down 2026-07-11 with the cost discipline in call 9; M1 planned $20–50 and metered ~$14 including three soak runs). Fixed lines: judge-gate validation for exemplars ~$2, fixture eval passes ~$5, reliability calibration ~$3, golden cases ~$1, the two live checkpoints ~$5; the labeled triage set is hand labeling over existing turns, $0. The remaining variable is **drift-soak certification runs** at ~$4–6 each — bounded by call 9's disciplines. No single script exceeds ~$5 without a note in conversation. **No automated test, eval, smoke, or soak ever calls Fable** (standing directive); dev traffic runs `DEV_TIER_SELECTION`.
7. **Two user checkpoints:** (a) after C4 you run a fresh live SZ — the gate reviews elicitation feel, not schemas; (b) after C8 you play 5–10 live turns on your real campaign — the gate is "does it feel more like the show," the only verdict that matters (§0).
8. **Process upgrades ride C10, not conversation:** an env-parity check (deployed variables diffed against the env schema) joins the deploy path, and the presentation pass (browser-verify every player-facing surface, including the long-turn case) joins the working cadence. Both are M1-retro lessons: every live failure was environment or presentation.
9. **Cost discipline (adopted 2026-07-11, holds for M3+ too):**
   - **Iterate on fixtures, gate on soaks.** Tuning loops (punch-through, drift correction, reliability) run on fixture A/B evals (~$0.50/pass: one scene brief, multiple renderings, blind-scored). A full soak run certifies a result; it never explores one.
   - **Soaks resume, never re-buy.** The soak harness resumes its persisted campaign after a crash instead of re-running from turn 1 (M1 re-bought ~$7 of dead turns; at M3's 100-turn scale this discipline is the largest single saving in the project).
   - **Dev-side judgment is session labor, not metered runtime.** Labeling the triage set, drafting exemplar candidates, and reviewing eval outputs are done in the development session (sub-covered); only validation gates (NAA judge) run on the meter. Authoring is development, not runtime.
   - **The live campaign is a free instrument.** TTL gap distributions, TTFT traces, trailer-drop rates, and douga labels come from real-play telemetry first; soaks are reserved for pressure real play shouldn't suffer (scripted drift temptation, failure injection, rewind storms).
   - Forward note for M3: genga-biasing the 100-turn soak scripts cuts their dominant cost ~30%, but a deliberate sakuga cluster stays in the script — thinking-budget and trailer behavior are stressed exactly there; that saving is taken only in part.

## Standing dependencies (green today)

Deterministic identity tier (entity-identity module, compiler dedup, resolver aliasing — pre-M2 batch) · merge primitives proven by hand (tombstone/enrich/version) · trailer_fallback telemetry in turn checkpoints · Sakkan v1 blind scorer shared by runtime and evals · assertion pipeline live with intent gate (narrow, by design, until C2).

---

## Commit plan

Cadence per the working agreement: work → subagent audit → fix → push, per commit. Ten thorough commits, Track R then Track M.

### C1 — The merge actor: one identity, one row, enforced by the system

*Failure mode (live): the protagonist existed as three rows by turn 3; the deterministic tier closed placeholder spellings, but "Lloyd and protagonist connection" vs "Path-Crossing with Lloyd" — different names, same meaning — still mints dupes, and nothing in the system can merge them. Pillar: P1 (§6.5 entity-pollution guard).*

- `src/lib/entity/merge.ts`: the merge primitive as a system operation — survivor enriched (identity-before-capability ordering carried from the compiler's dedup), dupe tombstoned, version row written, provenance `merge:{janitor|player}`, spotlight debt and relationship state folded. Reversible by construction.
- Mint-time semantic guard in the §5.4 resolver: when a new named entity is about to mint, embed the candidate name against same-type catalog names (Voyage, pennies); a near-hit above the high threshold routes to enrich via a one-probe "same entity?" check; below it, mint proceeds. The M1-audit empty-normalization edge gets its guard here.
- The janitor: a catalog review at session close (rides the existing close path beside Sakkan sampling) — same-type near-dup detection over the full catalog; high-confidence pairs merge automatically (provenance `merge:janitor`), ambiguous pairs become **booth-surfaced merge suggestions** ("these look like the same thread — merge?"), honoring player authority on anything the machine isn't sure of. Suggestions land in the notes panel; accepting one invokes the primitive with provenance `merge:player`.
- Tests: scripted campaign minting semantic dupes converges to one row per identity; automated merge reverses cleanly via tombstones; ambiguous pairs never auto-merge; the live Lloyd-thread pair is the fixture.

### C2 — Authorship detection: the 3-piece (ratified 2026-07-10)

*Failure mode (live + soak): the Red Sash faction assertion inside a SOCIAL action never reached ingestion — M1's gate is intent-typed, narrower than §5.4's "player language is always world-building." Pillar: P1/P3 (§5.4).*

- `contains_world_assertion` boolean added to the intent triage output — **on every intent**, orthogonal to classification (the ratified fix: a single text is often action AND authorship at once).
- When the flag fires, Phase A runs ingestion with a **context dossier**: cast summary, live threads, the active arc line — because "knowing what to do with that assertion requires context of the campaign so far" (user requirement, verbatim). The extractor prompt receives the dossier; extraction binds to existing arcs/threads where the assertion extends them rather than minting parallel structure.
- Relational reference resolution: "my mother," "your master," "the twelve" resolve through the PC anchor and the C1 identity machinery before minting — a relational phrase that resolves to an existing entity enriches it; one that names a genuinely new entity mints with the relation recorded in state.
- Golden acceptance case: **the battle scream** — "I WILL NOT LOSE! FOR MY MOTHER! FOR THE CHILDREN THAT DIED! FOR EVERYONE YOUR MASTER KILLED!" mid-COMBAT nests assertions including new canon (*the monster has a master*) — asserted end-to-end: flag fires, dossier extraction lands the master as a thread/npc bound to the fight, the mother reference enriches rather than mints. Red Sash is the regression case.
- Tests: flag orthogonality (COMBAT/SOCIAL/EXPLORATION all carry it), dossier presence in the extractor call, relational binding, both golden cases.

### C3 — Correction semantics: player word cleans the record

*Failure mode (live class): enrichment is append-only, so "actually, that's not true" appends a contradiction next to the error forever. Pillar: P1 + player authority (§0: expressed player word is the highest law — it must bind the record, not just the scene).*

- The extractor sees the resolved entity's current block (it already sees critical facts) and gains a `corrects_existing` posture dimension: a fact that directly contradicts block material triggers **revise** instead of append — a judgment call rewrites the living block (old block + correction in, clean block out; conservative prompt: change only what the correction touches), version row records the supersession, provenance `player_assertion` at confidence 1.
- Critical-fact corrections: tombstone-and-replace (the substrate's own idiom), never silent mutation.
- The assertion notice surfaces corrections distinctly ("Corrected: …" vs "Canon updated: …") — the player sees the record obey.
- Tests: "she died of fever, not the plague" leaves one cause of death in the block with the version trail intact; a correction never destroys unrelated block material (fixture asserts full non-target text survives); appends still append when nothing contradicts.

### C4 — SZ v2: the protagonist has a name

*Failure mode (live): the compiler wrote a cast row literally named "The Protagonist (unnamed)"; the conductor's gate never asks who the player IS. Pillar: P2/P4 — the PC is the premise's second pole, and the Director cold-starts without their web. (User-directed to this plan 2026-07-10.)*

- Conductor elicitation targets join the "table is set" gate: **PC name** (blocking unless the player explicitly defers — the defer affordance is first-class, as with the waifu deferral), **extant-relationship web** and **backstory hooks** (advisory gaps, 2–3 conversational beats, never a form). Age stays opportunistic unless the premise makes it load-bearing (§0: check whether a setting is actually a judgment — it is).
- Gap verdict entries to match; the compiler seeds the PC entity named, single (the identity module already guarantees single), with relationships as threads and backstory hooks as Director seed material in the OSP.
- **The compile says what it guessed:** deferred/ambiguous resolutions (the affordance class, ambiguous finitude, unparseable calibrations) surface in the conductor's table-is-set summary — the system stops knowing-it-guessed silently.
- Tests: gap verdict blocks an unnamed un-deferred PC; a deferred name compiles with the deferral recorded; guess-surfacing renders; scripted-transcript fixtures for the new elicitation shapes.

### C5 — The decided capabilities get their surface

*Failure mode (live): the conductor promises "you can change tiers anytime" (§13.1, decided) and nothing writes `tierModels` post-compile; `suggestion_affordance` was unfixable without database access. Pillar: co-authorship honesty (§0) — the system must not promise what it cannot do.*

- A small settings drawer in the play view (beside the notes panel): **narration/judgment/probe tier menus** (§3, plain cost framing) with the decided warning — cache reset + possible voice shift ("studio handoff") — applied on change; **suggestion-affordance toggle** (§9.2 calibration).
- Server route writes `tierModels` / `premiseContract.suggestion_affordance` with an audit trail (who/when in the campaign's record); the block cache invalidates on tier change by design.
- **Explicit non-goal, stated in code comment and here:** no other contract field is writable. DNA, framing, canonicality, voice, intensity → M4 studio view, gated (§13.4).
- Tests: tier change round-trip + cache-watermark reset; affordance toggle honored by the next turn's chips; every other contract field rejected server-side.

### C6 — Renderer v2: the full library speaks

- Exemplar library to **full coverage** (§4.7: both extremes of all 24 axes; §12: "full exemplar library"). Per §0.9: candidates are drafted in-session (dev labor, synthesized/hand-authored only per §13); the meter pays only for the NAA judge + skim gate. Axes prioritized by live-campaign usage so the authoring order follows real play.
- Learned shading (§12): pencil marks and player_taste graduate from verbatim notes to rendering *weights* — a mark about understatement shifts which exemplars and axis instructions render, never mutating the contract (render-time only, §6.6 discipline).
- Corrective punch-through tuning (§12): when a Sakkan corrective note fails to move the gauge within its window, Amendments escalate strength on that axis (bounded by the prescription budget, axiom 4); the renderer-efficacy eval extends to assert punch-through. Tuning iterates on fixture A/B passes per §0.9 — never on soak runs.
- Tests: coverage invariant tightens to all 24 axes; shading is render-only; punch-through eval green; budget assertions hold at the larger library.

### C7 — Gauge v2: measurement worth trusting

- Anchored-excerpt scoring (§12): the blind scorer receives the §4.6 anchor excerpts for the axis band, not just definitions.
- Blind protocol hardened: scorer never sees active values, arc state, or the conte — asserted structurally in the call construction, not by convention.
- Reliability calibration: repeated-measure variance per axis on fixed fixtures; axes whose variance swamps the drift band get wider bands or better anchors before their corrections are allowed to fire (measured, not vibed).
- Drift band (§4.5) re-tuned against v2 scores; Sakkan sampling cadence revisited with the live campaign's telemetry.
- Tests: blind-structure assertion, reliability report in the eval harness, band behavior on synthetic drift fixtures.

### C8 — Method play depth: the cast feels alive

- Voice cards deepen: research quote material renders into NPC voice fingerprints the KA receives on speaking-cast turns; NPC interiority stages (§7.5) exercised — interiority events accumulate and surface in entity cards.
- Cast depth posture calibrated (§12 "sharpening vs hollowing"): the two-tier cast model's promotion behavior measured against play — who deepens, who stays texture.
- Control key honored in play (§12): a soak-scripted campaign WITH a control key (the live campaign declined one, correctly) proves opt-in loss-of-control stakes fire inside the contract and never outside it.
- Anti-repetition suite deepened, including **beat-shape variety** (live watch item: both live turns ran task → quiet impossibility → understated shrug): the Pacer/Director rotate scene shapes; the anti-rep evals extend from phrasing to beat structure.
- Sakuga tuning (§12): thinking/output budget calibrated from live telemetry (12.3k-token turn as fixture); **trailer-drop review** — query the `trailer_fallback` checkpoint rate, and if Opus drops the `commit_scene` trailer above a threshold, reposition/strengthen the trailer instruction (measured first, prompt-tuned second).
- Tests: voice-card injection, interiority accumulation, control-key soak script, beat-shape eval, sakuga budget assertions updated.

### C9 — Telemetry decisions: the numbers choose

- **TTL per-block decision** (§5.6, explicitly assigned to M2): measured inter-turn gap distribution — live-campaign telemetry first per §0.9, soak data supplementing — decides 5-min vs 1-h TTL per block; the decision lands in code with the analysis in the commit message.
- **TTFT targets set from reality:** live traces establish real time-to-first-token per tier; §5.5 budgets updated from aspiration to measurement; cheap wins only (no engine rework) — the heartbeat already covers the experience floor.
- **Douga threshold calibration:** a hand-labeled set (~30 turns from soaks + live play) tunes `TRIAGE_THRESHOLDS` and the intent-probe anchors (the turn-12 epicness 0.3-vs-0.2 miss is the seed case); the third golden turn seed (douga) lands once a real douga fires. Routing stays parked (§13.6).
- Historical NULL metering rows: **explicitly declined** — pre-tagging history isn't worth a backfill; the ledger notes the cutover date instead.
- Tests: budget assertions carry the decided TTLs and measured TTFT floors; triage calibration fixtures.

### C10 — The drift soak (the gate) + the cadence learns from M1

- **Drift soak** (§12's M2 gate): scripted turns engineered dense with register temptation (genre gravity, tonal bait, escalation pressure — every turn carries pressure, so ~20–30 turns buy what a padded 30 would), Sakkan v2 measuring throughout; PASS = drift stays inside the §4.5 band and corrections demonstrably punch through when pushed outside. Per §0.9 the soak **certifies** tuning done on fixtures — it never explores — and the harness **resumes its persisted campaign** after a crash instead of re-buying turns. Sonnet narration; report in `docs/retros/` style with spend attribution.
- **Env-parity check:** a script diffing deployed Railway variables against the env schema's expected set (names only, never values), run in the deploy path — the VOYAGE_API_KEY class dies here.
- **Presentation pass discipline:** the working agreement gains a player-facing checklist (browser-verify each surface touched, including the long-turn and dropped-stream cases) — retro lesson: the soak proves the engine, never the experience.
- M2 retro written on request, per convention.

---

## Exit criteria (the milestone's definition of done)

1. Drift soak passing inside the band — the §12 gate.
2. The battle-scream golden case green end-to-end; Red Sash regression green.
3. A scripted campaign under semantic-dupe pressure converges to one row per identity, with ambiguous merges surfaced to the player, never auto-taken.
4. A correction cleans the record (block revision with version trail), never appends a contradiction.
5. A fresh SZ cannot compile an unnamed, un-deferred protagonist, and the compile surfaces its guesses.
6. Tier change works live from the play view with the decided warning; no other contract field is writable.
7. Exemplar coverage: both extremes, all 24 axes, judge-gated.
8. TTL and TTFT set from measured data; triage thresholds calibrated against the labeled set.
9. Every new mechanism entered through the ledger door with a named live failure mode (this document is the record).

## Risks

- **Exemplar authoring volume** (24 axes × extremes) — mitigated by the judge-gated pipeline and usage-ordered authoring; the coverage invariant prevents silent gaps but the tail axes are cheap-to-author by construction.
- **Semantic merge false positives** — mitigated three ways: high-threshold-only automation, booth-surfaced suggestions for the ambiguous band, and tombstone reversibility for everything.
- **Correction-revise losing material** — the conservative rewrite prompt plus the non-target-text-survives test; version rows preserve every prior state.
- **Two-track scope** — the cut line, if needed, is C5 and C8's cast-depth items (each independently valuable, none load-bearing for the gate); C1–C4 and C6–C7+C10 are the spine.
- **Method tuning on one campaign's taste** — the drift soak scripts multiple registers (the golden profiles exist for Bebop and Solo Leveling; the live 7th Prince campaign adds a third), so v2 tuning never overfits a single show's voice.
