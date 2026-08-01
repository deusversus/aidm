# M3 — the horizon: depth that survives its own length

**Status:** planned 2026-08-01; shape user-approved same day ("4) as you suggest" —
hardening first, then depth)
**Spec anchors:** §12 (M3 — Horizon depth, P1+P4), §7.6 (seed ledger), §6.2 (epoch
merges / Block 2 ceiling), §7.1 (evolution ratification), §10.3 (the long soak),
§5.7 (the commit_scene trailer), §10.8 (budget assertions)
**Evidence:** the 2026-08-01 playtest audit (4-reader workflow over the tape, the
instruments, the economics, the roadmap) — findings cited per commit below.

## Where M3 starts from

M3 is the least pre-paid milestone. The R-series bought it exactly two things:
M2.75 delivered the whole display-grammar plan (minus the stinger follow-on and
four RESERVED presentation fields), and M2R3 partially pre-paid arc attribution.
Everything else on §12's M3 line — organic seed detection, convergence, epoch
merges, season-boundary ratification, judged payoffs, the prospective flywheel,
the 100-turn soaks — has no implementation. And the audit found substrate debts
that 100-turn runs would amplify 4×. Hence the approved shape: **the substrate
pays its debts before the horizon work begins.**

Standing context: narration effort is now FLAT `high` (§3 amendment, user-ruled
2026-08-01) — every turn shares one cache key, so the soak economics below assume
warm turn-opens as the norm, not the exception.

## Commits

### C1 — the substrate pays its debts (the audit harvest)

*Named failure modes, all measured in production 2026-08-01:*

1. **The trailer never lands natively.** §5.7's mandatory `commit_scene` trailer
   has a 0% native success rate — 15/15 turns fell back to probe reconstruction,
   3 produced no sidecar at all, and one reconstruction corrupted the entity
   catalog (Shikō recorded as the dead sister). Diagnose WHY the KA never calls
   the tool at scene end (contract wording? tool_choice? the streaming path?);
   fix; the probe fallback stays as the net it was designed to be, and gains the
   guard the corruption exposed (a cast-delta note that contradicts the prose's
   own text should not be cataloged silently).
2. **Spend attribution.** 47% of real spend (session opens, recaps, prewarms,
   Director cycles) is invisible to per-turn telemetry — the cost model
   understates play by ~2×. Attribute session-scoped calls to a session row;
   cache-gauge and the budget assertions read the whole ledger.
3. **Seed lifecycle repairs** (the mechanical half; the depth half is C2): the
   Director's push-out duplicates rows instead of updating windows, so overdue
   seeds never leave the ledger; plants accrete faster than payoffs.
4. **The recap/yokoku cold write:** session-open composers pass no tools, so
   their prefix can never share the KA's cache entry — every session open pays
   two full cold Opus writes. One constant array, same as the tool law.
5. Small debts, same commit: the charter's 2× §4.4a budget overrun surfaces
   instead of silently discarding the record; the director memo's 5/21 loss gets
   a diagnosis; M2.75's leftover stinger + RESERVED presentation fields close out.

### C2 — the seed ledger grows judgment (§7.6)

Organic seed detection (seeds the prose planted without the Director asking),
judged payoff resolution (`expected_payoff` finally read by a judge instead of
string-luck), and convergence detection. The audit's evidence: 12 live China Shop
seeds, zero paid, resolution today depends on the Director naming a description
that string-matches. Blueprint §7.6 owns the full mechanism list; the plan-of-record
for this commit is written against it at build time, not paraphrased here.

### C3 — epochs: Block 2 earns its ceiling (§6.2)

The ceiling is documented as enforced and is not — Block 2 grows unbounded with a
console.warn where the epoch merge should be (audit HIGH; a real hazard at
100-turn scale). Build the epoch merge; enforce the ceiling; the §5.6 cache
discipline extends to the merge event (a sanctioned wholesale rewrite, like
compaction).

### C4 — evolution ratification, reconciled (§7.1)

§7.1's mechanism (player-ratified, season-boundaries-only, amends premise AND
bible) and M2R3's shipped mechanism (any cycle, dismissible notice, silence is
consent, bible untouched) are different mechanisms wearing the same name (audit
HIGH). Reconcile: M2R3's notice remains the in-season channel; §7.1's ratification
becomes the season-boundary event it was specified to be. Surfaces to the player
at a real table before it lands — this is player-authority machinery.

### C5 — the prospective flywheel + the long soak (§10.3, the M3 gate)

The prospective flywheel eval, then the 100-turn soaks the milestone gates on —
run on the C1-hardened substrate, DEV tiers only, flat-high warm-cache economics.
The M2 harness's four recorded metering holes get fixed in the harness BEFORE the
first long run. Budget: estimated **$10–20 per 100-turn Sonnet soak** (warm opens,
judgment-dominant); stated per-run, user-approved before each run, never assumed.

## Decisions deliberately NOT scheduled here

- **§13.5 playtester bridge** (allowlist + spend caps, M3–M4 per the blueprint):
  needs its own plan and the user's business call; flagged, not started.
- **xhigh's return**: only via the blind A/B recorded in §3's amendment.
- **The China Shop repairs**: user ruled 2026-08-01 — the campaign is depreciated
  to structural lessons; nothing gets touched; extraction quality is a watch item
  (C1's trailer fix is the systemic answer).

## Verification

- Per commit: the standing cadence (Opus audit → fixes → full bare gate → CI on
  own SHA → Railway confirmed). Player-visible surfaces (C4's ratification, any
  C1 recap changes) get the C10 browser pass on fixtures, never live campaigns.
- `pnpm cache:gauge` before/after every commit that touches a model-call shape.
- C5's soaks are the milestone gate; each run priced and approved beforehand.
