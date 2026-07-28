# M2R6 — the law channel: nothing of the player's ever falls

**Status:** planned 2026-07-28, user-directed ("The engine defect is real… let's begin drafting a plan")
**Spec anchors:** §2 player authority (expressed player word > premise-truth > inference), §8 (Session Zero — one conversation, a signed contract), §4 (the Premise Instrument's closed sets), §6 layer 9 (critical facts → hard_constraints)
**Evidence:** The China Shop (35a4823d), first M2R4 field test, 2026-07-27/28

## The failure, named

At the China Shop's table the player resolved, in plain words (szTranscript[20]):
*"there is no cost to my power or loss of control."* The conductor recorded it per its
own documented contract — `framing_choice {axis: "power_expression", value:
"overwhelming — force is rarely in doubt…"}` and `{axis: "tension_source", value:
"collateral consequence — who pays the cost…"}` — and the compiler dropped both into
`deferred`, shipped `ready: true`, and the contract signed without them. Three turns
later the pen, holding a JJK register whose motifs literally include "the cost
revealed after" and a hard line fencing capability and coolness, filled the unfenced
hollow with the one price left: memories of loved ones. The Chronicler canonized the
toll economy twice (layer 9: the sister's name; a girl's name "held in trust").

Three stacked defects, smallest first:

1. **Parser strictness masquerading as judgment** (compiler.ts:258-278). The
   conductor chose the CORRECT enum token (`overwhelming`) and glossed it; strict
   `safeParse` failed on the gloss. The model proposed right; the schema disposed of
   it on a technicality.
2. **No container for genuine instrument-outgrowth.** "collateral consequence" is a
   real tension design `TensionSource` doesn't hold. The engine has two organs — the
   GAUGE (closed, anchored, blind-measurable: DNA axes, framing enums) and the LAW
   (open, verbatim, absolute: hard lines, critical facts). The resolution belonged to
   the law; nothing routed it there.
3. **`ready: true` with player word on the floor.** `deferred` rides `open_items` in
   a tool result nobody re-reads; the recap narrates player-deferred items as "open
   for the story" and never distinguishes SCHEMA-dropped resolutions. Silent drop is
   a player-authority violation, full stop.

**The principle this landing encodes (the RbD → China Shop lesson, generalized):
the register is a positive-pressure system — it fills every unfenced hollow with
genre. A premise's negative space ("there is NO cost") needs the same first-class
standing as its hard lines, because absence is the one thing the pen cannot infer,
only fill.**

## Ledger note (§14 risk 6)

No new mechanism beyond: one observation kind, one parse normalization, one
provenance value — all inside existing organs (conductor vocabulary, compiler
resolver, layer 9). Named failure mode: *player resolution dropped at compile;
the register colonizes the gap* (happened 2026-07-27, canonized twice before the
player caught it). Pillar: player authority (§2) + the §8 contract's meaning.

**Explicitly rejected, recorded so it is not relitigated:** dynamically growing the
instrument (new axes/enums minted at SZ). A dynamic axis is a number with no ruler —
no anchors, no bands, no blind rubric — and re-imports the vibes-based judgment §4.5
exists to kill. The gauge stays closed; the law channel is how the premise outgrows
it. Law still gets teeth without measurement: layer 9 already rides every conte's
hard_constraints, and standing laws render in Block 1's world-rules freight (the
control-key precedent) — obeyed text, never scored text.

## Commits

### C1 — the routing rule at the table (conductor)

- **New observation kind `premise_law`**: a resolution recorded VERBATIM, one clause
  per observation, explicitly for anything that fits no instrument slot. The
  conductor prompt gains the routing rule, stated as law: *if the value you want is
  not on the axis's enum, the resolution is LAW — record `premise_law` verbatim;
  NEVER decorate an enum token with a gloss (record the bare token; the color goes
  in a premise_law or nowhere); never coin an axis value.* Negative-space clauses
  ("there is NO…") are called out as the canonical premise_law case.
- **The recap distinguishes its two lists**: player-deferred items stay "open for
  the story to discover"; anything the compiler carved as law is READ BACK for
  confirmation before propose_contract — "I'm carving these as law: …" The player
  hears the routing, at the table, before signing.
- Tests: conductor prompt-contract cases (existing scripted-round pattern) — a
  glossed enum answer records the bare token; an off-enum resolution records
  premise_law verbatim; the recap round carries the carve-back line.

### C2 — the compiler honors the whole contract (must-place invariant)

- **Token normalization** (compiler.ts `framing_choice` arm): a value whose
  normalized head matches exactly one of the axis's enum tokens compiles to that
  token (the gloss is logged, never load-bearing). "overwhelming — force is rarely
  in doubt" → `overwhelming`. Ambiguous or headless values fall through to law.
- **The law landing**: `premise_law` observations AND any framing_choice still
  unplaceable land verbatim as layer-9 critical facts — provenance `sz_resolution`,
  confidence 1 — and standing laws render into Block 1's world-rules freight beside
  the control key, so the pen reads them every turn, not only via per-turn
  hard_constraints.
- **`ready: true` becomes an oath**: resolveObservations returns placed / laws /
  playerDeferred, and the schema-dropped class is UNREPRESENTABLE — everything
  unplaceable is law by construction. `deferred` as a dead letter is deleted.
  propose_contract's open_items carries only playerDeferred plus the carved-law
  echo list C1 reads back.
- Tests: the China Shop's exact payloads as fixtures (the gloss compiles; the
  collateral clause lands as law and renders in the charter); ready-gate semantics;
  compiled-contract snapshot proves laws reach both Block 1 and hard_constraints.

### C3 — the China Shop repair + the retro audit

- **Record the law** (his words, provenance `player_correction`): "Kami's power
  costs HIM nothing — no toll, no loss of control; the cost is collateral: the
  people and world around him pay it." Tombstone the two toll-economy
  chronicler_promotions (the sister's name; the name held in trust). Pencil mark
  for the pen: the exchange-grammar of the register aims at the WORLD's economy,
  never at a price Kami pays.
- **DECISION GATE (the player's, before this commit lands):** the on-page scenes.
  (a) rewind 2 turns and replay the release unpriced, or (b) keep the scenes,
  re-aim the canon — Shikō's "price" talk was her aristocratic theater; nothing was
  taken — or (c) keep the sister's-name loss as a one-time artifact of the original
  sealing while killing the recurring toll. The plan carries all three; none is
  default.
- **Retro audit**: scan every campaign's szTranscript propose_contract results for
  `unrecognized`/`unparseable` drops (Thread-Reader's Ledger and Return by Design
  compiled under older SZ builds); surface findings to the player before touching
  any row. Shared-DB discipline: live-row mutations only with his word, per row.

## Verification

- C1/C2: mocked conductor rounds + compiler fixtures (no live spend); one live
  Sonnet SZ mini-conversation (~$0.10, DEV tiers, never Fable) proving the glossed
  token compiles and an off-enum clause is read back as carved law at a real table.
- C3: DB before/after printout for his review; if (a) rewind is chosen, the
  existing rewind substrate does the work (tombstones, not deletes).
- Full bare gate per commit; audit per cadence; CI on own SHA; Railway confirmed.
- Presentation pass: C1's carve-back line is player-visible in the SZ surface —
  browser-verify at a real table (the live mini-conversation doubles as it).

## Out of scope

- Growing the instrument (rejected above, recorded).
- The §3 effort↔tier cache ruling (separate, still pending the player).
- Sakkan measurement of laws (laws are obeyed, not scored; the attribution probe
  and Director dossier already watch compliance-shaped drift).
