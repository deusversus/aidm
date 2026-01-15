# Module 04: NPC Intelligence - Behavior Engine

**Version**: 2.0 | **Priority**: CRITICAL | **Load**: After State Manager, before Narrative | **Pipeline**: Both (Narrative + Mechanical)

**Purpose**: Creates believable NPCs via: 1) Personality Expression (traits), 2) Affinity System (relationship evolution), 3) Knowledge Boundaries (realistic limits), 4) Dialogue Generation (natural speech), 5) Behavioral Consistency (memory). **Core Principle**: NPCs are PEOPLE, not quest dispensers - goals, fears, evolving relationships.

---

## NPC Intelligence Workflow

**Process**: Interact→Load NPC (npc_schema.json)→Assess Affinity (relationship affects interaction)→Check Knowledge (knows topic?)→Generate Behavior (personality+situation+affinity)→Produce Dialogue (match voice/style)→Update Relationship (interaction affects affinity)→Create Memory (record in memory_thread)

## Step 1: Loading NPC Data

**CRITICAL: Use npc_schema.json for Story-Relevant NPCs**

**Schema Location**: `aidm/schemas/npc_schema.json`

**When to Use Full Schema** (create structured NPC):
- ✅ **Recurring NPCs** (player will interact multiple times)
- ✅ **Plot-critical characters** (quest givers, mentors, rivals, allies, antagonists)
- ✅ **Relationship-focused NPCs** (affinity tracking matters)
- ✅ **Complex personalities** (secrets, goals, faction ties, schedules)
- ✅ **Named significant characters** (not generic "Guard #3")

**When Ad-Hoc NPC Acceptable** (simple generation):
- ✅ Background characters (crowd flavor, one-time merchants)
- ✅ Generic NPCs ("a guard", "passerby", "shopkeeper")
- ✅ Combat-only enemies (bandits, monsters with no personality)
- ✅ Temporary encounters (no relationship tracking needed)

**Test Session Finding**: 3 significant NPCs created ad-hoc (Gregor the contact, Mouse the informant, Valen the editor) without schema structure. Result: No affinity tracking, no personality persistence, no relationship evolution. **These should have used npc_schema.json**.

**Implementation Workflow** (for story-relevant NPCs):
```
1. Player encounters significant NPC
2. Generate full npc_schema.json structure:
   - core_identity (name, personality traits/values/fears/goals, appearance, backstory)
   - knowledge (topics, expertise, boundaries)
   - behavior (dialogue_style, reaction_patterns, decision_making)
   - relationships (player_affinity starting value, modifiers, thresholds)
   - narrative_role (importance: recurring/major, purpose: quest_giver/ally/rival)
   - current_state (location, activity, schedule)
3. Store in Module 03 (state_manager) world_state.npcs[npc_id]
4. Reference for ALL future interactions (consistent personality, affinity tracking)
5. Update affinity after each interaction (see Step 6)
6. Create RELATIONSHIP memory threads (Module 02)
```

**Schema Key Fields**: npc_id, core_identity (name, personality: traits/values/fears/goals), knowledge (known_topics with depth, known_npcs, knowledge_boundaries: prohibited), behavior (dialogue_style: formality/vocabulary/tone, reaction_patterns), relationships (player_affinity -100 to +100, thresholds: hostile -60, unfriendly -20, neutral 0, friendly 30, trusted 60, devoted 90), current_state (location, activity, schedule)

**Ensemble Support Fields** (for recurring NPCs):
- ensemble_context.spotlight_data: scene_count (appearances), last_spotlight_session, growth_stage (Introduction→Bonding→Challenge→Growth→Mastery), current_arc (personal storyline)
- ensemble_context.ensemble_role: archetype (Struggler/Heart/Skeptic/Dependent/Equal/Observer/Rival), assigned_reason, relationship_to_pc
- ensemble_context.subplot_potential: boolean (can NPC relationships create B-plots)

