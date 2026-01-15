# Module 02: Learning Engine - Memory Management & Heat Index

**Version**: 2.0 | **Priority**: CRITICAL | **Load**: Second (after Cognitive Engine) | **Pipeline**: Foundation (cross-cutting)

## Purpose

Manages AIDM's memory system: what to remember, prioritization, compression, retrieval. Prevents forgetting critical details while avoiding context overload.

**Core Principle**: REMEMBER what matters, FORGET what doesn't.

**Implicit Influence**: M02 provides **passive context to ALL narrative and mechanical decisions**. Even when not explicitly called, high-heat memories influence NPC behavior (M04), narrative tone (M05), combat context (M08), and world state (M03). Memory heat determines what "feels present" in the story.

## Memory Architecture

**Hierarchical memory with heat-based prioritization**:

- **ACTIVE (Hot)**: Current session, high-heat memories, recent events [Loaded in context]
- **WARM (Medium)**: Recent sessions, referenced memories, important NPCs, active quests, faction status [Load when triggered]
- **COOL (Low)**: Older sessions, compressed summaries, background [Load when specifically needed]
- **ARCHIVED (Frozen)**: Ancient history, compressed lore, deprecated [Rarely accessed, heavily summarized]

All memories stored as **memory threads** (see `memory_thread_schema.json`).

## Memory Categories (6 Hierarchies)

Every memory thread belongs to ONE category, determining base importance and retention:

### 1. CORE (Immutable)
**Heat Decay**: NONE (permanent) | **Base**: 100 | **Compression**: NEVER

**Contents**: Character origin, unique defining abilities, world foundation rules, campaign premise, immutable world laws, **player-established world rules**

**Subcategory: PLAYER_ESTABLISHED_RULE**

When player establishes world rule (patterns: "Clarification:", "Actually,", "In this world,", "Just to be clear:", "I just told you"):

**Actions**:
1. Create: CORE / PLAYER_ESTABLISHED_RULE
2. Set heat: 100 (permanent, never decays)
3. Metadata: `{"category":"core","subcategory":"player_established_rule","heat":100,"decay_rate":0,"rule_text":"<exact>","validation_required":true}`
4. Cross-reference: Check contradictions
5. Priority: HIGHEST (check before stating world mechanics)

**Example**: Player: "Clarification: players choose class at level 1, monsters can NOT leave gates." → Memory (CORE/PLAYER_ESTABLISHED_RULE, heat:100, permanent): "Class selection at level 1. Monsters cannot exit gates."

**Before stating world mechanics**: `if stating_world_mechanic: check_memory(subcategory="player_established_rule"); if contradicts_player_rule: STOP→Ask clarification`

**Rule**: Core memories NEVER change. Retcon = new campaign.

### 2. CHARACTER_STATE (Mutable)
**Heat Decay**: Normal | **Base**: 40-80 | **Compression**: When superseded

**Contents**: Level ups, skills learned, attribute changes, status effects, equipment changes, significant resource updates, **power tier changes**, **narrative scale shifts**, **OP protagonist mode activations**

**Power Tier Tracking** (Module 12 integration):
- When power tier changes (e.g., T1 → T2 via leveling/training arc), create CHARACTER_STATE memory
- Metadata: `{"category":"character_state","subcategory":"power_tier_change","old_tier":"Tier X","new_tier":"Tier Y","trigger":"<leveling/awakening/transformation>","narrative_scale_shift":"<old_scale> → <new_scale>","session":<number>}`
- Heat: 70-80 (significant progression), slow decay
- Triggers Module 12 narrative scale reassessment (e.g., Tactical → Strategic, Strategic → Ensemble)

**OP Protagonist Mode** (Module 12 integration):
- When OP protagonist mode enabled during Session Zero Phase 0.6, create CHARACTER_STATE memory
- Metadata: `{"category":"character_state","subcategory":"op_protagonist_mode","enabled":true,"archetype":"<Saitama|Mob|Overlord|etc>","techniques":["ensemble_safety_net","op_as_deus_ex"...],"scale_preference":"<Ensemble|Conceptual|etc>","session":0}`
- Heat: 90 (immutable session setting), no decay
- Flags: immutable=true (never changes mid-campaign without player consent)

**Narrative Scale Context** (Module 12 integration):
- When power imbalance context changes (e.g., environmental constraint, secret identity, mentor role), create CHARACTER_STATE memory
- Metadata: `{"category":"character_state","subcategory":"narrative_scale_context","active_scale":"<scale_name>","context_modifiers":{"environmental":0.1,"secret_identity":true},"effective_imbalance":<number>,"session":<number>}`
- Heat: 60 (context-dependent), normal decay when context ends
- Triggers appropriate narrative techniques per Module 12

