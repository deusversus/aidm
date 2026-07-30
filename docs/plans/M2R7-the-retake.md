# M2R7 — the retake: the transcript is the picker

**Status:** planned 2026-07-28, user-approved same day ("I love it. Let's proceed.")
**Spec anchors:** §6.7 (rewind substrate — tombstones, revocable turns), §16 (the register: RETAKE), C9 audit (booth lines are not story anchors)
**Scope:** one commit, one surface (the play view + at most validation touches on the rewind route). No new mechanisms — UX repair of an existing feature; the ledger is untouched.

## The failure

The shipped rewind UI is a panel of chips reading `before turn N` — story moments
reduced to arithmetic, labels naming the turn being DESTROYED instead of the place
being returned to, and the degenerate chip `before turn 1` (the restart) reading as
nonsense. The player looks at a scroll of scenes and is asked to translate them into
integers. Janky, hard to use, player-reported 2026-07-28.

## The design (approved)

1. **Rewind mode, not rewind panel.** The rewind button puts the TRANSCRIPT into a
   mode: the composer swaps for a slim bar ("Choose the moment to return to —
   everything after it un-happens · cancel"); each story reply within the horizon
   grows a `↺ Return here` affordance. Booth/channel exchanges and beyond-horizon
   turns dim as non-targets (booth lines are not places in the story — C9).
2. **Return-here semantics.** The player picks the reply that becomes the new
   present (`toTurn: N` — the API already speaks this; only the labels lied).
   Selection dims everything below it with a count: "3 turns will un-happen."
3. **The RETAKE slate, in place.** No modal. A strip under the chosen reply:
   "RETAKE from here — 3 turns un-happen. The record keeps them; the spend is
   spent. [Retake] · cancel." The studio's own word, at the player's hand.
4. **The pre-fill (load-bearing).** After the retake, the composer returns focused,
   pre-filled with the player's FIRST unwound input as an editable draft — the
   dominant rewind reason is "let me say that differently." Survives the post-rewind
   reload via sessionStorage (read-once, keyed by campaign).
5. **The seam — session-only.** A quiet hairline ("— retake —") at the cut for the
   rest of the sitting, gone on reload (the durable record already reads clean).
   A seam, never a scar. sessionStorage, same read-once discipline.
6. **The top edge gets its name.** "Before turn 1" becomes a real anchor at the top
   of the scroll: "↺ Return to the opening — replay from the first scene."
7. **The horizon stays at 10**, honestly labeled (older turns: "beyond the retake
   horizon" tooltip). Un-rewind: explicitly killed (revocable tombstones remain a
   substrate fact, not a feature).

Happy fact, for the record: since M2R5 C3 the retake turn's prompt is a strict
prefix of blocks the original turn already wrote — within the 1h TTL a rewind
re-reads the old cache entry at 0.1×. The feature is warm by accident of design.

## Verification (C10 presentation pass — this is player-visible)

- Browser-verify on a FIXTURE campaign with real turns (never the player's live
  campaigns — rewind is destructive): mode entry/exit, non-target dimming, selection
  dim + count, slate copy, confirm → reload → pre-filled composer + seam hairline,
  cancel at every step, the opening anchor, the horizon tooltip. Structural DOM
  checks count where the screenshot pipe flakes.
- The dropped-stream and long-turn cases are untouched by this change (no streaming
  surface modified) — assert the rewind button stays disabled while a turn is
  in-flight (existing behavior, keep it pinned).
- Dark-only app — theme matrix vacuous. `pnpm env:parity` untouched (no env keys).
- Full bare gate; audit per cadence; CI on own SHA; Railway confirmed.
