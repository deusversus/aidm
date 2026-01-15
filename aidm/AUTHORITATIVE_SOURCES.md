# AIDM Authoritative Sources Registry

**Version**: 2.5  
**Purpose**: Single source of truth for cross-module dependencies  
**Created**: 2025-11-25  
**Reference**: Project Plan Gestalt Analysis (G-01, G-04)

---

## Purpose

This registry establishes **single sources of truth** for domains with cross-module dependencies. When multiple modules reference the same concept, ONE module is designated authoritative. Other modules MUST reference the authoritative source, not duplicate content.

**Anti-Pattern**: Module 08 duplicating Module 09's progression type definitions (2,800 tokens wasted)  
**Correct Pattern**: Module 08 says "See Module 09 for progression type definitions" (~50 tokens)

---

## Domain Ownership

| Domain | Authoritative Module | Referencing Modules | Notes |
|--------|---------------------|---------------------|-------|
| **Progression Types** | M09 (Progression Systems) | M08 (Combat) | 5 types: mastery_tiers, class_based, quirk_awakening, milestone_based, static_op |
| **Power Tier Scaling** | M12 (Narrative Scaling) | M08 (Combat), M06 (Session Zero) | 11 tiers (T11-T0), tier-appropriate language |
| **Narrative DNA Scales** | M13 (Narrative Calibration) | M07 (Anime Integration), M05 (Narrative Systems), M06 (Session Zero) | 10 scales (0-10 each), 15 trope switches |
| **State Persistence** | M03 (State Manager) | All modules | Change log protocol, 9 operation types, before/after values |
| **Combat Mechanics** | M08 (Combat Resolution) | M09 (Progression), M12 (Scaling) | 5-step validation, death/resurrection, combat maneuvers |
| **Error Recovery** | M10 (Error Recovery) | All modules | 5-tier classification, validation protocols, conflict resolution |
| **Dice/RNG** | M11 (Dice Resolution) | M08 (Combat), M09 (Progression) | 5-step protocol, transparent rolls, critical hits |
| **Memory Management** | M02 (Learning Engine) | All modules (implicit) | 8 categories, heat index, decay rates |
| **NPC Intelligence** | M04 (NPC Intelligence) | M05 (Narrative), M08 (Combat) | Disposition formula, affinity thresholds, ensemble archetypes |
| **Narrative Generation** | M05 (Narrative Systems) | M04 (NPC), M13 (Calibration) | Foreshadowing protocol, ensemble management, downtime |
| **Session Zero** | M06 (Session Zero) | M07 (Research), M13 (Calibration) | 5-phase creation, OP detection, mechanical instantiation |
| **Anime Research** | M07 (Anime Integration) | M06 (Session Zero), M13 (Calibration) | Knowledge self-assessment (L0-L4), research protocol, harmonization |
| **Validation Boundaries** | M03 (Structural), M10 (Semantic) | All modules | M03 = pre-commit structural, M10 = semantic validation + recovery |

---

## Terminology Standards

### Core Terminology

| Term | Definition | Authoritative Module | Used In | Notes |
|------|------------|---------------------|---------|-------|
| **Resource** | Action economy cost (HP/MP/SP/Stamina/Chakra) | M09 (Progression) | M08 (Combat), M06 (Session Zero) | **NOT** "Stamina" (M08 legacy term) - use "Resource" system-wide |
| **Tier** | Power level classification (T11-T0) | M12 (Narrative Scaling) | M08, M09, M06, M13 | 11 tiers, narrative (not mechanical) classification |
| **Narrative Scale** | Power fantasy context mode (9 scales) | M12 (Narrative Scaling) | M05, M06 | Orthogonal to Tier - same tier, different scales |
| **DNA Scale** | Narrative profile parameter (0-10) | M13 (Narrative Calibration) | M05, M07, M06 | 10 scales, distinct from M12 scales |
| **Pre-commit** | Validation before state change | M03 (State Manager) | M08, M09, M10 | **NOT** "pre-check" - standardize on "pre-commit" |
| **Semantic Validation** | Narrative consistency checking | M10 (Error Recovery) | All modules | Post-commit or on-error, distinct from M03 structural |
| **Heat Index** | Memory prioritization score (0-100+) | M02 (Learning Engine) | All modules | Higher heat = higher priority in context window |
| **Affinity** | NPC relationship score (-100 to +100) | M04 (NPC Intelligence) | M05, M02 | Distinct from faction reputation |
| **Change Log** | State modification protocol | M03 (State Manager) | M08, M09, M04, M05 | 9 operation types, before/after values required |
| **Intent** | Player input classification | M01 (Cognitive Engine) | All modules | 7 types: META, COMBAT, SOCIAL, EXPLORATION, CREATIVE, STRATEGIC, LORE |

