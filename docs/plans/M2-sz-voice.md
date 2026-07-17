# M2-SV — Session Zero Recovers v3's Voice

*Insertion into M2 (between C8 and C9), user-directed 2026-07-12 after the second live SZ. Status: **DRAFT — awaiting directional review.** Every bullet under a commit ships in that commit.*

**The finding, in one sentence:** the plumbing is v5 but the voice drifted — the conductor introduces itself as "a story studio" without ever saying *anime*, walks the player through no doors (the re:zero draft assumed the player was Subaru without asking), and omits the §8-mandated power-tier beat entirely, leaving v3's whole OP-mode doctrine structurally inert (`layout.ts:200` hardcodes `characterTier = worldBaseline`).

**The heart being recovered** (from the full v3 SZ collection, 2,130 lines, read 2026-07-12): v3's Session Zero was a guided walkthrough — *which anime?* → calibration with pitched blend scenarios → canonicality as three numbered questions with IP-specific examples → power tier against the world's named baseline, with named composition configurations offered at gap ≥2 → **"What's the BIG IDEA for your character?"** → identity → world integration, with the player-choice-vs-Director-territory boundary v5 already carries. We recover the doors, not the markup: no emoji headers, no JSON protocol, no 75-point stat build (research owns mechanics in v5), no art-direction phase (media is M5).

---

## Structural calls (veto here)

1. **Three commits, SV1 first and alone** — the URL bug kills profile generation live (the re:zero draft has none); it ships before any voice work.
2. **The concept gate is blocking-unless-deferred, same as the name.** v3 held character concept as a hard requirement; C4's deferral affordance carries over — "let it emerge" is the player's word and compiles. What can no longer happen: a canon-world campaign compiling with the engine silently assuming the canon protagonist's seat.
3. **Composition choices land in the existing Framing component** (`contract.active.framing` already carries tension_source / power_expression / narrative_focus / player_role — the 13 salvaged enums). No new component; the conductor finally gathers what the contract always had room for. The chosen tier lands as a new optional `pc_power_tier` on the contract (zod + jsonb — no migration).
4. **Spend:** SV1–SV3 are prompt/compiler/test work — near-$0 (mocked tests). The acceptance run is the user's live re:zero SZ (~$1–1.50, the C4-checkpoint precedent).

## SV1 — research URL hardening (immediate; ships alone)

*Failure mode (live, 2026-07-12): `research_title("Re:ZERO …")` died with `Invalid URL` twice — the colon rides into a fandom hostname. No profile was written; the conductor correctly refused to confirm. Pillar: §8 existence-validation — research that crashes on punctuation fails the superfan.*

- wiki.ts: slug/hostname derivation sanitizes to hostname-legal characters (lowercase alphanumerics + hyphens; colons, spaces, punctuation collapse); every candidate URL constructs inside a guard — an invalid candidate is SKIPPED (next discovery candidate), never a thrown research run.
- The 60-entry override map gains re:zero (`rezero.fandom.com`) and any other colon-titled staples missing (check: Fate entries, Oshi no Ko, Konosuba long-titles).
- Regression tests: "Re:ZERO kara Hajimeru Isekai Seikatsu", "Re:Zero", "Fate/Zero" (slash), "Oshi no Ko" — all derive valid URLs or skip cleanly; a scripted discovery where candidate 1 is invalid falls through to candidate 2.

## SV2 — the voice: the opening, the concept beat, the walked doors

*Failure modes (live): the opening never says anime and self-describes in internal register; the audition assumed the player was Subaru; canonicality gathered by inference instead of choice. Pillars: §0 (the product's identity), §8 (the conductor's contract), the C4 gate's completion.*

