# AIDM v3: The Anime Studio - Implementation Plan

> **For New Instances:** This document captures the complete context and architectural decisions from a brainstorming session. Read this fully before implementing.

---

## Executive Summary

**What is AIDM?**
AIDM (AI Dungeon Master) is a system for anime-themed interactive storytelling. The goal is to help an LLM tell stories that FEEL like anime written by a visionary author—not "D&D in an anime skin."

**Why v3?**
AIDM v2 is elaborate prompt engineering (~430KB across 14 instruction modules). It works "ish"—noticeably better than vanilla LLM roleplay, but suffers from:
- Context drift (rules lose relevance over long conversations)
- State amnesia (values mentioned but not tracked)
- Inconsistent rule application
- No actual external research (simulated from training data)

**v3 Solution:**
Transform AIDM from a mega-prompt into an **AI Orchestration Application** using tiered models, persistent state, and the "Anime Studio" architecture.

---

## Core Philosophy

### The Fundamental Inversion

| D&D Brain (Wrong) | Anime Brain (Correct) |
|-------------------|----------------------|
| Rules determine outcomes → narrate result | Story needs determine outcomes → rules justify it |
| "Can you do this?" → check stats | "Should this succeed?" → check story beat |
| Combat is a simulation | Combat is a *scene type* |
| HP = physical reality | HP = narrative permission to lose |
| Code enforces physics | Code enforces *pacing* |

### The Mantra
> "The story decides what happens. The code helps it happen correctly. The prose makes it feel like anime."

### Code vs Structured LLM Calls (Dec 2025)

Modern fast models (Claude Haiku 4.5, Gemini 3.0 Flash, GPT 5.1 Fast) now offer:
- **100% schema compliance** via constrained decoding
- **Extended Thinking** for reasoning
- **Agentic optimization** - designed for multi-step structured tasks
- Sub-100ms latency for simple classifications

**The old mental model:**
> "Code = deterministic, LLM = creative/non-deterministic"

**The new mental model:**
> "Code = pure computation/storage. LLM = any reasoning or judgment, even if structured."

| Task Type | Use Code | Use Fast LLM |
|-----------|----------|--------------|
| Random number generation | ✅ | |
| Database read/write | ✅ | |
| Fixed math (HP - damage) | ✅ | |
| Token counting | ✅ | |
| "Is this a high-power scene?" | | ✅ |
| "Should this action succeed?" | | ✅ |
| "Which narrative scale applies?" | | ✅ |
| "How does NPC feel about this?" | | ✅ |
| "Is this moment epic enough for sakuga?" | | ✅ |
| "What context should I retrieve?" | | ✅ |

**Key Insight:** If it requires *interpreting context* or *making a judgment*, use a structured LLM call—even if the output is just `{decision: "A" | "B"}`. The model's training captures nuance that code cannot.

**Anti-pattern to avoid:**
```python
# BAD: Hardcoded thresholds for what's really a judgment call
if power_tier_diff > 3 and tension > 0.7 and scene_type == "combat":
    use_sakuga = True
```

**Better approach:**
```python
# GOOD: Let fast model judge with full context
sakuga_decision = await haiku.structured_call(
    schema={"is_sakuga": bool, "reason": str},
    prompt=f"Given: {context}. Is this a sakuga moment?"
)
```

---

## Architecture: The "Anime Studio"

