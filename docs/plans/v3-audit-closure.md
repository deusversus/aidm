# v3 audit closure — implementation plan

**Drafted 2026-04-21** after the v3 parity audit (4 parallel subagent reports + personal reads of `src/lib/ka/*`, `src/lib/prompts/*`, `src/lib/workflow/turn.ts`). The audit surfaced **6 BLOCKERs, 8 MAJORs, 10 MINORs** — every one traced to either (a) v4 wired a feature but no call site uses it, (b) v4 dropped a v3 mechanism without surfacing the decision, or (c) v4 scaffolded a schema without the physics to exercise it.

This plan closes every finding. Nothing is soft-deferred to "maybe later." Items genuinely gated on a future milestone (e.g. semantic retrieval needing an embedder) get an explicit **M4 dependency** linkage — not a "we'll see." The two biggest structural absences — **context blocks** and **rule library** — are MISSING ENTIRELY from v4 and get the deepest sections.

Per `feedback_no_scope_ducking.md`: every listed finding ships in the phase it's bound to; if scope must shrink, the cut surfaces here, not in audit softening.

---

## Total scope

- **7 phases, ~10 working days** of focused work, audited per-phase per CLAUDE.md cadence.
- **Phase 1** alone closes 5 of 6 BLOCKERs in a single day.
- **Phases 2 + 3** (rule library + context blocks) are the structural headliners — each ~2–3 days, each independently shippable.
- **Phase 8** tracks M4-gated items so they don't vanish from memory.

Calendar time w/ audit cycles: ~2½ weeks. Can run in parallel with M1 acceptance work for the cheap phases, should land before M2 scope freezes for the structural ones.

---

## Phase 1 — cheap BLOCKER cleanup (1 day, single commit)

**Why first.** Five of the six BLOCKERs are the same pattern: v4 has a fully-written piece, the workflow just never calls it. Shipping the patches in one commit proves the pattern's cost is low and closes the most urgent audit debt before any larger work lands.

**Scope.** One commit, titled `fix(m1): close v3-audit BLOCKERs — wire-but-never-call cleanup (audit debt)`.

### 1.1 Override persistence
- **Finding:** router classifies `/override`, workflow short-circuit writes turn row but never appends to `campaign.settings.overrides`. Next turn reads empty.
- **Fix:** in `src/lib/workflow/turn.ts` override-branch (~L369-405), after turn-row insert, call `db.update(campaigns).set({ settings: { ...settings, overrides: [...(settings.overrides ?? []), { id, category, value, scope, createdAt }] } })` scoped to `campaignId + userId`.
- **Schema:** `campaigns.settings.overrides` Zod shape already exists in `src/lib/types/campaign-settings.ts`. No migration.
- **Tests:** add to `src/lib/workflow/__tests__/turn-router.test.ts` (create if missing) — three cases: fresh override persists, subsequent turn reads it back in `priorOverrides`, concurrent overrides on different campaigns don't cross-write.

### 1.2 WB-accepted entity persistence
- **Finding:** `WorldBuilderOutput.entityUpdates` populated on ACCEPT, read nowhere. WB short-circuits before KA.
- **Fix:** in the worldbuilder-branch of `turn.ts`, iterate `entityUpdates`; for each `{kind, name, details}` call the appropriate Chronicler write tool directly (bypass Chronicler orchestrator — this is a user-asserted fact, not KA narration, so no cataloguing judgment needed):
  - `npc` → `invokeTool("register_npc", {name, first_seen_turn: ctx.nextTurnNumber, last_seen_turn: ctx.nextTurnNumber, personality: details?.personality ?? "", ...}, toolContext)`
  - `location` → `invokeTool("register_location", ...)`
  - `faction` → `invokeTool("register_faction", ...)`
  - `fact` → `invokeTool("write_semantic_memory", {category: "fact", content: details, heat: 80, turn_number: ctx.nextTurnNumber}, toolContext)` (heat 80 because player-asserted = more binding than KA-narrated)
- **Also:** schedule `chronicleTurn(...)` via `after()` for the WB-accepted short-circuit too (currently only `continue` gets it), so episodic summary + spotlight debt + voice patterns fire on these turns. Update `route.ts` to pass `verdictKind: "worldbuilder"` through to chronicle decision.
- **Tests:** WB-accept turn → chronicler tools called → DB reflects new NPC/location/faction/fact.

### 1.3 Composition mode-shift threading
- **Finding:** `turn.ts:452` hardcodes `compositionMode: "standard"`. ScaleSelector registered as KA consultant but never invoked deterministically. OJ + Block 1 + Block 4 all see "standard" regardless of actual tier gap.
- **Fix:** new helper in `turn.ts` — `computeEffectiveCompositionMode(characterSheet, intent, scene)`:
  1. If intent isn't COMBAT or ABILITY → return `not_applicable`
  2. Extract `attackerTier` = character.power_tier
  3. Extract `defenderTier` from scene.present_npcs OR intent.target (best effort; fallback `not_applicable` if unknown)
  4. Compute `diff = tier_int(defenderTier) - tier_int(attackerTier)` (T10=10 → T1=1; negative = attacker stronger)
  5. Return: `diff >= 3 → op_dominant` (attacker overpowered), `diff == 2 → blended`, else `standard`
