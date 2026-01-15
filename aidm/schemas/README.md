# Mechanical Meta-Schemas

This directory contains the JSON schemas used to validate the mechanical configuration sections of Narrative Profiles. These schemas ensure that every anime profile provides the necessary parameters to instantiate the game's mechanical systems (Economy, Crafting, Progression, Downtime).

## Schema Overview

### 1. Economy Meta-Schema (`economy_meta_schema.json`)

Defines the economic system of the world.

- **Types**: `fiat_currency`, `resource_barter`, `reputation_based`, `post_scarcity`, `none`, `abstract_wealth`
- **Key Parameters**: `currency_name`, `starting_amount`, `scarcity`

### 2. Crafting Meta-Schema (`crafting_meta_schema.json`)

Defines how items are created or modified.

- **Types**: `skill_based`, `recipe_based`, `experimental`, `industrial`, `none`, `ritual_based`
- **Key Parameters**: `categories`, `special_mechanics`

### 3. Progression Meta-Schema (`progression_meta_schema.json`)

Defines how characters grow in power.

- **Types**: `xp_based`, `milestone_based`, `mastery_tiers`, `usage_based`, `narrative_unlock`, `hybrid`
- **Key Parameters**: `power_name`, `awakening_stages`, `evolution_triggers`

### 4. Downtime Meta-Schema (`downtime_meta_schema.json`)

Defines available activities between adventures.

- **Modes**: `training`, `recovery`, `social`, `research`, `crafting`, `exploration`, `maintenance`, `commerce`
- **Key Parameters**: `enabled_modes`, `default_mode`

## Usage

These schemas are used by the Session Zero module to load the correct mechanical systems for a campaign. When a Narrative Profile is loaded, its `Mechanical Configuration` block is validated against these schemas.

### Example Configuration (Hunter x Hunter)

```json
{
  "economy": {
    "type": "fiat_currency",
    "currency_name": "Jenny",
    "starting_amount": 200,
    "scarcity": "normal",
    "special_mechanics": ["hunter_licenses", "greed_island_cards"]
  },
  "crafting": {
    "type": "skill_based",
    "categories": ["cards"],
    "special_mechanics": ["greed_island_spell_cards"]
  },
  "progression": {
    "type": "mastery_tiers",
    "power_name": "Nen",
    "awakening_stages": ["Novice", "Initiate", "Practitioner", "Expert", "Master"],
    "evolution_triggers": ["training_arc", "emotional_breakthrough"]
  },
  "downtime": {
    "enabled_modes": ["training", "social", "research"],
    "default_mode": "training"
  }
}
```
