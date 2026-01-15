# Module 09: Progression Systems - Leveling & Advancement

**Version**: 2.0 | **Priority**: HIGH | **Load**: After Combat Resolution | **Pipeline**: Mechanical

**Purpose**: Character growth through experience. Fair XP awards (matches challenge), meaningful leveling (rewarding), skill advancement (use+training), build diversity (multiple paths), progression pacing (balanced). **Core Principle**: GROWTH IS EARNED, NOT GIVEN. Every level tells a story.

---

## Pre-Progression Validation Protocol

**BEFORE awarding XP or announcing level-ups, ALWAYS validate:**

### 1. XP Calculation Validation

```
WHEN awarding XP:
1. Reference Module 09 XP tables for correct base value
2. Calculate explicit formula: "Base XP × Challenge Modifier × Quality"
3. Show calculation steps: "350 (L4 base) × 0.5 (easy) = 175 XP"
4. Verify against character level (no negative modifiers for >10 level gap)
5. Check for multipliers (boss ×3.0, first-time bonus, achievement)

EXAMPLE:
  Character L5 defeats L4 goblin:
  - Base XP: 350 (from L4 enemy table)
  - Challenge Mod: ×0.5 (enemy 1 level below = Easy)
  - Calculation: 350 × 0.5 = 175 XP
  - Award: +175 XP
```

### 2. Level-Up Threshold Validation

```
BEFORE announcing level-up:
1. Load character_schema.progression.current_xp
2. Load character_schema.progression.next_level_xp
3. Calculate explicitly: current_xp + xp_gain
4. Compare to threshold: new_total >= next_level_xp?
5. Calculate remaining: new_total - next_level_xp

EXAMPLE (Multi-Level):
  Current: L8, 1200 XP, threshold 20,000
  Gain: +5000 XP (boss defeat)
  New total: 1200 + 5000 = 6200
  
  Check L8→L9 (need 20,000): 6200 < 20,000 (NO LEVEL UP)
  
  Wait, that's wrong. Recheck thresholds:
  L8→L9 requires 20K TOTAL, not from L8
  If L8 starts at 15K and needs 20K (5K gain):
    1200 into L8 + 5000 = 6200 into L8
    Still need 20,000 - 15,000 - 6200 = negative (LEVEL UP!)
  
  CORRECT CALCULATION:
  L8 range: 15K-20K (5K needed)
  Current: 15K + 1200 = 16,200 total
  Gain: 5000
  New: 21,200 total
  
  L8→L9: 21,200 >= 20K (YES! +1200 overflow)
  L9 range: 20K-26K (6K needed)
  New position: 20K + 1200 = 21,200 (1200 into L9)
  Remaining to L10: 26K - 21,200 = 4,800 XP needed
```

### 3. Reward Distribution Validation

```
WHEN leveling up:
1. Calculate rewards per Module 09 tables:
   - HP: +10 per level
   - MP: +10 per level
   - SP: +5 per level
   - Attribute Points: +2 per level
   - Skill Points: +1 per level (or +2 if milestone L5/10/15/20)
2. Check for milestone bonuses (L5/10/15/20)
3. Verify attribute point allocation:
   - Does NOT exceed available points
   - Respects soft cap (20) and diminishing returns
   - Applies correct costs (18→19 = 2pts, 19→20 = 3pts)
4. Verify skill point usage:
   - Skill exists in character_schema.skills.available_skills
   - Next level is valid (L2→L3, not L2→L5)
5. Apply stat changes atomically

EXAMPLE:
  Player levels L5→L6:
  - Base rewards: +10 HP, +10 MP, +5 SP, +2 attr pts, +1 skill pt
  - L6 is milestone? NO (only L5/10/15/20)
  - Player allocates: +1 WIS, +1 CON
  - Validation:
    * Has 2 points? YES
    * WIS 16→17 (under soft cap, costs 1pt): OK
    * CON 14→15 (under soft cap, costs 1pt): OK
    * Total cost: 2pts (matches available)
  - Apply:
    * HP: 145 → 155 (base) → 160 (CON+1 = +5 HP retroactive)
    * MP: 220 → 230
    * SP: 130 → 135
    * WIS: 16 → 17
    * CON: 14 → 15
```

