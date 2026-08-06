# Soak Report — 50-turn run

Generated: 2026-08-05T22:26:38.651Z

Campaign id: `439ad090-2bc2-4c39-afda-103e2b952ddb` — **KEPT** for reference (pass --cleanup to delete).

Tier selection (DEV): narration=`claude-sonnet-5`, judgment=`claude-haiku-4-5`, probe=`claude-haiku-4-5`. Fable guard: **PASS** (no Fable in any tier).

## Per-turn table

| step | turn | tier | served model | attempts | narration $ | turn $ | cacheRead frac | TTFT ms | total ms | flags |
| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1 | genga | claude-sonnet-5 | $0.1185 | $0.1185 | $0.1297 | 0.83 | 102228 | 132547 | cold turn — turn-to-turn cache-read frac 0.83 (prefix creation expected); TTFT 102228ms > target 8000ms; total 132547ms > target 35000ms |
| 2 | 2 | douga | claude-sonnet-5 | $0.0916 | $0.0916 | $0.0978 | 0.72 | 36506 | 59836 | TTFT 36506ms > target 3000ms; total 59836ms > target 10000ms |
| 3 | 3 | douga | claude-sonnet-5 | $0.0522 | $0.0522 | $0.0942 | 0.80 | 24153 | 44582 | TTFT 24153ms > target 3000ms; total 44582ms > target 10000ms |
| 4 | 4 | douga | claude-sonnet-5 | $0.0939 | $0.0939 | $0.1049 | 0.76 | 36187 | 61726 | TTFT 36187ms > target 3000ms; total 61726ms > target 10000ms |
| 5 | 5 | genga | claude-sonnet-5 | $0.1008 | $0.1008 | $0.1184 | 0.68 | 55856 | 82177 | turn-to-turn cache-read frac 0.68 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 55856ms > target 8000ms; total 82177ms > target 35000ms |
| 6 | 6 | douga | claude-sonnet-5 | $0.0769 | $0.0769 | $0.1291 | 0.78 | 36345 | 60773 | TTFT 36345ms > target 3000ms; total 60773ms > target 10000ms |
| 7 | 7 | genga | claude-sonnet-5 | $0.1109 | $0.1109 | $0.1238 | 0.75 | 56496 | 83762 | TTFT 56496ms > target 8000ms; total 83762ms > target 35000ms |
| 8 | 8 | sakuga | claude-sonnet-5 | $0.2241 | $0.2241 | $0.2597 | 0.74 | 110198 | 145601 | FAIL:turn 8 (sakuga): WITHIN-turn research read frac 0.38 < 0.5 floor (§5.6 guaranteed read missed); TTFT 110198ms > target 15000ms; total 145601ms > target 60000ms |
| 9 | 9 | sakuga | claude-sonnet-5 | $0.0791 | $0.0791 | $0.1716 | 0.74 | 44336 | 77831 | TTFT 44336ms > target 15000ms; total 77831ms > target 60000ms |
| 10 | 10 | genga | claude-sonnet-5 | $0.0739 | $0.0739 | $0.0879 | 0.74 | 38514 | 64000 | TTFT 38514ms > target 8000ms; total 64000ms > target 35000ms |
| 11 | 11 | genga | claude-sonnet-5 | $0.0887 | $0.0887 | $0.1022 | 0.78 | 59198 | 83622 | TTFT 59198ms > target 8000ms; total 83622ms > target 35000ms |
| 12 | 12 | douga | claude-sonnet-5 | $0.1629 | $0.1629 | $0.2575 | 0.83 | 102831 | 132508 | TTFT 102831ms > target 3000ms; total 132508ms > target 10000ms |
| 13 | 13 | genga | (none) | $0.0000 | $0.0000 | $0.0022 | — | — | 4629 | — |
| 14 | 14 | sakuga | claude-sonnet-5 | $0.0865 | $0.0865 | $0.1238 | 0.75 | 59476 | 78151 | TTFT 59476ms > target 15000ms; total 78151ms > target 60000ms |
| 15 | 15 | genga | claude-sonnet-5 | $0.0218 | $0.0218 | $0.0240 | 0.94 | 8048 | 18949 | TTFT 8048ms > target 8000ms |
| 16 | 16 | douga | claude-sonnet-5 | $0.1468 | $0.1468 | $0.2359 | 0.86 | 30449 | 60378 | FAIL:turn 16 (douga): WITHIN-turn research read frac 0.49 < 0.5 floor (§5.6 guaranteed read missed); TTFT 30449ms > target 3000ms; total 60378ms > target 10000ms |
| 17 | 17 | douga | claude-sonnet-5 | $0.2514 | $0.2514 | $0.2647 | 0.81 | 141316 | 161506 | TTFT 141316ms > target 3000ms; total 161506ms > target 10000ms |
| 18 | 18 | genga | claude-sonnet-5 | $0.1100 | $0.1100 | $0.1421 | 0.79 | 49601 | 67354 | TTFT 49601ms > target 8000ms; total 67354ms > target 35000ms |
| 19 | 19 | douga | claude-sonnet-5 | $0.1081 | $0.1081 | $0.1795 | 0.84 | 34114 | 53635 | TTFT 34114ms > target 3000ms; total 53635ms > target 10000ms |
| 20 | 20 | douga | claude-sonnet-5 | $0.0711 | $0.0711 | $0.0832 | 0.83 | 34336 | 54547 | TTFT 34336ms > target 3000ms; total 54547ms > target 10000ms |
| 21 | 21 | sakuga | claude-sonnet-5 | $0.1267 | $0.1267 | $0.1603 | 0.79 | 85914 | 114345 | TTFT 85914ms > target 15000ms; total 114345ms > target 60000ms |
| 22 | 22 | sakuga | claude-sonnet-5 | $0.0938 | $0.0938 | $0.2039 | 0.78 | 68270 | 93381 | TTFT 68270ms > target 15000ms; total 93381ms > target 60000ms |
| 23 | 23 | genga | claude-sonnet-5 | $0.2104 | $0.2104 | $0.2400 | 0.79 | 84267 | 121985 | TTFT 84267ms > target 8000ms; total 121985ms > target 35000ms |
| 24 | 24 | genga | claude-sonnet-5 | $0.3431 | $0.3431 | $0.3558 | 0.21 | 89409 | 114581 | FAIL:turn 24 (genga/claude-sonnet-5): narration $0.3431 > cold ceiling $0.2880; FAIL:turn 24 (genga): WITHIN-turn research read frac 0.20 < 0.5 floor (§5.6 guaranteed read missed); cold turn — turn-to-turn cache-read frac 0.21 (prefix creation expected); TTFT 89409ms > target 8000ms; total 114581ms > target 35000ms |
| 25 | 25 | sakuga | claude-sonnet-5 | $0.1734 | $0.1734 | $0.2782 | 0.71 | 82597 | 103230 | TTFT 82597ms > target 15000ms; total 103230ms > target 60000ms |
| 26 | 26 | genga | claude-sonnet-5 | $0.1658 | $0.1658 | $0.1798 | 0.78 | 14746 | 35599 | FAIL:turn 26 (genga): WITHIN-turn research read frac 0.25 < 0.5 floor (§5.6 guaranteed read missed); cold turn — turn-to-turn cache-read frac 0.78 (prefix creation expected); TTFT 14746ms > target 8000ms; total 35599ms > target 35000ms |
| 27 | 27 | sakuga | claude-sonnet-5 | $0.1315 | $0.1315 | $0.1680 | 0.74 | 87390 | 113777 | TTFT 87390ms > target 15000ms; total 113777ms > target 60000ms |
| 28 | 28 | genga | claude-sonnet-5 | $0.1611 | $0.1611 | $0.2366 | 0.74 | 57877 | 85325 | TTFT 57877ms > target 8000ms; total 85325ms > target 35000ms |
| 29 | 29 | genga | claude-sonnet-5 | $0.0897 | $0.0897 | $0.1051 | 0.74 | 38442 | 63918 | TTFT 38442ms > target 8000ms; total 63918ms > target 35000ms |
| 30 | 30 | genga | claude-sonnet-5 | $0.1684 | $0.1684 | $0.1817 | 0.74 | 71194 | 93238 | TTFT 71194ms > target 8000ms; total 93238ms > target 35000ms |
| 31 | 31 | sakuga | claude-sonnet-5 | $0.1659 | $0.1659 | $0.2237 | 0.75 | 79308 | 112539 | TTFT 79308ms > target 15000ms; total 112539ms > target 60000ms |
| 32 | 32 | sakuga | claude-sonnet-5 | $0.1309 | $0.1309 | $0.1786 | 0.74 | 76871 | 108202 | TTFT 76871ms > target 15000ms; total 108202ms > target 60000ms |
| 33 | 33 | sakuga | claude-sonnet-5 | $0.2490 | $0.2490 | $0.2844 | 0.21 | 113622 | 125924 | cold turn — turn-to-turn cache-read frac 0.21 (prefix creation expected); TTFT 113622ms > target 15000ms; total 125924ms > target 60000ms |
| 34 | 32 | douga | claude-sonnet-5 | $0.0862 | $0.0862 | $0.1097 | 0.82 | 44751 | 67411 | TTFT 44751ms > target 3000ms; total 67411ms > target 10000ms |
| 35 | 33 | douga | claude-sonnet-5 | $0.1624 | $0.1624 | $0.1684 | 0.23 | 26519 | 44957 | cold turn — turn-to-turn cache-read frac 0.23 (prefix creation expected); TTFT 26519ms > target 3000ms; total 44957ms > target 10000ms |
| 36 | 34 | sakuga | claude-sonnet-5 | $0.1019 | $0.1019 | $0.1863 | 0.70 | 62536 | 84405 | turn-to-turn cache-read frac 0.70 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 62536ms > target 15000ms; total 84405ms > target 60000ms |
| 37 | 35 | genga | claude-sonnet-5 | $0.2773 | $0.2773 | $0.2935 | 0.70 | 68397 | 94471 | FAIL:turn 35 (genga): WITHIN-turn research read frac 0.21 < 0.5 floor (§5.6 guaranteed read missed); turn-to-turn cache-read frac 0.70 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 68397ms > target 8000ms; total 94471ms > target 35000ms |
| 38 | 36 | sakuga | claude-sonnet-5 | $0.1126 | $0.1126 | $0.1496 | 0.71 | 67698 | 89766 | TTFT 67698ms > target 15000ms; total 89766ms > target 60000ms |
| 39 | 37 | douga | claude-sonnet-5 | $0.0908 | $0.0908 | $0.1503 | 0.77 | 39766 | 59016 | TTFT 39766ms > target 3000ms; total 59016ms > target 10000ms |
| 40 | 38 | genga | claude-sonnet-5 | $0.0961 | $0.0961 | $0.1128 | 0.73 | 47976 | 71572 | TTFT 47976ms > target 8000ms; total 71572ms > target 35000ms |
| 41 | 39 | douga | claude-sonnet-5 | $0.0940 | $0.0940 | $0.1000 | 0.77 | 41437 | 59149 | TTFT 41437ms > target 3000ms; total 59149ms > target 10000ms |
| 42 | 40 | genga | claude-sonnet-5 | $0.1059 | $0.1059 | $0.1901 | 0.74 | 61131 | 83577 | TTFT 61131ms > target 8000ms; total 83577ms > target 35000ms |
| 43 | 41 | genga | claude-sonnet-5 | $0.0646 | $0.0646 | $0.0912 | 0.75 | 17488 | 41026 | TTFT 17488ms > target 8000ms; total 41026ms > target 35000ms |
| 44 | 42 | sakuga | claude-sonnet-5 | $0.1665 | $0.1665 | $0.2002 | 0.21 | 43762 | 62227 | cold turn — turn-to-turn cache-read frac 0.21 (prefix creation expected); TTFT 43762ms > target 15000ms; total 62227ms > target 60000ms |
| 45 | 43 | genga | claude-sonnet-5 | $0.0933 | $0.0933 | $0.1650 | 0.68 | 40908 | 66039 | turn-to-turn cache-read frac 0.68 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 40908ms > target 8000ms; total 66039ms > target 35000ms |
| 46 | 44 | douga | claude-sonnet-5 | $0.1464 | $0.1464 | $0.1575 | 0.71 | 77354 | 102590 | TTFT 77354ms > target 3000ms; total 102590ms > target 10000ms |
| 47 | 45 | genga | claude-sonnet-5 | $0.2562 | $0.2562 | $0.2699 | 0.64 | 41014 | 66351 | FAIL:turn 45 (genga): WITHIN-turn research read frac 0.22 < 0.5 floor (§5.6 guaranteed read missed); turn-to-turn cache-read frac 0.64 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 41014ms > target 8000ms; total 66351ms > target 35000ms |
| 48 | 46 | genga | claude-sonnet-5 | $0.1137 | $0.1137 | $0.2337 | 0.69 | 52736 | 77384 | turn-to-turn cache-read frac 0.69 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 52736ms > target 8000ms; total 77384ms > target 35000ms |
| 49 | 47 | genga | claude-sonnet-5 | $0.1214 | $0.1214 | $0.1361 | 0.69 | 54256 | 81671 | turn-to-turn cache-read frac 0.69 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 54256ms > target 8000ms; total 81671ms > target 35000ms |
| 50 | 48 | genga | claude-sonnet-5 | $0.2454 | $0.2454 | $0.2605 | 0.69 | 55205 | 81360 | turn-to-turn cache-read frac 0.69 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 55205ms > target 8000ms; total 81360ms > target 35000ms |
| 51 | 49 | sakuga | claude-sonnet-5 | $0.1148 | $0.1148 | $0.1964 | 0.70 | 59762 | 83187 | turn-to-turn cache-read frac 0.70 under the 0.7 assumption (pnpm cache:gauge is the running measure); TTFT 59762ms > target 15000ms; total 83187ms > target 60000ms |
| 52 | 50 | genga | claude-sonnet-5 | $0.2022 | $0.2022 | $0.2330 | 0.72 | 94125 | 120461 | TTFT 94125ms > target 8000ms; total 120461ms > target 35000ms |