### Anime-Specific Terminology

| Term | Definition | Authoritative Source | Notes |
|------|------------|---------------------|-------|
| **Chakra** | Naruto energy system | ki_lifeforce_systems.md library | **NOT** "mana" - use source anime term |
| **Nen** | Hunter x Hunter power system | ki_lifeforce_systems.md library | Type-based (Enhancement, Emission, etc.) |
| **Quirk** | My Hero Academia power system | mechanical_systems library | Innate superpowers, classification system |
| **Devil Fruit** | One Piece power system | mechanical_systems library | Permanent transformation, seawater weakness |
| **Stand** | JoJo's Bizarre Adventure | mechanical_systems library | Manifestation of fighting spirit |

**Principle**: Use anime's EXACT terminology (e.g., "Raiton" for Lightning Style, "Konohagakure" not "Konoha Village").

---

## Cross-Module Dependency Map

### Explicit Dependencies (Hard Requirements)

```
CORE
  ├── M00 (Initialization) [REQUIRED FIRST]
  │     └── All Tier 1 modules must load before Tier 2
  │
  ├── M01 (Cognitive Engine) [TIER 1 - ALWAYS LOADED]
  │     ├── M02 (Learning) - Creates memories from intents
  │     ├── M07 (Anime) - Research gate for anime references
  │     └── M13 (Calibration) - Narrative profile validation
  │
  ├── M02 (Learning Engine) [TIER 1 - ALWAYS LOADED]
  │     ├── M03 (State) - Memory persistence
  │     └── M10 (Error Recovery) - Conflict resolution
  │
  ├── M03 (State Manager) [TIER 1 - ALWAYS LOADED]
  │     ├── M10 (Error Recovery) - Desync detection
  │     └── All modules - State changes require change logs
  │
  ├── M10 (Error Recovery) [TIER 1 - ALWAYS LOADED]
  │     └── All modules - Error monitoring
  │
  ├── M11 (Dice Resolution) [TIER 1 - ALWAYS LOADED]
  │     ├── M08 (Combat) - Combat rolls
  │     └── M09 (Progression) - Skill checks
  │
  ├── M12 (Narrative Scaling) [TIER 1 - ALWAYS LOADED]
  │     ├── M08 (Combat) - Tier-appropriate language
  │     ├── M06 (Session Zero) - OP detection
  │     └── M05 (Narrative) - Power imbalance triggers
  │
  └── TIER 2 (Lazy-Load on Intent)
        ├── M04 (NPC Intelligence) [SOCIAL intent]
        │     ├── M02 (Learning) - Relationship memories
        │     ├── M05 (Narrative) - Ensemble archetypes
        │     └── M03 (State) - NPC state updates
        │
        ├── M05 (Narrative Systems) [Story-heavy scenarios]
        │     ├── M04 (NPC) - Ensemble cast
        │     ├── M12 (Scaling) - Power imbalance triggers
        │     └── M13 (Calibration) - Narrative profile filtering
        │
        ├── M06 (Session Zero) [CHARACTER_CREATION intent]
        │     ├── M07 (Anime) - Research if anime mentioned
        │     ├── M13 (Calibration) - Narrative profile setup
        │     └── M12 (Scaling) - OP detection
        │
        ├── M07 (Anime Integration) [Anime reference detected]
        │     ├── M13 (Calibration) - Dual-phase research
        │     └── Libraries - Power system mechanics
        │
        ├── M08 (Combat Resolution) [COMBAT intent]
        │     ├── M09 (Progression) - XP/progression TYPES (authoritative)
        │     ├── M12 (Scaling) - Tier language (authoritative)
        │     ├── M11 (Dice) - Transparent rolls
        │     └── M03 (State) - Combat state updates
        │
        ├── M09 (Progression Systems) [XP award / level-up]
        │     ├── M08 (Combat) - Combat XP integration
        │     ├── M11 (Dice) - Skill advancement DCs
        │     └── M03 (State) - Character progression state
        │
        └── M13 (Narrative Calibration) [Profile setup/adjustment]
              ├── M07 (Anime) - Research-derived profiles
              ├── M05 (Narrative) - Profile application
              └── M12 (Scaling) - Terminology distinction
```