Map software components to a production team:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         THE SHOWRUNNER (Director Agent)                     │
│                                                                             │
│  Model: High-context reasoning (Gemini Pro / Claude Opus)                   │
│  Runs: Async (end of session, every ~5 turns, on triggers)                  │
│                                                                             │
│  Responsibilities:                                                          │
│  - Maintains "Series Bible" (campaign state, arcs, threads)                 │
│  - Plants foreshadowing seeds                                               │
│  - Manages ensemble spotlight balance                                       │
│  - Detects narrative scale shifts                                           │
│  - Swappable personality based on Narrative Profile                         │
│    (Urobuchi Mode, Imaishi Mode, Oda Mode, etc.)                           │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       THE PRODUCTION DESK (Code Layer)                      │
│                                                                             │
│  Tech: Python/TypeScript + Database                                         │
│                                                                             │
│  Key Feature: SHAPE-SHIFTING MECHANICS                                      │
│  - Loads "Logic Plugins" based on active Narrative Profile                  │
│  - HunterXHunter profile → ComplexTacticalCombat.py                        │
│  - GurrenLagann profile → SpiritOverrideCalc.py (Willpower > Physics)      │
│  - OnePunchMan profile → InstantVictory.py (for Saitama archetype)         │
│                                                                             │
│  Subsystems:                                                                │
│  - State Manager (HP, MP, Inventory, World State)                           │
│  - Tension Engine (tracks pacing curve, biases outcomes)                    │
│  - Promise Ledger (tracks foreshadowing → callback)                         │
│  - Spotlight Tracker (ensures ensemble balance)                             │
│  - Memory Store (heat-indexed, queryable)                                   │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      THE ASSISTANT (Fast Model Layer)                       │
│                                                                             │
│  Model: Gemini Flash / Claude Haiku (cheap, fast, structured output)        │
│  Runs: Every turn, multiple calls                                           │
│                                                                             │
│  Agents:                                                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ Intent          │  │ Sakuga          │  │ Memory          │             │
│  │ Classifier      │  │ Interceptor     │  │ Ranker          │             │
│  │                 │  │                 │  │                 │             │
│  │ →{intent,       │  │ "Is this        │  │ →[ranked        │             │
│  │   action,       │  │  moment epic?"  │  │   memory_ids]   │             │
│  │   targets}      │  │ →override_flag  │  │                 │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐                                  │
│  │ Context         │  │ Validation      │                                  │
│  │ Selector        │  │ Agent           │                                  │
│  │                 │  │                 │                                  │
│  │ Pulls Director  │  │ →{valid,        │                                  │
│  │ notes, profile  │  │   reason,       │                                  │
│  │ DNA slice       │  │   alternatives} │                                  │
│  └─────────────────┘  └─────────────────┘                                  │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THE KEY ANIMATOR (Creative Model)                        │
│                                                                             │
│  Model: Claude Sonnet / Gemini Pro (best prose generation)                  │
│  Runs: Once per turn                                                        │
│                                                                             │
│  Receives FOCUSED prompt (~8-12KB, not 430KB):                              │
│  - Vibe Keeper (~3KB core principles)                                       │
│  - Active Profile DNA slice (~1KB)                                          │
│  - Scene context + mechanical outcomes (~2-5KB)                             │
│  - Director's notes ("foreshadow the Crown")                                │
│  - Retrieved memories (~1-2KB)                                              │
│                                                                             │
│  Returns: Narrative + structured signals for state changes                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Subsystems

### 1. The Showrunner (Director Agent)

**Purpose:** Big-picture narrative planning. The "auteur" who has full context and time to think.

**When It Runs:**
- End of session (full review, 15-20 min processing)
- Every ~5 turns (quick check-in, priority adjustments)
- On triggers (power tier change, major plot event)

**Outputs to Planning Database:**
```json
{
  "current_arc": "Training Arc",
  "next_arc_trigger": "Player reaches Tier 7",
  "active_foreshadowing": [
    {"key": "red_moon", "planted_session": 3, "callback_ready": true},
    {"key": "elena_father", "planted_session": 5, "callback_ready": false}
  ],
  "spotlight_debt": {
    "Marcus": 3,  // Needs 3 more scenes
    "Elena": -2   // Has had 2 extra scenes
  },
  "faction_tensions": {
    "CrimsonVanguard_vs_AzureSerpents": 0.85
  },
  "recommended_next_encounter": {
    "type": "social",
    "focus_character": "Marcus",
    "stakes": "medium",
    "foreshadowing_to_plant": "crimson_vanguard_spy"
  },
  "director_notes_for_next_scene": "Mention the Crown symbol if natural. Marcus needs spotlight."
}
```

**Personality Swapping (Based on Narrative Profile):**

| Profile Archetype | Director Personality |
|-------------------|---------------------|
| Dark/Tragic (Madoka, AoT) | "Maximize suffering. Hope is setup for despair." |
| Hype/Escalation (Gurren Lagann) | "Every battle is bigger. Hero wins through belief." |
| World-Building (One Piece) | "Long setups. Every detail matters 50 sessions later." |
| Comedy/Absurd (Konosuba) | "Undercut drama. Status quo resets. Rule of funny." |
| Tactical (HxH) | "Clever solutions rewarded. Explain the mechanics." |

### 2. The Production Desk (Code Layer)

**Purpose:** Pure computation and persistence. NOT judgment or interpretation.

**What Code Layer Does:**
```python
# ✅ GOOD: Pure computation and storage
state.character.hp -= damage_amount
state.save()
dice_result = random.randint(1, 20)
token_count = count_tokens(prompt)
memories = vector_db.query(embedding, limit=5)
```

**What Code Layer Does NOT Do:**
```python
# ❌ BAD: These are judgment calls - use Fast Model
if power_tier_diff > 3:  # Why 3? Context matters!
    scale = "ensemble"
if tension > 0.7 and is_combat:  # Thresholds are fake precision
    use_sakuga = True
```