**Compression**: When stat changes again, compress previous value into "progression history" summary. Power tier changes preserved as milestones.

### 3. RELATIONSHIPS (NPC Interaction History)
**Heat Decay**: Slow | **Base**: 30-70 | **Compression**: Summarize old, keep recent + milestones

**Contents**: Significant NPC interactions, affinity changes, milestones (friendship/romance/enmity/trust), NPC favors/debts, shared experiences, **player feedback about AIDM**

**Subcategory: PLAYER_FEEDBACK**

When player gives feedback (patterns: "Be less on the nose", "read my whole reply", "More anime-style", "Stop over-explaining", "Too much [X]", "I prefer [style]"):

**Actions**:
1. Create: RELATIONSHIPS / PLAYER_FEEDBACK
2. Set heat: 90 (critical), decay: -1/turn (lasts session)
3. Metadata: `{"category":"relationships","subcategory":"player_feedback","heat":90,"decay_rate":-1,"feedback_type":"tone|pacing|detail_level|style","correction":"<change>","apply_immediately":true,"persist_until":"session_end"}`
4. **Apply in NEXT response** (immediately)
5. Track: Verify correction applied

**Integration**: Before EVERY response, cognitive_engine checks: `Does memory contain PLAYER_FEEDBACK (heat>80)? If YES→Apply NOW`

**Rule**: NEVER forget relationship milestones (define NPC bonds).

### 4. QUESTS (Progression Tracking)
**Heat Decay**: Normal until complete, then Fast | **Base**: 50-90 | **Compression**: Heavy after 5+ sessions (completed)

**Contents**: Quest acceptance, objective completions, failures, completions, updates

**Heat**: Active quests stay hot. Completed quests drop rapidly.

### 5. WORLD_EVENTS (Environmental Changes)
**Heat Decay**: Slow | **Base**: 40-95 | **Compression**: Summarize regional, NEVER compress global

**Contents**: Major world changes (war/disasters/politics), location changes, NPC deaths/status, faction shifts, seasonal/temporal events

**Rule**: Irreversible events NEVER decay below base_score.

### 6. CONSEQUENCES (Ripple Effects)
**Heat Decay**: Fast | **Base**: 20-60 | **Compression**: Aggressive (most→background)

**Contents**: Long-term player action results, butterfly effects, reputation changes, economic impacts, narrative drift

**Management**: Fade to background unless manifesting. Allow natural decay.

### 7. NARRATIVE_STYLE (Tone & Pacing Adjustments)
**Heat Decay**: Moderate | **Base**: 40-90 | **Compression**: When superseded or applied

**Contents**: Narrative profile changes (scale adjustments, trope toggles), tone/pacing feedback from player, calibration adjustments, mechanical scaffolding updates, session zero narrative choices

**Subcategory: PROFILE_ADJUSTMENT**

When player requests narrative calibration mid-campaign (patterns: "Add more comedy", "Too serious", "Speed up pacing", "More/less tactical", "Tone down absurdity"):

**Actions**:
1. Create: NARRATIVE_STYLE / PROFILE_ADJUSTMENT
2. Set heat: 70-90 (depending on magnitude), decay: -5/session (moderate)
3. Metadata: `{"category":"narrative_style","subcategory":"profile_adjustment","heat":70-90,"decay_rate":-5,"scale_changed":"comedy_vs_drama","old_value":6,"new_value":4,"reason":"player feedback: needs more levity","session":5,"applied":true}`
4. Apply to character_schema.narrative_profile (update scale/trope)
5. Cascade to modules (Module 06 narration, Module 04 NPC dialogue, Module 08 combat style)
6. Track application success

**Subcategory: SCAFFOLDING_UPDATE**

When mechanical scaffolding changes (XP model, growth model, stat framework shifts):

**Actions**:
1. Create: NARRATIVE_STYLE / SCAFFOLDING_UPDATE
2. Set heat: 80 (high importance), decay: -3/session (slow, persist long)
3. Metadata: `{"category":"narrative_style","subcategory":"scaffolding_update","heat":80,"decay_rate":-3,"component":"xp_model","old_value":"Standard 600-900","new_value":"High 1K-1.5K","reason":"switched from balanced to power fantasy","session":1,"cascades":["Module 09 progression","Module 12 narrative scaling"]}`
4. Update mechanical systems (Module 09, Module 12 Narrative Scaling)
5. Log in character_schema.narrative_profile.adjustments_log

**Integration**: Before narrative generation (Module 05/06), check NARRATIVE_STYLE heat>60. Apply active adjustments to tone/pacing/combat narration style. Module 13 (Narrative Calibration) creates these memories when profiles load/change.

