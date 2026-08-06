# M3R4 — The punch list: residual work between M3 and M4

**Status:** draft for user ratification (compiled 2026-08-06 from a full-repo + memory harvest merged with the M3-close ledger). M3 closed 2026-08-05 (60c799b) on its recorded exit condition; this plan is everything still owed, organized by what unblocks it. Nothing here relitigates a closed §13 decision; bucket D exists so milestone-owned work stops reading as forgotten residue.

---

## Bucket 0 — Closed since recording (the zombie-kill list)

Items still cited as open somewhere, actually done — recorded here so no future audit resurrects them:

- The soak retro's 6 within-turn read-frac failures + the turn-24 ceiling breach — ONE defect (the trailer `tool_choice` cache re-key), fixed and wire-pinned in 60c799b; the multi-call cost model absorbed the ceiling.
- Douga latency targets + thinking allowance — re-baselined (60c799b).
- The live-sweep-before-prompt-push rule — ratified 2026-08-05, in CLAUDE.md.
- The C9 douga-triage floor (M1-soak carry) and M2-drift-soak's "meter per-attempt, assert per-attempt" — landed with C9 / the soak harness.
- The recap event-mix miss — harness cause (`openSession` without `resume: true`) fixed in 60c799b; recap firing stays a watch item on the next soak, not a defect.
- M1-soak's aspirational latency markers — superseded by the measured re-baselines.
- The M2R6 "effort↔tier cache ruling pending" — superseded by the 2026-08-01 flat-high ruling.
- Multi-provider (three native KAs, per-campaign provider) — SUPERSEDED per A7; Anthropic-only for generation stands and the project memory is stamped to say so (2026-08-06), so M1.5's dispatch-extraction FU-D is moot too.
- ElevenLabs CLI access — done (v0.5.6, authed and on the roster, 2026-08-06); what remains under A6 is only the balance glance the CLI cannot serve.

## Bucket A — User rulings / business calls (updated 2026-08-06 with his answers)

- **A1 · Douga effort — RESOLVED: keep flat-high; the cache supersedes.** The user's own catch: effort is a cache-key ingredient, so douga→low would break the shared prefix lineage twice per interleaved douga turn (~$0.30 of re-writes at Sonnet, ~$1.00 at Fable, to save ~$0.06 of thinking) — decisively backwards. The latency lever moves to A2: a conte-side (Block 4, never cached) douga nudge line, tested blind.
- **A2 · The blind A/B — APPROVED, three arms (~$4.60):** sakuga high-vs-xhigh (2 scenes, cold, Fable — explicit user approval satisfies the no-Fable rule, price on record) + douga with/without the conte "no deliberation" nudge (Sonnet — a mechanism test, thinking tokens and TTFT are the measures). Output: blind pairs presented to the USER (key sealed), judge scores + token/latency metrics beside them — his ear is the final judge, per the original ruling.
- **A3 · Drift-soak retro renaming.** ELI5 delivered 2026-08-06; options offered (rename to -24turn / one honest header line pointing at the 50-turn record [recommended] / leave). Awaiting his pick.
- **A4 · Deus Versus hard-line repair — CLOSED, won't-do (his word 2026-08-06):** all existing campaigns are depreciable testbeds; no repairs.
- **A5 · §13.5 playtester bridge — DIRECTION RATIFIED (2026-08-06):** a couple of testers, default $20 cap, per-tester caps on an admin-facing surface. Plan drafted: docs/plans/M3R5-playtester-bridge.md (three commits: allowlist+cap enforcement at the choke point, the admin page, tester-experience guards incl. Fable off by default). Awaiting plan ratification + one open question (show testers their own allowance meter — recommended yes).
- **A6 · ElevenLabs calibration — RESOLVED (dashboard read 2026-08-06: $15.78).** Blended rate ≈ $0.0117/1k chars over 359,927 ledger chars; a listened scene costs 5–8¢; the listen button is budget noise. Recorded in the budget memory.
- **A7 · Multi-provider — RESOLVED: superseded (his word, 2026-08-06).** v4 fossil; Anthropic-only for generation stands; Google survives only as an M5 media bake-off candidate, where Seedance 2 / GPT-image are already noted as the field to beat. Memory stamped.

## Bucket B — The R4 punch-list arc (buildable now; three commits, full cadence each)

