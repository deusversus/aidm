# Context Blocks — Implementation Plan
*Authored 2026-03-06*

---

## The Problem

AIDM's memory is powerful but structurally flat. We have:
- **Compacted sliding window** — what just happened, low detail
- **campaign_memories** — individual facts (decaying, heat-scored, vector-searchable)
- **search_turn_narratives tool** — forensic search of raw transcript
- **Structured DB records** — NPC affinity, quest status, faction power, foreshadowing seeds

What's missing: **organized narrative understanding**. If the Director wants to know who the SPCA faction *is* as a story actor, it must reconstruct that from disconnected memory chunks — each fact is there, but the *arc* of the relationship, the *texture* of the encounters, the *implications* for what comes next have to be assembled on the fly. An LLM doing that assembly under token pressure will drop the orange cat and invent a brown one.

**Context blocks** are the missing layer: living prose summaries of a story element's entire narrative history, written for LLM consumption, organized by function, retrieved on demand. Not a replacement for any existing layer — a new stratum between the individual facts (memories) and the raw archive (transcript).

---

## Core Concept

A context block is:
- **Prose narrative** — written the way a script supervisor's continuity notes would be written. "The SPCA appeared first as a bureaucratic nuisance in the gate district..." Not a fact list. A story of the element's role in *this* campaign.
- **Continuity checklist** — a structured JSON companion listing every named entity with salient attributes (color, name, physical detail, last known state). This is the orange-cat enforcement mechanism.
- **Keyed by narrative unit** — arc, thread, quest, NPC, faction. Not by time.
- **Updated, not replaced** — blocks append new chapters as the story progresses; periodic consolidation rewrites them fresh.

---

## Block Types

### 1. Arc Block
**Unit:** One story arc (e.g., "The Gate District Conspiracy")
**Trigger:** Created when an arc closes (`arc_phase` → DENOUEMENT or Director explicitly closes). Updated at session end while arc is active (if ≥10 turns since last update).
**Source material:** All turn narratives from arc start turn to current/close.
**Purpose:** Replaces raw transcript re-reads for past arcs. RecapAgent uses arc blocks for multi-arc recaps instead of raw turns. Director reads at session start if a past arc is referenced.

### 2. Thread Block
**Unit:** One foreshadowing seed / narrative thread
**Trigger:** Created when seed reaches `callback` status. Updated when `mention_seed()` is called (if block exists). Closed when seed reaches `resolved` or `abandoned`.
**Source material:** Seed record + turn narratives matching seed's `related_npcs` / `related_locations` tags + any memories tagged with the seed_id.
**Purpose:** Director retrieves before resolving a thread; ensures setup/payoff coherence. The thread block is what makes "chekhov's gun" actually fire correctly.

### 3. Quest Block
**Unit:** One quest
**Trigger:** Created when quest is created (`create_quest()`). Updated when any objective completes or quest status changes (`update_quest_status()`, `update_quest_objective()`). Closed when quest reaches `completed`, `failed`, or `abandoned`.
**Source material:** Quest record + objectives history + turn narratives from `created_turn` onward mentioning related NPCs/locations.
**Purpose:** Makes quests feel narratively real instead of mechanical. KA reads quest block before writing scenes where quest progress occurs.

### 4. Entity Block — NPC
**Unit:** One NPC
**Trigger:** Created after NPC's 3rd scene appearance (`scene_count >= 3`). Updated at session end for any NPC with `scene_count` that increased this session.
**Source material:** NPC DB record (affinity, milestones, personality, secrets) + all memories with NPC in metadata + turn narratives matching NPC name.
**Purpose:** Director/KA retrieve before scenes where NPC appears. Contains full relationship arc — not just current affinity score but how it got there and what it means.

### 5. Entity Block — Faction
**Unit:** One faction
**Trigger:** Created when faction's `influence_score` first exceeds 20, or when `pc_is_member` becomes true, or when faction first appears in a turn narrative. Updated at arc close or when any faction relationship changes.
**Source material:** Faction DB record + memories mentioning faction name + turn narratives mentioning faction.
**Purpose:** Gives Director and KA a coherent understanding of the faction as a story actor, not a database entry.

---

## Data Model

### New Table: `context_blocks`