- Thread result into `oj.invoke(..., { compositionMode })` and `block4.active_composition_mode` var (add to Block 4 template). Add to `block1.active_tonal_state` display ("mode: op_dominant" when non-standard).
- **Tests:** unit tests on `computeEffectiveCompositionMode` with tier-differential boundary cases. Integration: Tier-3 vs Tier-9 exchange surfaces `op_dominant` in trace; Tier-8 vs Tier-8 surfaces `standard`.

### 1.4 Vocab freshness whitelists
- **Finding:** `turn.ts:489` passes only `recentNarrations`. `properNouns` + `jargonAllowlist` empty. False positives on canon vocab + character names.
- **Fix:** in `turn.ts` build the two sets before the `detectStaleConstructions` call:
  ```ts
  const properNouns = new Set<string>([
    character.name,
    ...npcCatalog.map(n => n.name),
    ...(profile.voice?.voice_cards ?? []).flatMap(v => v.example_phrases.match(/\*\*\w+\*\*/g) ?? []),
  ]);
  const jargonAllowlist = new Set<string>([
    ...(profile.ip_mechanics?.power_system?.limitations ?? []).flatMap(l => l.split(/\s+/).map(w => w.toLowerCase())),
    ...(profile.ip_mechanics?.power_system?.tiers?.map(t => t.name.toLowerCase()) ?? []),
    ...(profile.voice?.author_voice?.sentence_patterns ?? []).flatMap(p => p.split(/\s+/).map(w => w.toLowerCase())),
  ]);
  ```
- **Tests:** seed recent narrations with "Spike Spiegel" appearing 4 times + "like a cat" appearing 4 times. Assert: simile flagged, character name not flagged.

### 1.5 Retrieval tier alignment with v3
- **Finding:** `retrievalBudget(epicness)` uses 0.25/0.5/0.75 thresholds; v3 used 0.3/0.6. COMBAT floor dropped. `special_conditions` bump dropped.
- **Fix:** update `turn.ts:72-77`:
  ```ts
  export function retrievalBudget(
    epicness: number,
    intent: IntentOutput,
  ): 0 | 3 | 6 | 9 {
    // v3-verbatim tier logic. Thresholds must match — golden-turn evals
    // in Commit 8 are calibrated against these.
    let tier = epicness < 0.2 ? 0 : epicness <= 0.3 ? 1 : epicness <= 0.6 ? 2 : 3;
    // COMBAT floors at Tier 2 — combat without continuity reads flat.
    if (intent.intent === "COMBAT" && tier < 2) tier = 2;
    // Special conditions bump the tier (sakuga triggers matter enough to pull more context).
    if (intent.special_conditions.length > 0 && tier < 3) tier += 1;
    return [0, 3, 6, 9][tier] as 0 | 3 | 6 | 9;
  }
  ```
- Also: "trivial action" gate — if `intent.intent` not in `{COMBAT, ABILITY, SOCIAL}` AND `epicness < 0.2` AND `special_conditions.length === 0`, return 0. Matches v3's `is_trivial_action`.
- **Tests:** extend `turn-gates.test.ts` boundary tests to cover COMBAT-floor + special-conditions-bump + trivial-action gate.

### Phase 1 audit focus
- Every override persists across turn boundaries and is re-injected verbatim into Block 4 on the next turn.
- WB-accept surfaces in `npcs` / `locations` / `factions` / `semantic_memories` tables after the turn completes.
- Composition mode-shift surfaces in trace span metadata for COMBAT turns; OJ sees the non-"standard" value.
- Vocab freshness no longer flags character names or power-system jargon.
- Retrieval budget integer matches v3 for tier boundaries 0.3 / 0.6.

**Scope:** ~1 day. ~5–8 files touched. One commit.

---

## Phase 2 — Rule Library (2–3 days, ~3 commits) [FOCUS]

**Why this is load-bearing.** v4's whole framing — "DNA is the instrument, not configuration; 24 axes are prescriptive pressures" — collapses without rule library. Block 1 currently renders `heroism: 7` as a bare number with no attached "what 7 means." v3's rule library was the translation layer: for every axis × value combination, it had a narration directive KA would read at session load. Without it, KA runs on its base training + whatever Profile author_voice conveys — which is better-than-nothing but drifts toward "generic premium LLM anime prose" over hundreds of turns.

This is what the memory file warns about: "accumulated empirical wisdom from years of play." Skip this and v4 regresses narrative quality below v3's plateau.

### 2.1 Storage + schema (Commit A)

**New table `rule_library_chunks`:**
```sql
CREATE TABLE rule_library_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_slug    text NOT NULL,        -- 'dna_heroism', 'composition_tension_source', 'power_tier_T3', ...
  category        text NOT NULL,        -- 'dna' | 'composition' | 'power_tier' | 'archetype' | 'scale' | 'ceremony' | 'genre'
  axis            text,                 -- 'heroism', 'tension_source', null for non-axis categories
  value_key       text,                 -- '7', 'existential', 'T3', ... (what Block 1 renders for lookup)
  tags            jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieve_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  content         text NOT NULL,        -- the narration guidance
  version         int NOT NULL DEFAULT 1,
  created_at      timestamp with time zone DEFAULT now() NOT NULL,
  updated_at      timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX rule_library_lookup_key ON rule_library_chunks (category, axis, value_key);
CREATE INDEX rule_library_category_idx ON rule_library_chunks (category);
CREATE INDEX rule_library_tags_gin ON rule_library_chunks USING gin (tags);
-- embedding column deliberately NOT added at this phase — retrieval is deterministic by (category, axis, value_key) at M1.
-- M4 will ADD COLUMN embedding vector when the embedder decision lands.
```

