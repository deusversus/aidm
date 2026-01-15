# Module 03: State Manager - Game State Persistence & Validation

**Version**: 2.0 | **Priority**: CRITICAL | **Load**: 3rd (after Cognitive+Learning) | **Pipeline**: Mechanical

**Purpose**: Source of truth for game state (character/world/NPCs/quests). Handles save/load and validates all state changes. **Core Principle**: Maintain CONSISTENT and VALID state at all times.

---

## State Architecture

**5 Components** (must sync): 1) CHARACTER (resources/skills/inventory/progression/**narrative_profile** in character_schema.json), 2) WORLD (time/locations/factions/economy/events in world_state_schema.json), 3) NPCS (locations/schedules/affinities/flags in npc_schema.json×N), 4) MEMORY (threads/heat/compression in memory_thread_schema.json×N), 5) NARRATIVE_PROFILE (scales/tropes/scaffolding/adjustments tracked in character_schema.narrative_profile section)

---

## Narrative Profile State Tracking

**Purpose**: Track active narrative calibration from Module 13 for consistent tone/pacing across sessions. **CRITICAL for generated profiles** (must persist full data, not just file reference).

### State Structure (Add to character_schema.json)

```json
{
  "narrative_profile": {
    "profile_id": "narrative_dandadan",
    "profile_type": "pre-made",  // "pre-made" or "generated"
    "profile_source": "aidm/libraries/narrative_profiles/dandadan_profile.md",
    
    // Narrative Scales (0-10, extracted from Module 13)
    "scales": {
      "introspection_vs_action": 3,
      "comedy_vs_drama": 4,
      "simple_vs_complex": 6,
      "power_fantasy_vs_struggle": 4,
      "explained_vs_mysterious": 4,
      "fast_paced_vs_slow_burn": 2,
      "episodic_vs_serialized": 7,
      "grounded_vs_absurd": 2,
      "tactical_vs_instinctive": 5,
      "hopeful_vs_cynical": 5
    },
    
    // Enabled Tropes (15 switches, ON/OFF)
    "tropes": {
      "tournament_arc": false,
      "training_montage": true,
      "power_of_friendship": true,
      "mentor_death": false,
      "chosen_one": false,
      "tragic_backstory": true,
      "redemption_arc": false,
      "betrayal": false,
      "sacrifice": true,
      "transformation": true,
      "forbidden_technique": false,
      "time_loop": false,
      "false_identity": false,
      "ensemble_focus": true,
      "slow_burn_romance": true
    },
    
    // Mechanical Configuration (Active System Rules)
    "mechanical_config": {
      "economy": {
        "type": "scarcity_based",
        "config": {
          "currency_name": "Rations/Bullets",
          "inflation_rate": 0.05,
          "scarcity_multiplier": 1.5
        }
      },
      "crafting": {
        "type": "monster_harvesting",
        "config": {
          "harvest_difficulty": "hard",
          "preservation_required": true
        }
      },
      "progression": {
        "type": "milestone",
        "config": {
          "milestone_frequency": "arc_based",
          "training_required": true
        }
      },
      "downtime": {
        "type": "training_arcs",
        "config": {
          "training_efficiency": 1.0,
          "risk_of_injury": true
        }
      }
    },

    // Mechanical Scaffolding (Legacy/Helper mappings)
    "mechanical_scaffolding": {
      "power_level_model": "accelerated",  // "instant_op" / "accelerated" / "modest"
      "growth_tier_target": "tier_3_by_session_15",
      "xp_model": "high",  // "high" (1K-1.5K) / "standard" (600-900) / "low" (300-500) / "milestone"
      "stat_framework": "6-stat",  // "3-stat" / "6-stat" / "6-stat+custom"
      "power_systems": ["psionic_psychic_systems", "soul_spirit_systems"],
      "combat_narration_style": {
        "spectacle_percent": 70,
        "tactical_percent": 20,
        "banter_percent": 10
      },
      "attribute_priorities": ["DEX", "CON", "INT"],
      "resource_formulas": {
        "mp_formula": "power_level * 3",
        "sp_formula": "10_activation_plus_5_per_round"
      }
    },
    
    // Adjustments Log (Player preferences during play)
    "adjustments_log": [
      {
        "session": 3,
        "adjustment": "Reduced drama scale 6→4",
        "reason": "Player: 'needs more comedy, less serious'",
        "timestamp": "2025-10-01T14:30:00Z"
      },
      {
        "session": 5,
        "adjustment": "Increased absurdity 8→9",
        "reason": "Player enjoyed weirder alien encounters",
        "timestamp": "2025-10-03T16:45:00Z"
      }
    ],
    
    // Metadata
    "last_calibration_date": "2025-10-01T12:00:00Z",
    "calibration_source": "session_zero",  // "session_zero" / "mid-campaign" / "generated"
    "generation_method": null  // null for pre-made, "module_07_research" for generated
  }
}
```

### Pre-Made vs Generated Profiles

**Pre-Made Profile** (DanDaDan, Hunter x Hunter, etc.):

- `profile_type`: "pre-made"
- `profile_id`: Reference ID (e.g., "narrative_dandadan")
- `profile_source`: File path (can load from file on session restart)
- Scales/tropes: Load from file, store in state for adjustments
- Mechanical scaffolding: Load from file's scaffolding section
- **Lightweight storage**: Only ID + adjustments persist, reference file for base data

**Generated Profile** (Chainsaw Man, Frieren, custom anime):

- `profile_type`: "generated"
- `profile_id`: Generated ID (e.g., "narrative_generated_chainsaw_man")
- `profile_source`: null (no file reference)
- Scales/tropes: **MUST persist full data** (can't reload from file)
- Mechanical scaffolding: **MUST persist all mappings** (generated via Module 13 rules)
- **Full storage**: ALL data stored in state (no file to reference)
- `generation_method`: "module_07_research" (shows how it was created)

### Validation Rules

**On State Load** (session restart):

```text
1. Check profile_type
2. IF "pre-made":
   - Validate profile_id exists in library
   - Load base data from file
   - Apply adjustments_log on top
   - Warn if file missing (suggest fallback or regeneration)
3. IF "generated":
   - Validate scales/tropes/scaffolding present in state
   - Error if missing (can't reload, no file reference)
   - Suggest fallback to similar pre-made profile
4. Validate scales (all 0-10)
5. Validate tropes (all boolean)
6. Validate mechanical_config (economy, crafting, progression, downtime types valid)
7. Validate mechanical_scaffolding fields present
```

**On Profile Change** (mid-campaign calibration):

```text
1. Validate new scales/tropes
2. Create adjustment log entry
3. Update mechanical_scaffolding if mappings change
4. Store in NARRATIVE_STYLE memory (Module 02)
5. Apply atomically
```

### Export/Import Handling

**Export (Save File)**:

```json
{
  "session_export_schema": {
    "character": {
      "narrative_profile": {
        // FULL narrative_profile structure here
        // For pre-made: ID + adjustments (lightweight)
        // For generated: FULL data (critical, no file reference)
      }
    }
  }
}
```

**Import (Load File)**:

```text
1. Load narrative_profile from export
2. Validate profile_type
3. IF pre-made → Load base from file, apply adjustments
4. IF generated → Use state data directly (no file)
5. Validate all fields
6. Restore to active state
```

### Integration with Module 13

**Session Zero Flow**:

```text
1. Module 06 (Session Zero) asks: "Narrative calibration?"
2. Player chooses:
   a) Pre-made profile (DanDaDan, HxH, etc.)
      → Load from file
      → Store ID + base scales/tropes in state
      → Load mechanical scaffolding from profile
   
   b) Generate from anime (Chainsaw Man, etc.)
      → Module 07 research anime
      → Module 13 extract scales/tropes
      → Module 13 apply scaffolding rules (map to mechanics)
      → Store FULL generated profile in state
   
   c) Custom/No calibration
      → Default scales (all 5), no tropes enabled
      → Standard mechanical defaults
      → Store minimal profile in state

3. Apply mechanical scaffolding:
   - Set XP model in Module 09
   - Set power level model in Module 12 Narrative Scaling
   - Configure combat narration in Module 08
   - Select power systems from libraries

4. Save to character_schema.narrative_profile
```

**Mid-Campaign Adjustment Flow**:

```text
1. Player: "Can we add more comedy? This is too serious."
2. Module 02 creates NARRATIVE_STYLE memory (heat 70)
3. Module 03 updates state:
   - scales.comedy_vs_drama: 6 → 4 (more comedy)
   - adjustments_log: Add entry (session X, reason, timestamp)
4. Module 13 applies change to narration
5. Export updated profile to save file
```

### Critical Requirements

**MUST PERSIST for Generated Profiles**:

- ✅ All 10 scales (full values)
- ✅ All 15 tropes (full switches)
- ✅ Complete mechanical_scaffolding (all mappings)
- ✅ Adjustments log (player preferences)
- ✅ Generation metadata (how it was created)

**CAN REFERENCE for Pre-Made Profiles**:

- ✅ Profile ID only (lightweight)
- ✅ Load base data from file on restart
- ✅ Store adjustments in state
- ⚠️ Warn if file missing (handle gracefully)

**Error Handling**:

```text
ERROR: Pre-made profile file missing
→ Check: Does dandadan_profile.md exist?
→ NO: Offer options:
   a) Regenerate via Module 07+13 (convert to generated type)
   b) Use similar profile (suggest JJK for DanDaDan)
   c) Reset to defaults
→ Log warning, don't crash session
```

### World State Structure - Mechanical Systems

The `world_state.mechanical_systems` field tracks active gameplay mechanics initialized from the narrative profile during Session Zero (Phase 0.7). These systems are **instantiated** from profile configs at runtime.

**Schema Reference**: `world_state_schema.json` line 350-358

```json
{
  "mechanical_systems": {
    "economy": {
      "$ref": "economy_meta_schema.json"
    },
    "crafting": {
      "$ref": "crafting_meta_schema.json"
    },
    "progression": {
      "$ref": "progression_meta_schema.json"
    },
    "downtime": {
      "$ref": "downtime_meta_schema.json"
    }
  }
}
```

#### Mechanical Systems Instantiation Flow

**Step 1: Profile Config (Narrative Profile)**

Profile contains tiny config blocks (10-15 lines each):

```json
{
  "economy": {
    "type": "fiat_currency",
    "parameters": {
      "currency_name": "Jenny",
      "starting_amount": 200,
      "scarcity": "normal"
    }
  },
  "crafting": {
    "type": "skill_based",
    "parameters": {
      "craft_focus": "cards",
      "skill_stat": "INT"
    }
  },
  "progression": {
    "type": "mastery_tiers",
    "parameters": {
      "system_name": "Nen",
      "mastery_levels": ["Novice", "Practitioner", "Expert", "Master"],
      "categories": ["Enhancement", "Transmutation", "Emission"]
    }
  },
  "downtime": {
    "enabled_modes": ["training_arcs", "social_links"],
    "default_mode": "training_arcs"
  }
}
```

**Step 2: Instantiation (Phase 0.7 in Session Zero)**

Use `aidm/lib/mechanical_instantiation.py` to expand configs:

```python
from aidm.lib.mechanical_instantiation import instantiate_mechanical_systems

# Load profile config
profile_config = load_narrative_profile("hunter_x_hunter")

# Instantiate systems
mechanical_systems = instantiate_mechanical_systems(profile_config["mechanical_config"])

# Result: Full system objects with defaults, mechanics, validation
```

**Step 3: Expanded System Objects (Stored in world_state)**

```json
{
  "mechanical_systems": {
    "economy": {
      "type": "fiat_currency",
      "active": true,
      "currency_name": "Jenny",
      "starting_amount": 200,
      "scarcity": "normal",
      "inflation_rate": "none",  // Default
      "special_mechanics": [],    // Default
      "mechanics": {
        "transactions": "standard_merchant_system",
        "loot_generation": "currency_drops",
        "quest_rewards": "currency_based"
      }
    },
    "crafting": {
      "type": "skill_based",
      "active": true,
      "craft_focus": "cards",
      "skill_stat": "INT",
      "quality_tiers": ["Poor", "Common", "Fine", "Masterwork"],  // Default
      "mechanics": {
        "crafting_action": "skill_check_with_materials",
        "success_determination": "roll_vs_difficulty",
        "output": "variable_quality_item"
      }
    },
    "progression": {
      "type": "mastery_tiers",
      "active": true,
      "system_name": "Nen",
      "mastery_levels": ["Novice", "Practitioner", "Expert", "Master"],
      "categories": ["Enhancement", "Transmutation", "Emission"],
      "advancement_method": "practice_hours",  // Default
      "mechanics": {
        "leveling": "tier_based_unlock",
        "skills": "mastery_level_determines_access",
        "power_curve": "exponential_with_conditions"
      }
    },
    "downtime": {
      "enabled_modes": ["training_arcs", "social_links"],
      "default_mode": "training_arcs",
      "time_tracking": true,  // Default
      "active": true,
      "training_config": {  // Auto-populated for training_arcs
        "time_requirement": "weeks",
        "mentor_required": false,
        "breakthrough_chance": true
      },
      "social_config": {  // Auto-populated for social_links
        "time_slots": 2,
        "benefits": ["affinity_bonuses", "story_unlocks"]
      }
    }
  }
}
```

#### Integration Patterns

**Economy System Integration**:
- **Module 04 (NPC Intelligence)**: Merchants use `mechanical_systems.economy.mechanics.transactions` to determine behavior
- **Module 08 (Combat Resolution)**: Loot drops use `mechanical_systems.economy.mechanics.loot_generation`
- **Module 09 (Progression)**: Quest rewards use `mechanical_systems.economy.mechanics.quest_rewards`
- **Example**:
  ```text
  IF economy.type == "fiat_currency":
    Generate currency_drops on enemy death (amount based on scarcity)
  ELIF economy.type == "barter":
    Generate item_drops only (no currency)
  ELIF economy.type == "none":
    Generate narrative_only rewards (reputation, story progression)
  ```

**Crafting System Integration**:
- **Module 09 (Progression)**: Crafting skill progression uses `crafting.skill_stat`
- **Module 05 (Narrative)**: Crafting scenes generated based on `crafting.mechanics.crafting_action`
- **Inventory System**: Material tracking based on `crafting.material_categories` (if recipe_based)
- **Example**:
  ```text
  Player: "I want to craft a Greed Island card"
  
  IF crafting.type == "skill_based":
    Roll skill_check(character.stats[crafting.skill_stat], difficulty)
    Success → Create item with quality_tier based on roll
    Failure → Consume materials, no output
  ELIF crafting.type == "recipe_based":
    Check if recipe known
    Check if materials available
    Execute combine_materials_with_recipe
  ```

**Progression System Integration**:
- **Module 09 (Progression)**: XP/leveling logic uses `progression.mechanics.leveling`
- **Module 08 (Combat)**: Power scaling uses `progression.mechanics.power_curve`
- **Module 12 (Narrative Scaling)**: Adjusts challenge based on progression type
- **Example**:
  ```text
  IF progression.type == "mastery_tiers":
    Track mastery_level per category
    Unlock abilities at tier thresholds
    Advancement requires training_arc or breakthrough
  ELIF progression.type == "milestone_based":
    Track milestone_events completion
    Grant power_grants when milestone achieved
    No XP tracking (narrative only)
  ELIF progression.type == "static_op":
    Disable progression (active=false)
    Character starts at starting_power_tier
    Growth_focus determines alternate advancement (technique variety, control)
  ```

**Downtime System Integration**:
- **Module 04 (NPC Intelligence)**: Social links modify NPC relationships
- **Module 09 (Progression)**: Training arcs grant skill/stat improvements
- **Module 05 (Narrative)**: Downtime scenes generated for enabled_modes
- **Example**:
  ```text
  IF "training_arcs" in downtime.enabled_modes:
    Offer training menu based on progression.system_name
    Time cost: downtime.training_config.time_requirement
    Rewards: Stat increases, skill unlocks, breakthrough chance
  
  IF "social_links" in downtime.enabled_modes:
    Offer NPC interaction menu
    Max interactions: downtime.social_config.time_slots
    Benefits: downtime.social_config.benefits
  
  IF downtime.enabled_modes == []:
    Skip downtime phase (action-only anime)
  ```

#### State Validation for Mechanical Systems

**Validation Hooks**:

```text
BEFORE Loading Mechanical Systems (Session Zero Phase 0.7):
1. Validate profile config against meta-schemas
2. Check all required parameters present for each type
3. Verify type enums match schema definitions
4. Confirm enabled_modes valid for downtime

DURING Gameplay:
1. Check system.active before executing mechanics
2. Validate operations allowed by system type
3. Ensure character.resources align with economy.mechanics
4. Verify progression advancement follows mechanics.leveling rules

EXAMPLE VALIDATION:
IF player attempts crafting:
  CHECK mechanical_systems.crafting.active == true
  IF false: "This anime world has no crafting system"
  
  CHECK crafting.type != "none"
  IF none: "Crafting is not available"
  
  EXECUTE crafting.mechanics.crafting_action
```

#### Debugging Mechanical Systems

**Common Issues**:

1. **System Inactive**: Check `mechanical_systems.{system}.active == true`
2. **Missing Parameters**: Verify instantiation populated defaults
3. **Type Mismatch**: Confirm profile config uses valid enum values
4. **Mechanics Not Applied**: Check integration points in other modules

**Debug Commands**:
```text
SHOW mechanical_systems
→ Displays all active systems and configurations

SHOW mechanical_systems.economy
→ Shows economy system details

VALIDATE mechanical_systems
→ Runs validation against meta-schemas
```

---

## Critical State Rules

**Rule 1: Single Source of Truth** - ONE authoritative source per data: HP/MP/SP→character_schema.resources, NPC Affinity→npc_schema.relationships.player_affinity, Location→character_schema.world_context.current_location, Time→world_state_schema.temporal, Quests→character_schema.quests. NEVER duplicate data.

**Rule 2: Validate Before Update** - ALL changes validate: Proposed→[Math possible? Logic consistent? World-legal? Constraint satisfied?]→Valid?[Apply+Update+Memory]:Invalid?[Reject+Explain+Alternatives]

**Rule 3: Atomic Updates** - ALL parts succeed OR NONE (rollback). Example: Cast spell→Check MP→Deduct MP→Roll damage→Apply damage→Update schemas→Create memory. ANY step fails→Rollback ALL.

---

## State Validation System

**Character Validation**: Resources (current≥0, current≤max unless temp_max, max>0, can pay costs), Inventory (weight≤capacity, qty≥0, no duplicate IDs unless stackable, equipped match slots), Skills (level≥0, XP≥0 & <next_level_xp, valid category, no duplicate IDs), Progression (level≥1, XP≥0, available points≥0), **Narrative Profile** (profile_type "pre-made" or "generated", pre-made→profile_id exists in library, generated→ALL scales/tropes/scaffolding present, scales 0-10, tropes boolean, mechanical_scaffolding valid models, adjustments_log sessions ascending)

**World Validation**: Temporal (time forward or explicit set, season↔date, moon follows cycle), Locations (exists, accessible, travel time reasonable), Factions (power 0-100, resources≥0, relationships -100 to +100), Economy (currency>0, market 0-100, price mods reasonable)

**NPC Validation**: Affinity (new -100 to +100, change justified, threshold events trigger), Location/Schedule (valid location, schedule allows activity, not in two places), Status (alive/dead consistent, temp flags expire, no conflicting flags)

---

## Pre-Commit Validation Hooks

**CRITICAL**: Before ANY state update, ALWAYS execute validation hooks to prevent invalid data propagation.

### Validation Hook Protocol

**CRITICAL**: Change Log format enables validation by providing before/after values and operation types.

```text
BEFORE updating ANY schema field:

1. LOAD CURRENT STATE
   - Read affected schema (character_schema/world_state/npc_schema)
   - Verify schema exists and is accessible
   - Check for locks/conflicts (concurrent updates)

2. VALIDATE CHANGE LOG ENTRY
   - **Before-Value Verification**: change.before == current_state[change.path]
     * If mismatch: DESYNC DETECTED, log error, abort transaction
     * Example: Change says before=85, state shows 90 → ERROR
   
   - **Operation Type Check**: change.operation valid for field type?
     * Numeric fields: set, add, subtract, multiply
     * String fields: set, replace
     * Array fields: append, remove, replace
     * Boolean fields: set
     * If invalid: HALT, notify player, suggest correct operation
   
   - **Type Check**: change.after matches schema field type?
     * Resources: number
     * Location: string
     * Inventory items: array of objects
     * If type mismatch: REJECT, log error
   
   - **Range Check**: change.after within min/max constraints?
     * HP: 0 ≤ after ≤ max
     * Affinity: -100 ≤ after ≤ +100
     * XP: after ≥ 0
     * If out of range: BLOCK, suggest clamping or alternative
   
   - **Constraint Check**: Change respects business rules?
     * Can't spend more resources than available
     * Can't exceed carry capacity
     * Can't use skills not learned
     * If constraint violated: FAIL validation, explain why
   
   - **Delta Verification** (numeric operations): before + delta == after?
     * Example: before=85, delta=-50, after=35 → 85-50=35 ✓
     * If mismatch: CALCULATION ERROR, log and reject
   
   - **Dependency Check**: Related fields consistent?
     * Equipment changes → Update weight
     * Level up → Update stats, HP/MP/SP max
     * NPC death → Update relationships, quests

3. CALCULATE NEW STATE (Already in Change Log)
   - Change Log contains pre-calculated after value
   - Verify calculation: before ⊕ operation ⊗ delta = after
   - Example operations:
     * add: 85 + 50 = 135
     * subtract: 85 - 50 = 35
     * multiply: 10 × 1.5 = 15
     * set: _ → 100 (direct assignment)
   - If verification fails: REJECT change, request recalculation

4. SCHEMA COMPLIANCE CHECK
   - New state conforms to schema definition?
   - Required fields still present?
   - No orphaned references (NPC ID exists, item ID valid)?
   - Relationships maintain referential integrity?

5. IF VALIDATION FAILS
   - HALT update immediately
   - Log validation error with full context:
     * Failed change entry (path, operation, before, after, reason)
     * Specific validation that failed (before-value mismatch, constraint violation, etc.)
     * Current state value (for comparison)
     * Timestamp
   - Notify player of blocking issue with specifics:
     * "Cannot cast Fire Bolt: Insufficient MP"
     * "Need: 50 MP, Have: 35 MP, Short: 15 MP"
     * "Alternatives: A) Cast Spark (20 MP), B) Use Mana Potion"
   - Suggest corrective action
   - DO NOT propagate invalid data
   - Preserve state (rollback if mid-transaction)

6. IF VALIDATION PASSES
   - Mark change.validated = true
   - Proceed to atomic update
   - Apply all changes together (all-or-nothing)
   - Log state transition:
     ```
     schema.path: before → after (operation, reason)
     character_schema.resources.mp.current: 85 → 35 (subtract -50, Fire Bolt cast)
     ```
   - Create memory if significant (heat index based on importance)
   - Update dependencies (cascades if needed)
```

### Example: Change Log Validation Flow

```json
INCOMING CHANGE LOG:
{
  "path": "resources.mp.current",
  "operation": "subtract",
  "before": 85,
  "after": 35,
  "delta": -50,
  "reason": "Fire Bolt cast",
  "validated": false
}

VALIDATION STEPS:
1. Load current state: resources.mp.current = 85
2. Before-value check: 85 == 85 ✓
3. Operation check: "subtract" valid for numeric field ✓
4. Type check: after=35 is number ✓
5. Range check: 35 >= 0 ✓, 35 <= max(230) ✓
6. Delta verification: 85 + (-50) = 35 ✓
7. Constraint check: Has 85 MP, costs 50, leaves 35 >= 0 ✓

RESULT: VALIDATION PASSED
- Set validated = true
- Apply change: resources.mp.current = 35
- Log: "resources.mp.current: 85 → 35 (-50, Fire Bolt cast)"
```

### Example: Validation Failure

```json
INCOMING CHANGE LOG:
{
  "path": "resources.mp.current",
  "operation": "subtract",
  "before": 35,
  "after": -15,
  "delta": -50,
  "reason": "Fire Bolt cast",
  "validated": false
}

VALIDATION STEPS:
1. Load current state: resources.mp.current = 35
2. Before-value check: 35 == 35 ✓
3. Operation check: "subtract" valid ✓
4. Type check: after=-15 is number ✓
5. Range check: -15 >= 0 ✗ FAIL

RESULT: VALIDATION FAILED
- Reason: After-value violates constraint (MP cannot be negative)
- Action BLOCKED
- State preserved: resources.mp.current = 35
- Notify player:
  "Cannot cast Fire Bolt: Insufficient MP
   Need: 50 MP
   Have: 35 MP
   Short: 15 MP
   
   Alternatives:
   A) Cast Spark (20 MP, 1d6 damage)
   B) Use Mana Potion (+50 MP, have 2)
   C) Basic Attack (0 MP, 1d8+3 damage)
   
   What do?"
```

### Common Validation Checks

**Resource Updates:**

```text
BEFORE: character_schema.resources.mp.current = 85
CHANGE: -50 (spell cost)
VALIDATE:
  - Cost <= current? 50 <= 85 (YES)
  - Result >= 0? 35 >= 0 (YES)
  - Result <= max? 35 <= 230 (YES)
APPLY: 85 → 35
LOG: "character_schema.resources.mp.current: 85 → 35 (-50, Fire Bolt)"
```

**Inventory Updates:**

```text
BEFORE: inventory.items[3] = {id: "potion_health", qty: 5}
CHANGE: -3 (use 3 potions)
VALIDATE:
  - Item exists? YES
  - Qty available? 3 <= 5 (YES)
  - Result >= 0? 2 >= 0 (YES)
  - Weight after: current_weight - (3 × item_weight) <= capacity? (YES)
APPLY: qty 5 → 2
IF qty reaches 0: Remove item from array
LOG: "character_schema.inventory.items[3].qty: 5 → 2 (-3, used)"
```

**Progression Updates:**

```text
BEFORE: progression = {level: 8, current_xp: 1200, next_level_xp: 20000}
CHANGE: +5000 XP (boss defeat)
VALIDATE:
  - XP gain > 0? YES
  - New total = 1200 + 5000 = 6200
  - Exceeds threshold? 6200 >= 20000? NO (still L8)
  WAIT - Check if using cumulative or per-level XP system
  IF cumulative total system: 
    - Total XP to reach L9 from L1 = 20,000
    - Current total = 15,000 (start of L8) + 1200 = 16,200
    - New total = 16,200 + 5000 = 21,200
    - Exceeds L9 threshold (20,000)? YES → Level up to L9
    - Overflow: 21,200 - 20,000 = 1,200 into L9
  IF per-level XP system:
    - Need 5,000 more XP to reach L9 (from 1200/20000)
    - Gain 5,000 → Exactly meets threshold? NO, still short
    Check Module 09 for correct system!
APPLY: Depends on correct threshold calculation
LOG: Must reference Module 09 progression tables
```

**NPC Relationship Updates:**

```text
BEFORE: npc.relationships.player_affinity = 45
CHANGE: +15 (quest success)
VALIDATE:
  - Change justified? (has event/reason) YES
  - New value in range? 45 + 15 = 60, -100 to +100? YES
  - Crosses threshold? 45 (Neutral) → 60 (Friendly)? YES
  - Trigger threshold event? Unlock friendly dialogue/quests
APPLY: 45 → 60, status "neutral" → "friendly"
TRIGGER: Relationship milestone cascade
LOG: "npc_schema.elena.player_affinity: 45 → 60 (+15, quest success, threshold: Friendly)"
```

### Rollback Protocol

**CRITICAL**: Change Log format enables atomic rollback by providing before-values and operation types.

```text
IF validation fails mid-update OR atomic transaction incomplete:

1. DETECT FAILURE
   - Validation error caught during pre-commit hooks
   - Constraint violation detected (negative resource, exceeded capacity)
   - Schema non-compliance (type mismatch, missing required field)
   - Cascading update failed (dependency error)
   - Before-value desync (change.before ≠ current state)

2. REVERSE CHANGE LOG OPERATIONS
   Change Logs contain all information needed for rollback:
   
   **Operation Reversal Rules**:
   - **set**: Restore change.before value
     * Before: location = "village_konoha"
     * Change: set → "forest_death"
     * Rollback: set → "village_konoha" (restore before)
   
   - **add**: Apply subtract with same delta
     * Before: HP = 45
     * Change: add +50 (HP → 95)
     * Rollback: subtract -50 (HP → 45)
   
   - **subtract**: Apply add with same delta
     * Before: MP = 85
     * Change: subtract -50 (MP → 35)
     * Rollback: add +50 (MP → 85)
   
   - **multiply**: Apply divide with same factor
     * Before: damage = 10
     * Change: multiply ×1.5 (damage → 15)
     * Rollback: divide ÷1.5 (damage → 10)
   
   - **append**: Remove appended element
     * Before: items = [item1, item2]
     * Change: append item3 → [item1, item2, item3]
     * Rollback: remove item3 → [item1, item2]
   
   - **remove**: Restore removed element from change.before
     * Before: items[5] = {id: "key", qty: 1}
     * Change: remove → items[5] deleted
     * Rollback: insert {id: "key", qty: 1} at index 5
   
   - **replace**: Restore change.before element
     * Before: weapon = {id: "iron_sword"}
     * Change: replace → {id: "steel_sword"}
     * Rollback: replace → {id: "iron_sword"}

3. ROLLBACK EXECUTION
   - Process Change Log in REVERSE order (last change first)
   - For each change in transaction:
     * Apply reverse operation using before-value
     * Verify rollback succeeded (state matches pre-transaction)
     * Log rollback step
   - Restore all affected schemas to pre-transaction state
   - Clear transaction log (mark as aborted)
   - Confirm state consistency (run validation on final state)

4. LOG ERROR WITH FULL CONTEXT
   - Error type (validation/constraint/cascade/desync)
   - Failed field path (schema.path)
   - Attempted change (operation, before → after, delta, reason)
   - Blocking reason (specific validation that failed)
   - Timestamp
   - Transaction ID (for debugging)
   - All changes in transaction (show what was attempted)

5. NOTIFY PLAYER WITH SPECIFICS
   - Clear error message: "State update failed: [specific reason]"
   - Current state preserved: "[key values unchanged]"
   - What was attempted: "[action that failed]"
   - Why it failed: "[constraint violated]"
   - Suggested alternatives: "A) [option1], B) [option2], C) [option3]"

6. CONTINUE GAMEPLAY
   - System remains stable (no corrupted data)
   - Player can retry with corrections
   - No data corruption or orphaned references
   - State guaranteed consistent (validated post-rollback)
   - Transaction atomicity maintained (all-or-nothing)
```

### Example 1: Simple Rollback (Single Change)

```text
  Attempted: Allocate 5 attribute points (only 2 available)
  
  Change Log:
  {
    "path": "progression.available_attribute_points",
    "operation": "subtract",
    "before": 2,
    "after": -3,
    "delta": -5,
    "reason": "Attribute allocation",
    "validated": false
  }
  
  Validation: FAIL (after=-3 violates constraint: must be >= 0)
  
  Rollback:
  - Reverse operation: add +5 to restore before-value
  - Final state: available_attribute_points = 2 (unchanged)
  
  Notify: "Cannot allocate 5 points: only 2 available. Allocate ≤2."
  
  Continue: Player re-allocates correctly (2 points or less)
```

### Example 2: Multi-Change Transaction Rollback

```text
  Attempted: Level up (L8 → L9) with cascading stat increases
  
  Transaction Change Log:
  1. {path: "progression.level", operation: "set", before: 8, after: 9}
  2. {path: "progression.current_xp", operation: "set", before: 6200, after: 0}
  3. {path: "progression.available_skill_points", operation: "add", before: 3, after: 5, delta: 2}
  4. {path: "progression.available_attribute_points", operation: "add", before: 8, after: 13, delta: 5}
  5. {path: "resources.hp.max", operation: "add", before: 120, after: 130, delta: 10}
  6. {path: "resources.mp.max", operation: "add", before: 230, after: 245, delta: 15}
  
  Change 5 validation: FAIL (hp.max cannot exceed 999, but calculation error caused overflow)
  
  Rollback (REVERSE ORDER):
  - Change 6: Subtract 15 from mp.max → 230
  - Change 5: Subtract 10 from hp.max → 120 (failed change, rollback anyway)
  - Change 4: Subtract 5 from available_attribute_points → restore 8
  - Change 3: Subtract 2 from available_skill_points → restore 3
  - Change 2: Set current_xp to 6200 (restore before)
  - Change 1: Set level to 8 (restore before)
  
  Final state: Level 8, XP 6200, no changes applied
  
  Log: "Transaction aborted: Level-up calculation error at hp.max. State preserved."
  
  Notify: "Level-up failed: HP calculation error. Please report this bug. Your progress is safe (L8, 6200 XP)."
  
  Continue: Fix calculation logic, retry level-up with corrected formula
```

### Example 3: Cascade Failure Rollback

```text
  Attempted: NPC death cascade (affects relationships, quests, factions)
  
  Transaction Change Log:
  1. {schema: "npc_schema", path: "zabuza.status", operation: "set", before: "alive", after: "dead"}
  2. {schema: "npc_schema", path: "zabuza.can_die", operation: "set", before: true, after: false}
  3. {schema: "character_schema", path: "relationships[4].status", operation: "set", before: "hostile", after: "deceased"}
  4. {schema: "character_schema", path: "quests.active[2].status", operation: "set", before: "active", after: "completed"}
  5. {schema: "world_state", path: "factions.mist_village.power", operation: "subtract", before: 75, after: 60, delta: -15}
  6. {schema: "world_state", path: "factions.leaf_village.power", operation: "add", before: 65, after: 75, delta: 10}
  
  Change 5 validation: FAIL (faction power cannot drop below 50 without triggering faction_collapse event)
  
  Rollback (REVERSE ORDER):
  - Change 6: world_state.factions.leaf_village.power: subtract 10 → 65
  - Change 5: world_state.factions.mist_village.power: add 15 → 75 (failed change, restore)
  - Change 4: character_schema.quests.active[2].status: set "active" (restore)
  - Change 3: character_schema.relationships[4].status: set "hostile" (restore)
  - Change 2: npc_schema.zabuza.can_die: set true (restore)
  - Change 1: npc_schema.zabuza.status: set "alive" (restore)
  
  Final state: Zabuza alive, all relationships/quests/factions unchanged
  
  Log: "Cascade aborted: Faction power constraint violation. NPC death prevented."
  
  Notify: "Zabuza's defeat would collapse Mist Village (faction event not yet implemented). He survives with 1 HP. Continue battle or capture?"
  
  Continue: Player chooses next action, game state consistent
```

---

## State Update Protocols

**Standard Flow**: Request→Load Current State→**EXECUTE PRE-COMMIT HOOKS**→Validate Change→Calculate New Values→**CHECK SCHEMA COMPLIANCE**→Apply Atomic (or Rollback)→Create Memory (if significant)→Update Dependencies→Confirm

**Resource Update** (drink potion): HP=45/120, inventory has potion (qty 3, restores 50)→Validate (has potion, alive, not full)→Calculate (HP=min(45+50,120)=95, qty=2)→Apply atomic→Confirm

**Multi-System Update** (defeat boss, gain 5000 XP, level 8→9 at 2000, 9→10 at 2500, 10→11 at 3000): XP 1200+5000=6200→L8→9 (uses 800, leaves 4400)→L9→10 (uses 2500, leaves 1900)→L10→11 (uses 1900, leaves 0)→Final: L11 XP 0/3500, +6 skill pts, +15 attr pts, +30 HP max, +45 MP max, +30 SP max→Apply atomic→Create high-heat memory (85)→Notify dependencies (Progression, Quests)→Confirm triple level up

**Narrative Profile Update** (player requests more comedy mid-campaign): Current profile comedy_vs_drama=6, player feedback "needs more comedy, too serious"→Validate (scale exists, new value 0-10, propose 4)→Calculate (comedy_vs_drama 6→4, update narration style +20% comedic beats)→Apply atomic (character_schema.narrative_profile.scales.comedy_vs_drama=4, add adjustments_log entry: session 5, "increased comedy 6→4", reason "player feedback: more levity", timestamp)→Create memory (NARRATIVE_STYLE heat 40: "Tone adjusted: more comedy, less serious drama")→Update dependencies (Module 06 narration style +20% banter, Module 04 NPC dialogue more lighthearted)→Module 08 combat (add comedic flourishes to descriptions). ALL atomic.

### Token Optimization: Change Log Format

**Purpose**: Reduce token usage by outputting only CHANGED fields while maintaining validation compatibility with before/after values.

**CRITICAL**: All state updates MUST use Change Log format (not raw diffs or direct assignments) to enable pre-commit validation and atomic rollback.

**Change Log Structure**:

```json
{
  "update_type": "change_log",
  "target": "character_schema",
  "changes": [
    {
      "path": "resources.mp.current",
      "operation": "subtract",
      "before": 85,
      "after": 35,
      "delta": -50,
      "reason": "Fire Bolt cast",
      "validated": true
    },
    {
      "path": "inventory.items[3].qty",
      "operation": "subtract",
      "before": 5,
      "after": 2,
      "delta": -3,
      "reason": "Used 3 Health Potions",
      "validated": true
    },
    {
      "path": "progression.current_xp",
      "operation": "add",
      "before": 1200,
      "after": 6200,
      "delta": 5000,
      "reason": "Boss defeat: Elder Dragon",
      "validated": true
    }
  ],
  "timestamp": "2025-11-23T14:30:00Z",
  "atomic": true
}
```

**Change Log Operations**:

**set**: Assign absolute value (no delta)

```json
{
  "path": "character.world_context.current_location",
  "operation": "set",
  "before": "village_konoha",
  "after": "forest_death",
  "reason": "Fast travel to Forest of Death",
  "validated": true
}
```

**add**: Increase numeric value

```json
{
  "path": "resources.hp.current",
  "operation": "add",
  "before": 45,
  "after": 95,
  "delta": 50,
  "reason": "Health Potion consumed",
  "validated": true
}
```

**subtract**: Decrease numeric value

```json
{
  "path": "resources.sp.current",
  "operation": "subtract",
  "before": 80,
  "after": 60,
  "delta": -20,
  "reason": "Shadow Clone Technique activation",
  "validated": true
}
```

**multiply**: Scale numeric value

```json
{
  "path": "combat_stats.damage_multiplier",
  "operation": "multiply",
  "before": 1.0,
  "after": 1.5,
  "factor": 1.5,
  "reason": "Berserk Mode activated",
  "validated": true
}
```

**append**: Add element to array

```json
{
  "path": "inventory.items",
  "operation": "append",
  "before": null,
  "after": {"id": "sword_legendary", "name": "Excalibur", "qty": 1},
  "reason": "Quest reward: Sword in the Stone",
  "validated": true
}
```

**remove**: Delete element from array/object

```json
{
  "path": "inventory.items[5]",
  "operation": "remove",
  "before": {"id": "quest_item_key", "name": "Ancient Key", "qty": 1},
  "after": null,
  "reason": "Used Ancient Key to unlock dungeon door",
  "validated": true
}
```

**replace**: Swap array element or object property

```json
{
  "path": "equipment.weapon",
  "operation": "replace",
  "before": {"id": "sword_iron", "name": "Iron Sword", "damage": "1d8"},
  "after": {"id": "sword_steel", "name": "Steel Sword", "damage": "1d10+2"},
  "reason": "Equipped better weapon",
  "validated": true
}
```

**remove_batch**: Remove multiple elements matching criteria (optimization)

```json
{
  "path": "inventory.items",
  "operation": "remove_batch",
  "selector": {"type": "consumable", "qty": 0},
  "before": [
    {"id": "potion_health", "type": "consumable", "qty": 0},
    {"id": "potion_mana", "type": "consumable", "qty": 0},
    {"id": "elixir_stamina", "type": "consumable", "qty": 0}
  ],
  "after": null,
  "reason": "Cleanup: Remove empty consumables",
  "validated": true,
  "count": 3
}
```

**update_batch**: Update multiple elements matching criteria (optimization)

```json
{
  "path": "status_effects",
  "operation": "update_batch",
  "selector": {"type": "debuff"},
  "update": {"duration": {"operation": "subtract", "delta": 1}},
  "before": [
    {"id": "poison", "type": "debuff", "duration": 3},
    {"id": "slow", "type": "debuff", "duration": 2}
  ],
  "after": [
    {"id": "poison", "type": "debuff", "duration": 2},
    {"id": "slow", "type": "debuff", "duration": 1}
  ],
  "reason": "End of turn: Decrement debuff durations",
  "validated": true,
  "count": 2
}
```

### Operation Compatibility Matrix

**Numeric Fields** (HP, MP, XP, currency, stats):

- ✅ `set`, `add`, `subtract`, `multiply`
- ❌ `append`, `remove`, `replace`

**String Fields** (location, name, status):

- ✅ `set`, `replace`
- ❌ `add`, `subtract`, `multiply`, `append`, `remove`

**Boolean Fields** (flags, switches):

- ✅ `set`
- ❌ All other operations

**Array Fields** (inventory, quests, status_effects):

- ✅ `append`, `remove`, `replace` (for elements), `remove_batch`, `update_batch`
- ✅ `set` (for entire array replacement, rare)
- ❌ `add`, `subtract`, `multiply`

**Batch Operations** (`remove_batch`, `update_batch`):

- **Purpose**: Performance optimization for multi-element modifications
- **Use when**: Cleaning up empty items, decrementing status effect durations, bulk updates
- **Validation**: All matched elements verified before batch execution
- **Rollback**: All elements restored atomically if validation fails
- **Count**: Required field tracking number of elements affected

**Object Fields** (equipment, relationships):

- ✅ `set` (entire object), `replace` (properties)
- ❌ `add`, `subtract`, `multiply`, `append`, `remove`

### Safe Array Modification Protocol

**Risk**: Array indices (e.g., `items[3]`) are fragile. If an item at index 2 is removed, index 3 shifts to 2. Concurrent or multi-step updates can target the wrong item if relying solely on indices.

**Solution**: Use **ID-based targeting** via the `selector` field for `remove` and `replace` operations on arrays.

**Syntax**:

- `path`: Target the array itself (e.g., `"inventory.items"`)
- `selector`: Object identifying the target item (e.g., `{"id": "potion_health"}`)

**Example (Safe Remove)**:

```json
{
  "path": "inventory.items",
  "operation": "remove",
  "selector": {"id": "potion_health"},
  "before": {"id": "potion_health", "qty": 1},
  "after": null,
  "reason": "Consumed potion",
  "validated": true
}
```

**Example (Safe Replace)**:

```json
{
  "path": "character.quests.active",
  "operation": "replace",
  "selector": {"quest_id": "quest_001"},
  "before": {"quest_id": "quest_001", "status": "active"},
  "after": {"quest_id": "quest_001", "status": "completed"},
  "reason": "Quest completion",
  "validated": true
}
```

---

## Mechanical Systems Integration (Phase 4)

**CRITICAL**: Module 03 must read instantiated mechanical systems from `session_state.mechanical_systems` (populated by Session Zero Phase 3).

### Economy System Integration

**Purpose**: Use profile-specific economy configuration for all currency transactions, merchant interactions, and loot generation.

**Read Economy Config**:

```python
# Pseudocode - actual implementation is markdown instructions
economy = session_state.mechanical_systems["economy"]
currency_name = economy["currency_name"]  # "Jenny", "Eris", "Yen", "Gold"
starting_amount = economy["starting_amount"]  # 200, 0, 50000
scarcity_level = economy["scarcity_level"]  # "low", "normal", "high"
special_mechanics = economy.get("special_mechanics", "")  # Profile-specific rules
```

### Currency Operations

**MANDATORY**: Use dynamic currency name from economy config, **NEVER** hardcode "gold".

**Getting Currency**:

```python
# Read character's current currency
current_currency = character_schema.resources.currency.amount  # Numeric value
currency_name = session_state.mechanical_systems.economy.currency_name  # Name

# Display to player
display(f"{current_currency} {currency_name}")
# Examples:
# "160 Jenny" (Hunter x Hunter)
# "0 Eris (in debt!)" (Konosuba)
# "45,000 Yen" (My Hero Academia)
```

**Modifying Currency**:

```python
# Purchase transaction
item_cost = 40  # Base cost from item definition
currency_name = session_state.mechanical_systems.economy.currency_name

# Create change log
change_log = {
    "path": "resources.currency.amount",
    "operation": "subtract",
    "before": 200,
    "after": 160,
    "delta": -40,
    "reason": f"Purchased Iron Sword for {item_cost} {currency_name}",
    "validated": false
}

# Validate (ensure sufficient currency)
validate_change(change_log)  # Checks: 200 - 40 = 160 >= 0

# Apply if valid
apply_change(change_log)

# Display confirmation
display(f"Transaction complete. Paid {item_cost} {currency_name}. Remaining: {160} {currency_name}")
```

### Merchant Transactions

**Purchase Flow**:

1. **Load Economy Config**:
   ```
   economy = session_state.mechanical_systems.economy
   currency_name = economy.currency_name
   scarcity_level = economy.scarcity_level  # Affects pricing
   ```

2. **Calculate Price** (with scarcity multiplier):
   ```
   base_price = item.base_price  # From item definition
   scarcity_multiplier = {
       "low": 0.8,      # Abundant resources, 20% discount
       "normal": 1.0,   # Standard pricing
       "high": 1.5      # Scarce resources, 50% markup
   }[scarcity_level]
   
   final_price = base_price * scarcity_multiplier
   ```

3. **Display to Player**:
   ```
   AIDM: "The merchant displays wares:
   
   AVAILABLE ITEMS:
   - Iron Sword (1d8 damage) - {48} {currency_name}  [base: 40, scarcity: high]
   - Steel Longsword (1d10) - {96} {currency_name}  [base: 80, scarcity: high]
   - Health Potion (restore 50 HP) - {15} {currency_name}  [base: 10, scarcity: high]
   
   You have {current_amount} {currency_name}. What do you buy?"
   ```

4. **Execute Purchase**:
   ```
   # Player buys Iron Sword for 48 Jenny (high scarcity)
   validate_currency(current_amount >= 48)  # Check sufficient funds
   subtract_currency(48, reason="Purchased Iron Sword")
   add_inventory_item("iron_sword", qty=1)
   display(f"Paid {48} {currency_name}. Remaining: {current_amount - 48} {currency_name}")
   ```

**Sale Flow** (player sells to merchant):

1. **Calculate Sale Price** (typically 50% of purchase price):
   ```
   purchase_price = item.base_price * scarcity_multiplier
   sale_price = purchase_price * 0.5  # Merchants buy at half price
   ```

2. **Execute Sale**:
   ```
   remove_inventory_item(item_id, qty=1)
   add_currency(sale_price, reason=f"Sold {item_name}")
   display(f"Merchant pays {sale_price} {currency_name}. Total: {new_amount} {currency_name}")
   ```

### Loot Generation

**Currency Drops** (from defeated enemies):

```python
# Read loot generation mode
loot_mode = session_state.mechanical_systems.economy.mechanics.loot_generation

if loot_mode == "currency_drops":
    # Standard currency loot (most systems)
    currency_name = session_state.mechanical_systems.economy.currency_name
    loot_amount = calculate_loot_by_enemy_level(enemy_level)
    
    display(f"Enemy dropped {loot_amount} {currency_name}!")
    add_currency(loot_amount, reason=f"Looted from {enemy_name}")

elif loot_mode == "item_only":
    # No currency drops, only items (barter economies)
    loot_items = generate_item_loot(enemy_type)
    display(f"Enemy dropped: {', '.join(loot_items)}")
    add_inventory_items(loot_items)

elif loot_mode == "reputation_based":
    # Loot is reputation/bounty (One Piece style)
    reputation_gain = calculate_reputation_gain(enemy_threat_level)
    display(f"Defeated {enemy_name}! Bounty increased by {reputation_gain}")
    add_reputation(reputation_gain)
```

### Quest Rewards

**Currency Rewards**:

```python
# Read reward mode
reward_mode = session_state.mechanical_systems.economy.mechanics.quest_rewards

if reward_mode == "currency_based":
    # Standard currency rewards
    currency_name = session_state.mechanical_systems.economy.currency_name
    reward_amount = quest.reward_amount
    
    display(f"Quest complete! Reward: {reward_amount} {currency_name}")
    add_currency(reward_amount, reason=f"Quest reward: {quest_name}")

elif reward_mode == "item_based":
    # Rewards are items, not currency
    reward_items = quest.reward_items
    display(f"Quest complete! Reward: {', '.join(reward_items)}")
    add_inventory_items(reward_items)

elif reward_mode == "reputation_based":
    # Rewards are reputation/standing
    reputation_gain = quest.reputation_reward
    display(f"Quest complete! {faction_name} reputation: +{reputation_gain}")
    add_faction_reputation(faction_name, reputation_gain)
```

### Special Mechanics Integration

**Profile-Specific Rules**:

```python
special_mechanics = session_state.mechanical_systems.economy.special_mechanics

# Example: Hunter x Hunter (Hunter License privileges)
if "Hunter License" in special_mechanics:
    if character.has_hunter_license:
        # 20% discount at licensed merchants
        final_price *= 0.8
        display(f"Hunter License discount applied! Price: {final_price} Jenny")

# Example: Konosuba (Debt mechanics)
if "debt_accumulation" in special_mechanics:
    if currency_amount < 0:
        # Character is in debt
        debt_amount = abs(currency_amount)
        display(f"You owe {debt_amount} Eris to the guild. Debt collectors may visit.")
        # Trigger debt collection quest/events

# Example: My Hero Academia (Hero salary)
if "hero_salary" in special_mechanics:
    if character.hero_rank > 0:
        monthly_salary = calculate_hero_salary(character.hero_rank)
        display(f"Monthly hero salary: {monthly_salary} Yen (Rank {character.hero_rank})")
```

### Economy Type-Specific Handling

**Fiat Currency** (most common):
- Use currency_name for all transactions
- Track numeric amount in `resources.currency.amount`
- Support purchase/sale/loot/quest rewards

**Barter** (Dr. Stone, primitive settings):
- No currency tracking
- All transactions are item-for-item trades
- Merchant interactions ask: "What will you trade for this?"
- Loot drops only items, no currency

**Abstract Wealth** (aristocratic settings):
- Currency tracked as lifestyle tier: "Poor", "Comfortable", "Wealthy", "Rich", "Nobility"
- Purchases succeed if item cost <= lifestyle tier
- No numeric tracking

**Reputation-Based** (One Piece bounties):
- Currency = bounty/reputation value
- Purchases use reputation as currency
- Defeating enemies increases bounty
- High bounty attracts stronger opponents

**None** (economy irrelevant):
- No currency tracking
- Items obtained through plot/loot only
- No merchant interactions

### Integration Validation

**On Session Start**:

```python
# Verify mechanical_systems.economy exists
if "mechanical_systems" not in session_state:
    ERROR("session_state.mechanical_systems not found! Run Session Zero Phase 3.")
    
if "economy" not in session_state.mechanical_systems:
    ERROR("Economy system not instantiated! Check Phase 3 integration.")

# Load economy config
economy = session_state.mechanical_systems.economy
VALIDATE(economy.type in ["fiat_currency", "barter", "abstract_wealth", "reputation_based", "none"])
VALIDATE(economy.currency_name exists and is string)
VALIDATE(economy.starting_amount is numeric)

# Initialize character currency if not set
if character.resources.currency not exists:
    character.resources.currency = {
        "amount": economy.starting_amount,
        "currency_name": economy.currency_name
    }
```

**On Currency Transaction**:

```python
# Every currency operation MUST use economy config
def modify_currency(amount, reason):
    currency_name = session_state.mechanical_systems.economy.currency_name
    
    change_log = {
        "path": "resources.currency.amount",
        "operation": "add" if amount > 0 else "subtract",
        "before": character.resources.currency.amount,
        "after": character.resources.currency.amount + amount,
        "delta": amount,
        "reason": f"{reason} ({abs(amount)} {currency_name})",
        "validated": false
    }
    
    validate_change(change_log)
    apply_change(change_log)
    
    return character.resources.currency.amount
```

### Common Mistakes

❌ **Hardcoding "gold"**:
```
Bad: "You gained 50 gold from the quest."
Good: "You gained 50 {currency_name} from the quest."  # Uses Jenny/Eris/Yen
```

❌ **Ignoring scarcity level**:
```
Bad: item_price = base_price  # Always same price
Good: item_price = base_price * scarcity_multiplier  # Adjusts by economy
```

❌ **Not checking economy type**:
```
Bad: Always assume currency exists
Good: if economy.type == "barter": use_item_trade() else: use_currency()
```

❌ **Skipping special mechanics**:
```
Bad: Ignore special_mechanics field
Good: Check for Hunter License, debt, salary, etc.
```

### Module Completion Criteria

Module 03 economy integration complete when:
- ✅ Reads `session_state.mechanical_systems.economy` on initialization
- ✅ Uses `currency_name` dynamically in all displays (never "gold")
- ✅ Applies `scarcity_level` multiplier to merchant prices
- ✅ Respects economy type (fiat_currency vs barter vs reputation_based vs none)
- ✅ Implements `special_mechanics` (Hunter License, debt, salary, etc.)
- ✅ Validates currency operations via change log system
- ✅ Generates loot/rewards according to economy mechanics
- ✅ **NO hardcoded currency references** anywhere in module

---

**End of Module 03: State Manager**