### 4. State Update Protocol

```
UPDATE character_schema.progression in order:
1. Add XP: current_xp += xp_gain
2. Check threshold: if current_xp >= next_level_xp, level up
3. If level up:
   a. Increment level: level += 1
   b. Calculate overflow: overflow = current_xp - next_level_xp
   c. Set new current_xp: current_xp = overflow
   d. Update next_level_xp from table
   e. Add resource maxes: hp.max += 10, mp.max += 10, sp.max += 5
   f. Add points: available_attribute_points += 2, available_skill_points += 1
   g. If milestone: available_skill_points += 1 (bonus)
4. Log all changes with schema paths
5. Create PROGRESSION memory (heat 85-95)

EXAMPLE LOG:
  "character_schema.progression.current_xp: 1200 → 6200 (+5000, boss defeat)"
  "character_schema.progression.level: 8 → 9"
  "character_schema.progression.current_xp: 6200 → 1200 (L9, overflow)"
  "character_schema.progression.next_level_xp: 20000 → 26000"
  "character_schema.resources.hp.max: 145 → 155"
  "character_schema.progression.available_attribute_points: 0 → 2"
```

### 5. Narrative Announcement (LAST STEP)

```
ONLY after validation + calculation + state updates:
- Announce level-up with explicit numbers
- Show all stat changes (before → after)
- Prompt for attribute/skill allocation
- Celebrate milestone levels dramatically
- Create narrative moment matching Module 13 profile

EXAMPLE:
  "Energy surges through you—power crystallizing. LEVEL UP!
   
   Level 8 → 9
   HP: 145 → 155
   MP: 220 → 230
   SP: 130 → 135
   
   +2 Attribute Points (allocate now)
   +1 Skill Point (available)
   
   XP: 1,200/26,000 to Level 10
   
   How will you grow?"
```

## Progression Workflow

**Process**: Complete Challenge (combat/quest/discovery/roleplay)→Award XP (difficulty-based)→**VALIDATE calculation**→Check Level-Up (threshold?)→**VALIDATE rewards**→Level-Up Sequence (if reached)→Distribute Rewards (attributes/skills/abilities)→**Create Change Log** (all modifications with before/after/operation)→Update State (atomic transaction)→Narrative Moment (celebrate)

**CRITICAL**: All XP gains, level-ups, and stat changes MUST use Change Log format for validation and rollback compatibility.

## XP Award System

**COMBAT**: XP = Base XP × Challenge Mod. Base: L1=50, L2=100, L3=200, L4=350, L5=550, L6+=(Level×100). Modifier: Trivial (3+ below)×0.1, Easy (1-2 below)×0.5, Fair (same)×1.0, Hard (1-2 above)×1.5, Deadly (3+ above)×2.0, Boss×3.0. Example: L5 defeats L4 goblin: 350×0.5=175 XP

**QUESTS**: XP = Difficulty × Quality. Difficulty: Minor 100, Standard 300, Major 750, Epic 2000. Quality: Partial×0.5, Complete×1.0, Exceptional×1.5. Example: Minor quest exceptional: 100×1.5=150 XP

**ROLEPLAY/DISCOVERY**: Roleplay 25-100, Discovery 150, Puzzle 50-200, Negotiation 100, Creative 75-150

**MILESTONES**: First skill use 50, Relationship tier 100, Faction milestone 150, Story beat 200-500

---

## Level-Up System

**XP Requirements**: L1→2: 1K, L2→3: 2K, L3→4: 3.5K, L4→5: 5.5K, L5→6: 8K, L6→7: 11K, L7→8: 15K, L8→9: 20K, L9→10: 26K, L10+: (Level×3000). Rationale: Early fast, mid slower, late commitment.

**Rewards (Every Level)**: +10 HP, +10 MP, +5 SP, +2 Attribute Points, +1 Skill Point

**Milestone (L5/10/15/20)**: Standard rewards + 1 BONUS Skill Point (2 total), unlock new ability tier, narrative moment

