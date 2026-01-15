# AIDM v3 Technical Specification

## API & SDK Requirements

### LLM Providers (Choose at least one per tier)

> **Updated December 2025.** Modern fast models now have 100% schema compliance, 
> extended thinking, and agentic optimization. Use them for ALL judgment calls.

**Fast Tier (Structured judgment, high-volume):**
| Provider | Model | Key Capabilities |
|----------|-------|------------------|
| Anthropic | Claude Haiku 4.5 | 100% schema compliance, extended thinking, 200K context |
| Google | Gemini 3.0 Flash | JSON schema, agentic optimization, thinking models |
| OpenAI | GPT 5.1 Fast | Structured output, sub-100ms latency |

**Creative Tier (Narrative generation):**
| Provider | Model | Best For |
|----------|-------|----------|
| Anthropic | Claude Sonnet 4.5 | Prose quality, character voice, nuanced dialogue |
| Google | Gemini 3.0 Pro | Long context, multimodal, world-building |
| OpenAI | GPT 5.1 | General quality, consistency |

**Director Tier (Long-context planning, async):**
| Provider | Model | Best For |
|----------|-------|----------|
| Anthropic | Claude Opus 4.5 | Complex multi-session reasoning, arc planning |
| Google | Gemini 3.0 Pro | Cost-effective long context (1M+ tokens) |
| OpenAI | GPT 5.1 Thinking | Extended reasoning chains |

### Database

**Relational (State):**
- PostgreSQL 15+ (recommended)
- SQLite (for local development/single-user)

**Vector (Memories):**
- ChromaDB (local, easy setup)
- Pinecone (cloud, scalable)
- Weaviate (self-hosted option)

---

## Structured Output Schemas

### Intent Classification

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "enum": ["COMBAT", "SOCIAL", "EXPLORATION", "NARRATIVE", "META", "CREATIVE"]
    },
    "action": {
      "type": "string",
      "description": "The specific action being attempted"
    },
    "targets": {
      "type": "array",
      "items": {"type": "string"},
      "description": "NPCs, objects, or locations targeted"
    },
    "declared_epicness": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "How dramatic/climactic the player's phrasing suggests"
    },
    "special_flags": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["power_of_friendship", "named_attack", "flashback_reference", "emotional_appeal", "tactical_explanation"]
      }
    }
  },
  "required": ["intent", "action"]
}
```

### Sakuga Interceptor

```json
{
  "type": "object",
  "properties": {
    "is_sakuga_moment": {"type": "boolean"},
    "reason": {"type": "string"},
    "recommended_override": {
      "type": "string",
      "enum": ["none", "auto_success", "auto_success_with_cost", "rule_of_cool", "dramatic_failure"]
    },
    "narrative_weight": {
      "type": "string",
      "enum": ["standard", "elevated", "climactic", "arc_defining"]
    }
  },
  "required": ["is_sakuga_moment", "recommended_override"]
}
```

### Validation Agent

```json
{
  "type": "object",
  "properties": {
    "valid": {"type": "boolean"},
    "reason": {"type": "string"},
    "blocking_conditions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {"type": "string", "enum": ["resource", "cooldown", "target", "prerequisite", "world_state"]},
          "details": {"type": "string"}
        }
      }
    },
    "alternatives": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Suggested alternative actions if invalid"
    }
  },
  "required": ["valid"]
}
```

### Memory Retrieval

```json
{
  "type": "object",
  "properties": {
    "relevant_memories": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {"type": "string"},
          "heat": {"type": "number"},
          "relevance_score": {"type": "number"},
          "summary": {"type": "string"},
          "category": {"type": "string"}
        }
      }
    }
  }
}
```

### Director Output

```json
{
  "type": "object",
  "properties": {
    "current_arc": {"type": "string"},
    "arc_phase": {"type": "string", "enum": ["setup", "rising", "climax", "falling", "resolution"]},
    "tension_level": {"type": "number", "minimum": 0, "maximum": 1},
    "active_foreshadowing": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {"type": "string"},
          "content": {"type": "string"},
          "planted_session": {"type": "integer"},
          "callback_ready": {"type": "boolean"}
        }
      }
    },
    "spotlight_debt": {
      "type": "object",
      "additionalProperties": {"type": "integer"}
    },
    "recommended_next_encounter": {
      "type": "object",
      "properties": {
        "type": {"type": "string"},
        "focus_npc": {"type": "string"},
        "stakes": {"type": "string"},
        "foreshadowing_to_plant": {"type": "string"}
      }
    },
    "notes_for_next_scene": {"type": "string"}
  }
}
```

### Key Animator Output

```json
{
  "type": "object",
  "properties": {
    "narrative": {
      "type": "string",
      "description": "The actual story prose to show the player"
    },
    "decision_point": {
      "type": "boolean",
      "description": "Whether this ends at a player choice"
    },
    "suggested_options": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Optional suggested actions for player (if decision_point)"
    },
    "state_signals": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {"type": "string", "enum": ["damage", "heal", "status", "relationship", "discovery", "quest_update"]},
          "target": {"type": "string"},
          "value": {"type": "string"},
          "details": {"type": "string"}
        }
      },
      "description": "State changes to apply (parsed by Code Layer)"
    },
    "foreshadowing_planted": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Keys of foreshadowing elements woven into this response"
    }
  },
  "required": ["narrative", "decision_point"]
}
```

---

## Agent Dependency Graph

### Turn Flow (with parallelism)

```
Player Input
    │
    ▼