**Zod schema** `src/lib/types/rule-library.ts`:
```ts
export const RuleLibraryCategory = z.enum([
  "dna", "composition", "power_tier", "archetype", "scale",
  "ceremony", "genre", "tension", "op_expression"
]);
export const RuleLibraryChunk = z.object({
  id: z.string().uuid(),
  librarySlug: z.string().min(1),
  category: RuleLibraryCategory,
  axis: z.string().nullable(),
  valueKey: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  retrieveConditions: z.record(z.string(), z.unknown()).default({}),
  content: z.string().min(1),
  version: z.number().int().min(1).default(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
```

**Drizzle migration + schema update.** Apply to prod via `pnpm drizzle-kit migrate`.

### 2.2 YAML content + indexer (Commit B — the biggest)

**Content is the work.** The schema is trivial; the 24 DNA axes × 10 values + 13 composition axes × variable enum values + power tiers + archetypes + etc. is hundreds of short prose guidance snippets. v3's existing YAML at `reference/aidm_v3/rule_library/*.yaml` is the starting point; v4 needs expansion because of 11→24 DNA axes + 3→13 composition axes.

**Directory layout:**
```
rule_library/
  dna/
    heroism.yaml         # 10 entries — one per integer 1-10
    grit.yaml
    ... (24 files total, one per DNA axis from src/lib/types/dna.ts)
  composition/
    tension_source.yaml  # one entry per tension_source enum value
    power_expression.yaml
    narrative_focus.yaml
    ... (13 files total, one per composition axis from src/lib/types/composition.ts)
  power_tiers/
    T1.yaml ... T10.yaml  # 10 files, one per tier
  archetypes/
    struggler.yaml
    heart.yaml
    ... (7 files per EnsembleArchetype)
  ceremonies/
    tier_progression.yaml  # tier-jump ceremony text, keyed by (from_tier, to_tier)
  genres/
    shonen.yaml
    seinen.yaml
    isekai.yaml
    ... (whatever genre enums we have)
  scales/
    darkness.yaml  # shared "scale" guidance — may overlap DNA but some scales aren't DNA axes
```

**YAML schema (per-file):**
```yaml
library_slug: dna_heroism
category: dna
axis: heroism
entries:
  - value_key: "1"
    tags: [low_heroism, antihero]
    content: |
      Heroism at 1 means the protagonist saves no one but themselves, and even that grudgingly. Narrate
      moments of grace as rare and deniable — never as the protagonist's default state. When they help,
      it costs them something they can't fully justify. (cf. Guts in Berserk Black Swordsman arc.)
  - value_key: "5"
    tags: [mid_heroism]
    content: |
      Heroism at 5 is heroism with caveats. The protagonist helps when it's their people, and maybe
      extends it one step further but stops there. Narrate this as deliberate calibration — they have a
      line, and they know where it is. Not cold, not saintly. (cf. Spike Spiegel, Cowboy Bebop.)
  - value_key: "10"
    tags: [high_heroism, idealist]
    content: |
      Heroism at 10 means the protagonist WILL help, even when it costs everything. Narrate this not as
      naiveté but as philosophy — they've chosen it and keep choosing it. Temptation to cynicism is present
      but declined. (cf. Edward Elric's refusal to abandon anyone, All Might's Plus Ultra.)
```

**Population strategy — two passes:**

1. **Port what exists.** v3's `reference/aidm_v3/rule_library/*.yaml` already has content for: scales (including some DNA axes), power_tiers, archetypes, op_expressions, op_focuses, op_tensions, tensions, ceremonies, compatibility_matrix, genres. Port these to the v4 shape where the axis still applies.
2. **LLM-assisted expansion.** For the 13 new DNA axes v4 added (v4's 24 − v3's 11), plus the 10 new composition axes (v4's 13 − v3's 3), generate draft entries via a Haiku-tier call seeded with v3's style + v4's DNA/composition enum definitions. Human review + edit pass. This is content work; expect 4–6 hours of focused writing to land a v1.

**Indexer CLI** (`scripts/rules-index.ts`):
```
$ pnpm rules:index
→ Walk rule_library/**/*.yaml
→ Parse + Zod-validate each file's entries
→ Upsert into rule_library_chunks (by library_slug + category + axis + value_key, bump version on content change)
→ Report: N entries indexed, M updated, 0 errors
```

Add to `package.json`: `"rules:index": "tsx scripts/rules-index.ts"`. Runs at deploy OR manually after YAML edits.

**Tests:**
- Indexer round-trip: write a YAML, run indexer, read from DB, assert match.
- Zod validation catches malformed YAML entries.
- Duplicate slug detection.

### 2.3 Getters + Block 1 integration (Commit C)