```sql
CREATE TABLE context_blocks (
    id          SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),

    -- What this block is about
    block_type  VARCHAR(20) NOT NULL,  -- arc | thread | quest | npc | faction
    entity_id   VARCHAR(100),          -- seed_id, quest.id, npc.id, faction.id, or arc_name slug
    entity_name VARCHAR(255) NOT NULL, -- human-readable: "Director Tanaka", "Arc 1: Gate District"

    -- Block lifecycle
    status          VARCHAR(20) DEFAULT 'active',  -- active | closed
    first_turn      INTEGER,
    last_updated_turn INTEGER,
    version         INTEGER DEFAULT 1,

    -- The block content
    content              TEXT NOT NULL,   -- prose narrative summary
    continuity_checklist JSONB,           -- [{name, type, attributes[], last_known_state, narrative_weight}]

    -- Retrieval
    embedding_vec   vector(1536),
    metadata        JSONB DEFAULT '{}',  -- type-specific extra data

    created_at  TIMESTAMP DEFAULT now(),
    updated_at  TIMESTAMP DEFAULT now(),

    UNIQUE (campaign_id, block_type, entity_id)
);

CREATE INDEX idx_context_blocks_campaign ON context_blocks(campaign_id);
CREATE INDEX idx_context_blocks_type ON context_blocks(campaign_id, block_type);
CREATE INDEX idx_context_blocks_entity ON context_blocks(campaign_id, block_type, entity_id);
CREATE INDEX idx_context_blocks_embedding ON context_blocks USING ivfflat (embedding_vec vector_cosine_ops);
```

### Continuity Checklist Schema (JSON)
```json
{
  "entities": [
    {
      "name": "orange cat named Miso",
      "type": "object",
      "attributes": ["orange", "three-legged", "answers to Miso"],
      "last_known_state": "alive, recovering at Kami's apartment",
      "narrative_weight": "high",
      "first_appeared_turn": 7
    }
  ],
  "last_generated_turn": 42
}
```
`narrative_weight`: `high` (plot-relevant), `medium` (character-relevant), `low` (atmospheric).

---

## New Files

```
src/context/
    context_blocks.py          # ContextBlockStore — CRUD, retrieval
    block_generator.py         # ContextBlockGenerator — LLM generation

src/agents/
    context_block_tools.py     # Director/KA tool definitions for block retrieval

data/prompts/
    context_block_generator.md # System prompt for block generation LLM
```

---

## Implementation Details

### `src/context/context_blocks.py` — ContextBlockStore

```python
class ContextBlockStore:
    def __init__(self, campaign_id: int): ...

    def get(self, block_type: str, entity_id: str) -> dict | None
    def upsert(self, block_type, entity_id, entity_name, content,
               continuity_checklist, first_turn, last_updated_turn,
               status="active", metadata=None) -> int
    def close_block(self, block_type: str, entity_id: str) -> None
    def search(self, query: str, block_type: str | None = None,
               limit: int = 5) -> list[dict]
    def get_active_by_type(self, block_type: str) -> list[dict]
    def get_for_session_start(self) -> dict
    # Returns: {current_arc_block, active_quest_blocks, recent_thread_blocks}
```

### `src/context/block_generator.py` — ContextBlockGenerator

Single class, one public method per block type. Takes source material, calls fast model with a specialized system prompt, returns `(content: str, continuity_checklist: dict)`.

```python
class ContextBlockGenerator:
    async def generate_arc_block(self, arc_name, turn_narratives,
                                  existing_block=None) -> tuple[str, dict]
    async def generate_thread_block(self, seed, relevant_turns,
                                     memories, existing_block=None) -> tuple[str, dict]
    async def generate_quest_block(self, quest, relevant_turns,
                                    existing_block=None) -> tuple[str, dict]
    async def generate_npc_block(self, npc, memories, relevant_turns,
                                  existing_block=None) -> tuple[str, dict]
    async def generate_faction_block(self, faction, memories, relevant_turns,
                                      existing_block=None) -> tuple[str, dict]
```

`existing_block` is passed when updating (append model) vs. None for fresh creation.

### Generator System Prompt (key requirements)

The prompt must instruct the LLM to:
1. Write as a continuity supervisor, not a narrator — factual but narrative
2. **Preserve all named entities with exact attributes** — if it's orange, write orange; if it's named Miso, write Miso. No compression of proper nouns or physical descriptors.
3. Identify and extract all named entities into the continuity checklist
4. Mark `narrative_weight` based on how much story weight the entity has carried
5. For updates (existing_block provided): write a new version that incorporates the new events — do not just append; rewrite as a coherent whole

### Generation Strategy: Selective Transcript Retrieval

Don't pass the full transcript. For each block type, pull targeted content:

| Block Type | Source Material |
|-----------|----------------|
| Arc | `state.search_turn_narratives(turn_range=(arc_start, arc_end), limit=50)` |
| Thread | `state.search_turn_narratives(npc=seed.related_npcs, limit=20)` + seed memories |
| Quest | `state.search_turn_narratives(turn_range=(created_turn, now), location=quest.related_locations, limit=20)` |
| NPC | `memory.search(npc_name, limit=15)` + `state.get_npc_trajectory()` + 10 recent turns with NPC |
| Faction | `memory.search(faction_name, limit=10)` + faction DB record + 10 turns mentioning faction |