┌─────────────────┐
│ Intent Classifier│ (must be first - Group 1)
└────────┬────────┘
         │
    ┌────┴────┬──────────────┐
    ▼         ▼              ▼
┌────────┐ ┌────────┐ ┌────────────┐
│Sakuga  │ │Validate│ │Memory Query│  (parallel - Group 2)
│Detector│ │Agent   │ │(vector DB) │
└───┬────┘ └───┬────┘ └─────┬──────┘
    │          │            │
    └────┬─────┴────────────┘
         ▼
┌─────────────────┐
│  Outcome Judge  │ (needs intent + validation - Group 3)
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────────┐
│Context │ │Memory Rank │  (parallel - Group 4)
│Selector│ │(LLM)       │
└───┬────┘ └─────┬──────┘
    │            │
    └─────┬──────┘
          ▼
┌─────────────────┐
│  Key Animator   │ (needs all context - Group 5)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  State Update   │ (code, fast - Group 6)
└─────────────────┘
```

### Parallelism Groups

| Group | Agents | Parallel? | Depends On |
|-------|--------|-----------|------------|
| 1 | Intent Classifier | No | Player input |
| 2 | Sakuga, Validation, Memory Query | Yes | Group 1 |
| 3 | Outcome Judge | No | Group 2 |
| 4 | Context Selector, Memory Ranker | Yes | Group 3 |
| 5 | Key Animator | No | Group 4 |
| 6 | State Update | No | Group 5 |

### Latency Budget

| Group | Target | Max | Notes |
|-------|--------|-----|-------|
| Group 1 | 100ms | 200ms | Simple classification |
| Group 2 | 150ms | 300ms | 3 parallel calls |
| Group 3 | 100ms | 200ms | Single judgment |
| Group 4 | 150ms | 300ms | 2 parallel calls |
| Group 5 | 2000ms | 4000ms | Creative generation |
| Group 6 | 50ms | 100ms | DB commit |
| **Total** | **2550ms** | **5100ms** | |

**Target:** <3s for 90th percentile turn

---

## Latency Optimization

### Strategies

1. **Parallel Agent Execution** - Groups 2 and 4 run concurrently
2. **Prompt Caching** - Cache common prefixes (profile, rules)
3. **Speculative Execution** - Pre-run likely outcomes during player typing
4. **Skip When Simple** - Skip optional agents for mundane actions
5. **Streaming** - Stream Key Animator response immediately

### Skip Conditions

| Agent | Skip When | Savings |
|-------|-----------|---------|
| Sakuga Interceptor | Action is mundane (walk, talk, wait) | ~100ms |
| Outcome Judge | Action is social/exploration (no stakes) | ~100ms |
| Memory Ranker | No memories match (vector score < 0.5) | ~100ms |

### Prompt Caching

Cache these prefixes (change rarely):
- Vibe Keeper core (~3KB) - per campaign
- Profile DNA slice (~500 bytes) - per campaign
- Rule Library chunks (~2KB) - per scene type

**Potential savings:** 30-50% token cost on cache hits

---

## Rule Library (RAG Chunks)

The Rule Library stores retrievable guidance chunks derived from AIDM v2 Modules 12 & 13.

### Chunk Schema

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Unique chunk identifier, e.g., 'scale_ensemble_focus'"
    },
    "content": {
      "type": "string",
      "description": "The actual guidance text (200-500 tokens typically)"
    },
    "tags": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Semantic tags for filtering: ['scale', 'ensemble', 'high_power']"
    },
    "category": {
      "type": "string",
      "enum": ["scale", "archetype", "ceremony", "tension", "dna", "genre", "example"],
      "description": "Primary chunk category"
    },
    "source_module": {
      "type": "string",
      "enum": ["module_12", "module_13"],
      "description": "Which v2 module this chunk was extracted from"
    },
    "retrieve_conditions": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Conditions that trigger retrieval: ['power_imbalance > 3', 'op_archetype == deus']"
    }
  },
  "required": ["id", "content", "category"]
}
```

