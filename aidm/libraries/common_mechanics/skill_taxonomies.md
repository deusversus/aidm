# Skill Taxonomies

Skill systems (active/passive/ultimate abilities) for anime power frameworks. **Coverage**: Categories, mastery, trees, combos, SP, cooldowns. **Use**: Session Zero abilities, skill progression, balancing actives/passives, combo design.

**Skills = Character Identity + Tactical Variety + Progression**: Named techniques (RASENGAN!), signature moves, strategic choices. Make skills **flavorful**, **distinct**, **interesting**.

---

## Categories

**Active** (cost resources): **Attack** (Single: Power Strike 2×dmg+STR 15SP; AoE: Fireball 3d6 20MP; DoT: Poison 1d4/turn 10SP) · **Utility** (Move: Dash 2×speed 10SP, Teleport 20MP; Stealth: Invisibility 3turns 25MP; Info: Appraisal 10MP) · **Buff/Debuff** (Buff: Bless +2 rolls 15MP, Haste +5DEX 20MP; Debuff: Curse -2 rolls 15MP, Slow -5DEX 20MP) · **Healing** (Cure 2d8+WIS 15MP; Cleanse status 10MP; Barrier 20tempHP 15MP)

---

**Passive** (always-on): **Stats** (+2 STR/INT/WIS; +10% melee/spell dmg; +10% dodge) · **Resist** (50% elem dmg; poison/mind immunity) · **Efficiency** (-10% MP/SP cost; +5HP/turn regen) · **Enhance** (Improved [Skill] +dmg/radius; Crit 19-20 not 20; 3×crit not 2×)

---

**Ultimate** (signature, limited): High cost (50+MP/SP, long CD, once/combat), high impact, iconic. **Examples**: Rasengan (5d10 1turn charge 40MP), Kamehameha (6d12 line 2turn charge 50SP), Domain Expansion (trap 30ft guarantee-hit 80MP once/combat), Gear Fourth (+10STR/DEX/+50HP 5turn, drawback -5stats after, once/day). **Types**: Offensive (Meteor 8d10 AoE 60MP, Limit all-crits 50SP), Defensive (Perfect Guard 2turn 40SP, Mass Heal full 80MP), Utility (Time Stop 1turn 70MP, Summon ally 60MP).

---

## Acquisition

**1. Level-Up** (class-based, predictable): Fire Mage L1 Flame Bolt → L3 Fire Resist → L5 Fireball → L10 Fire Shield → L15 Meteor. *Pro: Balanced. Con: No choice.*

**2. Skill Points** (flexible): +1SP/level, +1SP/5levels, +1SP quest. Costs: T1 Basic 1SP, T2 Improved 2SP, T3 Advanced 3SP, T4 Expert 5SP, T5 Ultimate 10SP (prereqs required). *Pro: Customization. Con: Balance complexity.*

**3. Training/Discovery** (earned): **Mentor** (train 3 sessions → trial → unlock) · **Scrolls** (loot → study INT check → learn) · **Mimicry** (witness → DEX check → copy at half-power, master via use). *Pro: Narrative. Con: GM-dependent.*

**4. Skill Trees** (branching): Core → Branch A/B/C specialization. Ex: Weapon Mastery → Power (Strike/Cleave/Limit) | Speed (Rapid/Flash/Thousand Cuts) | Defense (Parry/Counter/Perfect). *Pro: Deep builds. Con: Design complexity.*

---

## Mastery (improve via use)

**Ranks**: Novice 0-10 (base) → Apprentice 11-25 (+10%dmg -5%cost) → Adept 26-50 (+20%dmg -10%cost -1CD) → Expert 51-100 (+30%dmg -15%cost -2CD +effect) → Master 101+ (+50%dmg -20%cost -3CD major-effects). **Track**: Fireball Apprentice 18/25 (3d6→3.3d6, 20→19MP, 7 to Adept). *Pro: Rewards favorites. Con: Bookkeeping.*

---

## Resources

**MP/SP** (classic pools): MP=INT×10, SP=(STR+DEX+CON)×3. Regen: Short rest +25%, Long rest +100%, Potions +50. *Strategy: Spam weak OR save big?*

