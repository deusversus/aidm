# State Export & Validation Guide

**Version**: 2.5  
**Source**: Extracted from Module 03 (State Manager)  
**Purpose**: Detailed examples for state export formats, validation flows, and rollback protocols

---

## Change Log Format Reference

### Operation Types

| Operation | Use Case | Required Fields | Example |
|-----------|----------|-----------------|---------|
| `set` | Assign absolute value | path, before, after, reason | Location change |
| `add` | Increase numeric | path, before, after, delta, reason | Gain currency |
| `subtract` | Decrease numeric | path, before, after, delta, reason | Spend MP |
| `multiply` | Scale numeric | path, before, after, factor, reason | Damage multiplier |
| `append` | Add to array | path, after, reason | Add inventory item |
| `remove` | Delete from array | path, before, reason | Use consumable |
| `replace` | Swap element | path, before, after, reason | Equip new weapon |
| `remove_batch` | Bulk delete | path, selector, before, count, reason | Cleanup empty items |
| `update_batch` | Bulk modify | path, selector, update, before, after, count, reason | Decrement durations |

### Operation Compatibility

| Field Type | Valid Operations |
|------------|------------------|
| Numeric (HP, MP, XP) | set, add, subtract, multiply |
| String (location, name) | set, replace |
| Boolean (flags) | set |
| Array (inventory, quests) | append, remove, replace, remove_batch, update_batch, set |
| Object (equipment) | set, replace |

---

## Validation Flow Examples

### Resource Update Validation

```json
{
  "path": "resources.mp.current",
  "operation": "subtract",
  "before": 85,
  "after": 35,
  "delta": -50,
  "reason": "Fire Bolt cast"
}
```

**Validation Steps**:
1. Load current state: `resources.mp.current = 85`
2. Before-value check: `85 == 85` ✓
3. Operation check: `subtract` valid for numeric ✓
4. Type check: `after=35` is number ✓
5. Range check: `35 >= 0` ✓, `35 <= max(230)` ✓
6. Delta verification: `85 + (-50) = 35` ✓
7. Constraint check: Has 85 MP, costs 50, leaves 35 >= 0 ✓

**Result**: PASS → Apply change, log transition

### Validation Failure Example

```json
{
  "path": "resources.mp.current",
  "operation": "subtract",
  "before": 35,
  "after": -15,
  "delta": -50,
  "reason": "Fire Bolt cast"
}
```

**Validation Steps**:
1. Load current state: `resources.mp.current = 35`
2. Before-value check: `35 == 35` ✓
3. Operation check: `subtract` valid ✓
4. Type check: `after=-15` is number ✓
5. Range check: `-15 >= 0` ✗ **FAIL**

**Result**: BLOCKED
- State preserved: `resources.mp.current = 35`
- Notify player with alternatives:
  ```
  Cannot cast Fire Bolt: Insufficient MP
  Need: 50 MP | Have: 35 MP | Short: 15 MP
  
  Alternatives:
  A) Cast Spark (20 MP, 1d6 damage)
  B) Use Mana Potion (+50 MP, have 2)
  C) Basic Attack (0 MP, 1d8+3 damage)
  ```

---

## Rollback Protocol Examples

### Example 1: Single Change Rollback

**Attempted**: Allocate 5 attribute points (only 2 available)

```json
{
  "path": "progression.available_attribute_points",
  "operation": "subtract",
  "before": 2,
  "after": -3,
  "delta": -5,
  "reason": "Attribute allocation"
}
```

**Validation**: FAIL (`after=-3` violates constraint: must be >= 0)

**Rollback**:
- Reverse operation: `add +5` to restore before-value
- Final state: `available_attribute_points = 2` (unchanged)

**Notify**: "Cannot allocate 5 points: only 2 available."

---

### Example 2: Multi-Change Transaction Rollback

**Attempted**: Level up (L8 → L9) with cascading stat increases