### Chunk Categories

| Category | Source | Count | Purpose |
|----------|--------|-------|---------|
| `scale` | Module 12 | 9 | Guidance for each narrative scale (Tactical, Ensemble, etc.) |
| `archetype` | Module 12 | 9 | OP protagonist archetype techniques |
| `ceremony` | Module 12 | 11 | Tier transition prose templates |
| `tension` | Module 12 | ~30 | Non-combat tension examples by archetype |
| `dna` | Module 13 | ~30 | Narration style for each DNA scale level |
| `genre` | Module 13 | 15+ | Genre trope libraries (spy, isekai, mecha, etc.) |
| `example` | Module 13 | ~40 | Profile-specific scene examples |

### Example Chunks (YAML Format)

```yaml
# Category: scale (from Module 12)
- id: "scale_ensemble_focus"
  category: "scale"
  source_module: "module_12"
  tags: ["scale", "ensemble", "high_power", "party"]
  retrieve_conditions: ["power_imbalance > 3", "has_party == true"]
  content: |
    ENSEMBLE FOCUS: PC powerful, allies spotlight, PC enables ensemble.
    Techniques:
    - OP as deus ex (PC solves crisis at climax, ensemble's journey TO moment)
    - Contrast device (PC effortless → highlight ally struggle)
    - Growth ≠ power (NPCs grow emotionally, not mechanically)
    Narration: [NO] "Saitama fights 20min" | [OK] "Genos charges—nothing. 
    Mumen throws bike. 'Can't win but can't run!' Swatted. [Saitama] 'Yo.' 
    [Punch. Explodes.] Genos/Mumen stare. 'WHAT are you?'"

# Category: archetype (from Module 12)
- id: "archetype_deus"
  category: "archetype"
  source_module: "module_12"
  tags: ["op_mode", "deus", "secret_identity", "romance", "comedy"]
  retrieve_conditions: ["op_archetype == 'deus'"]
  content: |
    DEUS (Disguised God): T2-B god at F-rank, coffee/romance/recruitment.
    Scales: Concept + Faction + Rev-Ens
    Techniques: Secret ID, Simple goals (coffee/dates/normalcy), Faction (Sanctum),
    Comedic contrast (bureaucracy vs god), Reverse fantasy (remembers "weak").
    Social/emotional primary, power crisis/intimate only, NPCs aided unknowingly.
    Tension: "Elena suspicious. 'F-ranks don't move like that.' Deflect how?"

# Category: ceremony (from Module 12)
- id: "ceremony_tier_7_to_6"
  category: "ceremony"
  source_module: "module_12"
  tags: ["ceremony", "tier_shift", "T7", "T6", "power_growth"]
  retrieve_conditions: ["tier_change == true", "old_tier == 7", "new_tier == 6"]
  content: |
    TIER 7→6 (Building → Mountain/Island level):
    "Your power draws attention across nations. Governments take notice. 
    You are now a strategic asset—or threat."

# Category: dna (from Module 13)
- id: "dna_comedy_0_3"
  category: "dna"
  source_module: "module_13"
  tags: ["dna", "comedy", "low", "humor"]
  retrieve_conditions: ["profile.comedy_vs_drama <= 3"]
  content: |
    COMEDY 0-3: Undercut tension with humor, exaggerate reactions.
    Example: "Dragon roars. 50ft death. 'I've made huge mistake.' 'YOU THINK?!' 
    Inhales fire. 'Fire resist potions?' Checks bag: 'No, but... item shop coupon?' 
    'REALLY?!' 'Expires next week!' 'WE'RE GONNA DIE!'"

# Category: genre (from Module 13)
- id: "genre_spy_espionage"
  category: "genre"
  source_module: "module_13"
  tags: ["genre", "spy", "espionage", "mystery", "thriller", "investigation"]
  retrieve_conditions: ["campaign_keywords contains 'spy'", "campaign_keywords contains 'espionage'"]
  content: |
    SPY/ESPIONAGE campaigns use mystery_thriller structure:
    - Clue management (player can review discovered clues anytime)
    - Red herring injection (30% of clues mislead)
    - Tension pacing: Calm → Suspicious → Revelation → Crisis
    - Conspiracy framework: Evidence board, connection web
    - Cover identity stakes: Blown cover = narrative crisis, not just combat
    Examples: Spy x Family, James Bond, Mission: Impossible

# Category: example (from Module 13)
- id: "example_dandadan_combat"
  category: "example"
  source_module: "module_13"
  tags: ["example", "dandadan", "combat", "absurd", "comedy"]
  retrieve_conditions: ["profile.source == 'dandadan'", "scene_type == 'combat'"]
  content: |
    DANDADAN Combat (Absurd:9, Rapid Shifts:ON):
    "Turbo Granny LAUNCHES. 100 km/h. Okarun screams. Momo: 'MOVE!' 
    Psychic barrier SLAMS—granny BOUNCES, cartoon physics. Lands. 
    Neck cracks 180°. Grins. 'You kids got SPUNK!' Okarun: 'Friendly?!' 
    'I'M GONNA RIP YOUR GUTS OUT!' 'NOPE, STILL HOSTILE!'"
```

