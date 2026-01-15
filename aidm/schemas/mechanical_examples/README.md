# Mechanical Systems Examples

This directory contains reference examples for configuring mechanical systems in narrative profiles.

## Directory Structure

```
mechanical_examples/
├── economy_*.json          (5 economy system examples)
├── crafting_*.json         (5 crafting system examples)
├── progression_*.json      (5 progression system examples)
├── downtime_*.json         (6 downtime configuration examples)
└── README.md               (this file)
```

## How to Use

When creating a new narrative profile, reference these examples to determine the appropriate mechanical configuration for your anime world.

### Example: Creating Hunter x Hunter Profile

1. **Economy**: Uses named currency → `economy_fiat_currency.json`
2. **Crafting**: Skill-based card creation → `crafting_skill_based.json`
3. **Progression**: Nen mastery system → `progression_mastery_tiers.json`
4. **Downtime**: Training and social links → `downtime_action_focused.json`

Combine these into profile config:

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
      "craft_focus": "greed_island_cards",
      "skill_stat": "INT"
    }
  },
  "progression": {
    "type": "mastery_tiers",
    "parameters": {
      "system_name": "Nen",
      "mastery_levels": ["Novice", "Practitioner", "Expert", "Master"],
      "categories": ["Enhancement", "Transmutation", "Emission", "Conjuration", "Manipulation", "Specialization"]
    }
  },
  "downtime": {
    "enabled_modes": ["training_arcs", "social_links"],
    "default_mode": "training_arcs"
  }
}
```

## System Type Quick Reference

### Economy Systems

| Type | Use Case | Examples |
|------|----------|----------|
| `fiat_currency` | Named currency | Hunter x Hunter (Jenny), One Piece (Berry) |
| `barter` | Resource trading | Dr. Stone, post-apocalyptic |
| `abstract_wealth` | Social class tiers | Aristocratic societies |
| `reputation_based` | Social credit | Dystopian, hero ranking systems |
| `none` | No economy | Death Note, Haikyuu, psychological |

### Crafting Systems

| Type | Use Case | Examples |
|------|----------|----------|
| `recipe_based` | Fixed recipes | Game-world isekai (SAO, Log Horizon) |
| `skill_based` | Quality from skill | Greed Island cards, craftsman anime |
| `experimental` | Discovery-based | Alchemy, inventor characters |
| `equivalent_exchange` | Sacrifice required | Fullmetal Alchemist |
| `none` | No crafting | Most battle shonen, sports |

### Progression Systems

| Type | Use Case | Examples |
|------|----------|----------|
| `mastery_tiers` | Skill mastery paths | HxH Nen, Naruto chakra, cultivation |
| `class_based` | Fixed classes/positions | Sports anime, RPG isekai |
| `quirk_awakening` | Power evolution | MHA Quirks, One Piece Devil Fruits |
| `milestone_based` | Story-driven only | Death Note, psychological thrillers |
| `static_op` | Already max power | Overlord, One Punch Man |

### Downtime Configurations

| Mode | Description | Common In |
|------|-------------|-----------|
| `training_arcs` | Skill development | Shonen battle anime |
| `social_links` | Relationship building | Persona-style, romance |
| `investigation` | Clue gathering | Detective, mystery |
| `travel` | Journeys with encounters | Adventure, exploration |
| `faction_building` | Organization management | Kingdom-building isekai |
| `slice_of_life` | Daily activities | School life, SoL |

## Validation

All examples in this directory are validated against the meta-schemas:
- `economy_meta_schema.json`
- `crafting_meta_schema.json`
- `progression_meta_schema.json`
- `downtime_meta_schema.json`

## Testing

To test a configuration:

```python
from aidm.lib.mechanical_instantiation import MechanicalInstantiator

instantiator = MechanicalInstantiator()

# Load example
import json
with open('mechanical_examples/economy_fiat_currency.json') as f:
    example = json.load(f)

# Validate
config = {
    "economy": {
        "type": example["type"],
        "parameters": example["parameters"]
    }
}

is_valid, errors = instantiator.validate_config(config)
print(f"Valid: {is_valid}")

# Instantiate
systems = instantiator.load_from_profile(config)
print(systems)
```

## Adding New Examples

When adding new examples:

1. Follow naming convention: `{system}_{type}.json`
2. Include `description`, `type`, `parameters`, and `use_case` fields
3. Validate against meta-schema
4. Add to this README's quick reference tables
5. Include real anime examples in use_case

## Related Files

- **Meta-Schemas**: `aidm/schemas/*_meta_schema.json`
- **Instantiation Logic**: `aidm/lib/mechanical_instantiation.py`
- **Test Profiles**: `tests/test_data/*_profile.md`
- **Integration Docs**: `aidm/instructions/03_state_manager.md` (Mechanical Systems section)

## Questions?

See the Implementation Plan: `MECHANICAL_META_SCHEMA_IMPLEMENTATION_PLAN.md`
