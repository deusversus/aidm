# WorldBuilder reshape — editor-not-gatekeeper closure

**Drafted 2026-04-22.** Closes the delta between what Phase 6B+6C shipped and the user's 2026-04-20 design conversation (quoted in `memory/project_worldbuilder_as_editor.md`). Scope is substantial but coherent — the reshape is a single structural shift, not a scatter of prompt tweaks.

---

## Why

Phase 6B+6C already dropped REJECT, made ACCEPT the default at the prompt level, and tightened CLARIFY to physical-only. But the **routing behavior** still matches v3's gatekeeper frame:

- IntentClassifier still returns `WORLD_BUILDING` for most narrative-blended assertions, routing every one to WorldBuilder.
- WB's ACCEPT path **short-circuits the turn** — WB's `response` prose is what the player sees; KA doesn't run. Even on ACCEPT, the player gets meta-voice DM commentary instead of continued narration.
- FLAG is a generic `{ concern, severity }` — the user's own design pushed for three specific categories (voice_fit, stakes_implication, internal_consistency) so sidebar UI can speak specifically.

Result today: the player asserts a world-fact, WB says "Noted — here's your amulet in ornate DM voice," and the scene halts. That's the gatekeeper-with-a-smile, not an editor. This commit closes that.

---

## Scope

**Lands in this commit:**

1. **IntentClassifier bias toward DEFAULT for narrative-blended assertions.** Prompt-level reshape: `WORLD_BUILDING` is reserved for *standalone worldbuilding declarations* ("Let's establish that the Gate Association has a black-ops wing," non-narrative framing). Most assertions embedded in action/dialogue/description route as `DEFAULT` and flow straight to KA. This is guidance, not a schema change — the enum keeps WORLD_BUILDING for the genuine case.

2. **Router: ACCEPT + FLAG no longer short-circuit.** WB still dispatches on WORLD_BUILDING. On CLARIFY the turn short-circuits with the clarifying question (same as now). On ACCEPT or FLAG the turn continues to KA:
   - `entityUpdates` persist synchronously (register_npc / register_location / etc.) BEFORE KA runs, so KA's tool calls see the new entities.
   - The assertion is injected into Block 4 as `player_assertion` (new fragment slot) so KA narrates with the fact as established canon.
   - Any `flags` flow through to the `done` event for the sidebar UI.

3. **Three FLAG types.** Replace the generic `{ concern, severity }` with a discriminated union:
   - `voice_fit` — tonal or register misalignment. Fields: `evidence` (the clashing element), `suggestion` (how the author could soften without losing the beat).
   - `stakes_implication` — move that dissolves or compresses current arc tension. Fields: `evidence`, `what_dissolves` (the tension being collapsed).
   - `internal_consistency` — contradicts the player's own prior canon (not source canon). Fields: `evidence`, `contradicts` (the specific prior turn/fact).

4. **`done` event carries flags.** `TurnWorkflowEvent` union's `done` case gets `flags: WorldBuilderFlag[]` (empty array when no flags). Persisted on `turns.flags` jsonb column (added via migration 0010).

5. **`<FlagSidebar />` component.** Renders flags from the done event with category-specific iconography + copy. Dismissable per-turn. Renders adjacent to the turn bubble in `play-ui.tsx`.

6. **Block 4 fragment update.** New fragment `fragments/player_assertion.md` or inline block_4 section renders "The player just established: <assertion>" when WB ACCEPT/FLAG fired. Points KA at treating the assertion as canon.

7. **Schema migration 0010.** Adds `turns.flags jsonb NOT NULL DEFAULT '[]'`. Backward-compat — existing rows get empty array.

8. **Prompts updated**:
   - `agents/intent-classifier.md` — WORLD_BUILDING section narrows to standalone declarations only.
   - `agents/world-builder.md` — three-flag schema, flag-type decision criteria, CLARIFY unchanged.

9. **Tests**:
   - Router: WB ACCEPT no longer short-circuits (continues to runKa).
   - Router: WB CLARIFY still short-circuits with the clarifying question.
   - Router: WB FLAG flows to KA + emits flags on done.
   - WB: each flag type parses; malformed falls back.
   - Turn workflow: flags persist on turns.flags.
   - IntentClassifier prompt test exercises the narrative-blended bias.

**Explicitly NOT landing here:**

- **IntentClassifier full tagger schema** (granular `tags` array). Kept as forward-looking opportunity; the narrative-blended bias via prompt is sufficient to achieve the intended routing behavior without a schema rewrite. If future tuning shows the prompt-level bias is too weak, we revisit with a typed `tags: string[]` addition.
- **FlagSidebar dismissal persistence** — per-turn dismissals are ephemeral in UI state at M1; cross-session dismissal is M2+.
- **Director consumption of flags** — Director currently doesn't read `turns.flags`. Wiring it to do so is M4+ when the arc-transition agent matures.
- **Deprecating the existing generic `concern/severity` fields in v3-era code** — only `world-builder.ts` produces flags; no migration of old data needed. v3 reference branch unchanged.

