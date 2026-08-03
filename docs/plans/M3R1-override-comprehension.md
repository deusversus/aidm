# M3R1 — Override comprehension: the studio understands before it complies

**Status:** approved (user, 2026-08-03 — "yes" to the dialectic proposal). One commit.

## The failure modes (measured, not vibed)

1. **Misroute-to-destructive-mint** (live, 2026-08-02/03): a story reply classified OVERRIDE_COMMAND minted VERBATIM as an active standing rule injected into every conte's hard constraints; the scene never ran. Post-repair residual: the hardest real input still misroutes ~25% of the time at a Haiku probe (majority-of-3 advisory line in `evals/suites/channel-routing.ts`). No honest prompt work closes that tail — the probe is the cheapest instrument in the stack and the mint is the most destructive act.
2. **The verbatim-paragraph rule**: even a REAL override buried in prose mints the whole prose. The ledger's reader (Layout, every turn including douga) then carries a paragraph where a rule should be.
3. *(Noted, deferred)* **One-shot-as-permanent**: OP_COMMAND ("set my HP to full") mints a standing per-turn injection for a one-beat request. Fixing it properly needs a G1-side mechanical-apply design — its own plan row when it earns one. This commit deliberately does NOT touch the OP path.

## Pillars

- **§7.4** — "compliance with minimal ceremony" means complying with what the player MEANT. Zero-comprehension compliance is compliance with bytes.
- **§2** — player authority: the restatement surfaces what the studio understood the moment it complies; correction is just the next player input. No confirmation gates, no negotiating the player's authority — v3's anxious-check-in failure stays dead.
- **§5.4** — the channels doctrine. The booth already carries the deep dialectic (META_FEEDBACK conversations). This gives the one zero-intelligence channel its eyes.

## The mechanism

One judged call (`comprehendOverride`, traced trio, judgment tier, strict structured output) inside the OVERRIDE_COMMAND dispatch:

- Output: `{ contains_standing_rule, rule, scope: standing | one_shot }`. Destroy-class bounds live in the prompt and consumer clamps, never the schema (API strips grammar bounds — M3 C1).
- **Standing rule found (either scope)** → `mintOverride` mints the EXTRACTED one-sentence rule (not the raw bytes); the acknowledgement quotes the restatement — the mutual-understanding surface. The raw input stays on the turn row for provenance.
- **No standing rule** → **the bounce floor**: the turn re-enters the story pipeline (`runLayout` with the channel short-circuit disabled, the still-channel re-probe RELABELED to DEFAULT so the scene never wears the mislabel through tiering/retrieval/the outcome judge). The scene the probe nearly ate gets its second look before anything destructive lands.

**Walk-back (M3R1 review, recorded per §15 posture):** the first draft bounced `one_shot` verdicts too. The review's adversarial trace showed that discards the comprehension's own understanding and re-enters the story machinery with a mislabeled non-action — on judged tiers the outcome die rolls against the *request itself* ("give this scene a big finish" → a FAILURE roll instructs the KA to narrate the request failing). A one-beat rule now complies via its restatement like any other; its self-retiring lifecycle is deferred with the OP-command design. The fail-open synthetic verdict also gained durable provenance (`override_comprehension_failed`, the trailer_source precedent) so an outage-minted raw rule is never forensically indistinguishable from a judged extraction.
- The Studio-notes panel's mint (`/overrides` route) is untouched: text typed into "Add a standing rule" is explicitly a rule; comprehension there would be ceremony.

## Re-entrancy (§5.7 — the C9 checkpoint discipline extends)

- Fresh run: Layout classifies OVERRIDE → comprehension runs → the VERDICT is checkpointed with `channel_intent` before any responder acts. A crash-replay never re-comprehends (a flipped verdict across a crash would be two different turns).
- Bounce: checkpoints `override_bounced` instead of `channel_intent`; crash-replay re-enters the story path directly. The double intent-probe on the rare bounce path (~half a cent) is accepted — passing pre-parsed intent through `runLayout` is complexity the frequency doesn't buy.
- `mintOverride`'s content-aware dedupe still holds: replay mints from the checkpointed verdict, so the content is deterministic.

## Deliverables (one commit)

- `comprehendOverride` in `src/lib/booth/booth.ts` + its output type in `src/lib/types/booth.ts`.
- Runtime dispatch rewiring in `src/lib/turn/runtime.ts` (verdict checkpoint, bounce path, replay paths).
- `runLayout` gains `forceStory` (skip the channel short-circuit; nothing else changes).
- Tests: booth comprehension round-trip; channels-wiring — standing mint with extracted content + verdict checkpoint, bounce runs the full story pipeline, both crash-replay paths, judgment-call count pinned (no re-comprehension on replay).
- Eval: `channel-routing` gains two FLOOR cases at the DEV judgment tier — the live specimen must bounce (`contains_standing_rule: false`), a real keyword-less override must extract. This is the measured close of the ~25% tail: probe noise no longer reaches the ledger without a second instrument agreeing.
- META_FEEDBACK and OP_COMMAND paths byte-identical to today.
