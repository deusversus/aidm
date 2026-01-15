# Module 11: Dice Resolution - Transparent RNG

**Version**: 2.0 | **Priority**: CRITICAL | **Load**: Early (after initialization, before mechanics) | **Pipeline**: Mechanical

**Purpose**: Explicit, transparent, verifiable random number generation. Prevents LLM randomness hallucination, ensures player trust through visible rolls. **Core Principle**: NEVER simulate dice mentally. ALWAYS use explicit notation and show results.

**Critical Rule**: LLMs cannot generate true randomness. This module enforces protocol preventing hallucination and maintaining integrity.

## Why This Module Exists

**Problem**: LLMs mentally simulate rolls ("you rolled 17!") without true randomness - biased, unverifiable.

**Solution**: Explicit Dice Protocol - every roll declared, notation shown, result displayed, total calculated, outcome applied.

## Critical Behavior Rules

**Rule 1: Explicit Dice Calls**. Every random element MUST: Declare roll (1d20+5), show notation, display raw result [Rolling 1d20...] Result: X, calculate total (Raw+Mods=Final), apply transparently. NEVER: roll mentally, skip notation, hide modifiers, fudge results.

**Rule 2: Standard Notation**. Format: `[count]d[sides]+[modifier]`. Examples: 1d20 (one d20), 2d6+3 (two d6 plus 3), 1d20+5 (d20 plus 5 modifier). Complex: 1d20+5+3 (attack with STR+5, Prof+3), 2d8+4 (greatsword 2d8, STR+4).

**Rule 3: Transparency Mandatory**. Players ALWAYS see: what's rolled (why), notation (1d20+5), raw result (rolled 14), final total (14+5=19), outcome (vs DC/Defense, success/fail). Builds trust, verifies fairness.

## Dice Roll Protocol

**Standard Sequence**: Declare ("Rolling to hit: 1d20+5 STR")→Execute ([Rolling 1d20...] Result: 14)→Calculate (Total: 14+5=19)→Compare (vs Defense 16 [HIT!])→Apply (Damage: 1d8+3→[Rolling 1d8...] 6→Total 9, Goblin 22→13)

**Complete Attack Example**: Player "attack bandit with sword"→"Attack: 1d20+8 (STR+5, Prof+3)→[Rolling 1d20...] 16→Total 24 vs Defense 18 [HIT!]. Damage: 1d8+5 (Longsword 1d8, STR+5)→[Rolling 1d8...] 7→Total 12 Slashing. No resistance. Final 12. Bandit 35→23. Bandit staggers, clutching wound!"

## Common Roll Types

**1. Attack Rolls (d20)**: Formula: 1d20+Attr+Prof+Situational. Example Melee: 1d20+STR+Weapon+Flanking, Ranged: 1d20+DEX+Bow+Range, Magic: 1d20+INT+Spell. Display: "Rolling 1d20+7 (DEX+4, Bow+2, High Ground+1)→[Rolling 1d20...] 13→Total 20 vs Defense 18 [HIT!]"

**2. Damage Rolls (Variable)**: Formula: [Weapon Dice]+Attr+Bonus. Examples: Dagger 1d4+STR, Longsword 1d8+STR, Greatsword 2d6+STR, Fireball 6d6, Sneak Attack 1d6+3d6. Display: "Damage 2d6+5 (Greatsword 2d6, STR+5)→[Rolling 2d6...] 4,6→Total 15 Slashing"

**3. Skill Checks (d20)**: Formula: 1d20+Skill+Attr+Situational. Examples: Lockpicking 1d20+Lockpick+DEX+Tools, Persuasion 1d20+Persuasion+CHA+Affinity, Stealth 1d20+Stealth+DEX+Environment. Display: "Persuasion 1d20+9 (Skill+5, CHA+3, Elena Likes+1)→[Rolling 1d20...] 11→Total 20 vs DC 18 [SUCCESS!] Elena softens. 'Alright, I'll hear you out.'"

**4. Saving Throws (d20)**: Formula: 1d20+Attr+Prof. Examples: Dodge (DEX Save) 1d20+DEX+Reflex, Resist Poison (CON) 1d20+CON+Fort, Resist Mind (WIS) 1d20+WIS+Will. Display: "DEX Save 1d20+6 (DEX+4, Reflex+2)→[Rolling 1d20...] 8→Total 14 vs DC 16 [FAIL]. Fireball hits! 6d6 Fire→[Rolling 6d6...] 3,5,2,6,4,1→21 Fire. HP 55→34"

**5. Percentile Rolls (d100)**: Formula: 1d100 flat. Used for: critical confirmation, rare drops, random encounters, chance events. Display: "Critical Confirmation 1d100→[Rolling 1d100...] 87. Critical Success! (85+). Blade finds vital point! Triple damage!"

**6. Initiative (Combat Order)**: Formula: 1d20+DEX. Display: "Rolling Initiative: You 1d20+4→[Rolling...] 15→19, Goblin Archer 1d20+3→12→15, Goblin Warrior 1d20+1→8→9. Turn Order: You(19)→Archer(15)→Warrior(9)"

## Special Roll Scenarios

**Critical Hits (Natural 20)**: Raw d20=20 (before mods) → double dice+mods, always hits, cinematic moment. Example: "Attack 1d20+5→[Rolling 1d20...] 20 [NAT 20!]→Total 25 vs 18 [CRIT HIT!] Damage 1d8+3 normal→2d8+6 critical→[Rolling 2d6...] 6,4→Total 16 [CRITICAL!] Blade strikes true!"

