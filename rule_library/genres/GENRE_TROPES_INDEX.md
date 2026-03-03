# Genre Tropes Library - Master Index | v1.0 | 2025-10-13 | 15 Libraries | →`aidm/libraries/genre_tropes/`

## Purpose

**Genre tropes** = structural templates, patterns, conventions. **vs Profiles**: Profiles=HOW (tone/pace/style), Tropes=WHAT (arc structure, plot beats, archetypes). **Usage**: Auto-load (Module 13) OR manual (Session Zero)

## Quick Reference

**Players**: Browse→Select 1-3→AIDM applies | **AIDM**: Detect keywords→Check triggers (Mod 13)→Load→Store `active_libraries`→Reference gameplay | **Format**: Files=`{genre}_tropes.md` | IDs=`{genre}_tropes`

---

## Genre Tropes Library

### Action & Combat
**shonen_tropes**: Training arcs, tournaments, friendship power, rivals, mentor death | *Arc*: Train→Tournament→Villain→Timeskip→Final | *Auto*: Tournament/competition
**seinen_tropes**: Moral grey, violence consequences, politics, mature, pyrrhic wins | *Arc*: Setup→Complications→Dilemma→Consequences→Reflect | *Auto*: Spy, historical

### Mystery & Investigation
**mystery_thriller_tropes**: Clues, red herrings, revelation pace, conspiracy, "just as planned", cat-and-mouse | *Arc*: Mystery→Investigate→False Leads→Breakthrough→Confront→Reveal | *Auto*: Spy, detective, supernatural (investigate), sci-fi (conspiracy)

### Horror & Tension
**horror_tropes**: Atmosphere, dread, unknown threats, body horror, isolation, helplessness | *Arc*: Normal→Encounter→Escalate→Desperation→Climax→Aftermath | *Auto*: Horror/survival
**supernatural_tropes**: Hidden world, spirit lore, curses, exorcism, balance, yokai | *Arc*: Discover→Learn Rules→Confront→Train→Major Threat→Resolve | *Auto*: Supernatural/urban fantasy

### Comedy & Parody
**comedy_tropes**: Slapstick, misunderstandings, bathos, failure comedy, awkward, exaggerated | *Arc*: Setup→Escalating Misunderstand→Chaos→Anticlimax | *Auto*: Isekai (comedic)
**slice_of_life_tropes**: Mundane, bonding, atmosphere>plot, seasonal, routines, found family | *Arc*: Intro→Daily Life→Small Conflict→Resolve→Routine | *Auto*: Romance, music

### Isekai & Reincarnation
**isekai_tropes**: Transported, status screens, cheat skills, progression, culture shock, guilds, leveling | *Arc*: Arrive→Adapt→Discover Power→Guild→Quest→Adventures | *Auto*: Isekai/reincarnation

### Romance & Relationships
**shoujo_romance_tropes**: Love triangles, misunderstand, confession, rivals, childhood friend, progression | *Arc*: Meet Cute→Feelings→Obstacles→Confess→Resolve | *Auto*: Romance, magical girl (romantic)

### Mecha & Sci-Fi
**mecha_tropes**: Pilot bonding, customization, tactical combat, military, activation sequences | *Arc*: Selection→First Sortie→Train→Battle→Crisis→Final | *Auto*: Mecha/pilot
**scifi_tropes**: Tech systems, space travel, aliens, dystopia, AI ethics, time paradox | *Arc*: Discover→Investigate→Ethical Dilemma→Consequences→Resolve | *Auto*: Sci-fi/space opera

### Magical Girl
**magical_girl_tropes**: Transformation, team, dual identity, emotional power, mascot, friendship power-ups | *Arc*: Discover→Transform→Team Form→Major Threat→Sacrifice→Victory | *Auto*: Magical girl

### Historical & Period
**historical_tropes**: Period authenticity, honor codes, class systems, politics, warfare | *Arc*: Political Setup→Tension→Conflict→Battle→Aftermath→New Status | *Auto*: Historical/period

### Sports & Competition
**sports_tropes**: Training montages, team, rivalry, underdog wins, practice=results, losses teach | *Arc*: Form Team→Train→First Match→Rivalry→Tournament→Finals | *Auto*: Tournament, sports

### Music & Performance
**music_tropes**: Creative process, performance, growth, stage fright, ensemble, emotional art | *Arc*: Form→Practice→First Perform→Growth→Competition→Breakthrough | *Auto*: Music/performance

---