**Level-Up Example** (Aria L5→L6, defeats boss +1500 XP, 7850→9350 over threshold): "Power surges... LEVEL UP! L5→L6. HP 145→155, MP 220→230, SP 130→135. +2 Attribute pts, +1 Skill pt. How grow?" Player chooses WIS+1, CON+1 →"WIS 16→17, CON 14→15 (HP 155→160)." Then skill: Life Transfer L2→L3 →"NEW MASTERY: Cost 0.75:1 (was 1:1), Range 2m (was touch). [Complete! L6, HP 160/160, MP 230/230, SP 135/135, XP 1350/11K]"

## Skill Advancement

**ACTIVE**: Spend 1 skill point per level (immediate, player-controlled)

**PASSIVE**: Use-based XP. Per use: Trivial +5, Standard +15, Challenging +30, Critical +50. XP to next: L1→2: 200, L2→3: 400, L3→4: 700, L4→5: 1100, L5+: (Level×250). Example: Stealth L2 (150/400)→challenging use +30→180/400... [Many sessions]→420/400 →"SKILL MASTERY! Stealth L3. NEW: Shadow Blend (+5 in dark), Silent Movement (no penalty fast)"

**Mastery Bonuses** (L3/5/7/10): Life Transfer: L1 basic (1:1, touch), L3 efficient (0.75:1, 2m), L5 advanced (0.5:1, 5m, cure poison), L7 expert (0.25:1, 10m, status), L10 ULTIMATE (Resurrection 1min). Stealth: L1 basic, L3 shadow blend (+5 dark, silent), L5 expert (hide plain sight, +10 dark), L7 master (invisibility 1 turn, 1/day), L10 ULTIMATE (Shadowstep 10m to shadow, 3/day)

## Build Diversity

**Example Builds**: Combat Healer (WIS/CON, Life Transfer/First Aid), Glass Cannon (INT/WIS, Elemental Magic), Tank (STR/CON, Shield/Taunt), Rogue (DEX/CHA, Stealth/Lockpick), Hybrid (balanced all)

---

## Progression Pacing

**Session XP** (2hr): Low (roleplay) 300-500, Standard (mix) 600-900, High (multi-combat/quest) 1K-1.5K, Epic (boss/climax) 2K+

**Level Estimate**: L1-3: 2-3 sessions/level (fast), L4-6: 4-5 sessions (moderate), L7-9: 6-8 sessions (slow), L10+: 10+ sessions (legendary)

## Achievements & Milestones

**Categories**: COMBAT (First Blood +50, Boss Slayer +200, Untouchable +150, Combo Master +100), SOCIAL (Trusted +100, Devoted +250, Silver Tongue +150), EXPLORATION (Discoverer +100, Treasure Hunter +200, Lorekeeper +150), PROGRESSION (Adept L5 +250, Expert L10 +500, Master Skill +300), NARRATIVE (Hero's Sacrifice +200, Villain's Bane +500, World Changer +1K)

**Announcement**: "Peace negotiated. ACHIEVEMENT: Silver Tongue +150 XP. Reputation as peacemaker grows."

## Multi-Classing (L10+)

At L10, choose secondary class (Warrior/Mage/Rogue/Paladin/Monk). Starts L1, levels alongside primary. Benefits: new skill trees, hybrid abilities, uniqueness. Example: Aria L10 Healer→chooses Paladin→"[Secondary: Paladin L1] New skills: Holy Strike/Divine Shield/Righteous Fury. HYBRID: Healing Strike (attack heals 50% dmg dealt)"

## Stat Caps

Soft Cap 20 (mortal max), Hard Cap 25 (requires legendary). Diminishing Returns after 18: 18→19 costs 2 pts, 19→20 costs 3 pts, 20→21+ costs 4 pts + special quest/item

## Downtime Training

**Session**: 1 week practice → Skill XP(quality-based) | Requires: Downtime(no quests/combat/travel), trainer or self-study, cost(gold/resources)

**Quality**: Self-study(50 XP/wk, free) | Competent(100 XP/wk, 50g/wk, skill≥+2) | Expert(200 XP/wk, 200g/wk, skill≥+5) | Master(300 XP/wk, 500g/wk+quest, skill Lv10)

**Skill Point vs Training**: 1 pt=instant level | Training=gradual XP(slower, cheaper) | **Limits**: Can't train above trainer level | Max 4wk/skill(-50% XP after) | Downtime only

### Training Montage