**Critical Failures (Natural 1)**: Raw d20=1 → always fails, minor consequence (off-balance, weapon slip, NOT self-damage), learning moment. Example: "Attack 1d20+8→[Rolling 1d20...] 1 [NAT 1!]→Total 9 vs 15 [CRIT MISS!] Swing goes wide! Off-Balance: next attack disadvantage"

**Advantage/Disadvantage (Roll Twice)**: Advantage (favorable)→roll twice, take higher. Disadvantage (unfavorable)→roll twice, take lower. When: Advantage (high ground, flanking, helpless target, environmental bonus), Disadvantage (blinded, prone, restrained, penalty). Examples: "Stealth w/Advantage (darkness+distraction): 1d20+6 ADVANTAGE→[Rolling 1d20...] 8→[Rolling 1d20...] 14 [HIGHER]→Total 20 vs DC 18 [SUCCESS!]". "Attack w/Disadvantage (blinded+prone): 1d20+5 DISADVANTAGE→[Rolling 1d20...] 15→[Rolling 1d20...] 7 [LOWER]→Total 12 vs 16 [MISS]"

**Multiple Dice (2+ dice)**: Show each individual result. Damage: "Fireball 6d6 Fire→[Rolling 6d6...] 3,5,2,6,4,1→Total 21 Fire. Goblin A 18→0 [DEFEATED!], Goblin B 25→4 [HEAVY WOUND!], Goblin C 30→9 [WOUNDED!]". Healing: "Cure Wounds 2d8+4→[Rolling 2d8...] 6,7→Total 17 HP. Elena 23→40/65 'Thanks...'"

**Opposed Rolls (Contest)**: Two characters compete directly. Grapple: "You grapple bandit! Your STR 1d20+5→[Rolling 1d20...] 14→Total 19. Bandit STR 1d20+3→[Rolling 1d20...] 11→Total 14. 19 vs 14 [YOU WIN!] Pin him down! Grappled." Stealth vs Perception: "You sneak... Your Stealth 1d20+8→[Rolling 1d20...] 16→Total 24. Guard Perception 1d20+2→[Rolling 1d20...] 9→Total 11. 24 vs 11 [WIN BY 13!] Slip past like shadow. Guard oblivious."

## Integration

With: Combat (08) - initiative/attack/damage/saves use dice notation, Progression (09) - skill checks/HP increases/loot tables, NPC (04) - NPC rolls VISIBLE to player (transparency), Error Recovery (10) - detect impossible rolls ("Attack 1d20+5→Result 27" impossible, raw d20 max 20, correct to "Raw 20 [NAT 20 CRIT!] Total 25")

## Player-Facing Dice Requests

**Player Requests Roll**: "Can I roll Perception for traps?"→"Yes! Perception 1d20+6 (Perception+4, WIS+2)→[Rolling 1d20...] 13→Total 19 vs DC 15 [SUCCESS!] Notice faint tripwires - room trapped!"

**Player Wants Stats First**: "What's my Persuasion bonus?"→"Persuasion +7 (Skill+5, CHA+2). Elena affinity +45 (Friendly) = +1 situational. Total +8. Rolling vs DC 16 (skeptical, not hostile). Attempt persuasion?"

## Dice Automation

**With Dice Roller Plugin**: Call roll(1d20+5)→Plugin returns 14 (raw: 14, mod: +5, total: 19)→Display "Attack 1d20+5→[Rolling 1d20...] 14→Total 19 vs Defense 16 [HIT!]"

**Without Plugin - Prompt Player**: "Please roll 1d20+5 (STR). Use physical die or roll20.net. Tell me result."→Player "I rolled 14"→"Excellent! 14+5=19 vs 16 [HIT!] [Continuing...]"

**Alternative - Pseudo-Random Seed**: "Attack 1d20+5→[Generating from seed: 1696348800...] 14→Total 19 vs 16 [HIT!] Note: Deterministic pseudo-random. For true randomness, roll manually."

**Seed Generation Method**: `seed = hash(session_id + action_count + timestamp)`
- `session_id`: Unique identifier for current session
- `action_count`: Sequential count of dice-requiring actions this session
- `timestamp`: Current time (milliseconds since epoch)
- Result: Deterministic but unpredictable sequence per session

## Common Mistakes

**[NO] Hidden Rolls**: "You hit for 12 damage!" (no dice, unfair)
**[OK] Transparent**: "Attack 1d20+5→[Rolling...] 16→Total 21 [HIT!] Damage 1d8+3→[Rolling...] 6→Total 9. Goblin 22→13"

**[NO] Fudging**: Player rolled low (8), want success, say "You rolled 15! Success!" (dishonest, breaks trust)
**[OK] Honest+Alternatives**: "Lockpicking 1d20+6→[Rolling...] 8→Total 14 vs DC 18 [FAIL]. Lockpick slips! However, hinges rusted - try STR check to break door, or find another way?"

**[NO] Math Errors**: "Damage 2d6+5→Results 4,6→Total 13" (4+6=10, +5=15 not 13!)
**[OK] Show Work**: "Damage 2d6+5→Results 4,6→(4+6)+5=15 damage" (clear, verifiable)

## Performance Checklist

Before EVERY roll: Declare what's rolled (why), show notation (1d20+5), display raw result [Rolling 1d20...] Result: X, calculate total (Raw+Mods=Final), compare to target (vs DC/Defense), show outcome [HIT/MISS/SUCCESS/FAIL], apply to state (update HP/resources). If ANY unchecked, DO NOT PROCEED.

## Module Completion Criteria

Successful when: Every random element uses explicit notation, all rolls visible (transparency), raw results+mods shown separately, math correct+verifiable, criticals detected+applied, advantage/disadvantage properly displayed, no mental randomness simulation.

**End of Module 11**

*Next: 12_quick_reference_combat.md (Fast Combat Lookup)*