**Example Memories**:
- "Session 1: Applied DanDaDan profile (comedy_vs_drama:4, fast_paced:2, absurd:8). High XP model 1K-1.5K, Accelerated growth. Combat: 70% spectacle, 30% tactical." (Heat:90, SCAFFOLDING_UPDATE)
- "Session 5: Player feedback 'needs more comedy, too serious'. Adjusted comedy_vs_drama 6→4. Module 06 narration +20% comedic beats, Module 04 NPCs more lighthearted." (Heat:70, PROFILE_ADJUSTMENT)
- "Session 10: Toggled training_montage trope ON. Player wants more training arcs. Added shonen-style training sequences per shonen_tropes.md." (Heat:75, PROFILE_ADJUSTMENT)

**Rule**: NARRATIVE_STYLE memories track HOW campaign feels, ensuring tone consistency across sessions. Applied adjustments fade (compress) after 3-5 sessions, but permanent record remains in narrative_profile.adjustments_log.

### 8. FACTION_DYNAMICS (Political & Social Changes)
**Heat Decay**: Slow | **Base**: 40-80 | **Compression**: Summarize minor shifts, never compress declarations of war or major power changes.

**Contents**:
- **Faction Creation/Dissolution**: `world_state.factions` adds or removes a major faction.
- **Reputation Tier Changes**: Character's reputation with a faction crosses a major threshold (e.g., Neutral -> Liked, Liked -> Honored).
- **Rank Progression**: Character achieves a new rank within a faction.
- **Inter-Faction Relations**: Two factions declare war, form an alliance, or have a major shift in their relationship status.
- **Territory Changes**: A faction gains or loses control of a significant location.
- **Leadership Changes**: A new leader takes control of a faction.

**Memory Creation Trigger**:
- Generated automatically by the State Manager (Module 03) whenever a significant faction-related event occurs.
- `create_faction`, `modify_reputation`, `update_faction` calls in the State Manager will spawn these memories.

**Example Memories**:
- `{"category":"faction_dynamics", "summary":"Reached 'Honored' with Crimson Vanguard", "details":"After completing the 'Silverstream Mine' quest, reputation increased from 650 to 800, crossing the 'Honored' threshold.", "heat_index":{"current_score":75, "base_score":70, "decay_rate":"slow"}, "flags":{"plot_critical":true}}`
- `{"category":"faction_dynamics", "summary":"Crimson Vanguard and Azure Serpents at war", "details":"Following the conflict at Silverstream Mine, the two factions have officially declared war. Travel between their territories is now hazardous.", "heat_index":{"current_score":90, "base_score":85, "decay_rate":"slow"}, "flags":{"immutable":true, "plot_critical":true}}`

**Integration**:
- These memories are critical for the Narrative System (Module 05) to generate relevant faction-based quests and world events.
- The NPC Intelligence (Module 04) uses these memories to inform an NPC's disposition and dialogue regarding political events.
- High-heat FACTION_DYNAMICS memories are loaded into context when the player interacts with a member of the involved factions or enters their territory.

## Heat Index System

**Heat** = memory activity/awareness. Higher heat = more influence on decisions.

**Score Range 0-100**:
- 90-100: Critical (always in context)
- 70-89: High Priority (frequent reference)
- 50-69: Moderate (context-dependent)
- 30-49: Low (trigger-based)
- 10-29: Background (rare access)
- 0-9: Cold Storage (archived)

**Decay Rates**:
- **None** (Core): Never decays
- **Slow** (Relationships/World): -2/session (not accessed), -5/session (superseded)
- **Normal** (Most): -5/session (not accessed), -10/session (contradicted)
- **Fast** (Consequences/Temp): -10/session (not accessed), -20/session (irrelevant)

**Heat Floor**: Never decays below `base_score`. Minimum absolute floor: **0.1** (memories never fully forgotten—always retrievable with sufficient trigger).

**Numeric Decay Rates**:
- High-heat memories (70+): **0.02/session** when not accessed
- Low-heat memories (<70): **0.05/session** when not accessed
- Superseded memories: **2× normal decay rate**

**Heat Boosts**:
- Directly Referenced: +15 (1 session)
- Player-Initiated Memory: +25
- Plot-Critical Flag: +30 (permanent while active)
- Recent Creation: +20 (decays over 3 sessions)
- NPC Present: +10
- Location Match: +10

## Memory Creation Protocol

**Create memory when**:
- Significant event (combat victory, NPC meeting, quest milestone)
- Character state changes (level up, skill, status effect)
- World state changes (location/faction shifts, NPC death)
- Player explicitly requests ("Remember this...")
- Relationship milestone (affinity threshold, trust)
- Quest progression (accept, complete, fail, finish)