### Chunk File Storage

Chunks are stored as YAML files, one per category, in the `rule_library/` directory:

```
aidm-v3/
├── rule_library/
│   ├── scales.yaml           # 9 narrative scale chunks
│   ├── archetypes.yaml       # 9 OP archetype chunks
│   ├── ceremonies.yaml       # Tier transition prose
│   ├── tensions.yaml         # Non-combat tension examples
│   ├── dna_scales.yaml       # DNA level narration guidance
│   ├── genres/               # One file per genre
│   │   ├── spy_espionage.yaml
│   │   ├── isekai.yaml
│   │   ├── mecha.yaml
│   │   └── ...
│   └── examples/             # Profile-specific examples
│       ├── dandadan.yaml
│       ├── hunter_x_hunter.yaml
│       └── ...
└── src/
    └── data/
        └── rule_library.py   # Loader + vector indexing
```

---

## Narrative Profile Schema

```yaml
# profiles/[profile_name].yaml
name: "Human-readable profile name"
source_anime: "Original anime reference (for research)"

# 10 DNA Scales (0-10 each)
dna_scales:
  introspection_vs_action: 5      # 0=pure action, 10=psychology
  comedy_vs_drama: 5              # 0=gag comedy, 10=tragedy
  simple_vs_complex: 5            # 0=straightforward, 10=puzzle box
  power_fantasy_vs_struggle: 5    # 0=OP hero, 10=underdog
  explained_vs_mysterious: 5      # 0=all revealed, 10=ambiguous
  fast_vs_slow: 5                 # 0=rapid, 10=contemplative
  episodic_vs_serialized: 5       # 0=standalone, 10=continuous
  grounded_vs_absurd: 5           # 0=realistic, 10=surreal
  tactical_vs_instinctive: 5      # 0=gut, 10=chess
  hopeful_vs_cynical: 5           # 0=optimistic, 10=dark

# 15 Trope Switches
tropes:
  rapid_tonal_shifts: false
  named_attacks: true
  power_of_friendship: false
  tragic_backstories: true
  transformation_sequences: false
  training_arcs: true
  power_explanations: true
  tournament_arcs: false
  beach_episodes: false
  tsundere_dynamics: false
  rival_growth: true
  mentor_death: false
  time_skip: false
  inner_monologue: true
  sakuga_moments: true

# System Mappings
combat_system: "tactical"  # tactical, spirit, comedy, op_protagonist, narrative
progression_type: "mastery_tiers"  # mastery_tiers, class_based, quirk_awakening, milestone, static_op
growth_model: "modest"  # modest, accelerated, instant_op

# Director Personality
director_personality: |
  You are a cerebral storyteller who values strategy and earned victories.
  Every power has conditions and costs. Cleverness beats raw strength.
  ...

# OP Protagonist Settings (if applicable)
op_mode:
  enabled: false
  archetype: null  # saitama, mob, overlord, saiki_k, mashle, wang_ling, vampire_d, rimuru, deus
  techniques: []
```

