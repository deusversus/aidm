# M2R5 — the cache: a prefix worth the premium

**Status:** planned 2026-07-26 · deliverable 3 signed off by the user same day ("consider #4 signed off")
**Spec anchors:** §5.6 (four-block prefix, append-only Block 3), §10.8 (budget assertions), §3 (tier menus / studio handoff), C9 telemetry decision (1h TTL, measured 2026-07-18)
**Evidence:** 12-agent cache audit, 2026-07-26 (workflow `cache-audit`, adversarially verified findings) + live `model_calls` measurement

## The failure mode (measured, not vibed)

Over the 14 days ending 2026-07-26, cache-touched tokens cost **$15.90 where the same
tokens uncached would have cost $10.65 — the cache is net-negative by $5.26**, and
40 of 81 narration calls on the two active campaigns read zero cached tokens while
paying the 2× 1h write premium. The block architecture itself audited sound on every
structural axis (stable-prefix ordering, structurally-enforced append-only, volatile
conte last, deterministic rendering, retry prefix reuse — all test-pinned). The money
leaks through four implementation gaps, all confirmed with file:line evidence:

1. **The prewarm writes a prefix nothing can read.** `prewarmPrefix`
   (src/lib/llm/calls.ts:385–405) sends no `tools`; every real narration call sends at
   least `commit_scene` (ka.ts:201). Tools render ahead of `system` in the cache key,
   so the prewarm's write lands in an entry the KA structurally cannot hit. Every
   firing — play-view refocus (api/campaigns/[id]/prewarm/route.ts:37) and session
   open (direction/session.ts:218) — is a pure 2×-rate loss that also delivers none
   of the latency it exists for. Its `max_tokens: 1` + "." placeholder is the
   superseded pre-warm form; the documented form is `max_tokens: 0` (prefill runs,
   cache writes, zero output billed).

2. **The tool array flaps with tier.** `budget > 0 ? [COMMIT_SCENE_TOOL,
   ...KA_RESEARCH_TOOLS] : [COMMIT_SCENE_TOOL]` (ka.ts:201) means a douga beat (or
   any `cap_research_0` degrade) between two genga turns busts all three breakpoints
   twice — same tools-gate-everything mechanism as #1.

3. **Block 3 rewrites its whole window every turn at 2×.** B3 is one growing text
   block (blocks/assemble.ts:180). Production measurement: median 12,288 creation
   tokens per first-narration-call (max 26,576); 60 of 82 turns made exactly one
   narration call, so nothing reads the write within the turn, and next turn's growth
   busts it again. Current best practice is incremental multi-turn caching — history
   as discrete blocks with a *moving* breakpoint: old window read at 0.1×, only the
   new exchange written at 2×. Worth ≈ $0.10/turn on Opus narration.

4. **The two in-process loops re-send their heads uncached.** The SZ conductor maps
   its whole append-only transcript into `messages` on every round of its 6-round
   loop with only `system[0]` cached (conductor.ts:314, 335–338) — the returning-player
   taste block (system[1]) and the entire transcript re-bill at list price every round.
   The Director's investigation loop (director.ts:412–426, the only production caller
   of callStructured's tool loop) re-sends a 1.2–3.5k-token head up to 6 rounds per
   cycle; `StructuredCallOptions.system` is typed `string` (calls.ts:104), so it
   *cannot* carry a breakpoint today.

Correct as-is, explicitly out of scope to "fix": judgment/probe calls stay uncached —
their static systems run 113–869 tokens, under the current minimums (Opus 5 512 /
Sonnet 5 1024 / Haiku 4.5 4096), and their payloads are unique per firing. The 1h TTL
for inter-turn blocks stays — C9's measured think-time (p50 ~36 min, no gap under 5
minutes) still holds.

## Ledger note (§14 risk 6)

No new mechanism — every deliverable repairs or completes the C5 four-block plumbing
and the §10.8 cost instrumentation that already exist. Named failure mode: *the cache
configuration ran silently net-negative for weeks* (−$5.26/14d, caught only by this
audit). Pillar: §0's quality-outranks-cost only stays honest if cost is measured —
budgets catch waste (CLAUDE.md doctrine), and this waste had no gauge.

## Commits

### C1 — the tool law + the honest prewarm

*The cache key starts at the tool array; the array becomes law.*

- **One constant KA tool array.** `runKeyAnimator` always sends
  `[COMMIT_SCENE_TOOL, ...KA_RESEARCH_TOOLS]`. The research *budget* moves entirely
  into the loop: a research `tool_use` arriving with budget exhausted gets a refusal
  `tool_result` ("research budget exhausted — write the scene from what you hold"),
  never execution; the conte already states the allowance (Drive line). Douga and
  degraded turns therefore keep byte-identical tools and stop busting the prefix.
- **The prewarm sends the identical array** — same `tools`, same `system` — so its
  write is the entry the KA reads. `max_tokens: 0`, drop the "." placeholder message
  per the current documented pre-warm form.
- **`scripts/cache-gauge.ts`** — the standing meter: reads `model_calls` over a
  window and prints, per tier × model, hit ratio (read / (read+creation+input)),
  creation-vs-read balance, and the one number that caught this: net-saved-or-lost
  USD vs the uncached counterfactual. Run: `pnpm tsx scripts/cache-gauge.ts [days]`.
  This is the regression tripwire for every later commit.