---

## File-level breakdown

### New files

- `src/components/flag-sidebar.tsx` — flag rendering (3 icons, 3 copy blocks).
- `src/lib/prompts/fragments/player_assertion.md` — Block 4 slot for WB-accepted assertions.
- `drizzle/0010_<name>.sql` — migration (`turns.flags` column).
- Test files:
  - `src/lib/agents/__tests__/world-builder-flags.test.ts` — three-flag schema + discriminated union parse.
  - (extend existing `turn-router.test.ts` + `router.test.ts` rather than new files).

### Modified files

- `src/lib/agents/world-builder.ts` — replace `WorldBuilderFlag` with discriminated union (voice_fit | stakes_implication | internal_consistency). Update fallback.
- `src/lib/prompts/agents/world-builder.md` — three-flag criteria + examples; CLARIFY unchanged.
- `src/lib/prompts/agents/intent-classifier.md` — narrow WORLD_BUILDING to standalone declarations; bias blended moves to DEFAULT.
- `src/lib/agents/router.ts` — router verdict shape update: on WB ACCEPT/FLAG, return `kind: "continue"` with a new `wbAssertion: { assertion, entityUpdates, flags }` field so the turn workflow can thread them into KA without short-circuiting. CLARIFY still returns `kind: "worldbuilder"`.
- `src/lib/workflow/turn.ts` — on new `wbAssertion` continue verdict: persist entityUpdates, inject assertion into Block 4, pass flags through to the done event. Persist `flags` on turns row.
- `src/lib/prompts/ka/block_4_dynamic.md` — `{{player_assertion}}` slot for the injected fact.
- `src/lib/state/schema.ts` — `turns.flags` jsonb column.
- `src/lib/types/turn.ts` — no changes needed for IntentOutput; the `flags` type lives in world-builder.ts.
- `src/app/(app)/campaigns/[id]/play/play-ui.tsx` — render `<FlagSidebar />` when the latest turn has flags; wire dismissal.
- `src/hooks/use-turn-stream.ts` — thread `flags` field through to the exposed `lastTurn`.

### Test files to extend