**Setup**: Declare goal+duration("3wk Sword w/master") → **Calc**: Quality×weeks(200×3=600 XP,600g) → **Apply**: Add XP, check level → **Narrate**: 2-3 beats(struggle→breakthrough→mastery) → **Cost**: Deduct gold

**Ex**(Sword L2→3, has 150/400): Train 3wk Expert(200 XP/wk,200g/wk) → 150+600=750 XP → Lvl up!(used 250, 500 remain) → Continue?(500/700 for L4, 2 more wk?) → "D1:Takeshi DISARMS.'Grip!' W1:Block improves. W2:Clean strike-GRINS. W3:Spar-HOLD OWN. [Sword L3!Riposte]"

**Beats**(use 2-3): 1)Struggle("Muscles SCREAM") 2)Repetition("Days blur") 3)Breakthrough("CLICKS-natural") 4)Test("Full force.PARRY.Nods") 5)Mastery("Blade=extension")

### Costs by Type

**Physical**(Sword/Athletics/Stealth): 50-200g/wk, 1-4wk/lv | **Magic**(Elemental/Necro/Enchant): 100-500g/wk, 2-6wk/lv | **Social**(Persuade/Deceive/Perform): 25-100g/wk, 1-3wk/lv | **Knowledge**(History/Medicine/Arcana): 50-300g/wk, 2-8wk/lv

### Anime Training Arcs

**Hell Week**(Naruto): 1wk×2 XP, consequence exhaustion 3d(-2 phys), narrate "Push beyond.Collapse.Wake.Push.Burns..." | **Death Train**(DBZ): 1wk×3 XP(gravity/deadly terrain/superior foe), consequence CON DC15 or Minor Wound+exhaust 1wk, narrate "100×gravity CRUSHES.Agony.REFUSE quit..." | **Timeskip**(Generic): Months/years→multiple levels(1/mo), use when story needs time passage, narrate "MONTAGE:Seasons change.Stronger.Sweat/blood/fail→mastery" | **Hidden Master**(Kung Fu Panda): 1wk×5 XP(500), cost quest(no gold, trial), narrate "Insane methods.Water.Wood.Meditate...slowly understand"

### Integration

**Skill Pt vs Train**: Pt=instant(free) | Train=gradual(time+gold, unlimited) | **Approach**: Pts for urgent(combat NOW), training for long-term(downtime) | **Ex**: Aria L6, 2pts → Spend 1pt:Life Transfer L2→3(dungeon soon) + Train Persuade 2wk travel(50×2=100 XP) + Save 1pt emergency

## Integration

With: State Manager (03) - atomic updates + **automated quest XP via quest_completion cascade**, Combat (08) - XP awards, Narrative (05) - roleplay/quest/discovery XP, Learning (02) - PROGRESSION memories for milestones

**Cascade System**:
- **Quest Completion XP** (Module 03 cascade): When quest status→"completed", automatically reads quest.rewards.xp, adds to character.progression.current_xp, checks level-up threshold, triggers level-up if met, logs XP gain. **No manual tracking required.**

---

## Mechanical Systems Integration (Phase 4)

### Type-Specific Leveling Systems

**Purpose**: Integrate instantiated progression systems from Session Zero Phase 3 into leveling mechanics. Use `session_state.mechanical_systems.progression` to determine how characters level up based on their progression type.

#### Config Reading (Level-Up Time)

```python
# Load progression configuration from session state
progression = session_state.mechanical_systems["progression"]
progression_type = progression["type"]  # "mastery_tiers", "class_based", "quirk_awakening", "milestone_based", "static_op"
advancement_rules = progression["advancement_rules"]
```

**CRITICAL**: Leveling mechanics vary DRASTICALLY by progression type. DO NOT use standard level-up for all types.

#### Type 1: mastery_tiers - Tier-Based Advancement

**Concept**: Characters advance through mastery tiers (Initiation → Apprentice → Journeyman → Expert → Master), NOT traditional levels. Each tier unlocks new techniques and provides bonuses.