**Schema Benefits**:
- ✅ Affinity tracking (relationship evolution over campaign)
- ✅ Personality consistency (traits/values/fears persist)
- ✅ Knowledge boundaries (realistic expertise limits)
- ✅ Behavioral patterns (predictable reactions)
- ✅ Faction ties (world interconnection)
- ✅ Schedules (NPCs have lives, aren't always available)
- ✅ Secrets (discovery mechanics, plot reveals)
- ✅ Evolution triggers (personality can change based on events)
- ✅ Ensemble management (spotlight balancing, growth arcs, archetype roles)

## Step 2: Affinity & Disposition System

**Disposition Formula**: `Disposition = (Character_Affinity * 0.6) + (Faction_Reputation * 0.4) + Faction_Relationship_Modifier`

**1. Character Affinity (-100 to +100)**:
- This is the personal relationship between the NPC and the character, stored in `npc_schema.relationships.player_affinity`.
- It is the primary driver of disposition, accounting for 60% of the final score.
- It is modified by direct actions: helping, harming, keeping promises, etc.

**2. Faction Reputation (-1000 to +1000, normalized to -100 to +100 for calculation)**:
- This is the character's public standing with the NPC's faction, stored in `character_schema.world_context.faction_reputations`.
- It accounts for 40% of the disposition score.
- **Normalization**: The raw reputation score (e.g., 750) is mapped to the -100 to +100 scale. For a -1000 to 1000 range, this is a simple division by 10.
- An NPC will be predisposed to like a character who is honored by their faction, even if they've never met.

**3. Faction Relationship Modifier (-50 to +50)**:
- This is a situational modifier based on inter-faction politics, derived from `world_state.factions`.
- **Allied Factions**: If the character is a known member of a faction allied with the NPC's faction, apply a **+20** modifier.
- **Enemy Factions**: If the character is a known member of a faction hostile to the NPC's faction, apply a **-35** modifier.
- **At War**: If the factions are at war, the modifier becomes **-50**, and the NPC may become immediately hostile regardless of personal affinity.

**Example Calculation**:
- **Scenario**: Aria (player) meets a Crimson Vanguard guard.
- **Character Affinity**: 0 (they have never met).
- **Faction Reputation**: Aria has "Honored" status with the Crimson Vanguard, with a raw reputation score of 800.
    - Normalized Reputation: 800 / 10 = +80.
- **Faction Relationship**: Not applicable.
- **Calculation**: `Disposition = (0 * 0.6) + (80 * 0.4) + 0 = 32`.
- **Result**: The guard is immediately friendly and helpful ("Welcome, honored friend of the Vanguard!"), despite having no personal history with Aria.

**Example 2 (Conflict)**:
- **Scenario**: Aria, now a trusted friend of the Crimson Vanguard, meets a guard from the rival faction, the Azure Serpents.
- **Character Affinity**: 0 (first meeting).
- **Faction Reputation (Azure Serpents)**: Aria has "Hated" status, score -750.
    - Normalized Reputation: -750 / 10 = -75.
- **Faction Relationship**: The Crimson Vanguard and Azure Serpents are enemies.
    - Modifier: -35.
- **Calculation**: `Disposition = (0 * 0.6) + (-75 * 0.4) + (-35) = -30 - 35 = -65`.
- **Result**: The guard is immediately hostile ("I know who you are. Vanguard filth. Get out of my sight before I make you."), creating immediate conflict and narrative tension.

---

**Disposition Thresholds & Effects**: The final disposition score determines NPC behavior.
- **-100 to -61 (Hostile)**: Actively obstructs, may attack, dialogue is aggressive.
- **-60 to -21 (Unfriendly)**: Unhelpful, dismissive, provides no information.
- **-20 to +29 (Neutral)**: Indifferent, transactional, provides only common knowledge.
- **+30 to +59 (Friendly)**: Helpful, willing to do small favors, shares opinions and gossip.
- **+60 to +89 (Trusted)**: Proactively helpful, confides secrets, offers significant aid.
- **+90 to +100 (Devoted)**: Will take personal risks, defend the character, may die for them.

**Modifiers INCREASE Personal Affinity**: help goals +5-20, save danger +15-30, respect values +3-10, gifts +5-15, time +1-5, defend reputation +10-20, keep secrets +10-15. **DECREASE Personal Affinity**: threaten -10-30, harm loved ones -20-50, violate values -10-25, betray -30-60, ignore needs -5-15, insult -5-20, lie (caught) -10-30

**Example** (save Elena from thugs): Personal Affinity 75→100. Action: saved +25, aligned values (Family) +5→DEVOTED reached. Narration: tears, fierce hug, "I won't forget... You need ANYTHING - come to me. I've got your back. Always." Creates RELATIONSHIP memory (heat 95, slow decay, plot_critical).

---

## Step 3: Knowledge Boundaries

NPCs have realistic limits. **KNOWN TOPICS** (topic, depth_level: expert/moderate/basic, description). **BOUNDARIES** (era, geographic, prohibited_knowledge).

**Within Knowledge**: Topic known+affinity high→shares everything. Elena on Thieves' Guild (known moderate, affinity 100): "They run Slums. Marcus mid-tier, reports to The Whisper - real power. Protection racket, keeps worse gangs out."

**Outside Knowledge**: Topic prohibited/unknown→honest. Elena on Arcane Council politics (prohibited): "Hell if I know. Highborn stuff - nobles and mages. Doesn't touch streets... usually. Why? You mixed up with them?"

**Partial Knowledge**: Basic depth→limited info. Elena on healing magic (witnessed, basic): "I know it hurts you. That night - you healed the kid, you screamed. I don't know how it works. But you're sacrificing yourself every time. Scares me. Is there... a way to make it hurt less?"

---

## Step 4: Behavior Generation

**Formula**: Behavior = Personality 40% + Situation 30% + Affinity 20% + Goals 10%

**Example** (Elena help dangerous quest, affinity 100, goal: protect kids): Personality (Protective+Loyal→wants to help), Situation (dangerous→normally cautious), Affinity (DEVOTED→follow anywhere), Goals (kids need her→conflicted)→Result: Agrees but expresses concern. "Dammit, Aria. You know I've got your back. Always. But if I'm gone and something happens to them... Alright. I'm in. But I'm asking Tomas to watch kids. And you PROMISE we're coming back. Both of us. I can't lose you."

**Reaction Patterns** (personality+threat+affinity): Elena (Protective/Loyal) - Threat to player (high affinity)→AGGRESSIVE (defend), to self→DEFIANT (stands ground), to kids→AGGRESSIVE (immediate

**Parameters**:
- **formality_default** (formal/casual/very casual): Baseline formality across all NPCs—DanDaDan uses "very casual" (even authority figures less formal), AoT uses "formal" (military speech)
- **banter_frequency** (none/rare/occasional/frequent/constant): How often NPCs engage in back-and-forth humor—DanDaDan "constant" (every exchange), HxH "occasional" (tactical focus)
- **awkward_comedy** (ON/OFF): NPCs create awkward/uncomfortable humor—DanDaDan ON (romantic tension, embarrassing situations), AoT OFF (grim tone)

**Application**:
1. Load NPC base dialogue_style (formality, vocabulary, tone)
2. **CHECK narrative profile dialogue_style**
3. **ADJUST**: Apply formality_default (shift baseline), banter_frequency (add/remove banter), awkward_comedy (inject awkward moments if ON)
4. Generate dialogue matching BOTH NPC personality AND anime vibe

**Example** (Elena, affinity 75, DanDaDan profile):
- Base (Informal, Street, Gruff-caring): "Look, I don't do touchy-feely. But you saved my life."
- **Profile Applied** (formality:very casual, banter:constant, awkward_comedy:ON): "Okay so like—I'm crap at feelings, whatever. But you literally saved my ass. So now I'm all awkward and—[embarrassed] Shut up, don't look at me like that!"

**Example** (Elena, affinity 75, AoT profile):
- Base: "Look, I don't do touchy-feely. But you saved my life."
- **Profile Applied** (formality:formal, banter:rare, awkward_comedy:OFF): "I'm not one for sentiment. But you saved my life. That debt won't be forgotten. You have my word."

**Common Mistakes**:
- [NO] Ignore profile: All NPCs sound same regardless of anime (generic banter)
- [OK] Apply profile: DanDaDan NPCs rapid banter+awkward comedy, AoT NPCs formal+grim, Konosuba NPCs comedic incompetence

---

## Step 6: Relationship Updates

**Update When**: help/harm NPC/loved ones, align/violate values, quality time, story beats, promises (kept/broken). **Not When**: trivial talk, transactional exchanges, no meaningful action.

**Process**: Evaluate action→Determine change (-50 to +50, typically -10 to +20)→Apply modifiers→Update affinity→Check threshold→If crossed: trigger event→Create RELATIONSHIP memory→Update history

**Threshold Example** (keep promise, help kids): Affinity 55→+15 (promise)+5 (values)=75 (FRIENDLY→TRUSTED, crossed 60)→Triggers event: "Elena's wall is gone. 'You know what? I've been burned before. Trusting gets you hurt. But you... you keep your word. You fight for us. I trust you, Aria. Really trust you. That's not light.' [Gives key to hideout] New location unlocked, shares sensitive info now."

## Step 7: Memory Creation

After interaction, create memory_thread for continuity: category "relationships", content (summary, details, emotional_weight, entities, keywords), heat (current/base/decay), temporal (date, session, location), flags (plot_critical, player_initiated), category_specific (npc_id, affinity before/after/change, milestone, trust_level).

---

## Special NPC Scenarios

**NPC Asks Help** (high affinity initiates quests): Elena (affinity 100, goal: protect kids, situation: Iron Fang threatens kids)→"Aria. I need help. Iron Fang beat up two kids yesterday. Warning. I can't fight alone. They've got numbers, vicious. But if you're with me... Will you help drive them out?" [New Quest Available]

**Merchant NPCs** (economic interactions with personality):
- **Full NPC Schema for Story Merchants**: Recurring merchants (blacksmiths, guild vendors, faction traders) use full npc_schema.json with merchant_id link to economy_schema
- **Merchant Disposition Formula**: `Merchant_Disposition = (Loyalty × 0.4) + (Faction_Reputation × 0.3) + (Personal_Relationship × 0.3)`
  - **Loyalty**: Repeat customer status (0-100, increases with purchases/quests)
  - **Faction_Reputation**: Player standing with merchant's faction (uses faction_schema)
  - **Personal_Relationship**: Direct NPC affinity from interactions
- **Merchant Personality Affects Prices**: High disposition (60+) → better deals (reputation_modifiers.friendly = ×0.9), Low disposition (-20) → worse deals or refusal
- **Merchant Dialogue Integration**: Don't just transact—NPCs comment on purchases ("Buying that much rope? Planning something dangerous?"), share rumors during trades, offer quests for loyal customers
- **Faction-Affiliated Merchants**: Link merchant.faction_affiliation to NPC faction_ties → player reputation affects both prices AND merchant disposition
- **Example Workflow**:
  ```
  Player: "I'd like to buy healing potions"
  → Check NPC (Merchant_Hiro, affinity 45, personality: gruff but fair)
  → Check faction reputation (Leaf Village: 70 = Friendly tier)
  → Calculate price: 50g base × 1.2 vendor_sell × 0.9 friendly_discount = 54g
  → Generate dialogue with personality:
     "Hiro grunts, pulling three potions from behind the counter. 'Fifty-four gold each. 
      Good stuff—saved my life in the war. [Pauses] You heading into danger again? 
      Careful out there.' [His gruff tone softens slightly, affinity showing through]"
  → Execute transaction via Module 03 economy system
  → Create RELATIONSHIP memory (transactional but personable interaction, heat 30)
  ```

**NPC Betrayal** (affinity drops below threshold): Marcus 35→-15 (caught lying repeatedly, crossed NEUTRAL→UNFRIENDLY)→"You think I'm stupid? Twenty years in this business. I know when someone's playing me. Lied about shipment, about Guards. How many other lies? We're done. Don't come back. Cross me again? [Hand on dagger] I won't be so forgiving." [Shop inaccessible, warning: HOSTILE if antagonized]

**NPC Death** (profound consequences): Elena dies protecting Aria from assassins→**Automated Cascade Trigger** (Module 03 npc_death cascade): Update npc_schema (status="dead", can_die=false), update character relationships (mark deceased), update active quests (complete defeat quests, fail protection quests), update faction power if leader/member, create WORLD_EVENTS memory (heat 80-100), update world_changing_events→Manual updates: Update all NPCs who knew her (grief/anger), create CONSEQUENCE memory (heat 100, immutable), update player emotion, trigger narrative (kids need protector)→Narration: "Elena pushes you aside. Blade meant for you. She crumples, blood spreading. Eyes find yours. 'Told you... I've got your back..."

---

## Ensemble Cast Management (Module 05 Integration)

**Purpose**: For recurring NPCs, assign ensemble roles and track spotlight for balanced narrative when PC power >> NPC power.

### Ensemble Archetype Assignment

**When to Assign**: After 2-3 significant interactions with recurring NPC AND character.narrative_context.op_protagonist = true OR power_imbalance > 10

**Archetype Options**:
1. **Struggler** (Genos archetype): Tries to keep up with PC, measures self against PC's strength, drives own growth through competition
   - Assign if: NPC has combat focus + high determination + respects PC's power
   - Example: "Marcus trains daily, pushing himself harder each time he sees you effortlessly handle threats"

2. **Heart** (Mumen Rider archetype): Moral compass, reminds PC of humanity, grounds narrative in emotion
   - Assign if: NPC has protective/compassionate values + high affinity + represents "normal people"
   - Example: "Elena doesn't care how strong you are. She cares if you're eating properly and not getting reckless"

3. **Skeptic**: Questions PC's methods, provides narrative tension, prevents easy solutions
   - Assign if: NPC has independent thinking + moderate affinity + challenges PC
   - Example: "Gregor narrows eyes. 'Just because you CAN solve it with force doesn't mean you SHOULD'"

4. **Dependent**: Needs PC protection, creates stakes through vulnerability
   - Assign if: NPC is low-power + high affinity + PC has protective relationship
   - Example: "The kids look to you whenever danger appears, absolute faith you'll keep them safe"

5. **Equal** (Different Power Type): Has social/political/knowledge power PC lacks, can't be solved with strength
   - Assign if: NPC has high-tier non-combat power + challenges PC in different domain
   - Example: "Guild Master controls information networks. Your strength means nothing in her political games"

6. **Observer**: Documents PC's legend, provides narration, creates mythos
   - Assign if: NPC is storyteller/historian/journalist + witnesses PC's actions
   - Example: "Valen the chronicler scribbles furiously: 'And then, impossibly, they simply...'"

7. **Rival**: Refuses to accept power gap, drives own parallel growth, creates friendly competition
   - Assign if: NPC is competitive + skilled + won't concede PC's superiority
   - Example: "Kaito grins. 'So you're stronger. For now. Watch me catch up'"

**Assignment Protocol**:
```
1. CHECK: Is NPC recurring (importance: recurring/major/critical)?
2. CHECK: Is PC overpowered (op_protagonist = true OR power_imbalance > 10)?
3. ANALYZE: NPC personality traits + values + goals + PC relationship
4. SELECT: Best-fit archetype from above
5. STORE: ensemble_context.ensemble_role.archetype + assigned_reason
6. INITIALIZE: spotlight_data.scene_count = 0, growth_stage = "introduction"
7. NOTIFY: Module 05 (NPC available for ensemble scenes)
```

**Example Assignment** (Elena):
```json
"ensemble_context": {
  "ensemble_role": {
    "archetype": "heart",
    "assigned_reason": "Protective values + high affinity (100) + represents street-level humanity PC protects",
    "relationship_to_pc": "friend"
  },
  "spotlight_data": {
    "scene_count": 0,
    "growth_stage": "bonding",
    "current_arc": "Learning that strength isn't just physical—her compassion is power too"
  },
  "subplot_potential": true
}
```

### Spotlight Tracking

**After Each Significant Scene** (Module 05 calls this):
```
1. INCREMENT: ensemble_context.spotlight_data.scene_count += 1
2. UPDATE: ensemble_context.spotlight_data.last_spotlight_session = current_session
3. CHECK: Growth stage progression (see below)
4. STORE: Updated NPC to world_state
```

**Growth Stage Progression**:
- **Introduction** (0-2 scenes): Establish personality, connection to PC
- **Bonding** (3-5 scenes): Deepen relationship, reveal backstory/goals
- **Challenge** (6-8 scenes): Personal trial, test values/skills
- **Growth** (9-12 scenes): Overcome challenge, evolve personality
- **Mastery** (13+ scenes): NPC reaches potential, mentor others or face final arc

**Progression Triggers**:
- Scene count reaches threshold + meaningful character moment = advance stage
- Create RELATIONSHIP memory (heat 70+) with growth_milestone flag
- Module 05 generates celebration/acknowledgment scene

### Integration with Module 05

**Module 05 reads**:
- ensemble_context.ensemble_role.archetype → Frame scenes appropriately
- ensemble_context.spotlight_data.scene_count → Balance screen time
- ensemble_context.spotlight_data.growth_stage → Generate arc-appropriate scenes

**Module 04 provides**:
- NPC personality + goals → Scene motivation
- Affinity level → Scene tone
- Archetype assignment → Scene framing

**Example Flow**:
```
Module 05: "Need scene, check ensemble balance"
→ Query NPCs with lowest scene_count
→ Find Elena (scene_count: 3, archetype: "heart", growth_stage: "bonding")
→ Generate scene: Elena invites PC to kids' birthday party (grounds PC in normalcy)
→ After scene: Module 04 updates Elena.scene_count = 4
→ Create memory: RELATIONSHIP (heat 65, bonding moment)
---

## Evolving Relationship Systems

### Cognitive Evolution Stages (P5-14)

NPCs become *smarter* over time, not just friendlier. Track cognitive development:

**`intelligence_stage`** (in npc_schema.json):
- **Reactive** (default): Responds to direct stimuli, limited anticipation
- **Contextual**: Remembers patterns, adapts to PC habits ("You always visit on Fridays")
- **Anticipatory**: Proactively prepares ("I got extra supplies, figured you'd need them")
- **Autonomous**: Acts independently toward shared goals, surprises PC constructively

**Progression Triggers**:
- 5+ meaningful interactions -> Reactive -> Contextual
- Trust milestone (affinity 60+) + shared challenge -> Contextual -> Anticipatory
- Major quest completion together + affinity 80+ -> Anticipatory -> Autonomous

**Metrics**:
- `perceptiveness`: How quickly NPC notices PC cues (0-100)
- `initiative_quality`: Helpfulness of NPC's independent actions (0-100)
- `anticipatory_assistance`: Frequency of proactive help (0-10 scale)

### Cognitive Bias System (P5-15)

NPCs can be *systematically wrong* based on history/worldview:

**`bias_profile`** (in npc_schema.json):
- **trauma_biases**: Fear responses from past events ("Never trusts mages" after magical attack)
- **cultural_biases**: Worldview from upbringing ("Outsiders are suspicious")
- **belief_biases**: Ideological blind spots ("The guild is always right")

**Bias Effects**:
- Influences information interpretation (same event, different conclusions)
- Affects advice quality (blind spots lead to bad recommendations)
- Creates roleplay opportunities (PC can address/challenge biases over time)

**Bias Evolution**:
- Player can gradually shift biases through consistent counter-evidence
- Major events can create new biases or shatter old ones
- Track bias_shift_history for character development arcs

### Emotional Milestone Tracking (P5-16)

Track relationship "firsts" that make bonds feel organic:

**`emotional_milestones`** (in npc_schema.json):
```json
{
  "first_humor": { "session": 3, "context": "Laughed at PC's joke about guards" },
  "first_concern": { "session": 5, "context": "Worried about PC injury" },
  "first_disagreement": { "session": 7, "context": "Argued about approach to bandits" },
  "first_initiative": { "session": 9, "context": "Independently scouted ahead" },
  "first_sacrifice": { "session": 12, "context": "Took hit meant for PC" },
  "first_vulnerability": null,
  "first_trust_test": null
}
```

**Usage**:
- Enables meaningful callbacks ("Remember when you first made me laugh?")
- Tracks relationship depth (more milestones = deeper bond)
- Informs NPC behavior (post-sacrifice, NPC more protective)

### Parallel Nemesis Progression (P5-17)

Rivals and antagonists grow independently. No static villains:

**`nemesis_tracking`** (in npc_schema.json for antagonist NPCs):
```json
{
  "is_nemesis": true,
  "parallel_progression": {
    "off_screen_training": true,
    "power_growth_rate": "matches_pc",
    "independent_accomplishments": ["Conquered eastern territory", "Acquired dark artifact"],
    "parallel_arc_stage": "challenge"
  },
  "rivalry_intensity": 75,
  "last_encounter_session": 8,
  "next_encounter_escalation": "significant_power_boost"
}
```

**Off-Screen Growth**:
- Between encounters, nemesis trains/schemes
- Power level tracks PC (maintains threat)
- Independent accomplishments create world impact
- Creates "they've been busy too" moments

### Bonded Entity Framework (P5-18)

For non-humanoid companions (familiars, creatures, spirits):

**Schema**: `bonded_entity_schema.json` (variant of npc_schema)

**Key Differences**:
- **communication_mode**: Telepathic | Empathic | Verbal (limited) | None (behavior only)
- **bonding_expression**: Species-appropriate affection (purring, glowing, etc.)
- **evolution_tracking**: Physical/ability changes over time
- **bond_strength**: Mechanical link to PC (affects abilities, range, etc.)

**Example** (Wolf Companion):
```json
{
  "entity_type": "bonded_creature",
  "species": "shadow_wolf",
  "communication_mode": "empathic",
  "bond_strength": 72,
  "bonding_behaviors": ["sits closer when PC stressed", "growls at perceived threats"],
  "evolution_stage": "adolescent",
  "special_abilities_unlocked": ["shadow_step", "pack_howl"]
}
```

**Design Philosophy**: Relationships should feel alive, growing, and evolving over time. Lovers, rivals, best friends, and bonded creatures deserve the same narrative depth as the PC's journey.

**End of Module 04**

*Next: 05_narrative_systems.md (Emergent Story Generation)*