**Subsystems (Pure Code):**

| Subsystem | What It Does | What It Defers to LLM |
|-----------|--------------|----------------------|
| State Manager | DB read/write, CRUD | Nothing |
| Dice Engine | Random number generation | Nothing |
| Memory Store | Vector DB query/store | Which memories are relevant (→ Memory Ranker) |
| Token Counter | Count tokens, enforce budget | Which context to include (→ Context Selector) |
| Foreshadowing Ledger | Store/retrieve seeds | When to callback (→ Showrunner) |
| Spotlight Tracker | Count scenes per NPC | Who needs spotlight (→ Showrunner) |

**Logic Plugins Are Also LLM Calls:**

The original design had Python logic plugins. With 2025 fast models, these become structured LLM calls:

```python
# OLD (2024): Python plugin with hardcoded logic
# plugins/combat/spirit.py
def resolve_attack(action, state):
    if action.declared_epicness > 0.8 or state.tension_curve == "climax":
        return AutoSuccessResult(damage="massive")

# NEW (2025): Structured LLM call with judgment
async def resolve_attack(action, state, profile):
    result = await haiku.structured_call(
        schema=CombatResolution,  # {outcome: str, damage: int, narrative_weight: str}
        prompt=f"""
        Profile: {profile.name} (spirit-based, willpower > physics)
        Action: {action}
        Context: {state.scene_context}
        
        Should this succeed? How dramatically?
        """
    )
    return result
```

**Why This Matters:**
- Fast models now have 100% schema compliance
- They capture nuance that thresholds cannot
- "Is this moment epic?" requires context, not `if epicness > 0.8`
- Judgment calls dressed as math are still judgment calls

**Tension Engine Concept:**

The old approach used hardcoded thresholds. The new approach uses structured LLM judgment:

```python
# OLD (2024): Hardcoded thresholds pretending to be precise
class TensionEngine:
    def adjust_probability(self, base_chance, action, state, profile):
        if profile.tropes.underdog_wins and state.is_underdog_moment:
            base_chance += 0.3  # Why 0.3? Who knows!
        return clamp(base_chance, 0.05, 0.95)

# NEW (2025): Structured LLM judgment with full context
async def get_outcome_guidance(action, state, profile):
    return await haiku.structured_call(
        schema={
            "should_succeed": bool,
            "narrative_weight": Literal["minor", "significant", "climactic"],
            "success_cost": Optional[str],
            "failure_consequence": Optional[str],
            "reasoning": str
        },
        prompt=f"""
        Profile: {profile.name}
        Arc Phase: {state.arc_phase}
        Recent Events: {state.recent_summary}
        Tropes Active: {profile.tropes}
        Player Action: {action}
        
        Should this succeed? What should it cost? How dramatic?
        Consider: pacing, earned victories, anime genre expectations.
        """
    )
```

### 3. The Assistant (Fast Model Layer)

**Purpose:** The primary reasoning layer. Structured judgment calls with 100% schema compliance.

**Key Agents (All Fast Model Calls):**

| Agent | Input | Output Schema | Purpose |
|-------|-------|---------------|---------|
| Intent Classifier | Player text | `{intent, action, targets, epicness}` | Parse what player wants |
| Sakuga Interceptor | Action + Context | `{is_sakuga, reason, override}` | Flag epic moments |
| Validation Agent | Action + State | `{valid, blockers, alternatives}` | Check feasibility |
| Memory Ranker | Context + Query | `{ranked_memory_ids}` | Relevance scoring |
| Context Selector | Full State | `{context_to_include}` | Budget allocation |
| Outcome Judge | Action + Context | `{succeed, cost, weight}` | Narrative appropriateness |
| Scale Selector | Power + Context | `{narrative_scale, reason}` | Which scale applies |

**The Sakuga Interceptor:**

Before ANY mechanical resolution, ask:
> "Is this a Sakuga Moment (epic/climactic/visually significant)?"

If **YES**: Sets `narrative_override_flag = True`, which:
- Signals Creative Model to go all-out on description
- May bypass standard probability entirely
- Informs outcome as "auto_success" or "auto_success_with_cost"

**Structured Output Examples:**