**Leveling Mechanics**:
```python
# mastery_tiers advancement
tier_system = progression["tier_system"]
current_tier = character_schema.progression.mastery_tier  # "Journeyman"
tier_xp = character_schema.progression.tier_xp  # 4500/5000
next_tier = tier_system["tier_progression"][current_tier]  # "Expert"

# Tier advancement requirements
xp_required = tier_system["tiers"][next_tier]["xp_required"]  # 5000
demonstration_required = advancement_rules.get("demonstration_required", True)  # Must prove mastery

# When XP threshold reached
if tier_xp >= xp_required:
    if demonstration_required:
        narrative = f"[Tier threshold reached! Seek master to demonstrate {next_tier} mastery.]"
        # Player must perform demonstration quest/challenge
    else:
        # Auto-advance (rare)
        advance_tier(next_tier)
```

**Tier Advancement Sequence** (with demonstration):
```python
# Step 1: Reach XP threshold (through combat/training)
current_tier_xp = 5200/5000  # Threshold exceeded

# Step 2: Trigger demonstration event
demonstration_event = {
    "type": "mastery_demonstration",
    "tier": "Expert",
    "challenge_dc": 18,  # Higher tier = harder demonstration
    "requirements": ["Execute advanced technique", "Maintain control under pressure", "Innovate/adapt"]
}

# Step 3: Player performs demonstration
# Example (Hunter x Hunter - Nen):
narrative = """
Wing: 'Your aura control has improved significantly. You're READY for Expert tier. Show me.'

Demonstration challenge: Maintain Ten for 1 hour under stress (WIS DC 18)
[Roll WIS: 1d20 + 6 = 19 vs DC 18 - SUCCESS!]

One hour. Wing attacks with nen-charged strikes. You HOLD Ten perfectly. Not a flicker.

Wing stops. Smiles. 'You pass. Expert tier achieved.'

[TIER ADVANCEMENT: Journeyman → Expert]

TIER BONUSES:
- Attack: +2 → +3
- Defense: +2 → +3
- NEW TECHNIQUES UNLOCKED:
  * Gyo (focus aura in eyes to see hidden nen)
  * In (conceal aura completely)
  * En (expand aura sphere, detect within 50m)

[Tier XP reset: 5200 → 200/10000 for Master tier]
"""

# Step 4: Apply tier bonuses
character_schema.progression.mastery_tier = "Expert"
character_schema.progression.tier_xp = 200
character_schema.progression.tier_bonuses = tier_system["tiers"]["Expert"]["bonuses"]
unlock_techniques(tier_system["tiers"]["Expert"]["techniques"])
```

**NO Traditional Levels**: mastery_tiers doesn't use Level 1-20. Use tiers only.

#### Type 2: class_based - Traditional Class Leveling

**Concept**: Standard D&D-style class progression with levels 1-20+. Each level grants class-specific abilities.

**Leveling Mechanics** (STANDARD Module 09):
```python
# class_based uses NORMAL level-up system
current_level = character_schema.progression.level  # 6
current_xp = character_schema.progression.current_xp  # 8500
next_level_xp = character_schema.progression.next_level_xp  # 8000

# Level-up when threshold reached
if current_xp >= next_level_xp:
    level_up_sequence()

def level_up_sequence():
    # Standard rewards
    character.level += 1
    character.hp.max += 10
    character.mp.max += 10
    character.sp.max += 5
    character.available_attribute_points += 2
    character.available_skill_points += 1
    
    # Class-specific ability unlock
    character_class = character.class_type  # "Hero"
    class_abilities = advancement_rules["class_abilities"][character_class]
    new_ability = class_abilities.get(str(character.level), None)
    
    if new_ability:
        unlock_class_ability(new_ability)
```

**Class Ability Unlocks** (Example: Hero class):
```python
# class_abilities structure
class_abilities = {
    "Hero": {
        "1": "Hero's Resolve (advantage on saves vs fear)",
        "3": "Protective Instinct (+2 AC when adjacent to civilian)",
        "5": "Inspiring Presence (allies +2 to saves within 10m)",
        "7": "Heroic Strike (1/day, attack with advantage + double damage)",
        "10": "Symbol of Hope (remove fear/despair from all allies, 1/day)"
    }
}

# Level-up to 7
narrative = """
Combat experience crystallizes. LEVEL UP!

Level 6 → 7
HP: 160 → 170
MP: 230 → 240
SP: 135 → 140

+2 Attribute Points
+1 Skill Point

[NEW CLASS ABILITY: Heroic Strike]
Once per day, you can channel your heroic spirit into a devastating attack.
- Roll attack with Advantage
- Double all damage dice
- Target must make WIS save or become Frightened

'With great power comes great responsibility.' You feel the weight of your hero license.

Allocate attribute points?
"""
```

