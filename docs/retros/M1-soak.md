# M1 Soak Report — playable to turn 30

Generated: 2026-07-10T07:48:11.607Z

Campaign id: `0c18362e-d4e0-48fc-9efb-4d82bac1d252` — **KEPT** for reference (pass --cleanup to delete).

Tier selection (DEV): narration=`claude-sonnet-5`, judgment=`claude-haiku-4-5`, probe=`claude-haiku-4-5`. Fable guard: **PASS** (no Fable in any tier).

## Per-turn table

| step | turn | tier | served model | narration $ | turn $ | cacheRead frac | TTFT ms | total ms | flags |
| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1 | genga | claude-sonnet-5 | $0.1199 | $0.1298 | 0.65 | 72332 | 101373 | cold turn — cache-read frac 0.65 (prefix creation expected); TTFT 72332ms > target 8000ms; total 101373ms > target 35000ms |
| 2 | 2 | genga | claude-sonnet-5 | $0.0313 | $0.0426 | 0.51 | 17897 | 41062 | TTFT 17897ms > target 8000ms; total 41062ms > target 35000ms |
| 3 | 3 | sakuga | claude-sonnet-5 | $0.1493 | $0.2119 | 0.54 | 119724 | 134469 | TTFT 119724ms > target 15000ms; total 134469ms > target 60000ms |
| 4 | 4 | genga | claude-sonnet-5 | $0.0538 | $0.0668 | 0.00 | 20053 | 42056 | FAIL:turn 4 (genga): cache-read frac 0.00 < 0.5 floor; TTFT 20053ms > target 8000ms; total 42056ms > target 35000ms |
| 5 | 5 | genga | claude-sonnet-5 | $0.1504 | $0.1623 | 0.54 | 86591 | 114008 | FAIL:turn 5 (genga/claude-sonnet-5): narration $0.1504 > cold ceiling $0.1283; TTFT 86591ms > target 8000ms; total 114008ms > target 35000ms |
| 6 | 6 | sakuga | claude-sonnet-5 | $0.1984 | $0.3132 | 0.00 | 174821 | 180015 | FAIL:turn 6 (sakuga/claude-sonnet-5): narration $0.1984 > cold ceiling $0.1965; FAIL:turn 6 (sakuga): cache-read frac 0.00 < 0.5 floor; retried once after a retryable error; TTFT 174821ms > target 15000ms; total 180015ms > target 60000ms |
| 7 | 7 | sakuga | claude-sonnet-5 | $0.1722 | $0.1927 | 0.23 | 127418 | 144177 | FAIL:turn 7 (sakuga): cache-read frac 0.23 < 0.5 floor; TTFT 127418ms > target 15000ms; total 144177ms > target 60000ms |
| 8 | 8 | sakuga | claude-sonnet-5 | $0.2418 | $0.2658 | 0.70 | 161290 | 183999 | FAIL:turn 8 (sakuga/claude-sonnet-5): narration $0.2418 > cold ceiling $0.1965; TTFT 161290ms > target 15000ms; total 183999ms > target 60000ms |
| 9 | 9 | sakuga | claude-sonnet-5 | $0.3267 | $0.4123 | 0.67 | — | 180011 | FAIL:turn 9 (sakuga/claude-sonnet-5): narration $0.3267 > cold ceiling $0.1965; retried once after a retryable error; total 180011ms > target 60000ms |
| 10 | 10 | genga | (none) | $0.0000 | $0.0247 | — | — | 38416 | retried once after a retryable error; total 38416ms > target 35000ms |

## Event-mix checklist

- [ ] douga (trivial) turn — none classified douga
- [x] genga (story) turn — turn 1
- [x] sakuga combat turn — turn 3
- [ ] WORLD_BUILDING faction mint (Red Sash) — no faction entity matched /red sash/
- [ ] override command — no OVERRIDE_COMMAND/OP_COMMAND channel turn
- [ ] meta booth exchange — no META_FEEDBACK channel turn
- [x] pin held — 1 pin(s), source turn 8
- [ ] rewind (2 turns) — no rewind logged
- [ ] session close + reopen — 1 session(s); yokoku no; recap no
- [ ] compaction event — 0 compacted beat(s)
- [x] Director cycle — last_director_turn=6
- [x] Sakkan sample — last_sample_turn=9

## Totals + spend attribution

- Soak engine spend (all model calls, this campaign): **$1.8475**
- Attributed to turns 1..N: $1.8323
- Session/harness overhead (persona probes, pre-warm, startup, recap/yokoku/memo): $0.0152
- Measured within-turn cache-read fraction (mean): 0.43 vs the 0.7 assumption (§5.6)
- Turns per session (measured): 5

Projected per-session play cost at each §3 narration tier (measured per-turn narration usage re-priced; non-narration held at measured average — pure pricing math, no Fable call):

| narration tier | projected $/turn | projected $/session |
| --- | ---: | ---: |
| claude-sonnet-5 | $0.1539 | $0.7697 |
| claude-opus-4-8 | $0.2304 | $1.1518 |
| claude-fable-5 | $0.4214 | $2.1072 |

## Failures / flags

