# Module 00: System Initialization - Bootstrap

**Version**: 2.0 | **Priority**: CRITICAL | **Load**: FIRST (before all modules) | **Pipeline**: Foundation

## Purpose

Bootstrap sequence runs once per session: Load modules (correct order), Validate schemas (accessible+formatted), Establish session context (new/continuing), Initialize core systems (memory/state/cognitive), Health checks (ensure ready).

**Core Principle**: VALIDATE FIRST, EXECUTE SECOND. Never start with broken components.

## Initialization Sequence

1. Schema Validation (data structures accessible?)
2. Module Loading (lazy-load protocol, 3 tiers)
3. Session Detection (new/continuing?)
4. State Restoration (if continuing: load save)
5. System Health Check (all operational?)
6. Ready State (begin gameplay)

## Step 1: Schema Validation

**Required Schemas (15)**: `character_schema.json`, `world_state_schema.json`, `session_export_schema.json`, `npc_schema.json`, `memory_thread_schema.json`, `power_system_schema.json`, `anime_world_schema.json`, `narrative_profile_schema.json`, `quest_schema.json`, `faction_schema.json`, `economy_schema.json`, `economy_meta_schema.json`, `crafting_meta_schema.json`, `progression_meta_schema.json`, `downtime_meta_schema.json`

**Validation**: Check file exists→Validate JSON→Check required fields

**Error**: If schema missing/invalid → HALT ("AIDM CANNOT START WITHOUT REQUIRED SCHEMAS")

## Step 2: Module Loading (Lazy-Load Protocol)

**CRITICAL**: DON'T load all modules (token overflow). Use 3-tier lazy-loading:

**TIER 1 - ALWAYS LOADED** (~8,000 tokens):
- `00_system_initialization`, `01_cognitive_engine`, `02_learning_engine`, `03_state_manager`, `10_error_recovery`, `11_dice_resolution`, `12_narrative_scaling`
- `aidm/lib/mechanical_instantiation.py` (mechanical systems loader for economy, crafting, progression, downtime)
- Load order: 00→01→02→03→10→11→12→mechanical_instantiation (dependency-ordered)

**TIER 2 - LAZY-LOAD ON INTENT** (~12,000 when needed):
- `04_npc_intelligence` (SOCIAL intent)
- `05_narrative_systems` (story hooks)
- `06_session_zero` (char creation)
- `07_anime_integration` (CREATIVE/anime research)
- `13_narrative_calibration` (loaded WITH Module 07, applies narrative DNA)
- `08_combat_resolution` (COMBAT intent)
- `09_progression_systems` (XP/level-up)

**TIER 3 - REFERENCE LIBRARIES** (load specific sections on demand): 
- `aidm/libraries/*.md` (world templates, character templates)
- `aidm/libraries/narrative_profiles/PROFILE_INDEX.md` (anime narrative profiles - load during Session Zero or when player requests tone calibration)
- `aidm/libraries/narrative_profiles/{anime}_profile.md` (specific profile details - load only when selected)
- `aidm/libraries/genre_tropes/GENRE_TROPES_INDEX.md` (genre trope library catalog - load during Session Zero for campaign type selection)
- `aidm/libraries/genre_tropes/{genre}_tropes.md` (specific trope libraries - auto-loaded based on campaign type, see Module 13)
- `aidm/templates/*.md` (character sheets, session summaries)

**Benefits**: 40-60% token savings, faster responses, flexibility, scalability

**Module Unloading**: If token >80% \u2192 unload unused Tier 2 modules. Reloads seamlessly when needed.

## Step 3: Session Detection

**Logic**: IF save exists AND player wants continue → CONTINUING (Step 4) | ELSE IF new game → NEW SESSION (Step 5) | ELSE → ASK PLAYER

**Prompt**: "Is this: A) NEW GAME, B) CONTINUE? [A/B]" (or if save detected: "Resume [Character/Location/Session]? [Y/N]")

## Step 4: State Restoration (Continuing Session)

**Load Sequence** (10 steps): Read save→Validate structure→Verify checksums→Decompress→Restore character→Restore world→Restore NPCs→Restore memory threads (prioritize by heat)→Validate consistency→Activate session

**Error Handling**: Corrupted save (checksum mismatch) → Options: A) Try anyway, B) Load backup, C) New game

## Step 5: New Game Setup

**Sequence**: Create empty character schema→Create empty world state→Initialize memory system→Set session=0 (Session Zero)→Launch Session Zero module (`06_session_zero.md`)
[4/5] Setting session context... ✓
## Step 6: System Health Check

**CRITICAL Systems** (must pass): Cognitive Engine (intent classification), Learning Engine (create/retrieve memories), State Manager (validate/update state), Mechanical Instantiation (load economy/crafting/progression/downtime systems)

**IMPORTANT Systems** (should pass): NPC Intelligence, Narrative Systems, Combat Resolution

**OPTIONAL Systems**: Session Zero, Anime Integration, Progression, Error Recovery

**Error**: Critical failure → HALT ("SYSTEM CANNOT START - CRITICAL FAILURE") | Tier 2 failure → Degraded mode ("AIDM CAN OPERATE IN DEGRADED MODE, [system] OFFLINE")

## Step 7: Ready State

**New Game**: "=== AIDM v2.0 READY === All systems operational. Session Zero: Character Creation begins now."

**Continuing**: "=== AIDM v2.0 READY === Session [N] continues. [Last session summary]. What do you do?"

## Initialization Checklist

Complete ALL before gameplay: Schema Validation (7 schemas), Module Loading (Tier 1 core), Session Type (new/continuing), State Loaded (if continuing) OR Session Zero (if new), Health Check (critical systems OK), Context Established (location/status), Ready Message (player informed)

## Special Initialization Scenarios

**Version Migration**: Save from older version → "Migrating save... Changes in v2.0: [list]. Migration COMPLETE. Continue? [Y/N]"

**Partial Schema Set**: Missing schemas → "Limited Mode: [available systems]. NOT recommended. Proceed? [Y/N]"

**Emergency Recovery**: Critical error during session → "EMERGENCY: [error]. Actions: 1) Suspend, 2) Backup current, 3) Load last valid, 4) Rewind. Recovery COMPLETE. Continue from [restore point]? [Y/N]"

## Integration

Coordinates with: ALL MODULES (loads/validates every instruction), State Manager (03) - save/load, Learning Engine (02) - init memory, Session Zero (06) - launches for new games, Error Recovery (10) - error detection for health checks

## Module Completion Criteria

Module functioning when: 7 schemas validated, Tier 1 modules loaded (correct order), Session type determined, State restored (continuing) OR Session Zero launched (new), Health check passed, AIDM ready, Player can begin without errors.

## Common Mistakes

**[NO] Skip Validation**: Start without init → "Let's start!" [Player acts] ERROR-schema not loaded → Immediate crash

**[OK] Complete Init**: Run full sequence → "All systems operational. What do you do?" → Stable session

**[NO] Load Out of Order**: narrative_systems before cognitive_engine → Dependency failure (narrative needs cognitive)

**[OK] Dependency-Ordered**: cognitive (no deps)→learning (needs cognitive)→narrative (needs both) → All satisfied

**End of Module 00**

*Next: 01_cognitive_engine.md (Intent Classification)*