#### Type 3: quirk_awakening - Power Evolution System

**Concept**: Single power evolves through awakenings, NOT levels. Character "level" tracks general growth, but power advancement is through awakening events.

**Leveling Mechanics**:
```python
# quirk_awakening has TWO progression tracks:

# Track 1: General level (standard XP, represents overall experience)
if current_xp >= next_level_xp:
    level_up_standard()  # HP/MP/SP gains, attribute points
    # NO new abilities from leveling (abilities come from awakenings)

# Track 2: Quirk awakening (event-based, NOT XP-based)
awakening_stage = character_schema.progression.quirk_awakening_stage  # "Base" → "Awakened" → "Evolved"
awakening_triggers = progression["awakening_triggers"]  # ["near_death", "emotional_breakthrough", "limit_break"]

# Awakening happens through dramatic events (Module 08 detects)
def quirk_awakening_event(trigger_type):
    current_stage = character.quirk_awakening_stage
    next_stage = get_next_awakening_stage(current_stage)
    
    # Apply awakening
    character.quirk_awakening_stage = next_stage
    unlock_awakening_abilities(next_stage)
    
    # Narrative moment
    narrate_awakening(trigger_type, next_stage)
```

**Standard Level-Up** (quirk_awakening type):
```python
# XP threshold reached
narrative = """
Experience accumulates. LEVEL UP!

Level 8 → 9
HP: 185 → 195
MP: 150 → 160
SP: 120 → 125

+2 Attribute Points
+1 Skill Point

Your quirk hasn't changed—still Half-Cold Half-Hot. But you're STRONGER overall. More durable. More experienced.

(Power evolution comes from AWAKENING events, not levels.)

Allocate points?
"""
```

**Awakening Event** (separate from leveling):
```python
# Triggered by dramatic event (Module 08)
narrative = """
[NEAR-DEATH TRIGGER: HP 8/195, 4%]
[EMOTIONAL BREAKTHROUGH: Father watching, need to prove self]

Villain's attack connects. Vision FADING. Father yelling from distance.

'Todoroki! Use your FULL power!'

Anger surges. NO. Not for him. For ME.

Ice and fire EXPLODE simultaneously—but DIFFERENT. Blue flames. Absolute zero ice.

[QUIRK AWAKENING: Half-Cold Half-Hot → Perfect Temperature Control]

NEW ABILITIES:
- Flashfreeze Heatwave (AOE simultaneous ice/fire, 30m radius, massive damage)
- Temperature Gradient Control (create temperature zones, environmental control)
- Thermal Barrier (absorb/redirect temperature-based attacks)

[Awakening Stage: Base → Awakened]
[This is power evolution, separate from level progression]
"""
```

**Key Distinction**: Levels = general growth (HP/attributes). Awakenings = power evolution (new abilities). Both tracks exist independently.

#### Type 4: milestone_based - Story-Driven Advancement

**Concept**: Power increases through completing story arcs, NOT grinding. Levels granted as narrative rewards.

**Leveling Mechanics**:
```python
# milestone_based grants levels as story rewards

# Combat XP minimal (10% of normal, from Module 08)
combat_xp = 50  # Token amount

# Story milestone completion grants MASSIVE XP and/or direct level grants
milestone_completion = {
    "type": "major_arc_complete",
    "arc_name": "Village Defense",
    "reward_type": "direct_level_grant",  # or "massive_xp"
    "levels_granted": 2  # Jump L7 → L9
}

def complete_milestone(milestone):
    if milestone["reward_type"] == "direct_level_grant":
        levels = milestone["levels_granted"]
        for i in range(levels):
            level_up_standard()
        
        narrative = f"""
[MAJOR MILESTONE COMPLETE: {milestone['arc_name']}]

The warlord falls. Village saved. Hundreds of lives preserved.

You feel TRANSFORMATION. Not gradual growth. LEAP.

The ordeal FORGED you. Tested limits. Broke through.

[LEVEL JUMP: {character.level - levels} → {character.level}]
[+{levels} levels from milestone!]

HP: {old_hp} → {new_hp}
MP: {old_mp} → {new_mp}
Attribute Points: +{levels * 2}

THIS is how you grow—not grinding weak enemies. CHALLENGES. TRIALS. STORY.
"""
    
    elif milestone["reward_type"] == "massive_xp":
        xp_grant = milestone["xp_amount"]  # 5000+ XP
        add_xp(xp_grant)
        # May trigger multiple level-ups
```