### Assertion failures (7)
- turn 4 (genga): cache-read frac 0.00 < 0.5 floor
- turn 5 (genga/claude-sonnet-5): narration $0.1504 > cold ceiling $0.1283
- turn 6 (sakuga/claude-sonnet-5): narration $0.1984 > cold ceiling $0.1965
- turn 6 (sakuga): cache-read frac 0.00 < 0.5 floor
- turn 7 (sakuga): cache-read frac 0.23 < 0.5 floor
- turn 8 (sakuga/claude-sonnet-5): narration $0.2418 > cold ceiling $0.1965
- turn 9 (sakuga/claude-sonnet-5): narration $0.3267 > cold ceiling $0.1965

### Event-mix misses (7)
- douga (trivial) turn — none classified douga
- WORLD_BUILDING faction mint (Red Sash) — no faction entity matched /red sash/
- override command — no OVERRIDE_COMMAND/OP_COMMAND channel turn
- meta booth exchange — no META_FEEDBACK channel turn
- rewind (2 turns) — no rewind logged
- session close + reopen — 1 session(s); yokoku no; recap no
- compaction event — 0 compacted beat(s)

### Waste-flags (22) — §5.5: surfaced for review, never hard-fails
- turn 1: cold turn — cache-read frac 0.65 (prefix creation expected)
- turn 1: TTFT 72332ms > target 8000ms
- turn 1: total 101373ms > target 35000ms
- turn 2: TTFT 17897ms > target 8000ms
- turn 2: total 41062ms > target 35000ms
- turn 3: TTFT 119724ms > target 15000ms
- turn 3: total 134469ms > target 60000ms
- turn 4: TTFT 20053ms > target 8000ms
- turn 4: total 42056ms > target 35000ms
- turn 5: TTFT 86591ms > target 8000ms
- turn 5: total 114008ms > target 35000ms
- turn 6: retried once after a retryable error
- turn 6: TTFT 174821ms > target 15000ms
- turn 6: total 180015ms > target 60000ms
- turn 7: TTFT 127418ms > target 15000ms
- turn 7: total 144177ms > target 60000ms
- turn 8: TTFT 161290ms > target 15000ms
- turn 8: total 183999ms > target 60000ms
- turn 9: retried once after a retryable error
- turn 9: total 180011ms > target 60000ms
- turn 10: retried once after a retryable error
- turn 10: total 38416ms > target 35000ms

## Beat plan (as scheduled)

```
M1 30-turn soak — scripted beat plan (DEV tiers: narration=claude-sonnet-5, judgment=claude-haiku-4-5, probe=claude-haiku-4-5)
target 30 turns · specials scripted, gaps persona-driven (one probe/turn) · rewind of 2 at turn 20

  turn  1  pilot cold-open (story) — I close out the shift, kill the dock floods, and walk toward the noodle stand where the bounty was last seen.
  turn  2  persona — probe-driven laconic bounty-hunter move
  turn  3  persona — probe-driven laconic bounty-hunter move
  turn  4  persona — probe-driven laconic bounty-hunter move
  turn  5  WORLD_BUILDING — mint a faction — "The Red Sash dockworkers' syndicate runs these piers." I say it flat, watching the fixer for a flinch, and start asking who answers to them.
  turn  6  persona — probe-driven laconic bounty-hunter move
  turn  7  persona — probe-driven laconic bounty-hunter move
  turn  8  COMBAT (sakuga-worthy) — I draw the Jericho and go loud — three of them between me and the gantry, close quarters, no cover, and I mean to walk out the far side.
          ↳ op: pin the combat passage (studio note)
  turn  9  persona — probe-driven laconic bounty-hunter move
  turn 10  persona — probe-driven laconic bounty-hunter move
  turn 11  persona — probe-driven laconic bounty-hunter move
  turn 12  trivial (douga) — I light a cigarette and watch the rain slide down the viewport.
  turn 13  OVERRIDE_COMMAND — /override From here on, keep the body count low — I want captures, not kills, unless there's no other way.
  turn 14  persona — probe-driven laconic bounty-hunter move
  turn 15  META_FEEDBACK (booth) — Hey — out of character for a second: can we lean harder into the noir mood? More smoke and silence, less banter.
          ↳ op: session close (yokoku + Sakkan) → reopen (recap)
  turn 16  persona — probe-driven laconic bounty-hunter move
  turn 17  persona — probe-driven laconic bounty-hunter move
  turn 18  persona — probe-driven laconic bounty-hunter move
  turn 19  persona — probe-driven laconic bounty-hunter move
  turn 20  persona — probe-driven laconic bounty-hunter move
          ↳ op: rewind 2 turns (20→18), then re-climb
  turn 21  persona — probe-driven laconic bounty-hunter move
  turn 22  persona — probe-driven laconic bounty-hunter move
  turn 23  persona — probe-driven laconic bounty-hunter move
  turn 24  persona — probe-driven laconic bounty-hunter move
  turn 25  persona — probe-driven laconic bounty-hunter move
  turn 26  persona — probe-driven laconic bounty-hunter move
  turn 27  persona — probe-driven laconic bounty-hunter move
  turn 28  persona — probe-driven laconic bounty-hunter move
  turn 29  persona — probe-driven laconic bounty-hunter move
  turn 30  persona — probe-driven laconic bounty-hunter move
```

## ABORTED

turn 10 ended error after retry — stopping with data intact
