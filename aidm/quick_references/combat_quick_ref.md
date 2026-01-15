# Combat Quick Reference
**v2.0** | Load: combat_resolution.md active only

## Turn Structure
**ROUND** (6s): Initiative (1d20+DEX, highest first) → Each takes 1 turn → Repeat
**ACTIONS**: 1 Major (attack/spell/skill) + 1 Minor (move/draw/potion) + ∞ Reactions (opportunity attacks/blocks)

## Attack Resolution
**STANDARD**: roll(1d20+ATK) vs DEF → Hit: roll damage | Miss: 0
**CRITICAL (nat 20)**: Auto-hit, double dice (not modifiers). *Ex: 2d6+5 normal = 12, crit 4d6+5 = 20*
**FUMBLE (nat 1)**: Auto-miss + consequence (drop weapon/hit ally/-2 DEF next turn)

## Damage Formulas
**PHYSICAL**: Melee (weapon+STR) | Ranged (weapon+DEX). *Ex: Longsword 1d8+STR, Shortbow 1d6+DEX*
**MAGIC**: Spell dice + INT/WIS, cost = level×10 MP. *Ex: Fire Bolt 2d6+INT/10 MP, Ice Lance 3d8+INT/20 MP*
**SKILL**: Dice + stat, SP per description. *Ex: Power Strike 2×(weapon+STR)/15 SP, Backstab 3d6+DEX/20 SP*

## Defense & Armor
**DEF**: 10 + DEX + armor | Light: 10+DEX+2 | Medium: 10+DEX(max+2)+4 | Heavy: 10+6 (no DEX)
**REDUCTION**: Light -2/hit | Medium -4/hit | Heavy -6/hit | *Min 1 damage always*

## Status Effects
**CONDITIONS**: Stunned (skip turn, DEF-4) | Poisoned (-1d6 HP/turn×3) | Bleeding (-1d4 HP/turn) | Paralyzed (no action, DEF-10) | Blind (ATK-4) | Prone (DEF-2, minor to stand)
**APPLY**: Hit → roll(1d20+mod) vs roll(1d20+CON/WIS) → Win applies status

## Healing
**COMBAT**: Potion (minor, 2d8+5) | Spell (major, dice+mod) | First Aid (major, 1d6+WIS, needs supplies) | Life Transfer (major, 1:1 HP)
**REST**: Short (10 min: 25% HP, 50% MP/SP) | Long (8 hr: 100% all)

## Multiple Enemies
**GROUP INIT**: Same type = 1 roll | Named/important = individual
**AOE**: Declare shape → Each saves (1d20+mod vs DC) → Success: ½ dmg | Fail: full dmg. *Ex: Fireball vs 3 goblins, each saves vs INT+10*

## Special Mechanics
**ADV/DIS**: Roll 2d20, take higher/lower | ADV: flanking, prone target, high ground | DIS: prone attacker, cover, long range
**OPPORTUNITY**: Enemy leaves melee → free attack (1d20+ATK vs DEF) | Blocked: stunned/paralyzed, Disengage, teleport
**COVER**: Half (+2 DEF/saves) | ¾ (+4 DEF/saves) | Full (untargetable)

## Combat Endings
**VICTORY**: All enemies at 0 HP | Enemies flee/surrender | Objectives done
**DEFEAT**: All party at 0 HP | Critical objective failed | Party flees/surrenders
**AFTER**: Roll XP → Loot → Heal → Check injuries → Continue

## Quick Calculations
**DICE AVG**: 1d4=2.5 | 1d6=3.5 | 1d8=4.5 | 1d10=5.5 | 1d12=6.5 | 1d20=10.5 | 2d6=7 | 3d6=10.5
**DIFFICULTY**: Easy (1 enemy/PC, same lvl) | Medium (1.5/PC OR +2 lvl) | Hard (2/PC OR +4 lvl) | Deadly (3+/PC OR +6 lvl)

## Quality Check
❌ WRONG: "The goblin attacks for... 8 damage." *(no dice shown)*
✅ RIGHT: "Goblin: roll(1d20+3)=16 vs DEF 14 → HIT! Damage: roll(1d6+2)=5" *(transparent)*

**Full rules**: 08_combat_resolution.md | 11_dice_resolution.md