### Implicit Dependencies (Background Context)

```
M02 (Learning Engine) - Implicit influence on ALL modules
  │
  │ Provides passive context via memory/heat system:
  │ ├── M04 (NPC): Relationship heat, past interactions
  │ ├── M08 (Combat): Player combat style preferences
  │ ├── M09 (Progression): Historical XP patterns
  │ ├── M10 (Error Recovery): Player-established rules
  │ └── M13 (Calibration): Accumulated tone feedback
  │
  └── M02 is NEVER explicitly invoked—it's always consulted
```

---

## Pipeline Architecture

### Pipeline A: Narrative Flow (Story-Focused)

```
M05 (Narrative) → M07 (Anime) → M13 (Calibration) → M12 (Scaling)
```

**Modules**: M05, M07, M12, M13  
**Concerns**: Tone, pacing, tropes, genre authenticity, power fantasy  
**Cross-References**: M13 profiles filter M05 narration, M12 scales contextualize power

### Pipeline B: Mechanical Flow (Game-Focused)

```
M03 (State) → M08 (Combat) → M09 (Progression) → M11 (Dice)
```

**Modules**: M03, M08, M09, M11  
**Concerns**: Numbers, validation, consistency, fairness, randomness  
**Cross-References**: M09 defines progression TYPES that M08 applies, M11 provides transparent rolls

### Cross-Pipeline Integration Points

**M04 (NPC Intelligence)**:
- Narrative: Personality, dialogue style (Pipeline A)
- Mechanical: Disposition formula, affinity tracking (Pipeline B)

**M06 (Session Zero)**:
- Narrative: Establishes narrative profile (Pipeline A)
- Mechanical: Creates character sheet, assigns stats (Pipeline B)

**M10 (Error Recovery)**:
- Narrative: Validates narrative consistency (Pipeline A)
- Mechanical: Validates state integrity (Pipeline B)

---

## Validation Boundary Definitions

### M03 (State Manager) - Structural Validation

**Responsibility**: Pre-commit structural validation

- Schema conformance (JSON structure valid?)
- Type checks (strings are strings, numbers are numbers?)
- Range limits (HP < 0 invalid, XP overflow?)
- Before-value verification (desync detection)

**NOT Responsible For**:
- Semantic validation (does action make narrative sense?)
- Error recovery (what to do when validation fails?)
- Player-established rule checking

### M10 (Error Recovery) - Semantic Validation

**Responsibility**: Post-commit semantic validation + recovery

- Narrative consistency (does this contradict established lore?)
- Player-established rule detection (player said X, now Y conflicts?)
- Desync recovery (if state corrupted, how to fix?)
- Conflict resolution strategies (gentle reminder, schema correction, ask player, offer retcon)