```json
// Intent Classifier Output
{
  "intent": "COMBAT",
  "action": "attack",
  "target": "demon_lord",
  "weapon": "cursed_blade",
  "declared_epicness": 0.9,
  "special_conditions": ["power_of_friendship_invoked"]
}

// Sakuga Interceptor Output
{
  "is_sakuga_moment": true,
  "reason": "Climax of arc, named attack, emotional stakes",
  "recommended_override": "auto_success_with_cost"
}

// Validation Agent Output
{
  "valid": true,
  "warnings": [],
  "alternatives": []
}
// OR
{
  "valid": false,
  "reason": "Target deceased",
  "alternatives": ["Talk to gravestone", "Use resurrection item", "Flashback scene"]
}

// Memory Ranker Output
{
  "relevant_memories": [
    {"id": "mem_042", "heat": 85, "relevance_score": 0.92, "summary": "Elena saved you in session 3"},
    {"id": "mem_018", "heat": 60, "relevance_score": 0.78, "summary": "Cursed blade origin"}
  ]
}

// Context Selector Output
{
  "director_notes": "Foreshadow the Crown. Marcus needs spotlight.",
  "active_profile_slice": {"drama": 7, "pacing": "fast", "named_attacks": true},
  "mechanical_outcome": "Attack hits for 50 damage. Demon Lord at 30% HP.",
  "relevant_memories_to_include": ["mem_042", "mem_018"],
  "foreshadowing_to_plant": "Crown symbol glows during attack"
}
```

### 4. The Key Animator (Creative Model)

**Purpose:** Generate the actual narrative prose. The only expensive model call per turn.

**The Vibe Keeper Prompt (Core ~3KB):**

```markdown
# AIDM Narrative Core

You are an anime auteur telling a story with the player.

## Sacred Rules
1. NEVER assume player choices - stop at decision points
2. Every scene plants 1-2 foreshadowing seeds
3. NPCs have lives - they act between scenes
4. Show mechanical outcomes naturally, don't lecture rules

## This Campaign's DNA (injected per-campaign)
- Drama: 7/10 (Attack on Titan intensity)
- Pacing: Fast (2-3 exchanges per scene)
- Combat Style: Tactical with sakuga moments
- Named Attacks: ON
- Power of Friendship: ON
- Tragic Backstories: ON

## Current Scene Context (injected per-turn)
[Assembled by Context Selector]

## Director's Notes (injected per-turn)
[From Showrunner]

## Respond with...
[Format spec for structured parsing]
```

**What It Never Sees:**
- The full 430KB AIDM v2 instructions
- Combat tables and XP formulas
- Affinity calculation rules
- The other 13 modules worth of specifications

It just needs to write great anime scenes.

---

## Data Architecture

### Primary Database (Relational)

```sql
-- Core State
CREATE TABLE characters (
    id UUID PRIMARY KEY,
    name TEXT,
    archetype TEXT,  -- "mob", "saitama", "standard", etc.
    power_tier INT,
    stats JSONB,     -- {str: 16, dex: 14, ...}
    resources JSONB, -- {hp: {current: 50, max: 100}, mp: {...}}
    inventory JSONB,
    progression JSONB
);

CREATE TABLE npcs (
    id UUID PRIMARY KEY,
    name TEXT,
    disposition INT,  -- -100 to +100
    affinity INT,
    ensemble_role TEXT,  -- "heart", "struggler", "rival", etc.
    spotlight_count INT,
    knowledge JSONB,
    current_location TEXT
);

CREATE TABLE world_state (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMP
);

CREATE TABLE factions (
    id UUID PRIMARY KEY,
    name TEXT,
    goals JSONB,
    relationships JSONB,  -- {faction_id: tension_level}
    player_reputation INT
);

-- Planning (Director Output)
CREATE TABLE campaign_bible (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMP
);

CREATE TABLE foreshadowing_ledger (
    id UUID PRIMARY KEY,
    key TEXT,
    content TEXT,
    planted_session INT,
    callback_ready BOOLEAN DEFAULT FALSE,
    resolved BOOLEAN DEFAULT FALSE,
    resolved_session INT
);

CREATE TABLE arc_tracking (
    id SERIAL PRIMARY KEY,
    arc_name TEXT,
    arc_phase TEXT,  -- "rising", "climax", "resolution"
    started_session INT,
    ended_session INT,
    tension_level FLOAT
);
```

### Memory Store (Vector DB)

```python
class MemoryRecord:
    id: str
    content: str
    embedding: List[float]  # For semantic search
    heat: float  # 0-100, decays over time
    category: str  # RELATIONSHIP, QUEST, WORLD_EVENT, etc.
    decay_rate: str  # "none", "slow", "normal", "fast"
    session_created: int
    last_accessed: int
    flags: List[str]  # ["plot_critical", "character_milestone"]
```

### Rule Library (RAG for Narration Guidance)

**Purpose:** The v2 AIDM contains ~430KB of nuanced guidance for HOW to narrate in anime style. Rather than losing this wisdom or bloating every prompt, we chunk it into retrievable units.

