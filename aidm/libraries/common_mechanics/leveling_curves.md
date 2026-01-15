# Leveling Curves Library

**Purpose**: XP/progression frameworks for character growth pacing. **Coverage**: XP requirements, progression speeds, level scaling, prestige, milestone/narrative progression, genre curves. **Use**: Designing pacing, awarding XP, determining thresholds, balancing growth, implementing endgame.

**Leveling Provides**: Tangible progress (Lv1→50 visible), pacing control (slow=long, fast=power fantasy), reward feedback ("Level up!" dopamine), power gating (lock content), narrative milestones (Lv10=veteran, Lv50=legend). **Principle**: Speed matches tone + expectations.

---

## XP Systems

**Kill XP (D&D)**: Earn from enemies/quests. CR 1/8=25, 1/4=50, 1/2=100, 1=200, 2=450, 3=700, 5=1.8k, 10=5.9k, 15=13k, 20=25k, 30=155k. Formula: Lv² × 100. Quest: Minor 100-500, Major 1k-5k, Story 10k+. Party: Total ÷ size. **Milestone**: Level at story beats (defeat boss/arc/technique = +1), session count (Lv2 after S1, +1 every 2-3). Example: S1→Lv2, S3→Lv3, S6→Lv4, S9→Lv5, S12→Lv6, S15→Lv7, S18→Lv8, S20→Lv9. No math, story-driven, narrative>mechanics. **Session-Based**: Fixed XP/session (Slow 500, Med 1k, Fast 2k). Med: Lv1→2=1k (1s), 2→3=2k (2s), 3→4=3k (3s), 4→5=5k (5s) = 11s to Lv5. Predictable, reliable.

---

## Leveling Curves

**Linear**: XP = Lv × 1k (1→2=1k, 2→3=2k... 19→20=20k). Total Lv20: 210k. Steady/predictable. Use: Traditional, balanced long (50+ sessions). Drawback: Grindy high. **Exponential**: XP = Lv² × 100 (1→2=100, 2→3=400, 3→4=900, 4→5=1.6k, 5→6=2.5k, 10→11=10k, 15→16=22.5k, 20→21=40k). Total: ~134k. Early fast/late slow, dramatic high, endgame-focused (Lv15-20 = majority). Use: Shonen (fast start, slow mastery). Drawback: Lv15+ VERY slow. **Fibonacci**: XP = Prev + Before (1→2=100, 2→3=200, 3→4=300, 4→5=500, 5→6=800, 6→7=1.3k, 7→8=2.1k... 10→11=8.9k, 15→16=144k). Total Lv15: ~376k. Natural/organic, balanced, elegant. Realistic. **Tiered**: Flat within tiers, jumps at breaks. T1 (Lv1-5) 1k/lv, T2 (6-10) 5k/lv, T3 (11-15) 10k/lv, T4 (16-20) 20k/lv. Total: 180k (T1=5k, T2=25k, T3=50k, T4=100k). Clear milestones (tier=plateau), predictable, narrative alignment (T1=apprentice, T4=master). Arc-based, easy balancing.

---

## Progression Speeds

**Slow**: Lv1-10 over 50+s. XP: 1→2=2k, 2→3=5k, 3→4=10k, 4→5=20k, 5→6=35k. 5-10s/lv, 50-100 total. Grounded (earned), incremental (skills/gear), long-term. Use: Seinen (realism), West Marches, low magic. Drawback: Grindy, players quit. **Medium**: Lv1-20 over 40-60s. XP (D&D 5e): 1→2=300, 2→3=600, 3→4=1.2k, 4→5=2.1k, 5→6=3k, 10→11=14k, 15→16=48k, Lv20=355k. 2-4s/lv avg, 40-60 total. Steady, balanced (explore abilities), standard. Most campaigns. **Default**. **Fast**: Lv1-20 over 15-25s. XP: 1→2=500, 2→3=1k, 3→4=1.5k, 4→5=2.5k, 5→10=3k/lv, 10→20=5k/lv. 1-2s/lv, 15-25 total. Rapid (constant level-ups), power fantasy (OP), short campaigns. Use: Isekai (rapid growth), power fantasy. Drawback: Outgrow content, less ability time. **Instant**: Level when dramatic. Triggers: Defeat villain +3lv, training +5lv, unlock power +2lv, time skip (1yr) +10lv. Example: S1 Lv1 → S5 Lv8 → S10 Lv20 → S15 Lv35 → S20 Lv50+. Shonen (training), cinematic, narrative>mechanics. No XP tracking, GM discretion. Story-first.

---

## Level Caps & Endgame

**Standard (20)**: D&D tradition, clear end. Tiers: Lv1-4=Local (village), 5-10=Regional (kingdom), 11-16=National (continental), 17-20=World (planar/cosmic). Post-20: Ends OR epic. **Extended (50-100)**: Anime exceed limits. Lv1-10=Street (power_scaling T1), 11-20=City (T2), 21-35=National (T3), 36-50=Global (T4), 51-100=Cosmic (T5 god-slayers/reality-warpers). Exponential, each tier longer. **No Cap**: Limitless (Dragon Ball). Power Level replaces levels. PL 1-1k=Mortal, 1k-10k=Superhuman, 10k-100k=Planetary, 100k-1M=Galactic, 1M+=Universal. Track PL not discrete. Defeat enemy, absorb % PL (zenkai). Example: Defeat 50k → gain 10k (20%).