---

## Integration Points

### 1. Director Tools (`src/agents/context_block_tools.py`)

Add to **Director and KA** tool registries:
```
get_context_block(block_type, entity_id)  → block content + continuity checklist
search_context_blocks(query, block_type?) → list of matching blocks
```

Director already searches memories and turns. Context blocks become the *first* retrieval call for understanding an entity — `search_turn_history` and memory search become the *fallback* for specific details not captured in the block.

KA also receives context blocks via passive injection (NPC checklists via NPC cards, quest blocks when quest progress is occurring in the scene — see §3 and §11). The tools are available as a fallback for anything not pre-injected: faction blocks, past arc blocks, thread payoffs the pipeline didn't anticipate. High-capability models won't make redundant tool calls for data already in context.

**Prompts path:** Generator prompt lives at `prompts/context_block_generator.md` (root-level `prompts/` directory, where the registry auto-discovers `.md` files). Not `data/prompts/`.

### 2. Session Startup Injection (`src/core/orchestrator.py`)

At session start, `ContextBlockStore.get_for_session_start()` returns:
- Current arc block (if arc is active and block exists) → injected into GameContext
- Active quest blocks (up to 3, most recently updated) → available for Director startup
- Any thread blocks marked `callback` (ready for payoff) → flagged for Director

These are NOT injected every turn — only at session startup, same as how Director startup reads the campaign bible.

### 3. Quest Block Pre-injection for KA (`src/core/_turn_pipeline.py`)

When the pipeline detects quest progress occurring in the current turn (objective completing, status changing), load the relevant quest block and inject it into KA's context alongside the active scene. This parallels NPC checklist injection — KA gets the block passively so it doesn't need to call a tool in the common case. The `get_context_block` tool remains available for anything the pipeline didn't anticipate.

### 4. NPC Block Auto-Injection (`src/core/_turn_pipeline.py`)

When `get_present_npc_cards()` is called for NPCs in the active scene, check if any NPC has a context block. If so, attach the block's continuity checklist to the NPC card (not the full prose — just the checklist). This gives the KA exact attribute references without a full prose injection every turn.

### 4. Arc Close Trigger (`src/db/_character.py`, `update_world_state()`)

When `arc_phase` transitions to `DENOUEMENT`, or when a new `arc_name` is set (old arc replaced), trigger arc block generation for the closing arc. Fire and forget (background task).

**Guard:** `update_world_state()` handles many field changes. The trigger must check that `arc_phase` is *changing to* DENOUEMENT, or that `arc_name` is *different from* the current value — not just that the function was called. The existing phase-change guard at `_character.py:184` already does this check; piggyback on it rather than adding a second comparison.

### 5. Quest Trigger (`src/db/_world.py`)

After `update_quest_status()` and `update_quest_objective()`, trigger a quest block update. Fire and forget.

### 6. NPC Trigger (`src/db/_npc.py`)

After `increment_npc_scene_count()`, check if `scene_count` just crossed 3. If so, schedule NPC block creation. Also trigger creation if `affinity` crosses ±30 for the first time (catches NPCs that become plot-relevant before accumulating 3 scenes). At session end, update blocks for all NPCs with new scenes this session.

**Session-end hook:** The orchestrator's session teardown needs to track NPCs that appeared this session and flush NPC block updates. Add a `session_npc_updates: set[str]` to the turn pipeline's session state, populated by `increment_npc_scene_count()`, consumed at teardown.

### 7. Thread Trigger (`src/core/foreshadowing.py`)

After `mention_seed()`, if block exists for this seed, schedule an update. After status → `callback`, create or update block. After status → `resolved`, close block and do a final update.

### 8. RecapAgent Enhancement

Pass arc blocks to RecapAgent instead of (or in addition to) raw turn narratives when summarizing past arcs. The RecapAgent already handles `arc_history` from the campaign bible — arc blocks are a richer version of that data.

---

## Generation Timing

All block generation is **fire-and-forget** via `safe_create_task()`. Never block a turn on block generation.

| Event | Block Action | Timing |
|-------|-------------|--------|
| NPC scene_count reaches 3 | Create NPC block | Background, after turn |
| NPC appears in session | Update NPC block | Background, at session end |
| Quest created | Create quest block | Background, after creation |
| Quest objective completes | Update quest block | Background, after update |
| Quest closes | Final update + close block | Background |
| Thread reaches `callback` | Create/update thread block | Background, after status change |
| Thread resolved | Final update + close | Background |
| Arc phase → DENOUEMENT | Create/update arc block, close | Background |
| New arc_name set (old arc ends) | Same as above | Background |
| Session end, arc still active | Update arc block if ≥10 turns since last | Background |