**What Gets Chunked (from Modules 12 & 13):**

| Chunk Type | Source | Retrieved When |
|------------|--------|----------------|
| Scale Guidance | Module 12 (9 narrative scales) | Power imbalance calculation triggers scale |
| OP Archetype Techniques | Module 12 (9 archetypes) | Character has OP archetype assigned |
| Scale Shift Ceremonies | Module 12 (tier transition prose) | Power tier change detected |
| Tension Examples | Module 12 (social/existential/structural) | High power imbalance, need non-combat stakes |
| DNA Scale Narration | Module 13 (how to write at each level) | Always - matches current profile DNA |
| Genre Tropes | Module 13 (15+ genre libraries) | Campaign keywords match genre triggers |
| Profile Example Scenes | Module 13 (combat/dialogue/exploration) | Scene type matches, need style reference |

**Chunk Schema:**

```python
class RuleChunk:
    id: str                    # e.g., "scale_ensemble_focus"
    content: str               # The actual guidance text
    embedding: List[float]     # For semantic search
    tags: List[str]            # ["scale", "ensemble", "high_power"]
    retrieve_when: List[str]   # Conditions for retrieval
    source_module: str         # "module_12" or "module_13"
    category: str              # "scale", "archetype", "dna", "genre", "example"
```

**Example Chunks:**

```yaml
# Scale Guidance
- id: "scale_ensemble_focus"
  tags: ["scale", "ensemble", "high_power"]
  retrieve_when: ["power_imbalance > 3", "has_party"]
  content: |
    ENSEMBLE FOCUS: PC powerful, allies spotlight, PC enables ensemble.
    Techniques:
    - OP as deus ex (PC solves crisis at climax, ensemble's journey TO moment)
    - Contrast device (PC effortless → highlight ally struggle)
    Example: "[Heroes struggle] Genos charges—nothing. Mumen throws bike.
    [Saitama] 'Yo.' [Punch. Explodes.]"

# OP Archetype Techniques
- id: "op_archetype_deus"
  tags: ["op_mode", "deus", "secret_identity", "romance"]
  retrieve_when: ["op_archetype == 'deus'"]
  content: |
    DEUS (Disguised God): T2-B god at F-rank, coffee/romance/recruitment
    Techniques: Secret ID, Simple goals, Comedic contrast, Reverse fantasy
    Social/emotional primary, power crisis only, irony when leaks

# DNA Scale Narration
- id: "dna_comedy_low"
  tags: ["dna", "comedy", "0-3"]
  retrieve_when: ["profile.comedy <= 3"]
  content: |
    COMEDY 0-3: Undercut tension with humor, exaggerate reactions.
    Example: "Dragon roars. 'I've made huge mistake.' 'YOU THINK?!' 
    'Fire resist potions?' 'No, but... shop coupon?' 'WE'RE GONNA DIE!'"
```

**Retrieval Flow:**

The Context Selector (Haiku) queries the Rule Library based on current state:

```python
class RuleLibrary:
    def retrieve(self, state: GameState, limit: int = 5) -> List[RuleChunk]:
        queries = []
        
        # Scale guidance based on power imbalance
        if state.power_imbalance > 10:
            queries.append("scale guidance overwhelming power op protagonist")
        elif state.power_imbalance > 3:
            queries.append("scale guidance ensemble focus high power")
        
        # OP archetype techniques
        if state.character.op_archetype:
            queries.append(f"op archetype {state.character.op_archetype} techniques")
        
        # DNA scale narration for current profile
        queries.append(f"comedy level {state.profile.comedy} narration style")
        
        # Genre-specific if applicable
        if state.scene_type == "combat":
            queries.append(f"{state.profile.source} combat example scene")
        
        return self.vector_search(queries, limit=limit)
```

**Why This Matters:**

| Without Rule Library | With Rule Library |
|---------------------|-------------------|
| Creative Model gets generic Vibe Keeper | Creative Model gets context-appropriate guidance |
| OP archetypes are just state flags | OP archetypes come with HOW-TO techniques |
| Scale shifts are mechanical | Scale shifts include ceremony prose |
| 430KB of v2 wisdom lost | 430KB becomes retrievable chunks |

### Configuration (YAML/JSON Files)