- Tests: tool-array constancy across tiers and ladder steps (pinned); loop refusal
  path (scripted over-budget research call → refusal result, scene still commits);
  prewarm request-shape parity with the narration call (same tools, same system,
  max_tokens 0) pinned via mock capture.

### C2 — moving breakpoints for the talkers

*The conductor and the Director stop re-buying their own transcripts.*

- **SZ conductor:** breakpoint moves from `system[0]` to the *last* system block (so
  the returning-player taste block rides inside the cached prefix), plus a **moving
  breakpoint on the last transcript message**, re-placed each round/turn — the
  documented incremental multi-turn pattern. Two of four breakpoints used; the
  transcript is already append-only (`.push` only), so each round reads the prior
  round's write.
- **callStructured grows an opt-in `cacheHead`** (`"5m" | "1h"`): converts the
  `system` string to a text block carrying `cache_control` and places a breakpoint on
  the last content block of `messages[0]`. The Director's investigation loop passes
  `cacheHead: "5m"` — rounds are seconds apart, so the 1.25× write amortizes across
  up to 6 reads at 0.1×; nothing else opts in (judgment/probe stay bare — the type
  stays `string` for everyone who doesn't ask).
- **The meter learns the 5m/1h split.** The API already reports
  `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`; `estimateCostUsd`
  prices the split (1.25× / 2×) when the breakdown is present instead of flat 2× —
  otherwise C2's own 5m writes would meter as overcharges. Pricing tests updated with
  the split fixtures.
- Tests: conductor request-shape (breakpoint on last system block + last message,
  moving across a scripted 3-turn transcript); cacheHead off-by-default byte-parity
  (existing callers' requests unchanged — pinned); meter split math.

### C3 — Block 3 breathes in exchanges (§5.6 evolution — signed off 2026-07-26)

*Append-only stays; the rendering stops paying 2× for what it already wrote.*

- **B3 renders as discrete text blocks:** one block for the pin head, one per
  exchange, in the same watermark-derived order as today. `cache_control` placement
  becomes: Block 1 tail · Block 2 tail · pin-head block · **last exchange block
  (moving)** — exactly the API's four breakpoints. Turn N+1 appends one exchange
  block and moves the tail breakpoint: prior window reads at 0.1×, only the new
  exchange writes at 2×. Append-only is untouched — same rows, same derivation, same
  watermark; only the join into a single string goes away. (Pins get their own
  breakpoint so a rare pin add busts pins+window, never Blocks 1–2.)
- **Constraint margin, documented in code:** cache reads walk back ≤20 blocks from a
  breakpoint. Compaction triggers at 16 exchanges (keep-tail 10), so the window is
  ≤16 blocks + pin head; the assembly asserts (dev-time) that the block count stays
  under 20 rather than trusting the compaction cadence forever.
- **Blueprint §5.6 dated amendment** (same form as the §3 Opus 5 note): single-block
  B3 → per-exchange blocks with a moving tail breakpoint, user-signed 2026-07-26,
  rationale one line (measured 2× rewrite of a 12k median window per turn).
- **Re-baseline the gauges:** soak read-fraction expectations (soak-lib currently
  soft-flags "B3 re-creates by design" — that excuse retires), and
  `BUDGET_ASSUMPTIONS.assumedCacheHitRate` (0.7 assumed; M1 measured 0.24 on a young
  campaign — post-C3 the soak measures the real number and the assertion tightens to
  it).
- Tests: prefix-stability test extends to block-list form (turn N's block list is a
  strict prefix of turn N+1's, breakpoint excepted); compaction event still resets
  B2+B3 wholesale; pin-add busts window but not B1/B2 (request-shape pinned).

## Verification (every commit)

- Mocks prove request shape; **one live Sonnet mini-soak proves the wire** (2 turns +
  a prewarm on a fixture campaign, DEV tiers, cents): assert `cache_read > 0` on the
  turn-2 narration call (C1), on conductor round 2 and Director round 2 (C2), and
  turn-to-turn read fraction at the C3 target. No Fable anywhere (standing rule).
- `pnpm tsx scripts/cache-gauge.ts 1` before/after each landing — the net-saved
  number moves the right way or the commit doesn't push.
- Full bare gate per push; CI on the commit's own head SHA; Railway confirmed.
- Nothing here is player-visible (no presentation pass); the studio-handoff warning
  copy is untouched — cache resets from tier changes remain disclosed as today.

## Expected recovery

Conservative: the standing −$5.26/14d loss flips to roughly break-even at C1 (the
pure-waste writes stop), and C3 adds ≈$0.08–0.10 per Opus narration turn (12k-median
window at 0.1× instead of 2×). At the current ~$1.06/turn average, that is ~8–10% off
the marginal turn price — while making the five-minute-good-reply *cheaper*, never
shallower (§0: budgets catch waste, never trim deliberate depth).

## Out of scope

- Caching judgment/probe systems (below per-model minimums; unique payloads — correct
  as-is, re-check only if a rubric ever exceeds its model's minimum).
- Top-level *automatic* caching for the narration path — explicit breakpoints remain
  the documented tool for multi-tier prefixes that change at different frequencies;
  automatic mode is the right pattern only for the single-tier talkers, and C2 gets
  the same effect explicitly with one moving breakpoint.
- Any TTL revisit of C9's 1h decision for inter-turn blocks (still measured-correct).
- voice_cards research starvation (M2R4 out-of-scope carry-over, unrelated).