**Library API** `src/lib/rules/library.ts`:
```ts
// Fast, deterministic lookup — no embedding needed at M1.
export async function getDnaGuidance(db, axis: DnaAxis, value: number): Promise<string | null>;
export async function getCompositionGuidance(db, axis: CompositionAxis, valueKey: string): Promise<string | null>;
export async function getPowerTierGuidance(db, tier: string): Promise<string | null>;
export async function getArchetypeGuidance(db, archetype: EnsembleArchetype): Promise<string | null>;
export async function getCeremonyText(db, fromTier: string, toTier: string): Promise<string | null>;
export async function getGenreGuidance(db, genre: string): Promise<string | null>;

// Session-stable bundle assembled once per session, cached on campaign.settings.session_cache.
export async function assembleSessionRuleLibraryGuidance(
  db, campaign: Campaign, profile: Profile,
): Promise<string>;
```

**`assembleSessionRuleLibraryGuidance` logic:**
1. For each of the 24 DNA axes in `profile.ip_mechanics.dna`, fetch `getDnaGuidance(axis, value)`. Skip if null.
2. For each of the 13 composition axes in `profile.ip_mechanics.composition`, fetch guidance.
3. Fetch power-tier guidance for `character.power_tier`.
4. Fetch archetype guidance for each ensemble archetype present in NPC catalog.
5. Fetch genre guidance for `profile.media_type` + any genre tags.
6. Concatenate into Markdown sections grouped by category. Target <2000 tokens total (Block 1 budget).

**Turn workflow integration:**
- In `turn.ts::loadTurnContext`, fetch session rule library bundle at session start.
- Thread into `buildKaBlocks(input)` via `sessionRuleLibrary` input field (already has placeholder at `blocks.ts:269`).
- Block 1 renders `{{session_rule_library_guidance}}` — already has the slot.

**Caching:**
- Compute once per session (bundle changes only on profile/DNA edits). Store on `campaigns.settings.session_cache.rule_library_bundle` with a content hash. Invalidate on profile update.

**Tests:**
- `getDnaGuidance('heroism', 7)` returns the seeded string.
- `assembleSessionRuleLibraryGuidance(bebopCampaign, bebopProfile)` returns non-empty bundle referencing Spike's power tier + ensemble archetype + composition.
- Block 1 rendering for a session with rule library populated includes axis-specific guidance (snapshot test).