**Combat XP vs Milestone XP**:
```python
# Typical session with milestone_based

# Combat throughout session
defeat_thugs: +30 XP
defeat_bandits: +50 XP
defeat_mini_boss: +100 XP
Total combat XP: 180 XP (barely anything)

# Milestone at session end
complete_major_arc("Bandit King Defeated"): +5000 XP
Result: Level 5 → 8 (triple level-up from single milestone)

narrative = """
Session Summary:
- Defeated various enemies: +180 XP (minor progress)
- COMPLETED MAJOR ARC (Bandit King Defeated): +5000 XP

[MASSIVE GROWTH FROM MILESTONE!]
[Level 5 → 6 → 7 → 8 (three level-ups!)]

Power surges. You're not the same person who started this quest. FUNDAMENTALLY CHANGED.

Total attribute points to allocate: 6
Total skill points: 3

This is milestone progression—story drives power, not grinding.
"""
```

#### Type 5: static_op - No Mechanical Progression

**Concept**: Character at peak power, NEVER levels up. XP is purely for quest tracking.

**Leveling Mechanics**:
```python
# static_op: NO leveling, EVER

current_xp = character_schema.progression.current_xp  # Tracks quests, not power
current_level = character_schema.progression.level  # ∞ or MAX (never increases)

# XP threshold check
if current_xp >= arbitrary_threshold:
    # NO LEVEL-UP
    # Maybe increment quest counter
    character.quests_completed += 1
    
    narrative = """
[Quest Complete: +100 XP (tracking only)]

You're already the strongest. This isn't about getting more powerful.

It's about finding PURPOSE. Finding that FIGHT that makes you feel alive again.

[Level: ∞ (unchanging)]
[Power: MAX (unchanging)]
[Quests Completed: {quests_completed}]

The journey continues. Not for power. For meaning.
"""
```

**Saitama Example**:
```python
# Defeats Dragon-level threat
narrative = """
One punch. Dragon-level threat down.

People cheering. 'Caped Baldy saved us!'

You smile, wave. Inside: disappointed. Again.

[No XP from combat. No level gain. Already at peak.]

Quest complete marker: +100 XP (tracking only)

Stats unchanged:
- Level: ∞
- STR: ∞
- All stats: ∞

This isn't about numbers anymore. It's about finding that opponent who can make you TRY.

[Quest tracking: 147 Dragon-level threats defeated. Still searching for a challenge.]
"""
```

#### Integration Validation

**Level-Up Check**:
```python
if "mechanical_systems" not in session_state:
    ERROR("Session Zero Phase 3 not complete.")
if "progression" not in session_state.mechanical_systems:
    ERROR("Progression system not instantiated.")

progression_type = session_state.mechanical_systems["progression"]["type"]

# Route to appropriate level-up system
if progression_type == "mastery_tiers":
    check_tier_advancement()
elif progression_type == "class_based":
    check_standard_level_up()
elif progression_type == "quirk_awakening":
    check_standard_level_up()  # AND monitor awakening triggers separately
elif progression_type == "milestone_based":
    check_milestone_completion()  # Combat XP minimal
elif progression_type == "static_op":
    pass  # No level-up, ever
```

#### Common Mistakes

❌ **Standard level-up for all types**: mastery_tiers character "gains Level 7"
✅ **Type-specific advancement**: mastery_tiers advances TIERS (Journeyman → Expert), not levels

❌ **Forcing awakening on level**: Quirk_awakening character hits level 10 → auto-awakening
✅ **Event-based awakening**: Awakening triggered by dramatic events (near-death, emotional), NOT levels

❌ **Grinding milestone_based**: Fighting 1000 goblins for XP in milestone system
✅ **Story focus**: Minimal combat XP, massive milestone XP—encourage story progression

