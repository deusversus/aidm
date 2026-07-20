# M2R — Carry repairs: what SZ collects, play honors

**Trigger (2026-07-19):** the player reported SZ choices not surfacing in play ("I'm not being presented response options like I was asked about"). A 28-agent adversarially-verified audit traced every SZ-collected preference end-to-end: the conductor and compiler are faithful (14 fields clean), but 19 read-side gaps were confirmed — collected, persisted, then dropped between the row and the player. This plan repairs all of them. Every item below is a repair of a blueprint-promised mechanism, not a new one; the ledger stays closed.

**Authority:** blueprint §9.2 (suggestions), §8 (finitude, calibration), §7.2 (Pacer, canonicality-aware), §6.9 (layer 10), §9.3/§9.4 (recap/yokoku), §5.4 (dossier), §9.1 (bible as review gate). Audit evidence at `…/tasks/wqdu4uw5d.output` (session artifact).

**Budget note:** zero new model calls. R1 removes calls (summon reuses persisted moves). Prompt-text changes (KA contract, commit_scene tool schema, Pacer system) bust the affected prompt caches once — the ordinary cost of any prompt edit.

---

## R1 — feat(suggestions): the promise kept

The player's `default_on` differs from `on_request_only` only when the KA spontaneously fills an undescribed optional schema field AND the player is watching the live stream. Three stacked repairs (§9.2):

- **Generation.** `sidecar.ts`: convert the JSDoc field comments to Zod `.describe()` on every CommitScene field — `z.toJSONSchema` (calls.ts:349) currently emits a bare schema, so the KA has never seen a word about any trailer field. `ka.ts` KA_CONTRACT trailer bullet: name `suggested_moves` — when `decision_point` is true, include 2–3 short premise-true next moves (chips, never prose); omit otherwise. Same instruction added to the trailer-fallback probe system (ka.ts:333) — half of long-form scenes route through it (measured 2026-07-11).
- **Rehydration.** `page.tsx`: when there is NO open turn, read the latest completed story turn's sidecar; if `decision_point` && `suggested_moves` && affordance is `default_on`, pass `initialChips` to PlayView (seeds the chips state). The durable record becomes the UI state, as page.tsx:14-17 already claims.
- **Reuse + backstop.** `suggestions/route.ts`: serve the latest completed turn's persisted `suggested_moves` when present (full-context KA moves, zero spend) before falling back to the fresh probe; return 403 when the contract says `never` (server backstop for the §9.2 "honored" promise — today it is one client-side button-hide).
- Consistency is repaired at the source (the KA now told moves accompany decision points); the client gate at play-view.tsx:343 stays — §9.2's letter is "at flagged decision points."
- **Tests:** COMMIT_SCENE_TOOL schema carries descriptions; suggestions route returns persisted moves without a probe call + 403 on `never` (real Postgres); KA contract text pins the instruction. **Browser-verify** (presentation pass): reload over a decision-point turn shows chips from the durable record.

## R2 — feat(direction): the contract reaches the judges