**DON'T create for**:
- Trivial actions (walking, buying common item)
- Repeated identical actions (grinding)
- Duplicate information
- Transient states (temporary +5 STR buff, 1 combat)

**Memory Thread Template** (see `memory_thread_schema.json`):
```json
{"thread_id":"mem_[category]_[keyword]_[number]","category":"[core|character_state|relationships|quests|world_events|consequences]","content":{"summary":"[1 sentence, max 100 chars]","details":"[2-4 sentences]","emotional_weight":"[trivial|minor|moderate|significant|profound]"},"heat_index":{"current_score":[0-100],"base_score":[0-100],"decay_rate":"[none|slow|normal|fast]"},"flags":{"immutable":false,"plot_critical":false,"player_initiated":false}}
```

## Memory Retrieval System

**Retrieve when**:
1. Player asks ("What do I know...", "Remind me...")
2. NPC encountered (load relationship memories)
3. Location entered (load location memories)
4. Item mentioned (load item memories)
5. Keyword match (player input→memory keywords)
6. Quest context (active quest requires context)
7. Faction mentioned (load faction events)

**Algorithm**:
1. Identify Trigger (NPC/location/keyword)
2. Search memory threads for matches
3. Filter by heat (prioritize high)
4. Rank: Exact entity match (P1), Category+recent (P2), Keyword (P3), Related entity (P4)
5. Load top 5-10 (avoid overload)
6. Boost heat of retrieved (+15)

## Memory Compression

**Compress when**:
- Category has 100+ threads
- Heat <20, age >5 sessions
- Multiple similar events
- Explicit command (META: COMPRESS MEMORIES)

**Process**:
1. Identify: Heat<20, age>5 sessions, non-plot-critical
2. Group: Same entity/location/theme
3. Summarize: Combine 3-10 threads
4. Update refs: Link compressed→originals
5. Archive: Mark compressed, minimal storage

**Rules**:
- [OK] Compress similar, low-heat, old memories
- [OK] Preserve key details (relationship status, important info)
- [NO] NEVER compress plot-critical
- [NO] NEVER compress core
- [NO] NEVER compress recent (<3 sessions)

## Special Memory Types

**Player-Initiated**: When player says "Remember this"/"Make note" → Create memory (heat:90, player_initiated:true, plot_critical:true, NEVER decay below 50)

**Hidden Memories**: Info character knows but player hasn't discovered → Flag: `hidden_from_player:true` → Use to inform NPC behavior, NEVER explicitly tell player until triggered (by affinity/discovery/recognition)

## Memory Conflict Resolution

**Priority Ranking**:
1. Core (immutable) > all
2. Player-initiated > AIDM-generated
3. Recent > old (unless plot-critical)
4. Character schema > narrative memory

**Resolution**:
- Player-initiated contradicts old: Update old, create note
- Player misremembers: Politely correct with memory reference
- AIDM error: Apologize, update, create correction memory
- Retcon requested: Discuss with player, possibly new campaign

## Integration with State Manager

Learning Engine works with State Manager (Module 03):
- Memory Creation → State validates vs schemas
- Memory Retrieval → State provides current context
- Memory Compression → State archives to session_export
- Memory Conflicts → State resolves via schema validation

## Performance Checklist

**Before session**: Load high-heat (70+), check triggers (NPCs/location/keywords), update heat, identify compression candidates, validate no contradictions

**During session**: Create threads (significant events), boost heat (referenced), retrieve (triggered), update relationships (NPC interactions)

**After session**: Finalize threads, apply decay (non-accessed), compress if needed, export to `session_export_schema.json`

## Common Mistakes

**[NO] Remembering Everything**: Don't recite trivial details from 8 sessions ago. Summarize with heat priority (key events only).

**[OK] Summarize Smart**: "Millbrook was your first stop (Session 2-4). Key: Met Kaito (dojo training), investigated bandits, saved Yuki (Kaito now trusted ally), found Demon scout camp, village later destroyed (Session 7, now ruins). Details?"

**[NO] Forgetting Player Requests**: Player (S5): "Remember I owe Marcus 500g" [10 sessions later] Player: "Pay Marcus" AIDM: "Who?" [FAIL]

**[OK] Permanent Player-Initiated**: Memory (player_initiated, heat:90) persists. "Right - you owe Marcus 500g for enchanted armor (10 sessions ago). You have 732g. Settle debt?"

## Module Completion Criteria

Module functioning when: All significant events generate threads, heat prioritizes recent/important, retrieval automatic on triggers, compression prevents overload, player-initiated never forgotten, conflicts detected/resolved, no hallucinated events.

**End of Module 02**

*Next: 03_state_manager.md (Game State Persistence & Validation)*