## Assertion coverage (§10.8)

- turns 1..50: 50 metered, 0 unmetered
- metering coverage CERTIFIED — every played turn carries an assertion

## Session-lifecycle coverage (§9.4)

- 2 sitting(s); 1 closed (#1:explicit); open now: #2
- every completed turn played inside a sitting — session-lifecycle coverage CERTIFIED

## Event-mix checklist

- [x] douga (trivial) turn — turn 2
- [x] genga (story) turn — turn 1
- [x] sakuga combat turn — turn 8
- [x] WORLD_BUILDING faction mint (Red Sash) — Red Sash
- [x] override command — turn 13
- [x] meta booth exchange — turn 15
- [x] pin held — 1 pin(s), source turn 8
- [x] rewind (2 turns) — to turn 31, 37 writes tombstoned
- [ ] session close + reopen — 2 session(s); yokoku yes; recap no
- [x] compaction event — 17 compacted beat(s), 0 epoch merge(s)
- [x] Director cycle — last_director_turn=49
- [x] Sakkan sample — last_sample_turn=49

## Totals + spend attribution

- Pre-run estimate (the number the run was authorized against): $11.6798 floor · $12.7468 expected · $20.5718 all-cold ceiling
- Soak engine spend (all model calls, this campaign): **$9.2466**
- Attributed to turns 1..N: $8.9799
- Session/harness overhead (persona probes, pre-warm, startup, recap/yokoku/memo): $0.2667
- Measured within-turn cache-read fraction (mean): 0.71 vs the 0.7 assumption (§5.6)
- Turns per session (measured): 25

Projected per-session play cost at each §3 narration tier (measured per-turn narration usage re-priced; non-narration held at measured average — pure pricing math, no Fable call):

| narration tier | projected $/turn | projected $/session |
| --- | ---: | ---: |
| claude-sonnet-5 | $0.1390 | $3.4752 |
| claude-opus-5 | $0.2050 | $5.1261 |
| claude-fable-5 | $0.3701 | $9.2535 |

## Failures / flags

### Assertion failures (7)
- turn 8 (sakuga): WITHIN-turn research read frac 0.38 < 0.5 floor (§5.6 guaranteed read missed)
- turn 16 (douga): WITHIN-turn research read frac 0.49 < 0.5 floor (§5.6 guaranteed read missed)
- turn 24 (genga/claude-sonnet-5): narration $0.3431 > cold ceiling $0.2880
- turn 24 (genga): WITHIN-turn research read frac 0.20 < 0.5 floor (§5.6 guaranteed read missed)
- turn 26 (genga): WITHIN-turn research read frac 0.25 < 0.5 floor (§5.6 guaranteed read missed)
- turn 35 (genga): WITHIN-turn research read frac 0.21 < 0.5 floor (§5.6 guaranteed read missed)
- turn 45 (genga): WITHIN-turn research read frac 0.22 < 0.5 floor (§5.6 guaranteed read missed)

### Event-mix misses (1)
- session close + reopen — 2 session(s); yokoku yes; recap no

### Waste-flags (116) — §5.5: surfaced for review, never hard-fails
- turn 1: cold turn — turn-to-turn cache-read frac 0.83 (prefix creation expected)
- turn 1: TTFT 102228ms > target 8000ms
- turn 1: total 132547ms > target 35000ms
- turn 2: TTFT 36506ms > target 3000ms
- turn 2: total 59836ms > target 10000ms
- turn 3: TTFT 24153ms > target 3000ms
- turn 3: total 44582ms > target 10000ms
- turn 4: TTFT 36187ms > target 3000ms
- turn 4: total 61726ms > target 10000ms
- turn 5: turn-to-turn cache-read frac 0.68 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 5: TTFT 55856ms > target 8000ms
- turn 5: total 82177ms > target 35000ms
- turn 6: TTFT 36345ms > target 3000ms
- turn 6: total 60773ms > target 10000ms
- turn 7: TTFT 56496ms > target 8000ms
- turn 7: total 83762ms > target 35000ms
- turn 8: TTFT 110198ms > target 15000ms
- turn 8: total 145601ms > target 60000ms
- turn 9: TTFT 44336ms > target 15000ms
- turn 9: total 77831ms > target 60000ms
- turn 10: TTFT 38514ms > target 8000ms
- turn 10: total 64000ms > target 35000ms
- turn 11: TTFT 59198ms > target 8000ms
- turn 11: total 83622ms > target 35000ms
- turn 12: TTFT 102831ms > target 3000ms
- turn 12: total 132508ms > target 10000ms
- turn 14: TTFT 59476ms > target 15000ms
- turn 14: total 78151ms > target 60000ms
- turn 15: TTFT 8048ms > target 8000ms
- turn 16: TTFT 30449ms > target 3000ms
- turn 16: total 60378ms > target 10000ms
- turn 17: TTFT 141316ms > target 3000ms
- turn 17: total 161506ms > target 10000ms
- turn 18: TTFT 49601ms > target 8000ms
- turn 18: total 67354ms > target 35000ms
- turn 19: TTFT 34114ms > target 3000ms
- turn 19: total 53635ms > target 10000ms
- turn 20: TTFT 34336ms > target 3000ms
- turn 20: total 54547ms > target 10000ms
- turn 21: TTFT 85914ms > target 15000ms
- turn 21: total 114345ms > target 60000ms
- turn 22: TTFT 68270ms > target 15000ms
- turn 22: total 93381ms > target 60000ms
- turn 23: TTFT 84267ms > target 8000ms
- turn 23: total 121985ms > target 35000ms
- turn 24: cold turn — turn-to-turn cache-read frac 0.21 (prefix creation expected)
- turn 24: TTFT 89409ms > target 8000ms
- turn 24: total 114581ms > target 35000ms
- turn 25: TTFT 82597ms > target 15000ms
- turn 25: total 103230ms > target 60000ms
- turn 26: cold turn — turn-to-turn cache-read frac 0.78 (prefix creation expected)
- turn 26: TTFT 14746ms > target 8000ms
- turn 26: total 35599ms > target 35000ms
- turn 27: TTFT 87390ms > target 15000ms
- turn 27: total 113777ms > target 60000ms
- turn 28: TTFT 57877ms > target 8000ms
- turn 28: total 85325ms > target 35000ms
- turn 29: TTFT 38442ms > target 8000ms
- turn 29: total 63918ms > target 35000ms
- turn 30: TTFT 71194ms > target 8000ms
- turn 30: total 93238ms > target 35000ms
- turn 31: TTFT 79308ms > target 15000ms
- turn 31: total 112539ms > target 60000ms
- turn 32: TTFT 76871ms > target 15000ms
- turn 32: total 108202ms > target 60000ms
- turn 33: cold turn — turn-to-turn cache-read frac 0.21 (prefix creation expected)
- turn 33: TTFT 113622ms > target 15000ms
- turn 33: total 125924ms > target 60000ms
- turn 32: TTFT 44751ms > target 3000ms
- turn 32: total 67411ms > target 10000ms
- turn 33: cold turn — turn-to-turn cache-read frac 0.23 (prefix creation expected)
- turn 33: TTFT 26519ms > target 3000ms
- turn 33: total 44957ms > target 10000ms
- turn 34: turn-to-turn cache-read frac 0.70 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 34: TTFT 62536ms > target 15000ms
- turn 34: total 84405ms > target 60000ms
- turn 35: turn-to-turn cache-read frac 0.70 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 35: TTFT 68397ms > target 8000ms
- turn 35: total 94471ms > target 35000ms
- turn 36: TTFT 67698ms > target 15000ms
- turn 36: total 89766ms > target 60000ms
- turn 37: TTFT 39766ms > target 3000ms
- turn 37: total 59016ms > target 10000ms
- turn 38: TTFT 47976ms > target 8000ms
- turn 38: total 71572ms > target 35000ms
- turn 39: TTFT 41437ms > target 3000ms
- turn 39: total 59149ms > target 10000ms
- turn 40: TTFT 61131ms > target 8000ms
- turn 40: total 83577ms > target 35000ms
- turn 41: TTFT 17488ms > target 8000ms
- turn 41: total 41026ms > target 35000ms
- turn 42: cold turn — turn-to-turn cache-read frac 0.21 (prefix creation expected)
- turn 42: TTFT 43762ms > target 15000ms
- turn 42: total 62227ms > target 60000ms
- turn 43: turn-to-turn cache-read frac 0.68 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 43: TTFT 40908ms > target 8000ms
- turn 43: total 66039ms > target 35000ms
- turn 44: TTFT 77354ms > target 3000ms
- turn 44: total 102590ms > target 10000ms
- turn 45: turn-to-turn cache-read frac 0.64 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 45: TTFT 41014ms > target 8000ms
- turn 45: total 66351ms > target 35000ms
- turn 46: turn-to-turn cache-read frac 0.69 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 46: TTFT 52736ms > target 8000ms
- turn 46: total 77384ms > target 35000ms
- turn 47: turn-to-turn cache-read frac 0.69 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 47: TTFT 54256ms > target 8000ms
- turn 47: total 81671ms > target 35000ms
- turn 48: turn-to-turn cache-read frac 0.69 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 48: TTFT 55205ms > target 8000ms
- turn 48: total 81360ms > target 35000ms
- turn 49: turn-to-turn cache-read frac 0.70 under the 0.7 assumption (pnpm cache:gauge is the running measure)
- turn 49: TTFT 59762ms > target 15000ms
- turn 49: total 83187ms > target 60000ms
- turn 50: TTFT 94125ms > target 8000ms
- turn 50: total 120461ms > target 35000ms

## Beat plan (as scheduled)

```
soak — 50-turn scripted beat plan (DEV tiers: narration=claude-sonnet-5, judgment=claude-haiku-4-5, probe=claude-haiku-4-5)
target 50 turns · specials scripted at their own turns, gaps persona-driven (one probe/turn) · pin after 8 · session close/reopen after 25 · rewind of 2 after 33

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
  turn 16  persona — probe-driven laconic bounty-hunter move
  turn 17  persona — probe-driven laconic bounty-hunter move
  turn 18  persona — probe-driven laconic bounty-hunter move
  turn 19  persona — probe-driven laconic bounty-hunter move
  turn 20  persona — probe-driven laconic bounty-hunter move
  turn 21  persona — probe-driven laconic bounty-hunter move
  turn 22  persona — probe-driven laconic bounty-hunter move
  turn 23  persona — probe-driven laconic bounty-hunter move
  turn 24  persona — probe-driven laconic bounty-hunter move
  turn 25  persona — probe-driven laconic bounty-hunter move
          ↳ op: session close (yokoku + Sakkan) → reopen (recap)
  turn 26  persona — probe-driven laconic bounty-hunter move
  turn 27  persona — probe-driven laconic bounty-hunter move
  turn 28  persona — probe-driven laconic bounty-hunter move
  turn 29  persona — probe-driven laconic bounty-hunter move
  turn 30  persona — probe-driven laconic bounty-hunter move
  turn 31  persona — probe-driven laconic bounty-hunter move
  turn 32  persona — probe-driven laconic bounty-hunter move
  turn 33  persona — probe-driven laconic bounty-hunter move
          ↳ op: rewind 2 turns (33→31), then re-climb — inside the 2-of-10 retake horizon (§6.7)
  turn 34  persona — probe-driven laconic bounty-hunter move
  turn 35  persona — probe-driven laconic bounty-hunter move
  turn 36  persona — probe-driven laconic bounty-hunter move
  turn 37  persona — probe-driven laconic bounty-hunter move
  turn 38  persona — probe-driven laconic bounty-hunter move
  turn 39  persona — probe-driven laconic bounty-hunter move
  turn 40  persona — probe-driven laconic bounty-hunter move
  turn 41  persona — probe-driven laconic bounty-hunter move
  turn 42  persona — probe-driven laconic bounty-hunter move
  turn 43  persona — probe-driven laconic bounty-hunter move
  turn 44  persona — probe-driven laconic bounty-hunter move
  turn 45  persona — probe-driven laconic bounty-hunter move
  turn 46  persona — probe-driven laconic bounty-hunter move
  turn 47  persona — probe-driven laconic bounty-hunter move
  turn 48  persona — probe-driven laconic bounty-hunter move
  turn 49  persona — probe-driven laconic bounty-hunter move
  turn 50  persona — probe-driven laconic bounty-hunter move
```

## Resume 2026-08-05 — +2 story turn(s)

Appended by `pnpm soak -- --campaign=439ad090-2bc2-4c39-afda-103e2b952ddb --turns=50` at 2026-08-05T23:37:19.883Z. The report above is the original run's and is untouched.

- Before: **48** completed story turn(s), highest turn number 50. Short of the 50-story-turn target by 2.
- Played: 2 submission(s) over turn(s) 51..52 — 2 story, 0 channel.
- Sitting: sitting #3 opened for the resumed turns
- Incremental spend (every model call this invocation made): **$0.7630**
- Completed STORY turns in the campaign: **50** vs the §10.3 gate floor of 50 (flywheel-prospective `MIN_SOAK_TURNS`) — **MET**. This invocation submitted 2 step(s), of which 0 channel turn(s) consumed a turn number without writing a scene.

### Per-turn table (resumed turns only)

| step | turn | tier | served model | attempts | narration $ | turn $ | cacheRead frac | TTFT ms | total ms | flags |
| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 51 | genga | claude-sonnet-5 | $0.2020 | $0.2020 | $0.2254 | 0.68 | 81555 | 109916 | cold turn — turn-to-turn cache-read frac 0.68 (prefix creation expected); TTFT 81555ms > target 8000ms; total 109916ms > target 35000ms |
| 2 | 52 | genga | claude-sonnet-5 | $0.1181 | $0.1181 | $0.1320 | 0.66 | 54806 | 77460 | cold turn — turn-to-turn cache-read frac 0.66 (prefix creation expected); TTFT 54806ms > target 8000ms; total 77460ms > target 35000ms |

### Assertion coverage (§10.8, resumed turns)

- turns 51..52: 2 metered, 0 unmetered
- metering coverage CERTIFIED — every played turn carries an assertion

### Session-lifecycle coverage (§9.4, campaign-wide)

- 3 sitting(s); 2 closed (#1:explicit, #2:idle_timeout); open now: #3
- every completed turn played inside a sitting — session-lifecycle coverage CERTIFIED

### Event-mix checklist (tier rows: the resumed turns only; the rest campaign-wide)

- [ ] douga (trivial) turn — none classified douga
- [x] genga (story) turn — turn 51
- [ ] sakuga combat turn — none classified sakuga
- [x] WORLD_BUILDING faction mint (Red Sash) — Red Sash
- [x] override command — turn 13
- [x] meta booth exchange — turn 15
- [x] pin held — 1 pin(s), source turn 8
- [x] rewind (2 turns) — to turn 31
- [ ] session close + reopen — 3 session(s); yokoku no; recap no
- [x] compaction event — 17 compacted beat(s), 0 epoch merge(s)
- [x] Director cycle — last_director_turn=50
- [x] Sakkan sample — last_sample_turn=50

### Assertion failures (0)
- none — every metered assertion held.

### Waste-flags (6) — §5.5: surfaced for review, never hard-fails
- turn 51: cold turn — turn-to-turn cache-read frac 0.68 (prefix creation expected)
- turn 51: TTFT 81555ms > target 8000ms
- turn 51: total 109916ms > target 35000ms
- turn 52: cold turn — turn-to-turn cache-read frac 0.66 (prefix creation expected)
- turn 52: TTFT 54806ms > target 8000ms
- turn 52: total 77460ms > target 35000ms

### Beat plan (the resumed window)

```
soak — 2-STORY-turn scripted beat plan (DEV tiers: narration=claude-sonnet-5, judgment=claude-haiku-4-5, probe=claude-haiku-4-5)
target 2 story turn(s) + 0 scheduled channel step(s) = 2 submission(s), turns 51..52 · specials scripted at their own turns, gaps persona-driven (one probe/turn) · pin after 8 · session close/reopen after 25 · rewind of 2 after 33
NOTE: specials at turn(s) 1, 5, 8, 12, 13, 15 do not fire in this window — the event mix will be short by design

  turn 51  persona — probe-driven laconic bounty-hunter move
  turn 52  persona — probe-driven laconic bounty-hunter move
```