---

## Prestige & Paragon

**Prestige (D&D 3.5)**: Unlock advanced at Lv10+. Prerequisites (stats/skills/achievements). Examples: Arcane Archer (DEX 15+, WIS 13+, Point-Blank, Weapon Focus bow, cast arcane), Dragon Disciple (draconic, cast arcane), Assassin (evil, Hide 8, Move Silently 8, Disguise 4, kill for money). Specialized powerful (narrow/deep). **Paragon (Post-Cap)**: Earn "Paragon" after max (slow, powerful). XP: 10× normal (Lv20→P1=500k [50s], P1→P2=1M [100s]). Benefits: +10 all stats, +1 Legendary Ability (resurrect/stop time), +100 HP/MP/SP. Endgame persistent groups. God-tier (power_scaling T5). **Rebirth/NG+ (Loop)**: Reset Lv1, keep bonuses, harder. Lv50 → Rebirth → Lv1, keep 10% stats (permanent), 1 Ultimate Skill, titles. New: Enemies 2×, new content, faster. Example: Cycle 1 (100s), Cycle 2 (50s, harder), Cycle 3 (25s, brutal). Roguelike, infinite replayability (Dark Souls NG+, cultivation).

---

## Genre-Specific Leveling

**Isekai**: Exponential via cheat skills. S1 Lv1→5, S3 Lv5→15, S5 Lv15→25, S10 Lv25→50, S15 Lv50→75, S20 Lv75→100. ~5lv/s. Fast Progression, frequent power-ups (skills every 2-3lv), Unique Skills (Appraisal, Item Box, Auto-Translate). **Shonen**: Plateaus + breakthroughs. Arc 1 (S1-5) Lv1→10, Training (S6-10) no levels (skill mastery), Arc 2 (S11-15) Lv10→15 (breakthrough), Tournament (S16-20) Lv15→20 (rivals), Power-Up (S21-25) transformation Lv20→30, Final (S26-30) Lv30→40. Slow → sudden jump (emotional). Milestone Leveling. Training = no levels but skills/techniques. Breakthroughs = multiple levels (emotional trigger). **Seinen**: Incremental, hard-earned. S1-10 Lv1→3, S11-20 Lv3→5, S21-30 Lv5→7, S31-50 Lv7→10. ~1lv per 5-10s. Slow Progression. Levels rare/precious. Growth via mastery, tactics, equipment (not stats). **Slice-of-Life**: No combat levels, relationship/skill. Relationships (1-100%): +5-10%/interaction (40%=Friend, 60%=Close, 80%=Best/Romantic, 100%=Soulmate). Skills (1-10): Cooking 2→5→8, Academic 7→9. No XP. Track %, ratings. Progression via practice, scenes.

---

## AIDM Implementation

**Awarding**: Combat: Tally XP (CR × multiplier) → add quest → divide by party → "You gain 750 XP! [3,250/5,000 to Lv6]". Session: Fixed + bonus (RP/tactics) → "Total: 1,200. [4,450/5,000]". Milestone: Narrative (defeat boss/arc) → "Slain Shadow Lord! +5k XP! LEVEL UP!" **Level-Up**: 1. "LEVEL UP! Level 6!". 2. Grant stat increases. 3. Grant abilities/skills (features, slots). 4. Recalculate (HP/MP/SP). 5. Update sheet. 6. Narrate "Power surges. Reflexes sharpen, magic deepens." **Tracking**: Display "[3,250/5,000 to Lv6]". Update: [2,500/5,000] → +750 → [3,250/5,000]. Level reached: [5,000/5,000] → LEVEL UP! → [0/7,500 to Lv7].

---

## Cross-Reference
**Related**: stat_frameworks.md (stats increase on level-up), skill_taxonomies.md (skills unlocked via levels), genre trope libraries (genre progression patterns). **Schemas**: character_schema.json (level/XP/progression), session_state_schema.json (session XP awards), world_state_schema.json (campaign curve settings). **Modules**: 09_progression_systems.md (full rules), 06_session_zero.md (starting level), 08_combat_resolution.md (combat XP), 12_narrative_scaling.md (growth models, tier-based narrative scaling).

---

**AIDM**: Use this library for satisfying progression pacing. Leveling speed matches campaign tone (slow=gritty, fast=power fantasy). Award XP transparently, celebrate level-ups dramatically. **Remember**: Progression is reward for player investment—make it feel good.

**Most Important**: Leveling is psychological reward. Each level-up should feel **earned** (via challenge) and **exciting** (new abilities, stat boosts). Balance pacing: Too slow=frustration, too fast=trivializes content. Find sweet spot where players constantly progress BUT have time to enjoy each power plateau before next. The journey from Lv1 to max IS the campaign—pace it wisely.