- `src/lib/agents/__tests__/router.test.ts` — new cases for ACCEPT/FLAG not short-circuiting + CLARIFY still short-circuiting.
- `src/lib/workflow/__tests__/turn-router.test.ts` — WB ACCEPT persistence path updates (KA runs after entity persistence).
- `src/lib/workflow/__tests__/turn-budget.test.ts` — no changes (flags don't affect cost aggregation).

---

## Router verdict reshape (key structural point)

Current (Phase 6B/C):

```ts
RouterVerdict =
  | { kind: "continue"; intent: IntentOutput }
  | { kind: "meta"; ... }
  | { kind: "override"; ... }
  | { kind: "worldbuilder"; intent; verdict: WorldBuilderOutput }  // ALL WB decisions
```

After this commit:

```ts
RouterVerdict =
  | { kind: "continue"; intent; wbAssertion?: WbAssertionPayload }  // includes ACCEPT/FLAG
  | { kind: "meta"; ... }
  | { kind: "override"; ... }
  | { kind: "worldbuilder"; intent; verdict: WorldBuilderOutput }   // CLARIFY only

interface WbAssertionPayload {
  assertion: string;
  entityUpdates: EntityUpdate[];
  flags: WorldBuilderFlag[];  // discriminated union (three types)
}
```

Turn workflow branches on `kind`:
- `continue` with `wbAssertion`: persist entityUpdates, inject assertion into Block 4, run KA, emit flags on done.
- `worldbuilder`: short-circuit with WB's CLARIFY question (unchanged).
- `continue` without `wbAssertion`: normal KA path (unchanged).

---

## Three-flag schema

```ts
export const VoiceFitFlag = z.object({
  kind: z.literal("voice_fit"),
  evidence: z.string(),       // the clashing element ("galactic empire" in a Bebop scene)
  suggestion: z.string(),     // how the author could soften without losing the beat
});

export const StakesImplicationFlag = z.object({
  kind: z.literal("stakes_implication"),
  evidence: z.string(),       // the move ("Spike reveals he's immortal")
  what_dissolves: z.string(), // the tension collapsed ("the next three arc beats around mortality")
});

export const InternalConsistencyFlag = z.object({
  kind: z.literal("internal_consistency"),
  evidence: z.string(),       // the move ("gates are ancient")
  contradicts: z.string(),    // the prior fact ("turn 1 said gates opened 10 years ago")
});

export const WorldBuilderFlag = z.discriminatedUnion("kind", [
  VoiceFitFlag,
  StakesImplicationFlag,
  InternalConsistencyFlag,
]);
```

UI: each kind has a distinct icon + label:
- `voice_fit` — "tonal note" (soft icon)
- `stakes_implication` — "narrative cost" (warning icon)
- `internal_consistency` — "prior canon" (rewind icon)

---

## Audit focus

- **Authorship frame honored end-to-end.** No "Noted, here's your amulet" meta-voice reappears. WB's response is ONLY surfaced on CLARIFY; ACCEPT/FLAG pass the assertion to KA, which narrates.
- **Router verdict shape.** `continue` with `wbAssertion` correctly persists entities BEFORE KA runs (so KA's tool calls see new NPCs/locations).
- **CLARIFY prose remains scene-preserving.** No GM-voice regressions.
- **Three flag types parse** — Zod discriminated union rejects malformed entries.
- **Flag rendering** — three distinct icons/copies; not a homogeneous "flag" badge.
- **IntentClassifier prompt change actually shifts routing.** Test a blended-mode assertion ("I pull out the amulet I mentioned earlier") and expect DEFAULT, not WORLD_BUILDING.
- **Migration 0010 reversible.** Drop the column cleanly.
- **Schema `turns.flags` defaults to `'[]'`** — existing rows back-compatible.
- **Block 4 fragment renders only when wbAssertion present.** No empty-state noise.
- **Tests cover the non-short-circuit path.**

---

## Risks

1. **IntentClassifier prompt bias may be too soft.** If the model keeps returning WORLD_BUILDING for blended moves, the reshape doesn't fire. Mitigation: test against 3–5 representative player messages before push; tighten prompt if misclassified. If still too soft, escalate to schema-level tags (deferred scope).
2. **Entity persistence timing.** Currently entityUpdates fire inside the short-circuit branch. Moving them to the continue branch means they run just before KA — if the DB call fails, do we still run KA? Plan: yes, log warn, continue. Entity persistence failure shouldn't mean the player doesn't get a narrative turn; KA proceeds without the new entity.
3. **Block 4 cache breakage.** Adding a new `{{player_assertion}}` slot mid-prompt could shift the cache boundary if rendered inside Block 3. Plan: put it in Block 4 dynamic (already non-cached). Verify cache hit rate after playtest.
4. **Sidebar UI visibility.** A sidebar flag that always shows gets ignored. A flag that never shows is invisible. Design: show under the turn's narrative bubble, compact, dismissable, three distinct visual treatments.
5. **Backwards compat for existing in-flight campaigns.** Any turn persisted before this migration has `turns.flags` absent — jsonb NOT NULL DEFAULT `'[]'` makes new rows land clean, and `ALTER TABLE` backfills existing rows with `'[]'`. No read-side null handling needed.
6. **WB prompt change breaks existing MockLLM fixtures** (Commit 8). The Commit 8 WB fixtures emit the old flag shape. Plan: update the two `evals/fixtures/llm/gameplay/*/validator.yaml` that exercise WB flags — currently none do (WB isn't invoked in the five gameplay scenarios). Verify: grep fixtures for `validateAssertion` or WB-shaped responses. If clean, no fixture updates needed.

---

## Scope estimate

~1 full day of focused work. Breakdown:
- Schemas + migration: 1 hr
- Prompts (IntentClassifier + WB): 2 hr
- Router + turn workflow: 2 hr
- UI sidebar: 1 hr
- Tests: 2 hr
- Audit + fixes: 1 hr

---

## Delivery order (within this commit)

1. Migration 0010 (`turns.flags` jsonb column) → regenerate + verify round-trip.
2. WB schema — three-flag discriminated union + update fallback.
3. WB prompt rewrite for three flag types.
4. WB tests for flag-type parsing.
5. Router verdict reshape — `continue` carries optional `wbAssertion`.
6. Turn workflow — branch on wbAssertion; entity persistence + Block 4 injection + flag emission.
7. Block 4 fragment for `{{player_assertion}}`.
8. IntentClassifier prompt — narrow WORLD_BUILDING to standalone declarations.
9. `done` event — `flags` field + client hook threading.
10. `<FlagSidebar />` component.
11. Play UI integration.
12. Router + turn workflow test updates.
13. `pnpm typecheck && pnpm lint && pnpm test` green.
14. Subagent audit on full stack.
15. Fix findings. Commit. Push.

---

*Drafted 2026-04-22. Closes the WB delta from the 2026-04-20 design conversation. Memory authority: `project_worldbuilder_as_editor.md` (read first when returning).*