- **The opening** (ratified copy direction): the conductor is the DM at the player's **anime** table — long-form campaigns in the register of a series they love (anime, manga, light novel), built to still feel like that series hundreds of turns in. Ground rules stay (word-always-wins, assert-and-it's-real, no command syntax, drafts keep). The model menu leaves the greeting — it arrives at its own beat. The returning-player variant stays warm, identity fixed underneath.
- **THE CONCEPT — new itinerary beat 2** (right after the audition): *who are you in this?* Never assume the canon seat. For a canon world, the seat is walked as options in the premise's own terms (the canon protagonist's position · beside the canon cast · replacing the protagonist · someone new entirely — these bind to the existing canon_cast_mode enum where they overlap) plus the v3 Phase-1 question adapted: the character's big idea, tagline-sized. New observation kind `pc_concept` (verbatim, latest-wins); compiler resolves it; gap verdict blocks an absent, un-deferred concept (call 2); the OSP receives it for the protagonist brief and Director inputs; the compile-guess surfacing (C4) covers concept deferrals.
- **Recognition, never presumption** (user-named 2026-07-12, §0 authority ordering): the §6.9 taste profile injects as WHO THEY'VE BEEN, explicitly not who they're being today — the conductor's instruction: hold prior taste as warmth and as material for questions ("same appetite as last time, or a departure?"), never as defaults for the new campaign; every campaign gets to be a departure, and the player must never have to push back against an assumption to claim one. Taste is the engine's inference tier — the LOWEST authority; the new campaign's spoken word outranks it before it is even spoken.
- **Canonicality as walked doors**: the prompt's one dense sentence becomes v3's three concrete questions — timeline, canon cast, event fidelity — each offered as short options *with IP-specific examples generated from the researched profile* ("you could witness the Royal Selection" beats an abstract enum). Enums unchanged; only the conversation changes.
- Itinerary renumbers; the "never a form" register holds — options are offered in prose, numbered only when a menu genuinely helps (v3's menus worked because they were concrete, not because they were numbered).
- Tests: scripted-transcript fixtures for the concept gate (blocks / defers / resolves), canon-seat options recorded correctly, opening spec asserts (the conductor system prompt contains the anime identity and does not contain "story studio" or cost-dial language in the opening block).

## SV3 — §8 compliance: the power-tier beat completes the OP circuit

*Failure mode: §8 mandates "power tier chosen in conversation … ≥2-tier gap → named composition configurations offered"; the conductor never asks, and layout.ts:200 hardcodes the PC's tier to the world baseline — v3's OP-mode doctrine (DC floors, scale compatibility, tension shifts: all salvaged, all tested, all dead code in live play) never fires. Pillar: §8 as written; §11's carried v3 mechanisms must not be scaffolding.*

- **The beat** (after canonicality, before the intensity contract): the world's baseline tier comes from the researched profile (`power_distribution.typical_tier` — already there); the conductor walks the choice v3-style — below / at / above / far above, each with what it does to the story — in the premise's own terms. At gap ≥2, it offers 2–3 **named composition configurations** (tension/expression/focus triples from the 13-enum vocabulary, v3's parsing table adapted as prompt guidance: "retired master, just wants peace" → mundane focus + hidden expression) and folds the player's own vision in.
- **Landing spots**: new observation kinds `pc_power_tier` (JSON `{tier, baseline}`) and `framing_choice` (JSON `{axis, value}`, calibration's idiom); the compiler resolves both — tier to the contract's new optional `pc_power_tier`, framing choices as active-layer Framing overrides.
- **The circuit closes**: layout reads `contract.pc_power_tier ?? worldBaseline` — the hardcode dies with a comment pointing here. At gap ≥3 the OP-mode machinery activates exactly as v3 shipped it.
- Tests: compiler resolution (tier + framing choices, latest-wins, malformed-JSON deferrals); layout consumes the chosen tier (OP context renders at gap ≥3, DC floor engages); a scripted gap-≥2 transcript records a configuration; keyless/tier-less drafts default to baseline exactly as today (no regression for existing campaigns).

## Acceptance

1. SV1: a live re-research of Re:ZERO writes a profile (the user's stuck draft resumes).
2. SV2/SV3: scripted-transcript suite green; then **the user re-runs his re:zero SZ live** — the checkpoint questions: does it greet him as what it is, ask who he wants to be, and walk him through the doors he remembers?

## Ledger additions (2026-07-12, user-directed)

1. **Taste-profile posture — recognition without presumption** → SV2 (above). Failure mode: live, the fresh SZ framed the new campaign through the prior one's preferences; the player felt the presumption as stifling. Pillar: §0 authority ordering.
2. **Taste-profile surface** — the engine holds beliefs about the player's taste with no view/edit/prune affordance; the record-needs-actors principle applied to the most personal layer. Home: M4 studio view (§13.4's gated write affordances are the natural door), flagged for possible pull-forward.
3. **Taste consolidation/aging** — entries append per-SZ with no dedup or staleness discipline; ten campaigns deep the list becomes long, redundant, and stale. Home: M3 (the compression/epoch-merge family).

## Not recovered, deliberately

Emoji/markdown formatting straitjacket (dead by §13 decision) · the JSON `detected_info` protocol (universal ingestion owns extraction) · MECHANICAL_BUILD's 75-point stats (research-derived stat mapping is v5's design) · art direction (M5, media) · v3's six-hard-requirements gate verbatim (v5's gap verdict + deferral affordance is the refined form of the same discipline).