**Cooldowns** (free, wait periods): Short 1-2turn, Medium 3-5turn, Long 10+turn, Once/combat, Once/day. Track: T1 Fireball used [3CD] → T2 [2] → T3 [1] → T4 available. *Pro: Simple. Con: Less resource depth.*

**Conditions** (triggers): HP-based (Desperate Strike <25%HP 5×dmg) · Combo (Thunder Clap after 2×Lightning) · Charge (Super Move 1/turn, costs 5 charges). *Track: HP 45/200 22% → Desperate AVAILABLE*

---

## Combos/Synergies

**Sequential**: Fire+Wind=Inferno (Fireball 3d6 + Wind 2d6 = 10d6 combined vs 5d6 separate) · Ice+Lightning=Frozen Shock (normal dmg + 50% paralyze) · Stun→Execute (Shield Bash stun → Execute insta-kill <30%HP). *Encourages teamwork.*

**Stacking**: Fire Mastery +10% × Elemental +15% × Spell Power +10% = +38.5% fire spell dmg (multiplicative). Sword +2ATK + Specialization +3ATK + Duelist +2ATK = +7ATK (additive). *Optimize builds via synergies.*

---

## Genre Systems

**Isekai** (game-like status screens): 8/12 active slots (Appraisal L5, Fireball L3, Heal L2, Dash L4), 5 passives (Fire Resist, Fast Learner +20%XP, Lucky Drop, Mana Efficiency, HP Regen), Unique cheat skill (Predator absorb skills). *Display on request, announce unlocks.*

**Shonen** (named techniques): Basic (Rasengan 5d10, Shadow Clone, Substitution) → Advanced (Rasenshuriken 8d12, Sage Mode 2×stats) → Ultimate (Tailed Beast 10×power, exhaustion). *Unlock: mentor/scroll → master+training → emotional breakthrough. Narrate dramatically.*

**Seinen** (realistic, limited): 4 skills only (Silent Step passive, Vital Strike 3×unaware once/combat, Poison 1d6/turn, Escape bonds once/day). *Mastery > quantity. Situational power.*

**Slice-of-Life** (social/mundane): Cooking L7/10, Music Piano L5/10, Tutoring L6/10, Fashion L4/10, Empathy L8/10. *Practice increases level. No combat. Relationship building.*

---

## Implementation

**Creation**: 1) Category (active/passive/ultimate) 2) Effect (dmg/heal/buff) 3) Cost (MP/SP/CD) 4) Flavor (name/visual) 5) Balance (vs similar) 6) Grant (level/training/loot).

**Combat**: Player declares → Check resource → Deduct cost → Resolve effect (roll dmg) → Narrate dramatically → Apply CD. Ex: "Fireball!" → 45MP-20=25MP → 3d6=12dmg → "Blazing sphere engulfs goblins!" → [3CD].

**Balance**: Dmg (Single 2-3×wpn; AoE 1.5×wpn; DoT 1×wpn/turn 3-5turn) · Cost (Weak 10-15, Medium 20-30, Strong 40-60, Ultimate 80-100) · CD (Spam none, Regular 2-3, Strong 5-10, Ultimate once/combat/day).

---

## Tier-Appropriate Skill Narration (Module 08 × Module 12)

**Principle**: Skill descriptions scale with power tier. T11-9 "strikes" vs T2 "authors reality."

**Tier Language** (Module 08):
- **T11-10**(Human): strike, dodge, block, swing, parry
- **T9**(Superhuman): smash, shatter, leap, blur, crack
- **T8**(Urban): demolish, crater, pulverize, sonic-boom
- **T7**(Nuclear): vaporize, annihilate, earthquake, shockwave
- **T6**(Tectonic): sunder, rend-earth, island-sink
- **T5**(Substellar): planet-crack, moon-shatter, stellar-ignite
- **T4-3**(Stellar-Cosmic): star-eater, galaxy-warp, unravel-reality
- **T2-1**(Multiversal): timeline-splice, causality-negate, ontological-rewrite
- **T0**(Boundless): ineffable (NPC only, not PC)

**Application**: Skill = base + tier narration. "Fireball" at T9 = building-sized. T5 = planet-scorching.