---

## What This Does NOT Replace

- `campaign_memories` — still the per-fact store, still heat-decaying, still retrieved every turn for hot memories. Context blocks don't replace facts; they organize the *narrative meaning* of those facts.
- `search_turn_narratives` tool — still the forensic tool. Context blocks handle understanding; transcript search handles verification and specific detail retrieval.
- NPC DB fields (affinity, milestones, personality) — still the source of truth for structured state. Block generation reads these as inputs.
- Campaign Bible — still the Director's planning document (arc intentions, voice patterns). Arc blocks are retrospective (what happened); the Bible is prospective (what's planned).

---

## Implementation Order

1. **DB migration** — add `context_blocks` table
2. **`ContextBlockStore`** — CRUD, search, retrieval methods
3. **Generator prompt** — write `prompts/context_block_generator.md`
4. **`ContextBlockGenerator`** — LLM generation for each block type
5. **Quest trigger** — simplest integration, quest lifecycle is well-defined
6. **NPC trigger** — hook `increment_npc_scene_count()` + affinity threshold; add session-end teardown hook
7. **NPC continuity checklist injection** — attach checklist to NPC cards in `get_present_npc_cards()` (high KA value, clean hook, block data already exists from step 6)
8. **Director + KA tools** — `get_context_block`, `search_context_blocks` wired into both agent tool registries
9. **Session startup injection** — `get_for_session_start()` + GameContext integration
10. **Arc trigger + Faction trigger** — arc close detection in `update_world_state()`; faction hooks in `set_faction_relationship()` and `update_faction_reputation()` (implement together, same complexity tier)
11. **Thread trigger** — requires foreshadowing status hook
12. **RecapAgent integration** — use arc blocks for multi-arc recaps
13. **KA voice journal** — KA writes end-of-session style annotation (established phrases, prose register, recurring imagery, tone calibration notes from meta conversations); injected into KA context at session open alongside profile DNA. New `voice_journal` field on `CampaignBible` or dedicated table. Hook in orchestrator session close.
14. **Director session memo** — Director writes structured end-of-session memo (arc position, seeds ready for payoff, NPC spotlight debt, creative decisions to carry forward); injected before campaign bible read at next session startup. Seeds the Director's continuity so the bible becomes reference archive rather than primary reconstruction source.

---

## Open Questions (Decide Before Implementation)

**Q1: Append vs. rewrite on update?**
Option A: Rewrite the whole block fresh from source material each update (consistent quality, higher cost). Option B: Append new "chapter" to existing prose, consolidate every N updates (cheaper, may drift in quality). **Decision: Rewrite.** Pass `existing_block.last_updated_turn` to the source retrieval query so only turns *since* that checkpoint are pulled — not the full history again. Ask the generator to integrate the new events into the existing block as a coherent whole. This keeps quality consistent while bounding the retrieval window.

**Q2: What's the NPC block creation threshold?**
`scene_count >= 3` is proposed. Could also be: first time NPC speaks a significant line, first time NPC has an emotional milestone, or when Director promotes from transient to catalog. Multiple triggers are fine — block creation is idempotent.

**Q3: How are context blocks surfaced to the player?**
They're internal — the player never sees them directly. But the "last time on..." message could be enriched with arc block content, and the "world info" panel (if it exists) could surface quest blocks. Out of scope for initial implementation.

**Q4: Block size limits?**
Proposed: `content` max 1,500 tokens. Generator prompt should enforce this. Continuity checklist max 20 entities per block. If an entity (esp. a long-running arc) would exceed this, the block should summarize by narrative weight — preserve `high` weight entities verbatim, compress `low` weight entities to a single phrase.

**Q5: Faction block triggers?**
Faction lifecycles are less well-defined than quests or NPCs. Proposed: generate block when `pc_is_member` becomes true, or when `influence_score > 20`, or when Director explicitly references a faction in planning. Update at arc close for any faction with `influence_score > 10`.

**Note:** Faction influence changes are driven by `set_faction_relationship()` and `update_faction_reputation()` in `src/db/_world.py`. The trigger hook belongs in both. Faction blocks are lower priority than NPC/quest blocks but should not be deferred indefinitely — factions can go several arcs without a trigger if the hooks aren't wired early. Recommend implementing faction triggers alongside arc triggers (step 10), not as an afterthought.