**B1 — Gates get teeth.**
- Build the real seed-integrity suite (§10.5 payoff windows + organic-detection recall over the soaked campaign; the scaffold's skip text has implied machinery that never existed since M3-C5).
- Harden renderer-efficacy: per-axis reps/majority + three-way verdicts (4 runs produced 4 distinct single-sample failure modes incl. a control-arm drift and a 529-as-FAIL; same repair its siblings channel-routing and control-key received).
- Re-baseline genga/sakuga latency targets from the soak's measured distributions (73 of 101 waste-flags are unactionable against dead letters).

**B2 — Hygiene sweep (one commit).**
- CLAUDE.md "traced trio" → the four traced calls (+ the same phrase in control-key.ts:29).
- cache-gauge.ts:425 stale "pending migration" note (the phase table was fixed in the writers'-room close).
- `soak50.log` out of the repo root (gitignore + git rm; the retro is the record).
- Probe-call phase attribution: 46 phase-NULL rows/run — thread `phase` through the probe callers that lack it.
- Prewarm→KA posture parity pinned in code (empirically healthy on the soak; the comment currently says "unproven").
- Memory reconciliations (multi-provider per A7's answer; M1.5's dispatch-extraction FU-D marked superseded if A7 confirms Anthropic-only).

**B3 — Carried repairs (one commit).**
- ElevenLabs ledger overcount (found by the 2026-08-06 calibration): our `model_calls` rows recorded ~360k chars over the 30 days the dashboard measured 53.9K — ~6.7× inflation, likely a row per stream chunk/retry each carrying the full char count. Find the TTS route's logging site, make it one row per synthesis with the true char count, and pin it; until then the dashboard is the character truth.
- Red Sash class (M1-soak carry): dialogue-embedded world claims miss the WORLD_BUILDING gate — widen the extractor's reach, pin with the original miss as fixture.
- Semantic alias resolution: M2 C1 shipped equality-after-normalization; the semantic tier ("different names, same meaning") was deferred to M2 and never landed — verify what the janitor's pairLikelySame already covers, build the remainder or record why not.
- Entity block-quote correction fallback: first-match/no-floor semantics (flagged at C4-fix time, deliberately left) — give it the same unique-match-or-quote-it discipline the critical-fact path got.
- voice_cards research starvation (M2R4/M2R5 carry): verify closed-by-M3R3 (search-topic quotes + mechanical grounding + honest gaps changed this materially); pin or fix the remainder.
- Eval-suite spend files as play (found by B2's phase audit): channel-routing.ts and authorship-detection.ts pass `turnNumber`, so their probe/judgment rows land in the "turn" bucket — and `campaignId` is `on delete set null`, so the rows outlive their throwaway campaigns and pollute the global per-turn baselines forever. Same defect class as the harness fix; sweep ALL eval callers (judgment too) to an honest phase.

**B4 — The stinger (small feature, its own commit).** `stinger_allowed` has sat PENDING in premise.ts since display-grammar: needs the SZ writer (one conductor beat) + the `composeStinger` reader. Whole-shape rule: ship writer and reader together. (Chip-skinning's reserved field stays pending — it is data-gated on chips accumulating usage, not buildable now.)

## Bucket C — Measurement-blocked (the funded-soak / Fable era)

- Sakuga thinking allowance 16k: known over-model; moves only when a Fable-served sakuga turn is measured.
- Control-key SAMPLES=2: bigger N when soak-scale budget exists.
- Director cycle fan-out (1–11 judgment calls, 10.7% of soak spend): measure why it varies before any cap.
- Prefix-fix verification at scale: free with the next soak.
- The N=100 soak: §10.3's upper letter — optional (M3 closed at the user-ratified N=50), natural vehicle for everything above in this bucket.
- OP_COMMAND one-shot design (runtime.ts/booth.ts): design-blocked, not measurement-blocked — needs its own G1-side plan row before code (ledger rule).

## Bucket D — Milestone-owned (the blueprint's schedule; listed so nothing reads as dropped)

- **M4:** studio view §13.4 (contract editing incl. the Bible's remaining archive-read intensity fields; taste display; active-premise editing) · deep rewind (epoch dissolution, compacted-beat resurrection) · hybrid per-component assembly · semantic retrieval runtime + `search_memory` + `turns.summary` · Director reads `turns.flags` · cost-dashboard aggregate · M1-closure Phase 8 tickets · Group-B trust labels (director_personality/author_voice grounding).
- **M5:** billing substrate · media module (g2 dispatch point, portraits, model_calls media tiers) · CombatAgent/ScaleSelector tuning · Compiled Campaign, shelf polish, abuse/limits.
- **M6+:** douga-routing experiment (§13.6, parked) · sound department (post-v5) · long-play retro, v6 go/no-go.
- **Data-gated:** chip-skinning (needs chip usage data).

## Order

B2 (hygiene, fast) → B1 (the gates) → B3 (carried repairs) → B4 (stinger). A-bucket rulings land whenever given and slot into whichever commit is open. C waits for its measurements; D waits for its milestones. Every commit: full cadence — build → Opus review → fix → bare gate (+ live sweep when prompts move) → push → CI → Railway.
