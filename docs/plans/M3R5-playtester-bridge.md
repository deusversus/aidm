# M3R5 — The playtester bridge (§13.5): a guest list and an allowance

**Status:** draft for user ratification (direction confirmed 2026-08-06: "a couple playtesters would be nice", default $20/tester, per-tester caps on an admin-facing surface — "feedback quality and needs changes tester to tester"). This is the §13.5 allowlist + spend-caps bridge the blueprint schedules between M3 and M5's real billing; it is deliberately NOT billing — no payments, no credits ledger, no markup. One key (his), a guest list, and a meter that says no.

**Named failure mode (ledger rule):** an invited tester's all-nighter drains the shared API key — the exact class the §0.9 cost discipline exists for, now with someone else's hand on the faucet. **Pillar:** §13.5 / §9.5 (the meter is load-bearing; if it isn't metered it doesn't ship — here, if it isn't CAPPED it doesn't serve).

## Shape (three commits)

**C1 — The allowlist + the cap column.**
- `players` gains `playtester` jsonb (nullable): `{ invited_at, invited_by, spend_cap_usd, note }`. The user's own row carries none — the owner is uncapped by construction (identified by env `OWNER_CLERK_ID`, parity-checked).
- Campaign creation (SZ start) gates on: owner, or `playtester` present. Everyone else: a polite closed-door page (no waitlist machinery — that's product surface M5+ owns).
- Spend accounting: `model_calls` already carries campaignId → campaigns carry playerId — one query sums a tester's lifetime spend. Enforcement at the ONE choke point every model call passes (the traced calls): a per-player spend check cached in-process with a short TTL (~60s) so it costs one query a minute, not one per call. Over cap → the turn engine refuses with an honest player-facing message ("your playtest allowance is spent — tell jcettison what you thought"), never a mid-scene crash: the check runs at turn SUBMIT, not mid-stream.
- Default cap **$20** (his number); the column is per-tester from day one.

**C2 — The admin surface.**
- One page, Clerk-gated to the owner id only: the guest list — each tester's email/id, invited date, cap, lifetime spend (live query), remaining, a cap edit field, and an enable/disable toggle. Server actions write `players.playtester`; every cap change appends to a small audit trail inside the jsonb (the settingsLog idiom).
- No invite-email machinery: he invites by telling a friend to sign up, then flips them on by email match. (Clerk sign-up stays open; the gate is campaign creation, not account creation.)
- C10 presentation pass applies (owner-facing but a real surface): browser-verify with a real second account.

**C3 — The tester experience guards.**
- Tier menus for testers: capped at the Sonnet/Opus rungs by default (`playtester.fable_allowed: false` unless he flips it) — Fable is the expensive hand; a $20 allowance at ~$1/turn Fable evaporates in one sitting, at Sonnet it's a real campaign.
- The cost meter's gauge gains a per-player rollup (`pnpm cache:gauge` table) so he can see tester spend without the admin page.
- Soak/harness guard: playtester rows never run soaks (the harness's assertSoakCampaign already binds by title; add the owner check for belt).

## Out of scope (stays M5)
Real billing, credits, markup, self-serve top-ups, waitlists, abuse tooling beyond the cap, exporting campaigns for departed testers.

## Open question for ratification
Whether a tester hitting the cap can SEE their own spend meter in-app (a small "allowance" line on the play view) or only discovers it at the refusal. Recommendation: show it — §9.5's transparency doctrine, and it converts "why did it stop" support pings into self-service.