**Transaction Change Log**:
1. `progression.level`: set 8 → 9
2. `progression.current_xp`: set 6200 → 0
3. `progression.available_skill_points`: add +2 (3 → 5)
4. `progression.available_attribute_points`: add +5 (8 → 13)
5. `resources.hp.max`: add +10 (120 → 130) ← **FAILS** (calculation error)
6. `resources.mp.max`: add +15 (230 → 245)

**Rollback (REVERSE ORDER)**:
- Change 6: Subtract 15 from mp.max → 230
- Change 5: Subtract 10 from hp.max → 120
- Change 4: Subtract 5 from available_attribute_points → 8
- Change 3: Subtract 2 from available_skill_points → 3
- Change 2: Set current_xp to 6200
- Change 1: Set level to 8

**Final state**: Level 8, XP 6200, no changes applied

---

### Example 3: Cascade Failure Rollback

**Attempted**: NPC death cascade (affects relationships, quests, factions)

**Transaction Change Log**:
1. `npc_schema.zabuza.status`: set "alive" → "dead"
2. `npc_schema.zabuza.can_die`: set true → false
3. `character_schema.relationships[4].status`: set "hostile" → "deceased"
4. `character_schema.quests.active[2].status`: set "active" → "completed"
5. `world_state.factions.mist_village.power`: subtract -15 (75 → 60) ← **FAILS**
6. `world_state.factions.leaf_village.power`: add +10 (65 → 75)

**Validation Failure**: Faction power cannot drop below 50 without triggering faction_collapse event

**Rollback (REVERSE ORDER)**:
- All 6 changes reversed in order
- Final state: Zabuza alive, all relationships/quests/factions unchanged

**Notify**: "Zabuza's defeat would collapse Mist Village. He survives with 1 HP."

---

## Narrative Profile Export/Import

### Export Structure (Save File)

```json
{
  "session_export_schema": {
    "character": {
      "narrative_profile": {
        "profile_id": "narrative_dandadan",
        "profile_type": "pre-made",
        "profile_source": "aidm/libraries/narrative_profiles/dandadan_profile.md",
        "scales": { /* 10 DNA scales */ },
        "tropes": { /* 15 trope switches */ },
        "mechanical_config": { /* economy/crafting/progression/downtime */ },
        "mechanical_scaffolding": { /* power models, XP, combat style */ },
        "adjustments_log": [ /* session adjustments */ ],
        "last_calibration_date": "2025-10-01T12:00:00Z"
      }
    }
  }
}
```

### Import Flow

1. Load `narrative_profile` from export
2. Validate `profile_type`
3. **IF pre-made**: Load base from file, apply adjustments
4. **IF generated**: Use state data directly (no file reference)
5. Validate all fields
6. Restore to active state

### Pre-Made vs Generated Profiles

| Aspect | Pre-Made | Generated |
|--------|----------|-----------|
| `profile_type` | "pre-made" | "generated" |
| `profile_source` | File path | null |
| Storage | ID + adjustments only | FULL data (scales/tropes/scaffolding) |
| On restart | Reload from file | Use state data |
| File missing | Warn, suggest fallback | N/A |

---

## Safe Array Modification

**Problem**: Array indices shift when elements are removed.

**Solution**: Use ID-based targeting via `selector` field.

### Safe Remove

```json
{
  "path": "inventory.items",
  "operation": "remove",
  "selector": {"id": "potion_health"},
  "before": {"id": "potion_health", "qty": 1},
  "after": null,
  "reason": "Consumed potion"
}
```

### Safe Replace

```json
{
  "path": "character.quests.active",
  "operation": "replace",
  "selector": {"quest_id": "quest_001"},
  "before": {"quest_id": "quest_001", "status": "active"},
  "after": {"quest_id": "quest_001", "status": "completed"},
  "reason": "Quest completion"
}
```

---

## Full Change Log Example

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

---

**Reference**: This guide extracted from Module 03 to reduce token load. See Module 03 for core validation rules and integration points.
