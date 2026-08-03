# M3R2 — The writers' room: the wiring audit's repairs

**Status:** approved (user, 2026-08-03 — "Let's fix all of that, no shortcuts, and if it means extra work or new systems, we do that too"). Source: the five-reader wiring audit (23 agents, live forensics on campaign 86135b1f) + the player's own booth finding. Named failure modes throughout are MEASURED, not hypothesized.

**The symptom that opened this:** "each reply isn't coming from the same writer, but a writer that just picked up from where someone else left off." The audit found that literally true twice: a live break froze every direction channel at turn-0 values (leaving anti-repetition as the only per-turn craft pressure — a channel that pushes AWAY from the last three scenes), and the architecture hands the pen its own prose as an unattributed transcript.

---

## C1 — The Director breathes again (URGENT — live break)

**Failure mode (live, Railway logs):** every Director cycle since turn 0 dies with API 400 "the compiled grammar is too large" on the final structured emit. DirectorOutput's schema outgrew the API's grammar-compilation limit (M3 C2 seed ops + C4 evolution proposal are the prime suspects — the deferred gate soak is exactly what would have caught it). Cascade: §7 frozen entirely; the SAME throw kills openSession (whose catch deletes the claimed session row) → no sessions, no Settei rebuild, no recap, no prewarm; accumulators ratchet so a doomed cycle fires every turn ($1.71 burned on 37 dead calls).

- Reproduce with the real schema at DEV judgment tier (trivial prompt, ~$0.001), then SHRINK THE GRAMMAR until it compiles with margin: flatten unions, collapse enum branches to strings validated in code, prune optional nesting — the M3 C1 doctrine extended from bounds to STRUCTURE (the contract lives in prompt + clamps, the schema carries shape only).
- **Grammar canary** (new system, earns its ledger row here): a `requiresLlm` eval case that submits every production structured schema to the API and fails on grammar rejection — the class of regression that ships silently because local Zod never compiles a grammar.
- **openSession survives a Director throw**: review failure degrades (session opens, review skipped, flag surfaced) — never deletes the session row, never 500s the mount.
- **Cycle failure backoff**: a failed cycle stamps last_director_attempt; no refire for DIRECTOR_MIN_TURNS_BETWEEN turns — the ratchet-burn dies.
- Live verification on the player's campaign post-deploy: next cycle lands, drains the 3 parked drift findings + 3 pending flags + accumulators; sessions open again.

## C2 — The pen's own hand

**Failure mode:** the KA receives one user message; prior scenes arrive as unattributed SYSTEM transcript (player half labeled `Player:`, narration half labeled nothing, zero assistant turns) — the disparate-writer architecture. Plus the KA_CONTRACT's orientation sentence says the story-so-far is above it when it renders below, and §5.3 anti-repetition (the only live varying pressure) explicitly pushes away from recent style — it deleted an established title-card grammar at turn 4.

- **Block 3 becomes real conversation turns**: exchanges render as alternating user (player input) / assistant (narration) messages, the conte as the final user message. The pen sees its own hand AS its own hand — the native shape the API expects. Cache semantics preserved exactly (system prefix = B1+B2 stable; messages append-only; breakpoint discipline unchanged; compaction still the only shrink event).
- KA_CONTRACT orientation corrected; contract position vs campaign voice matter in Block 1 re-examined (the 1,652-token invariant tail currently outranks every campaign-specific voice cue for recency).
- **Anti-repetition re-scoped**: vary the DOOR, never the HAND — entries/techniques/shot choices vary; voice identity is explicitly out of its jurisdiction.
- Trailer nativeness re-measured after the messages-shape change (live 0/6 native → every turn pays a continuation round; the wire proof was native in isolation, so shape is the suspect).

## C3 — The voice substrate

**Failure modes:** Block 1's voice fingerprint + exemplar describe a DIFFERENT protagonist ("Elymas", "Heavy Knight", "Edvan family") — a third SZ-compiler defect class (provenance, after coverage and inversion). The charter renders 2.16× §4.4a and the trim ladder eats register exemplars FIRST (voice sacrificed before axis caveats). The verbatim window collapses to the 4-exchange floor on the player's real scene lengths (~2k tokens/scene), so compaction fires ~every 3 turns and voice memory past the window is beats written under "discard choreography."

- Root-cause the fingerprint provenance in the SZ compiler (fixture leak / cross-campaign bleed / hallucinated exemplar — find which, fix, pin with a test); joins the existing SZ chip's coverage + the inversion incident as one SZ-fidelity commit.
- Heal the live campaign's voice matter: recompute fingerprint + exemplar from the player's actual SZ conversation and played prose; rebuild the Settei (C1's session repair makes rebuilds reachable again).
- **Trim ladder inverted**: voice matter (exemplars, fingerprint) becomes the LAST thing trimmed, axis caveats first; §4.4a budget re-examined against measured render sizes — if 600–900 is unrealistic for rich premises, the budget amendment is proposed to the user with numbers, not silently exceeded.
- **Window calibration**: raise the compaction token trigger + keep-tail so the pen holds ~8–10 of the player's actual scenes verbatim (quality outranks cost — axiom; the cache carries it).

## C4 — The booth corrections channel (the player's own finding)

**Failure mode (live):** the booth heard a premise correction ("the hard line is the opposite of what I asked for"), the Writer agreed and promised the fix — and the booth's close-time resolution has no write path to critical facts. The one correction mechanism (M2-C3) listens only on the story channel. The record was fixed by hand this time.

- Booth resolution schema gains `corrections`: explicit player statements that the RECORD is wrong route through M2-C3's retire-and-replace (player_correction provenance, confidence 1, revocable at the current turn). Gated on the player's words, never the responder's inference.
- The responder personas learn to SAY when a correction has been filed vs merely heard (the acknowledgment names the record change — the M3R1 restatement pattern).

## C5 — The small leaks (each measured in the audit)

- **Pacer beat null on 5/5 live turns** — root-cause and wire it to the conte (the per-scene continuity channel is fully dark).
- **voice_cards starvation** (confirmed both copies) — wire a reader or retire the field; blueprint intent decides.
- **voiceJournal** writer-only — becomes an input to session-open recap + Settei rebuild (the cross-sitting voice thread).
- **G2 step hygiene**: the four error-swallowing steps stop marking themselves done on failure; the nine unisolated steps get failure isolation so a failing step can't wedge submits; session close drains G2 first.
- **Assembly telemetry finds readers**: droppedPins → surfaced to the player; budgets → cache gauge; uncovered_extremes → Director dossier.
- director_notes' `.slice(0,3)` starvation; arc_events rendered into the dossier (the Pacer's phase_transition suggestion finally reaches the Director); KA contract notes that turn numbering may skip (channel turns).

## Rider — output headroom +50% (user-directed)

All model-call maxTokens budgets raise ~50% (budgets.ts, with the WHY comment): headroom is a truncation guard, not spend — output bills by usage. budget-assertions ceilings re-baseline accordingly. The player's hypothesis — better writing with more room — gets measured by play, not asserted.

## Order

C1 ships alone and fast (live bleed). C2+rider together (both touch the KA call shape). C3, C4, C5 in that order, each with the full cadence: build → Opus/workflow audit → fix → bare gate → push → CI → Railway → live verification on the player's campaign where applicable.