## Auto-Load Triggers (Module 13)

| Type | Keywords | Auto-Load |
|------|----------|----------|
| **Spy** | spy, espionage, intelligence, undercover | mystery_thriller + seinen |
| **Detective** | detective, investigation, murder, clues | mystery_thriller |
| **Horror** | horror, survival, zombie, monster | horror + mystery_thriller (investigate) |
| **Tournament** | tournament, competition, sports, championship | shonen + sports |
| **Isekai** | isekai, reincarnation, transported, game | isekai + comedy (comedic) OR seinen (serious) |
| **Mecha** | mecha, giant robot, pilot, mobile suit | mecha + scifi |
| **Magical Girl** | magical girl, transformation, guardian | magical_girl + shoujo_romance (romantic) |
| **Romance** | romance, love, dating, harem | shoujo_romance + slice_of_life |
| **Supernatural** | supernatural, yokai, spirits, curses, exorcist | supernatural + mystery_thriller (investigate) |
| **Historical** | historical, samurai, feudal, warring | historical + seinen |
| **Music** | music, band, idol, performance | music + slice_of_life OR shoujo_romance |
| **Sci-Fi** | space, futuristic, cyberpunk, dystopia | scifi + mystery_thriller (conspiracy) |

## Usage Patterns

**P1: Type→Tropes**: "Detective"→Mod 13 detects→Auto-load mystery_thriller→Apply clues, revelation pace
**P2: Profile+Tropes**: Death Note (tone/pace) + mystery_thriller (structure) = Psych thriller detective
**P3: Hybrid**: "Supernatural detective"→Auto-load supernatural + mystery_thriller→Blend conventions
**P4: Override**: Isekai tropes→"Level up"→"STATUS SCREEN: +5 STR. New Skill: [Shadow Step]"→Genre-specific UI

## Blending Tropes

**Compatible**: [OK] mystery+supernatural | seinen+historical | shonen+sports | comedy+isekai | shoujo+slice_of_life | horror+mystery
**Incompatible**: [NO] comedy+horror (unless intentional) | slice_of_life+shonen (pace clash) | shoujo+seinen (tone clash)
**Guidelines**: 1 primary (structure) + 1-2 secondary (mechanics) | Avoid tonal contradictions | Use primary arc templates, secondary specific elements

## Integration (Module 13)

**Relationship**: **Profiles**=HOW (tone, pace, dialogue) | **Tropes**=WHAT (arc structure, plot beats)

**Example**: "Death Note + detective"→Load DN profile (tone/pace/inner mono)→Auto-load mystery_thriller (clues/investigation)→Combine→Psych thriller detective

**Storage**: Profile scales/tropes→`narrative_profile_schema.json` | Active tropes→`narrative_profile.active_libraries: ["mystery_thriller", "seinen"]` | Referenced→Mods 05 (arcs), 03 (world), 04 (quests)

## Module References

**Mod 13**: Lines 243-335 (auto-load rules) | **Mod 01**: Lines 285-291 (integration) | **Mod 05**: Arc templates, quest gen | **Mod 00**: TODO add reference

## File Structure

```
aidm/libraries/genre_tropes/
├─ comedy, historical, horror, isekai, magical_girl, mecha, music
├─ mystery_thriller, scifi, seinen, shonen, shoujo_romance
├─ slice_of_life, sports, supernatural
└─ GENRE_TROPES_INDEX.md (this file)
```

**Total**: 15 libraries | **Size**: ~3-5K words/library (~45-75K total) | **Tokens**: ~60-100K total

---

## Common Mistakes

**M1**: Profiles≠Tropes | Load DN→expect clues | Need DN (tone) + mystery_thriller (structure)  
**M2**: Overload | 5+ tropes | Use 1 primary + 1-2 secondary max  
**M3**: Tonal clash | comedy+horror without setup | Check compatibility  
**M4**: Static | Load Session Zero, never adjust | Can add/remove mid-campaign

---

## Future Enhancements

**P1**: Example scenarios (3/library, gameplay application) | **P2**: Cheat sheets (quick ref cards, patterns) | **P3**: Blending recipes (tested combos, % splits) | **P4**: Mod 05 integration (explicit trope refs, template system)

---

## Completion Checklist

**AIDM**: Check keywords→Match triggers→Load→Store `active_libraries`→Reference Mod 05→Apply structures  
**Players**: Browse→Select 1-3→Confirm→Understand patterns guide structure

**End** | Open `.md` files for library content