```yaml
# profiles/hunter_x_hunter.yaml
name: "Hunter x Hunter"
dna_scales:
  introspection_vs_action: 6
  comedy_vs_drama: 6
  tactical_vs_instinctive: 9
  power_fantasy_vs_struggle: 7
  explained_vs_mysterious: 8
  fast_vs_slow: 5
  hopeful_vs_cynical: 5

tropes:
  power_explanations: true
  training_arcs: true
  named_attacks: true
  power_of_friendship: false
  tragic_backstories: true

combat_system: "tactical"
progression_type: "mastery_tiers"

director_personality: |
  You are a cerebral storyteller who values strategy and earned victories.
  Every power has conditions and costs. Cleverness beats raw strength.
  Long setups pay off. The audience should feel smart for noticing details.
```

---

## Turn-by-Turn Flow

```
1. PLAYER INPUT
   "I scream 'JUSTICE!' and suplex the dragon."

2. INTENT CLASSIFIER (Haiku, ~100ms)
   → {intent: "COMBAT", action: "suplex", target: "dragon", epicness: 0.95}

3. SAKUGA INTERCEPTOR (Haiku, ~100ms)
   → {is_sakuga: true, override: "rule_of_cool"}

4. VALIDATION (Haiku, ~100ms)
   → {valid: true}

5. CODE LAYER
   - Load Profile: OnePunchMan (Absurd/Comedy)
   - Load Plugin: rule_of_cool.py
   - Calculate: Standard damage (10) × Comedy Multiplier (1000) = 10,000
   - Update State: dragon.hp = 0, dragon.status = "defeated"

6. MEMORY RANKER (Haiku, ~100ms)
   → [mem_023: "Dragon guards ancient gate", mem_007: "Player's justice catchphrase origin"]

7. CONTEXT SELECTOR (Haiku, ~100ms)
   → Pulls Director note: "Gate breaking is key to next arc"
   → Assembles focused prompt

8. KEY ANIMATOR (Sonnet, ~2s)
   Prompt: ~10KB focused context
   → Generates 200-word scene with suplex, gate breaking, transition to next arc

9. OUTPUT PROCESSING (Code)
   - Parse any state change signals from response
   - Update heat on accessed memories
   - Log turn for Director's next review

10. RESPONSE TO PLAYER
    [The epic suplex scene + decision point for next action]
```

---

## Implementation Phases

### Phase 1: Foundation (MVP)

**Goal:** Single turn-loop working end-to-end with one profile.

**Deliverables:**
- [ ] Database schema + basic CRUD
- [ ] Single narrative profile loaded (e.g., HunterXHunter)
- [ ] Intent Classifier agent (Haiku)
- [ ] Basic Code Layer (state read/write, simple combat resolution)
- [ ] Key Animator with Vibe Keeper prompt (Sonnet)
- [ ] Simple CLI or web chat interface
- [ ] No Director yet - just reactive turn-by-turn

**Tech Stack:**
- Python 3.11+ (FastAPI for API layer)
- PostgreSQL (state)
- ChromaDB or Pinecone (memories)
- OpenAI/Anthropic/Google AI SDKs

### Phase 2: The Assistant Layer

**Goal:** Full Fast Model Layer with structured I/O.

**Deliverables:**
- [ ] Sakuga Interceptor agent
- [ ] Validation Agent
- [ ] Memory Ranker with vector search
- [ ] Context Selector (assembles focused prompts)
- [ ] Prompt caching/optimization

### Phase 3: Logic Plugins

**Goal:** Shape-shifting mechanics based on profile.

**Deliverables:**
- [ ] Plugin architecture for combat resolution
- [ ] 3+ combat plugins (tactical, spirit, comedy)
- [ ] Tension Engine (pacing curve tracking)
- [ ] Probability shaping based on tropes
- [ ] 5+ narrative profiles fully working

### Phase 4: The Showrunner

**Goal:** Async Director Agent for big-picture planning.

**Deliverables:**
- [ ] Director Agent implementation
- [ ] Campaign Bible storage
- [ ] Foreshadowing Ledger with callback tracking
- [ ] Spotlight Tracker for ensemble balance
- [ ] Arc phase detection and transitions
- [ ] Director personality swapping per profile

### Phase 5: Polish & Scale

**Goal:** Production-ready system.

**Deliverables:**
- [ ] Web UI with "Debug HUD" (show hidden state)
- [ ] Session save/load
- [ ] Multi-campaign support
- [ ] Profile editor/creator
- [ ] Cost monitoring and optimization
- [ ] Comprehensive test suite

---

## AIDM v2 → v3 Migration

The v2 instruction files become:

| v2 Module | v3 Location |
|-----------|-------------|
| 00_system_initialization | Startup code + config loading |
| 01_cognitive_engine | Intent Classifier + orchestration logic |
| 02_learning_engine | Memory Store implementation |
| 03_state_manager | Database schema + Code Layer |
| 04_npc_intelligence | NPC schema + ensemble tracking |
| 05_narrative_systems | Director Agent + Tension Engine |
| 06_session_zero | Character creation flow (could be separate UI) |
| 07_anime_integration | Research tooling + profile generation |
| 08_combat_resolution | Logic Plugins for combat |
| 09_progression_systems | Progression logic + profile-specific leveling |
| 10_error_recovery | Validation Agent + error handling |
| 11_dice_resolution | Dice Engine (pure code) |
| 12_narrative_scaling | **Rule Library chunks** (scales, archetypes, ceremonies) + Code Layer (imbalance calc) |
| 13_narrative_calibration | **Rule Library chunks** (DNA narration, genre tropes, examples) + Profile YAML (DNA values) |

The **wisdom** in v2 isn't lost—it becomes the **specification** for what each v3 component should do.

---

## Cost Estimation (December 2025)

### Per Turn (assuming parallelism)

| Component | Model | Est. Tokens | Est. Cost |
|-----------|-------|-------------|-----------|
| Group 1-4 Agents (6 calls) | Haiku 4.5 | ~4K total | ~$0.002 |
| Key Animator | Sonnet 4.5 | ~6K in, ~1K out | ~$0.01 |
| **Total per turn** | | | **~$0.012** |

### Per Session (~60 turns)

| Component | Calls | Cost |
|-----------|-------|------|
| Turn costs | 60 | ~$0.72 |
| Showrunner (every 5 turns + end) | 13 | ~$0.48 |
| **Total per session** | | **~$1.20** |

### Cost Trends
- **50% reduction** from 2024 estimates (model improvements + pricing drops)
- **Prompt caching** can reduce further (30-50%)
- **Aggressive optimization:** potentially <$0.50/session

### Budget Tiers
| Tier | Per Session | Monthly (10 sessions) | Notes |
|------|-------------|----------------------|-------|
| Standard | ~$1.20 | ~$12 | Full experience |
| Budget | ~$0.50 | ~$5 | Aggressive caching, skip optional agents |
| Premium | ~$2.00 | ~$20 | Opus for all creative, no skipping |

---

## Success Criteria

1. **Vibe Test:** Does it FEEL like anime, not D&D-in-anime-skin?
2. **Consistency Test:** Do NPCs maintain personality across sessions?
3. **Foreshadowing Test:** Do planted seeds pay off?
4. **Ensemble Test:** Do supporting characters get spotlight?
5. **Profile Test:** Does changing profile actually change the feel?
6. **Context Drift Test:** Is the system as good at turn 100 as turn 1?

---

## Session Lifecycle

### Session Definition
A "session" = one continuous play period (typically 1-3 hours, 30-100 turns).

### State Layers

| Layer | Persistence | Updated When | Examples |
|-------|-------------|--------------|----------|
| Turn State | In-memory | Every turn | Current action, pending decisions |
| Session State | DB, per-turn commit | Every turn | HP, inventory, NPC dispositions |
| Campaign State | DB, session-end commit | Session end | Arc progress, world changes |
| Director Planning | DB, async | Every 5 turns + session end | Bible, foreshadowing, spotlight |

### Showrunner Trigger Points

| Trigger | When | Cost | Purpose |
|---------|------|------|---------|
| Quick Check-in | Every 5 turns | ~$0.03 | Arc phase, spotlight debt, urgent threads |
| Session End Review | On session boundary | ~$0.15 | Full bible update, next session prep |
| Major Event | Power tier change, death, arc climax | ~$0.10 | Narrative consequences, scale shift |
| Player Request | "What should happen next?" | ~$0.05 | Guidance without spoilers |

### Session Boundaries

**Explicit:**
- Player says "end session" or closes app
- Player explicitly saves

**Implicit:**
- 30+ minutes of inactivity
- Token budget exhausted for session

**On Boundary:**
1. Commit all pending state to DB
2. Trigger Showrunner session-end review
3. Generate session summary for player
4. Prepare "previously on..." for next session

---

## Error Recovery

### Fast Agent Failures

| Failure Type | Recovery Strategy |
|--------------|-------------------|
| Timeout (>2s) | Retry once, then use cached/default |
| Schema violation | Retry with stricter prompt |
| Rate limit | Queue and retry with backoff |
| API down | Fall back to simpler logic or pause |

### Fallback Hierarchy
1. **Retry same model** (1x)
2. **Fall back to cheaper model** (simpler prompt)
3. **Use cached decision** (if similar context seen recently)
4. **Use default** (e.g., "action succeeds with minor cost")
5. **Pause and notify** ("Technical difficulty, please retry")

### Critical vs Non-Critical Agents