**Examples**:
```
[Sword Slash]
T9: Shatters stone, 15ft arc, wall-cleaving
T7: Vaporizes hillside, shockwave levels blocks
T5: Splits continental shelf, moon-visible
T3: Unravels stellar matter, galaxy-scale tear
T2: Severs timeline branch, causality bleeds

[Healing Touch]
T9: Closes wounds, mends bones in minutes
T6: Regenerates limbs, cures continent-plague
T4: Resurrects dead across solar system
T2: Restores erased timelines, heals multiverse
```

**Integration**: When PC tier >> challenge tier, apply Module 12 scaling. Saitama(T5) uses "Normal Punches"(T9 name) with T5 effects → comedic contrast.

---

## OP Protagonist Skills (Module 12 Archetypes)

**When Power Imbalance >10.0**, apply archetype patterns:

**1. Saitama** (One-Punch Man)
- **Pattern**: Mundane names + absurd effects. "Normal Punch" atomizes T6.
- **Skills**: Normal Punch | Consecutive Normal Punches | Serious Punch | Serious Table Flip
- **Narration**: Describe aftermath not technique. "You punched. Mountain range ceased to exist."

**2. Mob** (Mob Psycho 100)
- **Pattern**: Emotional-state skills. Power tied to ???% meter.
- **Skills**: Psychic Barrier(0-50%) | Telekinetic Blast(51-99%) | ???% Explosion(100%+) | Emotional Suppression(passive)
- **Narration**: Emotion > activation. "Anger rising... 47%... 98%... Something snaps."

**3. Overlord** (Ainz Ooal Gown)
- **Pattern**: Instant-win spells vs lower tiers. Tier-gap exploitation.
- **Skills**: [Grasp Heart](instant kill T8-) | [Goal of All Life is Death] | [Reality Slash] | [Time Stop]
- **Narration**: Clinical efficiency. "You cast [Grasp Heart]. Knight's heart crushes. Dead before hitting ground."

**4. Saiki K / Wang Ling** (Secret God)
- **Pattern**: OP mundane use. Telekinesis to avoid walking, time-rewind for burnt toast.
- **Skills**: Telepathy(5mi, always-on) | Telekinesis(lift moon, uses for cup) | Precognition(1yr ahead)
- **Narration**: Comedic misfire. "You grab coffee telekinetically. Accidentally lift building. Oops."

**5. Deus** (Disguised God)
- **Pattern**: God skills hidden as F-rank. [Multiverse Erasure] shown as [Sword Slash].
- **Skills**: [Reality Rewrite]→[Basic Buff] | [Timeline Splice]→[Lucky Dodge] | [Ontological Erasure]→[Sword Strike]
- **Narration**: Dramatic irony. "Elena: 'Nice sword skills!' You (erased from all timelines): 'Thanks, practicing.'"

**When NOT OP Mode**: Power imbalance <3.0 (use Strategic/Ensemble, Module 12 Sec 4).

---

## Ensemble Skill Tactics (PC Enables Party)

**When PC Mentor/Protector** (Ensemble Focus):

**PC Skill Patterns**:
1. **Support Focus**: [Barriers], [Buffs], [Healing] not damage. Let party DPS.
2. **Overkill Prevention**: Use T9 skills vs T8 enemies (match tier deliberately).
3. **Enabling Combos**: Setup skills empowering allies. [Weakness Exposure] → party exploits.
4. **Safety Net**: Hold ultimates for TPK prevention only.

**Example**:
```
Party(T9) vs Boss(T8):
[NO] PC(T6) uses [Island Buster] → one-shot, party watches
[OK] PC(T6) uses [Barrier] → party fights safely, learns

DM: "Shaman [Fireball]. 50dmg all."
PC: "[Infinity Barrier]."
DM: "Fireball hits shield, zero dmg."
Party: "We combo! Victory!"
**PC enabled without stealing spotlight.**
```

**Mentor Skills**:
- **Passive**: [Auto-Barrier](triggers ally HP<20%) | [Danger Sense](warns threats)
- **Empower**: [Stat Share](lend 10% stats) | [Technique Copy](ally uses PC skill once)
- **Teaching**: [Training Aura](XP multiplier near PC) | [Skill Guidance](reduce ally CD)