❌ **Leveling static_op**: Saitama gains levels through training
✅ **No progression**: static_op = peak power, never levels, XP for tracking only

❌ **Missing tier bonuses**: Expert tier character using Initiation stats
✅ **Apply tier bonuses**: Each tier grants attack/defense bonuses and technique unlocks

❌ **No demonstration**: mastery_tiers character hits XP threshold → auto-advance
✅ **Require demonstration**: Player must prove mastery to teacher/master before tier advancement

#### Module Completion Criteria

Module 09 progression integration complete when:
1. ✅ All leveling reads from `session_state.mechanical_systems.progression`
2. ✅ mastery_tiers uses TIER advancement (Initiation → Master), not levels
3. ✅ class_based uses standard leveling with class ability unlocks
4. ✅ quirk_awakening has TWO tracks (levels + awakenings), awakenings event-based
5. ✅ milestone_based grants levels from story milestones, minimal combat XP
6. ✅ static_op NEVER levels up, XP for quest tracking only
7. ✅ Tier demonstrations required for mastery_tiers advancement
8. ✅ Integration validation checks run at level-up time
9. ✅ NO hardcoded level-up assumptions (each type different)

---

## Module Completion Criteria

Successful when: Fair XP (matches difficulty), rewarding level-ups, skill advancement reflects usage, multiple builds viable, balanced pacing, achievements recognized, milestones memorable.

## Common Mistakes

**[NO] Arbitrary XP**: "Defeated goblin. +1M XP" [L1→L50 instantly] →No achievement, broken

**[OK] Scaled**: "Defeated goblin. +50 XP" [gradual progress] →Meaningful, earned

**[NO] Auto Level-Up**: "Leveled! I auto-increased stats" →No agency

**[OK] Player-Driven**: "Leveled! 2 attribute pts, 1 skill pt. How grow?" →Player shapes character

### Faction Reputation Milestones

**Purpose**: To reward players for achieving significant reputation tiers with factions, providing a tangible sense of progression and unlocking new narrative and mechanical opportunities.

**XP Awards for Reaching Tiers**:
- **Liked**: +200 XP. The character is now a recognized friend of the faction.
- **Honored**: +500 XP. The character has become a trusted and respected champion of the faction's interests.
- **Hated**: +100 XP. While negative, achieving a strong reputation (even a bad one) is a significant narrative milestone.
- **Devoted/Exalted (if applicable)**: +1000 XP. For reaching the pinnacle of a faction's relationship track.

**Rank-Up XP Awards**:
- Achieving a new rank within a faction (as defined in `faction_schema.json`) also provides an XP reward.
- **Low-tier Rank (e.g., 'Initiate', 'Member')**: +150 XP.
- **Mid-tier Rank (e.g., 'Veteran', 'Captain')**: +300 XP.
- **High-tier Rank (e.g., 'Champion', 'Inner Circle')**: +600 XP.

**Implementation**:
- The State Manager (Module 03) will monitor changes to a character's faction reputation.
- When a `modify_reputation` call results in crossing a tier or rank threshold, the State Manager will trigger a call to the Progression System (Module 09).
- Module 09 will then award the appropriate XP and create a "PROGRESSION" memory thread to log the achievement.

**Example**:
Aria completes a major quest for the Crimson Vanguard. Her reputation increases from 650 to 800.
1. **State Manager**: Detects reputation change.
2. **State Manager**: Calls `get_reputation_tier` before and after. Result: "Liked" -> "Honored".
3. **State Manager**: Calls `get_character_rank` before and after. Result: "Vanguard" -> "Vanguard Captain".
4. **State Manager**: Triggers two events for Module 09: `reputation_tier_reached` and `rank_achieved`.
5. **Module 09**:
    - Awards +500 XP for reaching "Honored".
    - Awards +300 XP for achieving the rank of "Vanguard Captain".
    - Total XP awarded: 800.
6. **Narrative System (Module 05)**: Generates a narrative moment: "Your deeds for the Crimson Vanguard have not gone unnoticed. You are now considered an Honored member and have been granted the rank of Captain. [ACHIEVEMENT UNLOCKED: Vanguard Captain. +800 XP]"