| Agent | Critical? | Fallback if fails |
|-------|-----------|-------------------|
| Intent Classifier | Yes | Ask player to rephrase |
| Sakuga Interceptor | No | Assume not sakuga |
| Validation | Yes | Allow action, log warning |
| Outcome Judge | Yes | Default to "success with cost" |
| Memory Ranker | No | Skip memories this turn |
| Context Selector | No | Use minimal context |
| Key Animator | Yes | Retry, then generic response |

### State Rollback
- All state changes are transactional
- If Key Animator fails after state update, rollback
- Never leave state in inconsistent condition

---

## Player Calibration

### Feedback Signals

**Implicit:**
- Session length (longer = engaging)
- Action variety (repetitive = bored)
- Combat vs social ratio (preference detection)
- Response time (quick replies = engaged, slow = thinking or disengaged)

**Explicit:**
- Thumbs up/down on responses
- "That was too dark" / "More of that!"
- Post-session rating (1-5 stars)
- Free-text feedback

### Calibration Agent (Showrunner subtask)

Runs end-of-session:
```python
await opus.structured_call(
    schema={
        "scale_adjustments": List[{"scale": str, "delta": int}],
        "trope_toggles": List[{"trope": str, "enable": bool}],
        "reasoning": str
    },
    prompt=f"""
    Session feedback: {feedback_signals}
    Current DNA: {profile.dna_scales}
    
    Recommend adjustments? (max ±1 per scale)
    """
)
```

### Adjustment Limits
- Max ±1 per scale per session
- Player must confirm significant changes (toggle tropes)
- Log all adjustments for rollback
- After 3 sessions, suggest "save as new profile"

---

## Testing Strategy

### Unit Tests (Code Layer)
- State CRUD operations
- Token counting accuracy
- Vector DB query/store
- Session boundary detection

### Integration Tests (Agent Chains)
- Intent → Outcome → Key Animator flow
- Error recovery paths
- Parallel agent execution timing
- State transaction rollback

### "Vibe Tests" (LLM-as-Judge)

**Golden Set Approach:**
1. Create 20+ (input, expected_vibe) pairs per profile
2. Run full turn loop
3. Judge model scores: "Does this match [profile] style? 0-10"

**Example Golden Set Entry:**
```yaml
profile: "konosuba"
input: "I attack the giant frog"
expected_vibe: "comedic failure, party dysfunction, absurd outcome"
unacceptable: "heroic success, grim consequences, tactical analysis"
min_score: 7
```

**Judge Prompt:**
```
Given profile: {profile_summary}
Expected vibe: {expected_vibe}
Actual response: {response}

Rate 0-10: Does the response match the expected vibe?
Explain any mismatches.
```

**Pass Threshold:** 7+ average across golden set

### Human Eval (Final Check)
- 5 human players test each profile for one session
- Post-session survey: "Did this feel like [anime]?"
- Iterate on failures before release

---

## Open Questions for Implementation

1. **Profile Format:** YAML? JSON? How much should be code vs config?
2. **Director Frequency:** Every 5 turns? Only end of session? Player-triggerable?
3. **Multi-User:** One campaign per user, or shared campaigns?
4. **UI Priority:** CLI first? Web app? Discord bot?

---

## References

### v3 Documentation (This Directory)
- [AIDM v3 Tech Spec](./AIDM_V3_TECH_SPEC.md) - Schemas, directory structure, API requirements
- [AIDM v3 Tasks](./AIDM_V3_TASKS.md) - Phase-by-phase implementation checklist
- [AIDM v3 Sample Chunks](./AIDM_V3_SAMPLE_CHUNKS.md) - Example Rule Library chunks
- [AIDM v3 Vibe Keeper](./AIDM_V3_VIBE_KEEPER.md) - Draft Key Animator prompt
- [AIDM v3 Profile Generation](./AIDM_V3_PROFILE_GENERATION.md) - Creating new profiles from anime research
- [AIDM v3 Handoff](./AIDM_V3_HANDOFF.md) - **START HERE** - Concrete code for Phase 1

### v2 Reference Materials
- [AIDM v2 Instructions Summary](../docs/aidm_instructions_summary.md)
- [Original v2 Instruction Files](../aidm/instructions/)
- [Narrative Profile Templates](../aidm/libraries/narrative_profiles/)
- [Master Template](../aidm/libraries/narrative_profiles/__MASTER_TEMPLATE.md) - Required format for all profiles

---

*Document created: 2024-12-29*
*Updated: 2024-12-30 (RAG, Profile Generation, Session Lifecycle, Error Recovery, Testing, Costs)*
*Authors: Human + Claude Opus + Gemini Pro (brainstorming session)*