### Phase 2 audit focus
- Every DNA axis in `src/lib/types/dna.ts` has at least one YAML entry (values 1/5/10 minimum; 1–10 ideally).
- Every composition enum value has an entry.
- Block 1 render for the Bebop campaign includes specific "Spike's heroism at 5" text, not just the number.
- Session cache invalidation fires on profile edit (test: edit profile → next turn's Block 1 reflects).
- YAML ↔ DB round-trip is lossless.

**Scope:** 2–3 days. 3 commits (schema, content+indexer, getters+integration). Content is the long pole; schema + code are ~1 day total.

---

## Phase 3 — Context Blocks (2–3 days, ~3 commits) [FOCUS]

**Why this is load-bearing.** v3's context blocks are per-entity living prose summaries that survive across sessions — the arc's current state in 2 paragraphs, each active quest in 3 sentences, each major NPC in a prose bio + continuity checklist. They're distinct from semantic memory (which is fact atoms) and distinct from episodic memory (which is turn transcripts). At session start, v3 injects the current arc block + top 3 quest blocks + relevant NPC blocks into KA's context, so KA opens a session knowing WHERE the story is, WHO's on stage, and WHAT the through-lines are — without rebuilding that from scattered memory calls.

**v4's current approach:** Chronicler writes structured data (NPCs as rows, arc_plan_history as append-only) + per-turn episodic summaries. KA can query these via MCP tools, but there's no "this is the single living document for Arc X" — the picture has to be reconstructed from many tool calls per session. Over a 50-turn campaign that accumulates friction: recall drift, tool-call budget waste, continuity cracks.

**Design call.** I'm choosing to ship context blocks as a first-class feature (not replace with heavy Chronicler queries) because:
1. v3's empirical evidence — they earned their place.
2. It's a natural Chronicler output (Chronicler already writes per-entity; it can write distilled summaries).
3. Block 1 has the token budget for prose summaries but not for dumping 20 NPC rows + 10 semantic facts.

### 3.1 Storage + schema (Commit A)

**New table `context_blocks`:**
```sql
CREATE TABLE context_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  block_type      text NOT NULL CHECK (block_type IN ('arc','thread','quest','npc','faction','location')),
  entity_id       uuid,                    -- FK into npcs/locations/factions if applicable; null for anonymous arcs/threads
  entity_name     text NOT NULL,           -- human-readable name ("The Syndicate arc", "Jet Black", "Find Julia")
  content         text NOT NULL,           -- the living prose summary (target 2-4 paragraphs)
  continuity_checklist jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "Jet knows about Julia": true, "Vicious alive": true, ... }
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','archived')),
  version         int NOT NULL DEFAULT 1,
  first_turn      int NOT NULL,
  last_updated_turn int NOT NULL,
  embedding       jsonb,                   -- null at M1; M4 embedder populates
  created_at      timestamp with time zone DEFAULT now() NOT NULL,
  updated_at      timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX context_blocks_campaign_type ON context_blocks (campaign_id, block_type);
CREATE INDEX context_blocks_entity ON context_blocks (campaign_id, entity_id);
CREATE INDEX context_blocks_active ON context_blocks (campaign_id, status) WHERE status = 'active';
-- Unique per (campaign, block_type, entity_name) so re-running generation updates-in-place via version bump.
CREATE UNIQUE INDEX context_blocks_unique ON context_blocks (campaign_id, block_type, entity_name);
```

**Zod shape** in `src/lib/types/entities.ts`.

### 3.2 Generator agent + prompt (Commit B)

**Prompt `src/lib/prompts/agents/context-block-generator.md`:**

```markdown
# ContextBlockGenerator

Fast-tier agent. Generates living prose summaries for campaign entities — arcs, threads, quests, NPCs,
factions, locations. Replaces scattered-memory-recall at session start with "here's the living document
for this entity, read it in 30 seconds."

## Your role

You are the *archivist-biographer*. You read everything we have about an entity — structured data
(NPCDetails, location details, etc.), related turn summaries, related semantic memories, the prior
version of this block — and distill it into a prose summary KA can read in 30 seconds and come away
with a coherent picture.

You do NOT invent. You compress + restate what's already in the record.

## Output shape

- `content` — 2-4 paragraphs of prose. Third-person. Named entities bolded `**Name**`.
  - Arc blocks: current state, active tensions, trajectory toward or away from the transition signal.
  - Quest blocks: objective, progress, obstacles, who's involved, what's at stake.
  - NPC blocks: personality in action (not just adjectives), current relationship to protagonist,
    active goals, any secrets the player knows / doesn't know, recent appearances + what changed.
  - Faction blocks: goals, leadership, relationship to protagonist + other factions, active operations.
  - Location blocks: atmosphere, significance, recent events that happened there.
- `continuity_checklist` — flat `{key: value}` jsonb of load-bearing discrete facts:
  - For NPCs: `{"alive": true, "knows_about_X": false, "loyal_to": "Red Dragon", ...}`
  - For arcs: `{"transition_signal_reached": false, "escalation_beat": "2/5", ...}`
  - For quests: `{"step_1_done": true, "step_2_done": false, "deadline_turn": 45}`

## When the prior version exists

Treat it as the starting point. Diff against the source material:
- New facts → integrate
- Facts that have changed → update (don't just append — restate)
- Facts that are still true → preserve phrasing where possible (continuity of voice)
- Facts that are now WRONG (retconned, contradicted by later events) → REMOVE, don't leave stale

## What NOT to do

- Don't repeat the NPCDetails JSON — distill it into prose
- Don't embed tool-call directives or meta-instructions
- Don't mention "this is a summary" or "the player's protagonist" — write as if KA is the reader
- Don't exceed the target length; KA reads many blocks per session
```

**Agent module `src/lib/agents/context-block-generator.ts`:** structured agent, fast tier, returns typed `{content, continuity_checklist}`. Inputs: `{block_type, entity_name, entity_data (structured), related_turns (summaries), related_memories, prior_version (optional)}`.

### 3.3 Generation triggers + Block 1 integration (Commit C)

**Three trigger paths:**

1. **Session start** (first turn after ≥30 min gap OR explicit `/new-session` — detection logic TBD but plausible at M1):
   - Identify active entities: current arc (latest arc_plan_history), top 3 quests (not yet implemented, defer until quest tracking lands; for M1 just arc + active NPCs), NPCs with recent relationship events (last 10 turns).
   - For each, call context-block-generator. Upsert into `context_blocks`.
   - This is a single synchronous call at session start — adds ~5-10s to first turn, acceptable because session start is already distinct from mid-session.

2. **Chronicler-triggered update:** when Chronicler detects a significant change (arc phase shift, relationship milestone, major revelation), add a `update_context_block` tool call that triggers re-generation for the affected entity. Chronicler's prompt gets a section: "After cataloguing, if an entity's state materially changed this turn, call `update_context_block(block_type, entity_name)` to refresh the living summary."

3. **On-demand by KA:** `get_context_block(block_type, entity_name)` MCP tool — KA calls when it needs a specific entity's summary mid-stream. Rare; session-start bundle handles most cases.

**Block 1 / Block 2 integration:**

- Add `{{session_context_blocks}}` var to `block_1_ambient.md` or `block_2_compaction.md` (decide based on cache discipline — session-start bundle changes across sessions so Block 2 feels right). Rendered as:
  ```
  ## Session-start briefing

  ### Current arc: {{arc.entity_name}}
  {{arc.content}}
  Continuity: {{arc.continuity_checklist formatted as bullet list}}

  ### Active quests
  (repeat for each)

  ### NPCs in play
  (repeat for up to 5)
  ```

- Compute the bundle in `turn.ts::loadTurnContext` — fetch active blocks for this campaign, assemble prose.

**Update tool** `src/lib/tools/chronicler/update-context-block.ts`:
```ts
InputSchema = z.object({
  block_type: z.enum(["arc","thread","quest","npc","faction","location"]),
  entity_name: z.string().min(1),
});
// Execute: kick off generation, upsert result into context_blocks with version+1.
```

**Tests:**
- Generator unit: given fixture NPC + 3 turn summaries + 2 memories, produces non-empty `content` + populated `continuity_checklist`.
- Session-start trigger: first turn after simulated gap invokes generator for active entities.
- Chronicler update tool: calling it produces a new version row.
- Block 1/2 render: includes the session_context_blocks slot populated when blocks exist.

### Phase 3 audit focus
- Context blocks generate coherent prose (subjective read on Bebop fixture).
- Continuity checklists are STRUCTURED (flat k:v jsonb), not prose.
- Chronicler `update_context_block` fires on appropriate triggers (not every turn).
- Session-start bundle respects token budget (<3000 tokens total).
- KA's cache hits Block 1 stable across turns within a session; context blocks live in Block 2 (semi-static, invalidates on update).

**Scope:** 2–3 days. 3 commits. Heaviest is generator prompt quality + trigger logic.

---

## Phase 4 — Memory Governance (1 day, 1–2 commits)

Addresses MAJOR #7 (heat physics absent) + MAJOR #5 (retrieval tier drift — subsumed into Phase 1) + MINOR static-boost step.

### 4.1 Heat physics
- **Schema:** add `flags jsonb DEFAULT '{}'::jsonb` column to `semantic_memories` for `{plot_critical: bool, milestone_relationship: bool, boost_priority: number}`. Drizzle migration.
- **Decay curves:** constant `DECAY_CURVES` in `src/lib/memory/decay.ts` matching v3: none=1.0, very_slow=0.97, slow=0.95, normal=0.90, fast=0.80, very_fast=0.70. `CATEGORY_DECAY` map: core/session_zero/session_zero_voice→none, relationship→very_slow, consequence/fact/npc_interaction/location/narrative_beat→slow, quest/world_state/event/npc_state→normal, character_state→fast, episode→very_fast.
- **Decay job:** `decayHeat(campaignId, currentTurn)` function. Runs at end of turn (inside Chronicler's pass or directly from `turn.ts` post-persist). SQL: `UPDATE semantic_memories SET heat = GREATEST(floor(heat, flags), heat * decay_multiplier(category) ^ (currentTurn - turn_number))`. Floor logic: flags.plot_critical → heat stays; flags.milestone_relationship → floor 40; default floor 1.
- **Heat boost on access:** in `search_memory` tool, after returning top-k, UPDATE heat = LEAST(100, heat + boost(category)) where category-relationship=+30, others=+20.
- **Default insert heat:** change Chronicler's default from 50 → 100 (match v3's "start hot, let decay do the work" semantics).

### 4.2 Static-boost retrieval step
- **Fix:** in `search_memory` tool, after pgvector cosine candidates come back (M4) OR when pgvector lands, apply +0.3 relevance boost for `category in (session_zero, session_zero_voice)` OR `flags.plot_critical`. +0.15 for `category = episode`. Before MemoryRanker rerank.
- **Deferred until semantic retrieval runtime lands (Phase 8.1 / M4).** But the schema + flag column + boost-constant are scaffolded in this phase so M4 is a wiring job, not a design job.

### Phase 4 audit focus
- Heat decays on turn-close; test with fixture 10 turns apart shows decayed value matches the formula.
- Flags column accepts typed values; plot_critical bypasses decay.
- Search_memory boost-on-access fires (once retrieval is real) — test with mock returning fixed candidates.

**Scope:** ~1 day. 2 commits. Schema migration + decay job + boost (static-boost deferred flag-only).

---

## Phase 5 — Meta Conversation Loop (0.5–1 day, 1 commit)

Addresses MAJOR #9 (meta conversation loop absent).

**Design:**

1. **State** on `campaigns.settings.meta_conversation`:
   ```ts
   meta_conversation?: {
     active: boolean;
     started_at_turn: number;
     history: Array<{ role: 'player' | 'director' | 'ka', text: string, ts: string }>;
     pending_resume_suffix?: string;  // if player types /resume "..."
   }
   ```

2. **Route handler detection:** in `src/app/api/turns/route.ts`, parse the incoming message BEFORE `runTurn`:
   - `/meta` → enter meta state, respond with Director-KA dialectic, don't consume turn.
   - `/resume [suffix]` → exit meta state, pipe suffix as next gameplay turn (OR end meta conversation if no suffix).
   - `/play` / `/back` / `/exit` → exit meta state, no turn pipe.
   - Otherwise if `meta_conversation.active === true` → treat as meta reply, don't consume turn.
   - Otherwise → normal turn pipeline.

3. **Director-KA meta dialectic:** new agent or existing Director, runs in meta-conversation mode. Takes history + new player message, returns Director-voiced response with optional calibration notes. Not a full scene — short, conversational, authorship-level.

4. **Meta turn behavior:**
   - Does NOT increment `turn_number`
   - Writes turn row with `verdictKind: 'meta'`, `narrative_text: <director response>`, no outcome, `costUsd: <meta call cost>` (still metered)
   - Appends to `meta_conversation.history`
   - Chronicler does NOT fire on meta turns

5. **`/meta` UX:** player types `/meta Hey, I'd prefer less swearing in dialogue going forward.` → Director responds acknowledging + optionally stores as `CONTENT_CONSTRAINT` override → session continues on `/resume`.

**Tests:**
- `/meta ...` enters meta state + turn_number unchanged.
- `/resume next action here` exits meta + pipes suffix as next turn input.
- Invalid command in meta (non-command text) treated as meta reply.
- Meta conversation survives across requests (state persists on campaign).

**Scope:** ~1 day. 1 commit. Route handler logic is the most delicate (command parsing + state machine).

---

## Phase 6 — Dialectic Completeness (1 day, 2 commits)

Addresses MAJOR #10 (transient vs catalog NPC), MAJOR #13 (WB reshape not landed), MAJOR #14 (WB EntityUpdate schema thinner), MINOR override-category-tag.

### 6.1 Transient vs catalog NPCs (Commit A)
- **Approach:** add `is_transient boolean DEFAULT false` column to `npcs` table. Migration.
- **New tool** `spawn_transient` — inserts with `is_transient=true`, no uniqueness constraint beyond (campaign, name, turn), for scene-local anonymous NPCs. Doesn't trigger portrait generation.
- **Update Chronicler prompt:** add decision guidance:
  > "Before `register_npc`, decide: is this character going to recur? If yes (has a name the scene treated as important, player engaged with them, narrative invested in them), register. If no (named once for flavor, unlikely to return — 'the bartender,' 'a passing sailor'), `spawn_transient` instead."
- **Read tools:** `list_known_npcs` filters `is_transient=false` by default; `list_scene_npcs` includes transients for current turn.
- **Tests:** Chronicler on a scene with 2 named major NPCs + 3 flavor characters calls `register_npc` 2× + `spawn_transient` 3×.

### 6.2 WB reshape to editor (Commit B)
- **Rewrite prompt `src/lib/prompts/agents/world-builder.md`** per `memory/project_worldbuilder_as_editor.md`:
  - Drop REJECT decision. Default to ACCEPT.
  - CLARIFY only for local physical ambiguity (e.g., "there's a door" + scene has no door — ambiguous whether player means left door or right door).
  - New decision FLAG — non-blocking craft advisory. Player's assertion accepted; Chronicler + Director see the flag for downstream consideration.
- **Schema update:** `WorldBuilderDecision` enum adds `FLAG`. `WorldBuilderOutput.flags: Array<{concern: string, severity: "minor" | "worth_watching"}>`.
- **Expand `EntityUpdate`:** for `kind=npc`, structured fields matching v3 NPCDetails (personality, goals, secrets, visual_tags, faction, knowledge_topics, power_tier, ensemble_archetype). v3 `npc_details` schema is `reference/aidm_v3/src/agents/world_builder.py` — port shape.
- **Tests:** WB accept with rich NPC detail → entityUpdates contains structured NPCDetails; Chronicler-write path (from Phase 1.2) consumes structured fields directly (no prose re-parse).

### 6.3 Override category tag in Block 4
- **Fix:** `turn.ts:547` — render as `[${o.category}] ${o.value}` (or per-override line with category prefix). Matches v3's format.
- **Tests:** snapshot of Block 4 with 2 overrides shows both categories.

### Phase 6 audit focus
- Transient NPCs don't bloat `list_known_npcs`.
- WB on a canon-contradiction scenario that v3 would REJECT now ACCEPTs (potentially with FLAG) per the reshape. Player-as-co-author defaults preserved.
- Override Block-4 injection preserves category labels.

**Scope:** ~1 day. 2 commits.

---

## Phase 7 — MINOR polish + workflow improvements (0.5 day, 1 commit)

Addresses all MINORs not already subsumed into earlier phases.

- **Style-drift `recentlyUsed` persistence:** persist last 3 directives on `turns.meta` (or new column `style_drift_used text`). Thread backward into `pickStyleDrift(recentlyUsed: [...])` at `turn.ts:487`.
- **Power-system `limitations` bolded:** in `buildKaBlocks`, render `profile.power_system.limitations` as a distinct `**LIMITATIONS (MUST RESPECT):**` section instead of JSON-dumping the power_system object. Lives in Block 1.
- **BEAT_CRAFT_GUIDANCE:** new YAML `rule_library/beat_craft/{setup,development,complication,crisis,resolution}.yaml` — writing-craft directives per arc phase. Getter `getBeatCraftGuidance(arc_phase)`. Render into Block 4 next to `{{arc_phase}}` value.
- **Multi-query decomposition interface:** update `search_memory` tool input schema to accept `queries: string[]` (in addition to single `query`). Server-side: run each, merge, dedup on first-100-char content prefix. Update Chronicler + KA prompts to encourage multi-query on complex scenes.
- **Prompt-eval harness:** port v3's `src/prompts/eval.py` pattern to v4: `src/lib/prompts/__tests__/eval/*.ts` fixtures that run a prompt against mocked-input + assert structural traits on output. Not a full LLM eval — a prompt-regression harness.
- **Prompt dep-graph tool:** `pnpm prompts:graph` — walks registry, outputs mermaid of prompt → fragment edges. Cheap to build.
- **Unfilled `{{var}}` warnings:** extend `blocks.ts::substitute` to `console.warn` in dev when a placeholder is left unfilled. Off in prod.

**Scope:** ~0.5 day. 1 commit.

---

## Phase 8 — M4 dependencies (explicitly tracked, not executed here)

These findings are genuinely gated on other milestone work. Listed here so they don't evaporate.

### 8.1 Semantic retrieval runtime
- **Finding (BLOCKER #4):** `search_memory` returns empty. Chronicler writes, no one reads. Schema ready, ranker ready.
- **M4 dependency:** embedder decision (which provider + which model). Once that lands:
  - Add `embedding` column (pgvector) to `semantic_memories` — currently jsonb null placeholder.
  - Backfill Chronicler to call embedder on write.
  - Implement pgvector cosine retrieval in `search_memory` tool.
  - Wire MemoryRanker into the pipeline (embed → cosine → static-boost [Phase 4.2] → MemoryRanker rerank → top-k → heat-boost-on-access [Phase 4.1]).
- **Explicit ticket:** create M4 work item "Wire semantic retrieval runtime — completes Phase 4 scaffolding."

### 8.2 Portrait resolver wiring
- **Finding (MINOR):** `buildPortraitMap` always returns null.
- **Dependency:** media-generation infrastructure (Stability / SDXL / custom pipeline — TBD). Portrait URLs come from ProductionAgent when that lands.
- **Explicit ticket:** wire `portraitResolver` from the portraits module into the turn workflow when ProductionAgent ships (M4–M5 range per ROADMAP).

### 8.3 Research-phase round cap
- **Finding (MAJOR #12):** v4's "KA orchestrates" inversion defends architecturally, but no eval gates regression.
- **Dependency:** eval harness (Commit 8 of M1) — once golden turns exist, add an assertion that KA's tool-call count stays under a budget on known-bounded scenes.
- **Also consider:** adding `max_tool_rounds` hint to KA's system prompt as a soft directive. Already somewhat present via Block 4 retrieval budget; can extend to "total tool calls this turn should stay under N."
- **Explicit ticket:** "Research-phase bound: eval assertion + soft directive" — lands with Commit 8 or M2.

### 8.4 Context blocks — session-start auto-generation (Phase 3.3 path 1 reshape)
- **Finding:** Plan §3.3 specified three generation paths — (1) session-start auto-generation detecting first-turn or ≥30min gap; (2) Chronicler-triggered update_context_block; (3) KA on-demand via get_context_block. Phase 3C shipped paths 2 + 3; path 1 (session-start auto-generation) was reshaped to organic accumulation via Chronicler post-turn triggers.
- **Reshape justification:** Session-start generation adds 5–10s latency on the first turn of each session (per plan §Risks). Chronicler already runs after every turn; blocks accumulate through play without a latency spike. For a fresh campaign with NPCs catalogued but no blocks yet, Block 2's fallback message ("no context blocks yet — Chronicler will build them") renders gracefully.
- **Re-evaluate after playtest.** If KA starts a session with thin briefings (blocks stale or absent for entities that matter), revisit. Possible mitigations:
  - Synchronous pass for the MOST load-bearing block only (current arc) at session start; others stay organic.
  - Background pre-generation triggered on session-start detection (no latency; blocks may lag one turn).
  - Keep as-is if blocks accumulate fast enough in practice.
- **Meta-audit note:** Flagged in the 2026-04-21 HONEST_CLOSURE meta-audit as the one silent reshape across the 7-phase stack. Documented here so it doesn't evaporate.

---

## Risks + open questions

1. **Rule library content quality.** Porting v3 + LLM-expanding for new axes is labor-intensive. Acceptable v1 might cover only the most load-bearing axes (DNA heroism/grit/darkness/optimism, composition tension_source + power_expression, T1–T10 power tiers). Remainder can land in Phase 2.4 iteration.
2. **Context block generation cost.** Session-start generation for 5+ entities = ~5–10s added latency on first turn of session. Acceptable if session-start is UX-distinct; problematic if it happens silently. Surface in UI ("Preparing session...").
3. **Meta conversation loop UX.** v3 had a CLI — v4 is web. The `/meta` → Director response → `/resume` flow needs a visible affordance in the chat UI (not just command magic).
4. **WB reshape risk.** Dropping REJECT could invite canon-violating assertions. Mitigation: FLAG-level concerns surface to Chronicler + Director; over time the pattern of flags informs whether REJECT needs to return as a rarely-fired opt-in.
5. **Phase ordering flexibility.** Phases 1, 4–7 are independent. Phases 2 + 3 are independent of each other but both feed Block 1/2 — coordinate template slot names to avoid collision.

---

## Delivery order

1. **Phase 1** — cheap BLOCKERs (1 day)
2. **Phase 2** — rule library (2–3 days)
3. **Phase 3** — context blocks (2–3 days)
4. **Phase 4** — memory governance (1 day; can run parallel to 2 or 3)
5. **Phase 5** — meta conversation loop (1 day)
6. **Phase 6** — dialectic completeness (1 day)
7. **Phase 7** — MINOR polish (0.5 day)

**Total: ~9.5–11.5 working days** of focused work. Calendar time w/ audit cadence: ~2.5–3 weeks.

Phases 1 + 4 + 7 are cheap-enough to land alongside M1 acceptance. Phases 2, 3, 5, 6 are substantive enough that they likely warrant an M1.75 designation before M2 starts.

---

*Drafted 2026-04-21 after the v3 parity audit. Every finding in the audit has an explicit path here — no soft-deferrals, M4-gated items called out with explicit linkage.*