**NOT Responsible For**:
- Pre-commit structural validation (M03's job)
- State change execution (M03's job)

**Clear Boundary**: M03 = "Is this change STRUCTURALLY valid?" | M10 = "Does this change NARRATIVELY make sense?"

---

## M06→M07→M13 Pipeline Triggers

### Explicit Handoff Protocol

```
M06 (Session Zero)
  │
  │ Player mentions anime title (e.g., "I want Hunter x Hunter vibes")
  ↓
M07 (Anime Integration)
  │ TRIGGER: Anime reference detected
  │ ACTION: Execute dual-phase research
  │   Phase 1: Mechanics (power systems, combat rules)
  │   Phase 2: Narrative DNA (tone, pacing, tropes)
  │ CITE: Sources (wikis, VS Battles, Reddit)
  │ CONFIRM: Player validates research accuracy
  │
  │ Research complete (2-4 exchanges)
  ↓
M13 (Narrative Calibration)
  │ TRIGGER: Research complete + player confirmation
  │ ACTION: Extract narrative profile
  │   - 10 DNA Scales (0-10 each)
  │   - 15 Trope Switches (ON/OFF)
  │   - Pacing/Tone/Dialogue/Combat parameters
  │ STORE: narrative_profile_schema.json
  │
  │ Profile extracted
  ↓
M06 (Session Zero) - Resume
  │ RETURN: Calibrated profile ready
  │ APPLY: Profile filters character creation options
  │ CONTINUE: Phases 1-5 (creation process)
  ↓
Campaign Start (Profile active for all narration)
```

### Timeout/Fallback Protocol

If M07 research inconclusive after 2 attempts:
1. M07 offers generic profile template (M13 Spartan mode)
2. Player selects vibe (Shonen/Seinen/Isekai/etc.)
3. M13 applies corresponding template
4. Continue Session Zero

**Maximum Delay**: 5 exchanges for full research → calibration → return

---

## Critical Infrastructure Markers

Modules marked with `CRITICAL_INFRASTRUCTURE` flag (optimization requires extra care):

| Module | Flag Status | Reason | Optimization Approach |
|--------|-------------|--------|----------------------|
| M03 | ✓ CRITICAL_INFRASTRUCTURE | All persistent data flows through it | Optimize format, preserve all operations |
| M05 | ✓ CRITICAL_INFRASTRUCTURE | Core storytelling differentiator | Preserve pedagogical examples fully |
| M10 | ✓ CRITICAL_INFRASTRUCTURE | Prevents cascade failures | Preserve all recovery paths |
| M11 | ✓ CRITICAL_INFRASTRUCTURE | Solves LLM randomness problem | Preserve RNG methodology fully |

**Optimization Rule**: For these modules, procedural correctness > token efficiency. A 10% optimization that risks 1% failure rate is NOT acceptable.

---

## Module Header Template

**Recommended addition to all module headers** (Phase 5 enhancement P5-12):

```markdown
## Module Metadata

**Version**: 2.5  
**Tier**: [1 (Always Loaded) / 2 (Lazy-Load on Intent)]  
**Pipeline**: [Narrative Flow / Mechanical Flow / Cross-Pipeline]  
**Critical Infrastructure**: [Yes / No]

### Dependencies

**Requires**:
- [Module XX]: [What it provides]

**Provides To**:
- [Module YY]: [What this module provides]

### Authoritative Domains

This module is the AUTHORITATIVE source for:
- [Domain 1]: [Brief description]
- [Domain 2]: [Brief description]

**Other modules MUST reference this module for the above domains, not duplicate content.**
```

---

## Usage Guidelines

### For Module Authors/Editors

1. **Before adding content**: Check this registry. Is there an authoritative source?
   - If YES: Reference it, don't duplicate.
   - If NO: Add your module as authoritative and document here.

2. **When removing duplication**: Add cross-reference to authoritative source.
   - Example: "See Module 09 (Progression Systems) for progression type definitions."

3. **When defining new domains**: Add to this registry immediately.

### For AIDM Executor (AI)

1. **When loading modules**: Consult dependency map to determine load order.

2. **When resolving conflicts**: Authoritative module wins. If Module 08 says "Stamina" but Module 09 (authoritative) says "Resource", use "Resource".

3. **When uncertain**: This registry is the tiebreaker for "which module do I trust?"

---

## Change Log

| Date | Change | Reason | Modules Affected |
|------|--------|--------|------------------|
| 2025-11-25 | Registry created | Resolve M08/M09/M12 duplication triangle (Gestalt Analysis G-01) | CORE, M08, M09, M12 |
| 2025-11-25 | Validation boundaries defined | Clarify M03↔M10 responsibility blur (Gestalt Analysis G-02) | M03, M10 |
| 2025-11-25 | Pipeline triggers documented | Make M06→M07→M13 handoffs explicit (Gestalt Analysis G-03) | M06, M07, M13 |
| 2025-11-25 | Terminology standards added | Resolve terminology drift (Gestalt Analysis G-04) | M08, M09, M03 |

---

**Last Updated**: 2025-11-25  
**Status**: ✓ ACTIVE - Reference this registry for all cross-module work
