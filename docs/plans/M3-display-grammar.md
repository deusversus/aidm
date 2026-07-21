# M3-DG — The Display Grammar: What the Writer Writes Into

*Drafted 2026-07-18, user-directed ("we need a richer display system for our writer to write into/with"). Status: **APPROVED 2026-07-20 — pulled forward as M2.75.** Directional review resolved: starter set is SIX (comms added on the integrator's recommendation, user-invited); memory MARKING is universal with premise-styled chrome; the stinger is a follow-on commit after the wardrobe exists, not part of this plan.*

**Failure mode (named, live):** §8 grants promise diegetic devices — "diegetic System status windows (hooks into stat_mapping)" is the blueprint's own example — that no current surface can render and no current vocabulary can invoke. The KA fakes every device with the one offset channel it has (blockquote), so a System window, a tactical readout, a letter, and a memory all wear the same clothes; SV4's channel law ("mark the variant") has prompt-side force but no product-side teeth. The Return by Design T6 flashback confusion was this gap wearing its temporal face.

**Pillar:** §8 walk-back 2026-07-03 (formatting is authorial judgment guided by premise; the product layer renders, never imposes) + §9.2 (chips skinnable as a System window — the same component family).

## The grammar (structural calls — veto here)

1. **Directives are fenced blocks with info strings** — ` ```readout ` … ` ``` ` — because the syntax is markdown-native (react-markdown hands us the fence token; no custom parser), streaming-degrades gracefully (an unclosed fence renders as a forming block, never garbage), and pins/Sakkan/compaction see the inner text as plain prose with trivial stripping.
2. **Directives are GRANTED, per premise, at SZ** — exactly like today's prose grants. The presentation vocabulary gains an optional structured half: `directives: [{ name, skin }]` beside the existing `grants: string[]` (zod + jsonb, no migration). The Settei lists what's granted with usage guidance; an UNGRANTED directive in prose renders as the plain offset channel (graceful, logged) — the KA is corrected by the Sakkan/dailies, never by a render error.
3. **The starter set is six, premise-skinned, closed until the ledger opens it:**
   - `window` — the diegetic UI panel (Solo Leveling's System; a cyberpunk HUD). Skin string from SZ styles the chrome.
   - `readout` — the analytical/tactical channel (Return by Design's machine), visually distinct from `window`.
   - `letter` — written artifacts in their own face (letters, notes, inscriptions, signs).
   - `title` — the episode title card (already half-granted in live play: "episode-title cards only").
   - `memory` — the marked not-now/not-real channel: SV4's "mark the variant" made a real, visible channel. UNIVERSAL (resolved Q2, 2026-07-20): the MARKING works on every campaign — the legibility law is universal — while the chrome is premise-styled via the skin (flashback / dream / vision are skins of this one device, not separate devices). Ungranted-chrome campaigns get a minimal neutral marking, never nothing.
   - `comms` — the conversation-shaped channel: chat logs, radio chatter, phone screens, message threads, with speaker attribution. Modern anime's second device after the System window; cannot fake as `letter` (wrong tempo, needs speakers) or `window` (a conversation, not a status). Ships inert for premises that don't grant it (added at directional review 2026-07-20).
4. **The KA's side is a grants-render extension, not a new contract section** — the camera law already governs usage; the grants block teaches the granted names and their skins. Renderer changes: `renderPresentationGrants` grows to render the structured half.
5. **The floor stays the fallback everywhere**: SZ view, bible, recap — any surface without directive components renders directives as offset prose. No surface ever breaks on a directive it doesn't know.

## Deliverables (one commit, M3 cadence)

- Types: `PresentationVocabulary.directives` (optional, defaulted) + compiler gathering (SZ presentation observations resolve structured directives when the conversation grants them; prose grants unchanged).
- `NarrationProse` learns fenced directives: a component registry mapping granted names → styled blocks (skin-aware), unknown fences → the offset fallback. Streaming-safe by construction (call 1).
- The conductor's presentation beat learns to OFFER the vocabulary premise-natively (a Solo Leveling table gets asked about its System window; Berserk is never offered chrome).
- `plainProse` strips fence markers (pin-from-selection reaches inside directives).
- Sakkan neutrality check: one eval assertion that directive-bearing prose scores identically to its stripped projection (the Gauge reads story, not chrome).
- Tests: component registry (granted/ungranted/unknown), compiler resolution, prompt-spec asserts on the grants render; browser verification against a live campaign per CLAUDE.md.

## Not in this plan, deliberately

Chips-as-System-window skinning (§9.2 — same component family, own commit once chips have usage data) · media/portrait embedding (M5) · player-authored formatting (their words stay verbatim) · per-directive animation/sound (post-v5 with the sound department).

## Acceptance

The user's live table: a campaign whose premise grants `readout` and `memory` shows Lilith's machine in its own chrome and a flashback that *looks* like a flashback — and a premise granted neither renders the same prose cleanly with none of it.

## Directional review — RESOLVED 2026-07-20

1. Starter set: SIX — the five plus `comms` (integrator recommendation on user invitation; one-word veto stood open, not taken). Dreams/visions/prophecies are `memory` skins; signs are `letter`; countdowns are `readout`.
2. `memory`: universal MARKING, premise-styled chrome — the law is universal, only the look is premise.
3. Pulled forward: M2.75, effective immediately.
4. Stinger: its own small commit AFTER this plan lands (a close-path artifact beside the yokoku, using the wardrobe this plan builds).