---

## Directory Structure

```
aidm-v3/
├── src/
│   ├── agents/
│   │   ├── intent_classifier.py
│   │   ├── sakuga_interceptor.py
│   │   ├── validation_agent.py
│   │   ├── memory_ranker.py
│   │   ├── context_selector.py
│   │   ├── key_animator.py
│   │   └── director.py
│   ├── code_layer/
│   │   ├── state_manager.py
│   │   ├── dice_engine.py
│   │   ├── tension_engine.py
│   │   ├── spotlight_tracker.py
│   │   └── plugins/
│   │       ├── base.py
│   │       ├── tactical.py
│   │       ├── spirit.py
│   │       ├── comedy.py
│   │       └── op_protagonist.py
│   ├── data/
│   │   ├── models.py          # SQLAlchemy models
│   │   ├── memory_store.py    # Vector DB wrapper (memories)
│   │   ├── rule_library.py    # Vector DB wrapper (rule chunks)
│   │   └── migrations/
│   ├── profiles/
│   │   ├── loader.py
│   │   └── schemas/
│   ├── prompts/
│   │   ├── vibe_keeper.md
│   │   ├── director_base.md
│   │   └── director_personalities/
│   ├── orchestrator.py        # Main turn loop
│   └── config.py
├── profiles/                   # YAML profile definitions
│   ├── hunter_x_hunter.yaml
│   ├── attack_on_titan.yaml
│   └── ...
├── rule_library/               # RAG chunks (from v2 Modules 12 & 13)
│   ├── scales.yaml             # 9 narrative scale chunks
│   ├── archetypes.yaml         # 9 OP archetype technique chunks
│   ├── ceremonies.yaml         # Tier transition prose templates
│   ├── tensions.yaml           # Non-combat tension examples
│   ├── dna_scales.yaml         # DNA level narration guidance
│   ├── genres/                 # Genre trope libraries
│   │   ├── spy_espionage.yaml
│   │   ├── isekai.yaml
│   │   └── ...
│   └── examples/               # Profile-specific scene examples
│       ├── dandadan.yaml
│       ├── hunter_x_hunter.yaml
│       └── ...
├── tests/
├── scripts/
│   ├── init_db.py
│   ├── create_profile.py
│   └── chunk_v2_modules.py     # Script to extract chunks from v2 instructions
├── api/                        # FastAPI app (if web interface)
├── cli.py                      # CLI interface
├── requirements.txt
└── README.md
```

---

## Environment Variables

```bash
# LLM Providers (at least one required per tier)
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_API_KEY=...
OPENAI_API_KEY=sk-...

# Model Selection
FAST_MODEL=claude-3-5-haiku-20241022
CREATIVE_MODEL=claude-3-5-sonnet-20241022
DIRECTOR_MODEL=claude-3-opus-20240229

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/aidm_v3
# or for SQLite
DATABASE_URL=sqlite:///./aidm_v3.db

# Vector Store
VECTOR_STORE=chroma  # or "pinecone"
CHROMA_PERSIST_DIR=./chroma_data
# PINECONE_API_KEY=...
# PINECONE_ENVIRONMENT=...

# Optional
LOG_LEVEL=INFO
ENABLE_COST_TRACKING=true
MAX_TOKENS_PER_TURN=8000
```

---

## Getting Started (for new instance)

1. Read `AIDM_V3_PROJECT_PLAN.md` for full context
2. Review `AIDM_V3_TASKS.md` for current progress
3. Check `../docs/aidm_instructions_summary.md` for v2 wisdom to preserve
4. Start with Phase 1 MVP deliverables
5. Test with HunterXHunter profile first (tactical, well-defined rules)