- **Finitude → Director (§8 L398).** The dossier (director.ts:309) gains a `## Series contract` section rendering finitude with its behavioral meaning: finite → build quietly toward a planned finale across seasons; indefinite → open cycle, never force an ending; undecided → revisit at season boundaries, never resolve unilaterally. `ensureSeriesScaffold` (arcs.ts): indefinite widens the series budget tolerance to a full two cours (payoff-debt "RUSHED" pressure is meaningless for an open cycle); finite/undecided keep the current 2-cours-±1.
- **Pacer canonicality (v3 rule #10, §7.2 "canonicality-aware").** PacerInput gains the contract's `timeline_mode` + `event_fidelity`; buildPrompt renders a CANONICALITY line; buildSystem restores the three-branch rule verbatim from v3 pacing.md:28-31 (canon_adjacent+observable → canon events as escalation anchors; alternate/influenceable → fully player-driven; inspired/background → no external timeline). layout.ts passes it from `contract.active.canonicality`.
- **power_expression + mode (SV3).** `renderSceneShape` (the Framing consumer, §4.8) gains a power-expression line — compact per-value distillations of `rule_library/composition/power_expression.yaml` (the yaml stays the library source; scene-shape keeps its ≤150-token budget). `mode`: layout appends an OP-mode framing line to the power context when `framing.mode === "op_dominant"` even below the ≥3-tier mechanical threshold (the player's explicit configuration outranks the derived gap); the tier-math hard core is untouched, and `blended` never suppresses it.
- **Tests:** pacer prompt/system carry the canonicality branch; scene-shape renders the power line; arcs budget differs by finitude; director dossier carries the finitude section.

## R3 — feat(session): paid artifacts survive

- **Yokoku (§9.4).** Reload after an explicit close currently burns a full open sequence AND drops the tease. `openSession`: latest session explicit-closed less than the idle timeout ago with no turns since → return `{opened:false, closedRecently:true, yokoku}` instead of opening; the play view renders the closed state + tease + a "begin the next sitting" affordance whose POST passes `{resume:true}` to bypass the guard. `composeRecap` gains the prior session's yokoku as context ("the tease made at last close — its vibe may be honored"), which finally surfaces idle-timeout yokoku (today composed, paid, never seen by anyone).
- **Recap durability (§9.3).** Additive migration: `session_records.recap` text column. Persist the composed recap on the session row; the idempotent open no-op returns it while the sitting has no completed turns yet — a reload during or just after the long open no longer eats the paid recap.
- **Degraded flag (§5.5).** The client reads `done.degraded` (currently a dead SSE wire) and marks the exchange with a quiet "rendered thin" whisper; page.tsx rehydrates it from `turns.degraded`.
- **Queued input.** On mount with a queued message but no open turn, the queue drains into the input box instead of showing a phantom "queued" indicator that later inverts send order.
- **Tests:** openSession closed-recently guard + resume bypass; recap round-trips the row and the no-op response (real Postgres); **browser-verify** closed-state + tease render and the reopen affordance.

## R4 — feat(learned): layer 10 graduates; the bible tells the whole premise

- **player_taste readers (§6.9).** `composeRecap` receives the player's taste notes as light priors ("the premise outranks"); `SetteiInput` gains `tasteNotes` rendered as a bounded "the player, known" shading (most recent 3) — the Renderer-defaults reader §6.9 names and M2-C6 re-promised.
- **player_taste writers (§6.9).** The booth resolution extraction and the session-close memo extraction each gain one optional `player_taste_note` field on their EXISTING calls (zero new spend); notes append to `players.profile.taste`.
- **Bible truth (§9.1 review gate).** `getBible` premise scalar gains `death_physics`, `lethality_posture`, `control_key`; the bible page renders them under premise. The bible.ts:156 comment ("contract rows render under premise") becomes true instead of aspirational.
- **Protagonist dossier (§5.4/C4).** `DossierEntity` carries the `is_player_protagonist` state marker; `renderDossier` groups and always-includes the PC by flag, not placeholder-name match — a real-named PC no longer files under NPCS or falls off the recency budget.
- **presentation_vocabulary:** the four unpopulated subfields stay (removing contract fields churns live jsonb rows for nothing); they get reserved-for-M3-DG comments, and the stinger staging decision is added to M3-display-grammar.md's open questions. Conscious non-fix, surfaced here.
- **§6.9 "player-transparent" — conscious staged gap.** The clause "viewable and editable by its subject" has no surface yet: no page reads players.profile.taste back to the player. That display belongs to M4's studio view alongside the rest of the premise dashboard (the same staging as the full intensity display was, pre-R4). Surfaced here per the working agreement, not silently shipped past.
- **Tests:** taste round-trip (write via booth/close extraction → read in recap prompt + settei text); bible carries the intensity lines; dossier groups a real-named PC correctly.

---

**Cadence:** each R-scope ran work → its own multi-lens subagent audit → fixes, then the full bare gate → push → CI green. R1 and R3 took the presentation pass (browser-verified with real campaign data).

**Landing note (2026-07-19):** the four scopes share files (play-view.tsx spans R1+R3, session.ts spans R3+R4, renderer.test.ts spans R2+R4), so M2R landed as ONE commit rather than the four planned — every scope still received its own adversarially-verified audit before the merge. Audit fixes folded in: R1 (sakuga_used describe, page/route gate parity), R2 (series budget gained its dossier reader, op_dominant floored at positive differential, startup briefing carries finitude, trajectory-note clamp), R3 (closed-recently guard steps aside for live turns, sessionClosed enforced on every submit path), R4 (per its audit). A pre-existing SZ defect surfaced during verification (declined control key compiled as a cut key) was spun off as its own task, not folded in.

**Explicitly out of scope:** the M2 gate adjudication (still awaiting directional review), M3 display grammar (drafted separately), any new suggestion UI beyond chips.