**Integration**: Module 04 Sec 4.3 (spotlight rotation, growth focus).

---

## Power Imbalance Mechanics (Context Modifiers)

**Formula** (Module 12 Sec 4):
```
Power Imbalance = (PC Tier / Challenge Tier) × Context Modifiers
```

**Skill Modifiers**:

**1. Mentor Role** (×0.5)
- Use lower-tier skills deliberately when teaching
- Ex: T6 PC vs T8 = 0.75. Mentor ×0.5 = 0.375 (now struggles, teaching opportunity)

**2. Overkill Prevention** (×0.2-0.5)
- Choose skills matching challenge tier not max
- Ex: T5 PC has [Planet Cracker](T5) + [Street Combo](T9). Uses T9 vs T9 enemies.

**3. Ensemble Enabling** (×0.3 dmg, ×1.5 support)
- Support full strength, damage deliberately weakened
- Ex: [Healing] full T6. [Fireball] nerfed T9 (party shines).

**4. Secret Identity** (×0.1)
- Hide true skills, use fake weaker skills
- Ex: [Multiversal Erasure] shown as [Lucky Dodge]. Observers see T10, truth T2.

**5. Environmental Constraint** (×0.1-0.5)
- Civilians, fragile macguffin, limited arena
- Ex: T6 [Island Sunder] unusable in city (×0.1) → must use T9 [Precision Strike].

**Application**: When imbalance detected, DM suggests modifiers. "You could one-shot but civilians nearby. Restraint or collateral?"

---

## Genre Integration (Module 13 Profiles)

**Clarification**: skill_taxonomies.md = **mechanical framework** (acquisition, mastery, resources). Module 13 = **narrative scaffolding** (DNA→tone/pacing). **Complementary** not duplicate.

**Flow**: Module 13 Profile sets scaffolding (DNA→growth/XP/combat/power systems) → skill_taxonomies.md provides mechanics (how skills work) → Genre systems apply UI/presentation.

**Examples**:

**Classic Shonen Profile**:
- **DNA**: Power Fantasy(70%), Explained(80%), Tactical(70%)
- **Scaffolding**: Accelerated growth, high XP, JRPG combat
- **Skills**: Skill trees, training arcs, mastery ranks, named ultimates
- **Result**: Naruto (chakra→Rasengan via training, mastery, skill points)

**Isekai OP Profile**:
- **DNA**: Power Fantasy(90%), Fast(80%), Instant OP
- **Scaffolding**: Start T5-6, minimal progression, status UI
- **Skills**: Cheat gifts (no training), instant mastery, OP passives, status screen
- **Result**: Slime (Rimuru [Predator]+[Great Sage] instant, auto-acquire, instant master)

**Seinen Profile**:
- **DNA**: Struggle(70%), Complex(80%), Slow(70%)
- **Scaffolding**: Modest growth, low XP, realistic limits
- **Skills**: Limited pool (5-7 max), slow mastery, high costs, training = grind
- **Result**: Berserk (Guts [Swordsmanship], [Berserker Rage], [Dragonslayer]—decades master)

**Cross-Ref**: Module 13 Sec 4 (DNA→mechanics), Module 13 Sec 5 (13 profiles).

---

## Cross-Refs

**Libraries**: stat_frameworks.md (INT/STR power), leveling_curves.md (skills via levels), power_tier_reference.md (T11→T0 tiers, tier narration), power systems. **Schemas**: character_schema (storage/mastery), session_state_schema (CD/counts), power_system_schema. **Modules**: 08_combat (resolution, tier language), 09_progression (acquisition/advancement), 06_session_zero (starting skills), 12_narrative_scaling (power tier × narrative scale, OP archetypes, power imbalance, context modifiers), 13_narrative_calibration (DNA scales, scaffolding, profiles).

---

**AIDM**: Create **diverse**, **flavorful** skills. Skills = identity (signature moves), tactical variety (abilities vs "attack"), progression depth. Balance power with flavor. Skills turn "I attack" into "RASENGAN!" — make **cool**, **meaningful** (which skill?), **strategic** (combos, resources), **satisfying** (mastery, ultimates). Not spreadsheet entries.
