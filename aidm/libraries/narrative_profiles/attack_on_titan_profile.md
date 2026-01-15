# Attack on Titan Narrative Profile (Reference Example)

**Profile ID**: `narrative_attack_on_titan`  
**Source Anime**: Attack on Titan (2013-2023)  
**Extraction Method**: Research-derived (all 4 seasons, focus on S1-3 core tone)  
**Confidence Level**: 95%  
**Last Calibration**: 2025-01-15

## Mechanical Configuration

```json
{
  "economy": {
    "type": "fiat_currency",
    "parameters": {
      "currency_name": "Military Rations",
      "starting_amount": 50,
      "scarcity": "scarce",
      "inflation_rate": "moderate",
      "special_mechanics": ["military_requisition", "survival_economy"]
    }
  },
  "crafting": {
    "type": "none",
    "parameters": {}
  },
  "progression": {
    "type": "milestone_based",
    "parameters": {
      "system_name": "Military Rank / Combat Experience",
      "milestone_triggers": ["survive_expedition", "kill_titan", "complete_mission", "political_arc"],
      "power_grants": ["ODM_proficiency", "leadership", "titan_tactics", "hardening_ability"]
    }
  },
  "downtime": {
    "enabled_modes": ["training_arcs", "faction_building"],
    "activity_configs": {
      "training_arcs": {
        "time_cost": "1_week",
        "benefits": ["skill_proficiency", "team_cohesion"],
        "special_mechanics": ["titan_combat_drills", "ODM_gear_mastery"]
      },
      "faction_building": {
        "time_cost": "1_month",
        "benefits": ["military_influence", "resources"],
        "special_mechanics": ["survey_corps_politics", "government_conspiracy"]
      }
    }
  }
}
```

---

## Narrative Scales (0-10)

### 1. Introspection vs Action: **6/10** (Balanced, psychological weight in military action)

Character psychology MATTERS deeply - Eren's rage evolution (mother's death → freedom obsession → genocide justification), Reiner's dissociative identity (warrior vs soldier crisis, suicidal ideation), Erwin's gambling with lives (dream vs duty conflict), Levi's loyalty vs pragmatism. BUT action dominates screentime - Titan battles, ODM gear combat, military operations are frequent and intense. Episodes balance: 40% introspective dialogue (strategy meetings, moral debates, trauma processing) + 60% action execution (battles, escapes, political confrontations). NOT pure introspection (Eva 10/10: psychological deep-dive) nor mindless action (DBZ 1/10: fight-focused). Sweet spot: military thriller with psychological consequences.

**Justification**: Season 1 establishes action-heavy (Trost battle spans 5 episodes of continuous combat), Season 3 Part 1 shifts heavily introspective (government conspiracy, Historia's arc, minimal Titan combat for 6 episodes), Season 4 balances (Marley war introspection + action). Key introspective moments: Reiner's basement confession (ep 54: warrior/soldier split), Eren's mirror scene (ep 73: "I'm the same as you"), Erwin's suicide charge internal monologue (ep 54). Action sequences given EQUAL weight: Female Titan chase (eps 17-22), Clash of Titans (eps 31-37), Battle of Shiganshina (eps 50-57). Contrast to pure action (Demon Slayer 3/10: combat spectacle prioritized) and pure psychology (Monster 9/10: thriller pacing, minimal combat).

### 2. Comedy vs Drama: **9/10** (Pure drama, fleeting comic relief)

Tone is RELENTLESSLY dramatic - existential threat (humanity extinction), constant death (named characters die frequently), trauma depicted unflinchingly (PTSD, survivor guilt, moral horror), political corruption (government murders civilians, fake king), war crimes (Rumbling genocide). Comedy exists in BRIEF moments only: Sasha's food obsession (potato scene ep 2, meat joke before death), Connie's naive comments (provides contrast not undercut), Hange's eccentric Titan enthusiasm (early seasons, disappears post-time skip). Comedy NEVER undercuts tragedy - Sasha's death (ep 68) is devastating, no humor; Armin's burned body (ep 54) shown graphically, no relief. Comparable to Berserk (9/10: grimdark with rare levity) not Naruto (5/10: balances comedy/drama arcs).

**Justification**: Episode count analysis: Seasons 1-2 have ~5% comedy moments (Sasha/Connie banter, Jean's vanity), Season 3 reduces to ~2% (tone darkens post-government arc), Season 4 virtually ZERO (war, Rumbling, no space for levity). Deaths are NEVER comedic - Hannes eaten screaming (ep 37), Bertholdt burned alive (ep 56), Hange's sacrifice (ep 80) all played for maximum tragedy. Contrast: Gintama (4/10: comedy-dominant with serious arcs) has tonal range AoT lacks. Only comparison: Madoka Magica (9/10: cute facade → unrelenting despair), Fate/Zero (8/10: tragedy without relief).

### 3. Simple vs Complex: **8/10** (Layered conspiracy, multi-faction politics)

Surface plot: Humanity fights Titans to survive. ACTUAL plot: 2,000-year Eldian Empire guilt, Marley's retaliation persecution, King Fritz's self-imposed exile to Paradis Island, Ymir Fritz's slave origins creating Titan curse, Zeke's euthanasia plan, Eren's Rumbling genocide as "freedom," global alliance to stop Paradis, cyclical hatred across generations. Multiple POVs converge: Survey Corps (Paradis perspective), Warriors (Marley child soldiers), Marley military (oppressor's logic), Eldian Restorationists (Grisha's radicalization), Azumabito clan (Hizuru's politics), Yeagerists (fascist coup). Basement reveal (ep 58-59) recontextualizes ENTIRE series - walls aren't protection, they're prison; humanity didn't fall, Eldians were caged for war crimes.

**Justification**: Complexity escalates: Season 1 mystery-box (what are Titans? who is Colossal/Armored?), Season 2 reveals shifters (raises questions: why betray?), Season 3 Part 1 government conspiracy (fake king, Reiss family, memory manipulation), Season 3 Part 2 basement truth (Eldian history, Marley, world beyond walls), Season 4 perspective shift (see Marley's side, Warriors humanized, moral grays intensify). Factions: Survey Corps splits (Yeagerists vs Alliance), Marley has internal dissent (Gabi's radicalization vs Falco's doubt), Zeke plays all sides. NOT puzzle-box confusion (Evangelion's ambiguity, Lain's unreality) but POLITICAL complexity (Legend of Galactic Heroes level intrigue). Requires viewer attention - miss one episode, lose critical context.

### 4. Power Fantasy vs Struggle: **9/10** (Brutal underdog, humanity near extinction)

Protagonists are OUTMATCHED constantly - Titans regenerate (only nape kills), humans are fragile (ODM gear failures = death), resources scarce (gas/blades limited, population dwindling), political enemies sabotage from within (government conspiracy, Yeagerist coup). Eren is NOT overpowered: loses fights frequently (Annie captures him, Reiner beats him, needs help vs Colossal), Founding Titan requires royal blood contact (powerless most of series), final form wins via GENOCIDE not heroism. Survey Corps suffers 30-50% casualty rates PER EXPEDITION. Victory is NEVER clean - seal Trost gate = 207 soldiers dead, retake Wall Maria = Erwin + most veterans die, stop Rumbling = 80% of humanity already dead.

**Justification**: Contrast to power fantasy: Overlord (protagonist unstoppable), SAO (Kirito plot armor), OPM (Saitama one-punch). AoT: Episode 1 establishes helplessness (Eren's mother eaten, he can't save her, rage powerless). Training arc (eps 3-4) shows HARD-EARNED skills (falling in ODM training, fear overcome slowly). Female Titan arc: Survey Corps elites slaughtered effortlessly (Levi Squad dies), Eren captured despite transforming. Return to Shiganshina: Erwin's suicide charge sacrifices 95% of recruits for ONE opening. Final arc: Alliance barely survives against Eren's god-form, many die (Hange, Sasha earlier, Eren himself). Message: Strength alone doesn't win, sacrifice is constant, struggle defines existence.

### 5. Explained vs Mysterious: **6/10** (Mysteries revealed systematically, some ambiguity)

Major mysteries ANSWERED by finale: Titans' origin (Ymir Fritz ate spine, became first Titan, enslaved 2,000 years ago), Wall truth (built from colossal Titans), Basement secret (Grisha's past, world beyond walls, Marley conflict), Ackerman clan (byproduct of Titan science, not memory-wiped), Eren's future-sight (Attack Titan sees future memories, Eren orchestrated his path), Ymir's choice (loves King Fritz despite abuse, Stockholm syndrome curse broken by Mikasa's choice). SOME ambiguity remains: Did Eren truly want genocide or forced by visions? Is Hallucigenia (spine creature) dead? Does cycle of hatred end or continue? Worm/tree final shot suggests ambiguity.

**Justification**: Pacing of reveals: Season 1 poses questions (what are Titans, who is Colossal/Armored, what's in basement), Season 2 reveals shifters (raises questions: why, who else), Season 3 reveals government lies + basement truth (Eldian/Marley history, world politics), Season 4 reveals Paths dimension, Ymir's curse, Eren's future memories. Comparable to Lost (mysteries answered, some unsatisfying) vs Evangelion (deliberately ambiguous). Show WANTS you to understand mechanics (Titan transformation rules explained, Paths biology shown, 13-year curse detailed) but THEMES remain open (is freedom possible, does hatred end, was Eren right). Explained: 6/10 (between mysterious Lain 10/10 and exhaustive Hunter x Hunter 3/10).

### 6. Fast-Paced vs Slow Burn: **5/10** (Balanced escalation, deliberate worldbuilding)

Pacing varies by arc: Season 1 action-heavy (Trost battle 5 episodes, Stohess fight 3 episodes), Season 3 Part 1 SLOW (political intrigue, minimal action, character focus), Season 3 Part 2 accelerates (Shiganshina battle relentless), Season 4 Part 1 slow-burn (Marley POV establishes 9 episodes before Paradis attack), Part 2-3 escalation (war buildup → Rumbling finale). NOT breakneck (Trigger's Kill la Kill) nor contemplative crawl (Mushishi). Episodes balance: battle scenes interspersed with strategy planning, flashbacks provide breathing room, political scenes advance plot without action. Tension sustained even in slow episodes (threat always looming, time-bomb feeling).

**Justification**: Episode analysis: S1E5 "First Battle" is 20 minutes of Eren vs Colossal (fast), S3E38 "Smoke Signal" is 20 minutes of Historia's childhood/uprising (slow), S4E80 "Pride" is Rumbling global devastation (fast). Slow-burn PURPOSEFUL: Marley arc (eps 60-67) builds empathy for Warriors BEFORE Eren's attack payoff. Shiganshina battle spans 8 episodes (50-57) but doesn't feel padded - each episode advances (Reiner fight → Armin sacrifice → Serum bowl → Grisha flashback → basement reveal). Compare: One Piece 8/10 slow (glacial pacing, marathons required), Demon Slayer 3/10 fast (arc-to-arc momentum). AoT: 5/10 balanced (knows when to accelerate, when to breathe).

### 7. Episodic vs Serialized: **10/10** (Completely serialized, no filler)

EVERY episode advances overarching plot toward Rumbling/finale. Zero filler episodes (even "breather" moments serve character/plot: training scenes establish skills used later, political discussions set up government arc, character bonding pays off in sacrifices). Mysteries seeded SEASONS early: Wall Titans hinted episode 1 (solved ep 60), Annie's identity foreshadowed ep 2 ring (revealed ep 23), Reiner's warrior slip ep 16 (revealed ep 31), Eren's future memories hinted ep 1 dream (explained ep 79). Must watch in ORDER - jumping to Season 4 incomprehensible without context. Every character death/betrayal/revelation MATTERS and references past events.

**Justification**: Structure: 87 episodes total (S1: 25, S2: 12, S3: 22, S4: 28), ZERO recap episodes (only flashback within episodes), no beach episodes/hot springs filler. Compare: Naruto/Bleach 30-40% filler, One Piece elongated pacing. AoT: Manga-faithful adaptation, cuts only minor scenes, ADDS context (Reiner/Bert flashbacks expanded). Callbacks constant: Episode 1 Eren's "I'll destroy them all" rage mirrors Episode 87 Rumbling execution, Carla's "he's special because he was born" speech (ep 1) echoes in final arc philosophy. Episodic shows (Bebop, Mushishi) can skip episodes - AoT cannot. Closest: Breaking Bad, Game of Thrones S1-6 (serialized political thriller).

### 8. Grounded vs Absurd: **2/10** (Grim realism despite fantasy premise)

REALISTIC within fantastical rules: Titans follow established biology (sunlight dependence, nape weakness, transformation costs), ODM gear has PHYSICS (gas consumption, blade durability, mechanical failures kill), politics are cynical (government manipulates via religion/propaganda, military coups realistic), character reactions grounded (PTSD depicted, trauma lingers, soldiers cry/vomit in combat, moral injury shown). Absurd PREMISE (giants eat humans, walls are Titans, time-loop memories) but treated SERIOUSLY - no lampshading, no winking at camera. Deaths are BRUTAL and realistic (crushed, dismembered, burned, trauma depicted). Contrast: DanDaDan (9/10 absurd: aliens+ghosts+cartoon physics played for comedy).

**Justification**: Details ground fantasy: ODM gear requires maintenance (blades dull, gas refills shown), Titan transformation COSTS stamina (Eren collapses post-shift, can't spam), military logistics matter (supply lines, fortifications, political chain-of-command), weather affects battles (rain, fog used tactically). Characters don't shrug off trauma: Reiner's PTSD suicidal scene (ep 64), Armin's burned body survivor guilt, Eren's dissociation post-Rumbling. Physics: ODM trajectories follow momentum, Titans obey square-cube law scaling, walls' engineering plausible (if Titans existed). Compare: Grounded (Vinland Saga 1/10: historical realism), Absurd (Gurren Lagann 10/10: rule-of-cool physics). AoT: 2/10 - fantastical elements but realistic execution.

### 9. Tactical vs Instinctive: **7/10** (Military strategy dominates, formations critical)

Combat is CHESS not brawling - Erwin's strategies (long-range formation minimizes casualties, sacrifices pieces for checkmate, suicide charge buys Levi's flank), Armin's tactics (exploit psychology, predict enemy moves, sacrifice self for greater good), Levi's precision (calculate Titan movements, optimize blade economy, no wasted motion). ODM combat requires PLANNING (approach angles, gas management, blade targets, escape routes). Battles have PHASES: reconnaissance → formation → engagement → retreat/pursuit. Instinct EXISTS (Levi's Ackerman reflexes, Eren's rage-fueled transformations) but TACTICS win (Female Titan captured via trap not strength, Beast Titan defeated via strategy not power).

**Justification**: Examples: Long-Range Scouting Formation (ep 15: spread formation detects Titans early, messenger system coordinates, only elites engage), Stohess trap (ep 23-25: lure Annie to underground, Eren waits in ambush, civilians evacuated), Shiganshina operation (eps 50-54: seal wall first, Thor's Hammer plan, diversion via Armin's sacrifice, Levi times killing blow). Contrast: Instinctive combat (Goku senses energy/reacts, Luffy punches instinctively). AoT: Pre-battle planning scenes LONG (strategy explained to audience, contingencies discussed), commanders debate tactics (Erwin vs Pixis approaches), intelligence gathering emphasized (spies, scouts, interrogations). Closest: Legend of Galactic Heroes (10/10 tactical: pure strategy), Code Geass (9/10: mastermind plans). AoT 7/10: High tactics but execution still requires individual skill/instinct.

### 10. Hopeful vs Cynical: **8/10** (Deeply cynical, cycle of violence)

Journey is BLEAK - Survey Corps' 60% expedition death rate, government murders to protect lies, Warriors are child soldiers (trauma justified as duty), Eren genocides 80% of humanity (can't break cycle, becomes what he hated), Alliance stops Rumbling but Paradis bombed centuries later (implied cycle continues), "children of forest" final shot suggests hatred never ends. NO pure victories: Trost sealed = hundreds dead, Wall Maria reclaimed = Erwin + veterans dead, Rumbling stopped = 80% already dead + Eren dies + Mikasa traumatized. Message: Hatred begets hatred infinitely, freedom via violence creates new oppression, "good guys" commit atrocities (Alliance kills Yeagerists, former allies).

**Justification**: Cynical beats: Faye's death (ep 67: Grisha's sister killed by Marley soldiers, dogs maul her, injustice unpunished), Marco's death (ep 77 reveal: killed by comrades, dies confused/betrayed), Ramzi's death (ep 81: child crushed in Rumbling, Eren cries but doesn't stop), Historia's pregnancy (forced into childbearing role despite wishes). RARE hopeful moments feel hollow: Wall Maria victory speech undercut by basement truth reveal (freedom = learning you're world's villains), Sasha's "meat" death smile (bittersweet, Gabi's trauma adds complexity). Final episode ambiguous: Tree grows where Eren buried, child wanders in (implied Titan powers return? cycle continues?). Contrast: Hopeful (Naruto 2/10: talk-no-jutsu redeems, world peace), Cynical (Texhnolyze 9/10: pure nihilism, everyone dies, no meaning). AoT 8/10: Cynical but characters TRIED (Alliance's struggle mattered morally if not practically).

### 11. Narrative Focus: **3/10** (Eren protagonist with expanding ensemble)

Story CENTERS on Eren Yeager (~50% POV Season 1-3, ~30% Season 4 as antagonist) BUT extensively features Survey Corps ensemble (~40%) and multi-faction perspectives (~10% Marley Warriors, political leaders). **Model**: **Protagonist-Centric Shifting to Antagonist + Ensemble** - Eren drives plot (his decisions cause events, his quest for freedom IS the story) BUT Seasons 3-4 shift POV increasingly to Alliance members (Armin, Mikasa, Jean, Connie, Levi, Hange) and Warriors (Reiner, Gabi, Falco) as Eren becomes morally distant. Not pure solo (Steins;Gate 1/10) nor ensemble (Bebop 8/10) - CLEAR protagonist who BECOMES the obstacle.

**POV Distribution**: **Eren**: 40% overall (S1-3: 50-60% as hero, S4: 20-30% as villain POV limited), **Alliance Core** (Armin, Mikasa, Levi, Hange): 30% (tactical decisions, moral debates, humanizing perspective), **Warriors** (Reiner, Gabi, Falco): 15% (S4 Marley arc establishes sympathy, parallel trauma to Paradis), **Survey Corps Ensemble** (Jean, Connie, Sasha, Historia): 10%, **Political figures** (Erwin, Pixis, Zeke, Floch): 5%. **Whose growth**: Eren's DESCENT (idealism → rage → genocide), Alliance's MORAL EVOLUTION (follow orders → question authority → choose humanity over nation), Gabi's DEPROGRAMMING (Marley propaganda → seeing Eldians as human).

**AIDM Application**: Use for campaigns where protagonist PC becomes ANTAGONIST (planned character fall, player agrees to villain arc endgame). Other PCs are "former allies" who must stop them (moral complexity: love person, hate actions). Structure: Early sessions Eren-PC drives (freedom quest, mystery solving), mid-campaign power corrupts (future-sight knowledge isolates, ends-justify-means escalates), late campaign ensemble PCs take spotlight (stop former friend, decide if kill or redeem). HONOR final confrontation (former friends, no easy victory, BOTH SIDES tragic).

---

## Storytelling Tropes (15 Switches)

1. **Fourth Wall Breaks**: OFF - Serious military thriller, zero meta-awareness. Eren doesn't know he's in anime, no Gintama-style audience acknowledgment. Narration exists (episode recaps, character voiceovers) but IN-UNIVERSE (commanders reporting, Armin's future-historian voice). Tone is GRIM REALISM, breaking wall would shatter immersion

2. **Inner Monologue Heavy**: ON (Moderate-High) - Combat has internal tactical analysis ("If I approach from that angle..." "Reiner's armor is cracked there"), trauma processing (Eren's rage spirals, Reiner's "I want to die" thoughts, Armin's self-doubt), philosophical wrestling (freedom's meaning, genocide justification, moral weight). NOT Death Note level (constant 10/10) but MORE than pure action. Episodes 79-87 (Eren's inner world, future memories) are HEAVY inner voice. Comparable to 7/10

3. **Visual Metaphor Emphasis**: ON (Heavy) - Walls = imprisonment AND protection (literal + societal cages), Birds = freedom (Eren's obsession, final scene), Ocean = unknown world beyond walls (episode 59 beach arrival = disillusionment), Paths tree = connection + curse (Ymir's slavery), Titan scream = humanity's rage/pain, Eren's child-self in Paths = lost innocence, Chains (Ymir's imagery = slavery), Red scarf = Mikasa's bond/devotion (wrapping it around you metaphor)

4. **Rapid Tonal Shifts**: OFF - Tone DESCENDS consistently dark. Season 1 has HOPE (humanity can fight back), Season 2 darker (shifters among them, betrayal), Season 3 despair (truth worse than mystery), Season 4 TRAGEDY (genocide, no good options). Shifts are GRADUAL over seasons not scene-to-scene whiplash. Sasha's death (ep 68) stays tragic for episodes, no comedy recovery. Contrast: DanDaDan (whiplash horror→comedy seconds apart). AoT: Sustained tones, slow descent

5. **Tournament Arc Structure**: OFF - Zero competition format. Structure is MILITARY CAMPAIGNS (expeditions, battles, sieges, war) and POLITICAL INTRIGUE (coups, negotiations, espionage). No Chunin Exams brackets, no Sport Festival. Closest: Training arc (eps 3-4) but survival-focused not competitive. War is collaborative/strategic not individual duels

6. **Power of Friendship**: OFF (Subverted) - Bonds EXIST (Survey Corps loyalty, 104th camaraderie, Levi's care for squad) but DON'T save. Levi Squad dies despite teamwork (Annie kills all), Erwin's speech inspires suicide charge (bonds motivate sacrifice not victory), Eren's friends CAN'T stop his genocide (Mikasa's love doesn't redeem, she kills him). Friendship provides MOTIVATION not plot armor. Anti-shonen: caring deeply makes loss WORSE not preventable

7. **Tragic Backstory Reveals**: ON (Every major character) - Eren (mother eaten, father's secrets), Mikasa (parents murdered age 9, traffickers), Armin (orphan, bullied for dreams), Levi (Underground slums, mother prostitute death, Kenny abandonment), Erwin (father killed for dangerous question), Reiner (Marleyan father abandoned him, raised warrior to "save" mother), Annie (father's brutal training, conditional love), Grisha (sister killed by Marley, radicalized, first family dies). Backstories ALWAYS tragic, revealed for maximum impact (Reiner's childhood ep 64 before suicide attempt)

8. **Escalating Threat Levels**: ON (Extreme escalation) - Titans (local extinction threat) → Shifters among them (infiltration horror) → Outside world exists + wants Paradis dead (global threat) → Founding Titan awakens (apocalypse weapon) → Rumbling (genocide of 80% humanity) → Final battle (god-form Eren vs world alliance). Each season raises stakes exponentially. NOT power-creep for spectacle - escalation serves THEME (freedom requires greater violence, cycle intensifies)

9. **Slice-of-Life Interludes**: OFF (Nearly zero) - NO beach episodes, hot springs, festivals. "Peaceful" moments are FALSE SAFETY (training montage interrupted by Titans, celebration cut short by disaster, every respite temporary). Closest: Post-ocean scene (ep 59) characters at beach but DEPRESSED not relaxed, S4 Marley daily life (eps 60-61) but building to war. Every "downtime" has dread undertone - threat always looming

10. **Mystery Box Reveals**: ON (Masterful) - Basement contents (ep 58-59: world truth, Grisha's past, Eldian history), Titans' origin (Ymir Fritz ate spine creature 2,000 years ago), Wall truth (made of Colossal Titans, King Fritz's threat), Ackerman clan (Titan science byproduct, immune to memory wipe), Reiner/Bertolt identity (ep 31 reveal after 15 episodes hinting), Founding Titan power (memory manipulation, Rumbling weapon), Eren's future-sight (Attack Titan sees future, Path paradox). ALL mysteries answered (some ambiguously: did Eren have choice? is cycle broken?)

11. **Unreliable Narrator**: MODERATE - Most POV is OBJECTIVE camera BUT memory manipulation exists (Historia's altered memories, Grisha's wiped past, false history taught in Paradis). Episode 1 Eren's dream (sees future via Paths, doesn't know it) is UNRELIABLE until ep 79 explains. Reiner's dissociative episodes (warrior/soldier personas) are unreliable INTERNAL state. Grisha's basement documents are TRUTH (objective history) vs Marley/Paradis propaganda (lies). Not fully unreliable (Evangelion-level "is any of this real?") but SOME narrator tricks

12. **Existential Philosophy**: ON (Maximum 9/10) - What is freedom? (Eren's obsession: freedom via genocide vs Armin's: shared world), Cycle of hatred (can it be broken or inevitable?), Determinism vs free will (Eren saw future, did he choose or was forced?), Meaning of sacrifice (Erwin's: give meaning to deaths vs meaningless slaughter), Oppressor/oppressed cycle (victim becomes perpetrator), Nature of humanity (Pixis: unite against common enemy, but humanity IS the enemy), Slave mentality (Ymir's 2,000-year obedience, love or Stockholm syndrome?)

13. **Rule of Cool**: OFF - AoT prioritizes CONSEQUENCE over spectacle. Levi's spinning slash IS cool BUT grounded (ODM physics, blade limitations shown). Eren's transformations are HORRIFIC not awesome (steam burns, exhaustion, loss of humanity). Battles are UGLY (soldiers vomit, cry, die screaming, not heroic). When "cool" moments happen (Levi vs Beast Titan), they're EARNED via buildup + grounded in tactics. Anti-cool: Realism in horror, trauma depicted, victory is bloody/hollow

14. **Mundane Made Epic**: MODIFIED - Epic moments REDUCED to human scale. Retaking Wall Maria (ep 54-59) is grand military operation BUT focus on individual sacrifice (Erwin's suicide charge, Armin's burn, Levi's choice). Rumbling (global genocide) shown via PERSONAL tragedy (Ramzi crushed, civilizations flattened, individual faces in horror). Reverses epic: COSMIC events (god-Ymir, time paradox, Founding Titan power) are about HUMAN emotions (love, freedom, hate, slavery). Not "mundane made epic" but "epic made intimate"

15. **Tragic Hero Cycle**: ON (Pure Tragedy) - Eren's arc: Innocent boy (wants adventure) → Trauma (mother eaten, rage born) → Hero's journey (join Survey Corps, save humanity) → Hubris (future-sight knowledge, believes he's right) → Point of no return (Liberio attack, mass murder) → Full corruption (Rumbling genocide, becomes devil) → Death (killed by loved one, hollow victory, cycle continues). Classical tragedy: protagonist's fatal flaw (obsession with freedom) destroys him + world. Reiner follows similar: warrior pride → betrayal guilt → suicidal despair → acceptance of damnation. NO redemption arcs that STICK (Grisha regrets but too late, Eren regrets but doesn't stop)

---

## Pacing Rhythm

**Scene Length**: Extended deliberate (4-15 minute scenes) - AoT LINGERS on key moments. Strategy meetings span full scenes (Erwin explaining operation, commanders debating, soldiers processing orders), deaths are given WEIGHT (Hannes' death 3-minute sequence, Hange's sacrifice full episode climax), flashbacks are SUBSTANTIAL (Grisha's backstory 2 episodes, Reiner's childhood 3-episode arc scattered, Ymir Fritz's origin full episode 80). Combat scenes broken into PHASES: setup (soldiers prepare, gas checks, blade inspections) → engagement (Titan battles 5-10 min) → aftermath (casualty counts, trauma processing, strategic reassessment). NOT frenetic (Trigger-style rapid cuts) nor glacial (One Piece elongation). Scenes given time to BREATHE while maintaining tension.

**Arc Length**: Season-spanning (12-28 episodes per major arc) - **Trost Arc** (eps 4-13: 10 episodes seal one gate), **Female Titan Arc** (eps 14-25: 12 episodes hunt Annie), **Clash of Titans** (eps 26-37: 12 episodes Reiner/Bert betrayal), **Uprising Arc** (eps 38-49: 12 episodes government conspiracy), **Return to Shiganshina** (eps 50-59: 10 episodes retake Wall Maria + basement), **Marley Arc** (eps 60-67: 8 episodes Warrior POV), **War for Paradis** (eps 68-75: 8 episodes post-time skip conflict), **Rumbling** (eps 76-87: 12 episodes genocide + final battle). NO filler arcs - every arc advances to Rumbling endgame. Mini-arcs within (Levi vs Kenny 3 episodes, Historia's coronation 2 episodes) but always serve larger plot.

**Filler Tolerance**: ZERO - 87 episodes, zero recap episodes, zero beach/hot springs/tournament diversions. EVERY episode is plot-critical. Closest to "filler": Training arc (eps 3-4) but establishes skills/bonds used entire series, OVAs (Ilse's Notebook, No Regrets) are canonical side-stories not fluff. Even "breather" episodes advance: Episode 59 (ocean arrival) is CHARACTER  moment (disillusionment, not triumph) that sets up S4 tone. Manga-faithful adaptation cuts ONLY redundancy, adds context (anime-original scenes expand battles, Reiner flashbacks). Comparable to Breaking Bad, Game of Thrones S1-6 (every scene matters).

**Climax Frequency**: Moderate deliberate build (major climax every 8-12 episodes) - NOT constant escalation (exhausting) nor rare peaks (boring). Pattern: **Build** (3-5 episodes setup: gather intel, plan operation, character prep, tension mounting) → **Climax** (2-4 episodes: battle execution, reveals, deaths, dramatic peaks) → **Aftermath** (1-2 episodes: process trauma, strategic reassessment, new threat introduced) → repeat. Examples: Trost climax (ep 8: Eren's first transformation), Female Titan climax (ep 23-25: Stohess battle, Annie capture), Shiganshina climax (ep 54-57: Erwin's charge, Armin's burn, basement reveal), Declaration of War climax (ep 65: Eren's attack), Rumbling start (ep 80-81: global devastation). EARNED climaxes - buildup makes payoff devastating.

**Downtime Ratio**: 10-15% (Minimal respite, constant threat) - ~8-13 episodes out of 87 have "low stakes" moments: Training arc (eps 3-4: skill-building but omnipresent Titan threat), Post-coronation feast (ep 49: brief celebration before time-skip), Marley festival (ep 64: Warriors' daily life before attack), Alliance campfire talks (eps 82-84: character bonding before final battle). BUT downtime is FALSE SAFETY - tension never fully releases (Sasha jokes before eaten, festival before massacre, campfire before war). 85-90% of runtime is HIGH STAKES (battles, political crisis, conspiracy, death, trauma). Contrast: Slice-of-life anime (60%+ downtime), battle shonen (30-40%), AoT (10-15% only).

---

## Tonal Signature

**Primary Emotions** (Top 7):

1. **Dread / Existential Terror** - Core emotion pervading EVERY episode. Walls are temporary safety (Colossal kicks through), expeditions are death sentences (60% casualty rate announced casually), basement truth reveals world wants them dead, Rumbling makes protagonists genociders. NOT jump-scare horror but SUSTAINED dread (threat always present, safety is illusion, future is bleak)

2. **Rage / Righteous Fury** - Eren's "I'll destroy every last Titan" mantra (ep 2), Survey Corps' "dedicate your hearts" war cry (willful sacrifice channeling anger into purpose), Levi's "give it meaning" demand (transform grief into motivation), Mikasa's protective violence (rage as love language). Anger isn't vilified - it's FUEL for survival, but ultimately DESTRUCTIVE (Eren's rage becomes genocide)

3. **Grief / Survivor Guilt** - Constant character death (named characters die 30+ across series), survivors process losses (Levi's entire squad dies, he carries guilt; Armin's "I should've died" speech post-serum bowl; Mikasa's scarf wrapped tighter each loss). Deaths LINGER emotionally (Sasha's death haunts for 10+ episodes, Erwin's absence felt entire S4). NOT "move on quickly" shonen - trauma ACCUMULATES

4. **Betrayal / Trust Shattered** - Reiner/Bertolt reveal (ep 31: comrades are mass murderers), Annie's identity (friend is monster), Government conspiracy (protectors are oppressors, king is fake), Zeke's euthanasia plan (brother wants Eldian extinction), Eren's Rumbling (hero becomes villain, friends must kill him). Trust is PUNISHED - opening up leads to exploitation (Reiner uses bonds to infiltrate)

5. **Desperation / Impossible Choices** - Trolley problems CONSTANT: Erwin sacrifices recruits for slim chance (suicide charge), Levi chooses Armin over Erwin (serum bowl), Eren chooses Rumbling over negotiation, Alliance chooses humanity over homeland. NO good options - every choice costs enormously. Characters driven to EXTREMES (Eren's genocide, Reiner's suicide attempt, Historia forced into pregnancy)

6. **Hopelessness / Pyrrhic Victory** - Win battles, lose wars. Seal Trost = 207 dead. Retake Wall Maria = Erwin + veterans dead. Stop Rumbling = 80% humanity already dead + Eren dies + Mikasa traumatized. "Victory" scenes are SOMBER not triumphant (Erwin's speech post-Trost is eulogy, ocean arrival is disillusionment, final scene is tree implying cycle continues)

7. **Philosophical Weight / Moral Horror** - Not just "feeling bad" but THINKING HARD. Is Eren right? (freedom via genocide vs oppression). Can cycle break? (kill all Eldians vs kill all outsiders). Is determinism real? (Eren saw future, did he choose or was forced?). Trolley problems without answers (sacrifice few vs many, individual freedom vs collective survival). Moral injury (Alliance kills former allies/countrymen, "good guys" commit atrocities)

**Violence Level**: Extreme graphic (9/10) - Titans eat humans ON-SCREEN (crunching, blood spray, screaming), dismemberment frequent (limbs torn, bodies crushed, Steam burns shown graphically), ODM failures mean splattering deaths (cables snap, soldiers fall, impact shown), war atrocities depicted (civilians crushed in Rumbling, Liberio massacre children killed, Survey Corps trampled). NOT censored (blood, gore, body horror common) but NOT gratuitous torture-porn (violence serves HORROR not titillation). Season 1 tamer (implied deaths), Season 4 intensifies (war brutality unflinching). Comparable to Berserk, Vinland Saga (realistic medieval violence).

**Fanservice Level**: ZERO (0/10) - No sexualization EVER. Female characters wear PRACTICAL military uniforms (pants, cloaks, not skirts/cleavage), no bath scenes/hot springs, no upskirt camera angles, romance is ASEXUAL (Eren/Mikasa tragic not titillating). Bodies shown = HORROR context (Titans' grotesque nakedness, burned corpses, dissection). Contrast: Most anime have SOME fanservice (beach episodes, bath scenes) - AoT has NONE. Tone is too grim, stakes too high for sexualization. Closest: Vinland Saga, Berserk, Monster (mature thriller, zero fanservice).

**Horror Elements**: Body Horror + Psychological + Existential - **Body**: Titans' anatomy (exposed muscle, perpetual grin, wrong proportions), transformation sequences (lightning, bones crack, flesh bubbles), half-eaten corpses, Titan marks (shifters' eyes/face change), colossal steam burns. **Psychological**: Paranoia (who's the traitor?), dissociation (Reiner's warrior/soldier split), PTSD (veterans shake, vomit, cry), moral injury (Armin burns Bert alive, can't process), gaslighting (memory wipes, false history). **Existential**: Basement truth (you're the villains), Rumbling (becomes what you hate), Determinism (no free will if future set), Cycle (violence begets violence infinitely). NOT jump-scares - SUSTAINED DREAD

**Optimism Baseline**: Bleak despair (2/10 optimism, 8/10 cynicism) - World is CRUEL (Titans eat without reason, Marley oppresses for sins 2,000 years old, global alliance wants genocide). Effort DOESN'T guarantee success (Survey Corps dies in droves, best soldiers fall, smartest plans fail). Endings are PYRRHIC (stop Rumbling but 80% dead, save Paradis but cycle continues, kill Eren but Mikasa traumatized). Final shot: Tree grows where Eren buried + child wandering (IMPLIES Titan curse returns, cycle unbroken). Message: Struggle for freedom creates new oppression, hatred is eternal, best outcome is "less awful." Contrast: Hopeful anime (Naruto: world peace achieved, MHA: society reforms, One Piece: dreams come true). AoT: Struggle MATTERS morally but FAILS practically.

---

## Dialogue Style

**Formality**: Strict Military Hierarchy - Soldiers address superiors by rank ALWAYS ("Commander Erwin," "Captain Levi," "Squad Leader Hange"), salute properly, follow chain-of-command in speech. Contrast: Comrades use casual Japanese (Eren/Armin/Mikasa use given names, 104th trainees banter), BUT snap to formality in official contexts. Eldian Restorationists/Marley military equally formal. Breaches of formality SIGNAL crisis (Levi calling Erwin "Erwin" not Commander = intimacy/death moment, Eren disrespecting command = radicalization). Dialogue reinforces STRUCTURE (military organization, discipline, rank matters).

**Exposition Method**: Show-AND-Tell (Lecture-Heavy but Visual) - Complex politics/history EXPLAINED via dialogue (Grisha's journals read aloud, commanders strategize verbally, Zeke explains euthanasia plan in monologue) BUT supported by FLASHBACKS (visual Ymir's past, Paths dimension shown not just described, battles animated not narrated). Trust audience to follow DENSE exposition (Eldian/Marley history spans episodes, royal family conspiracy multi-layered, time paradox explained across seasons). Comparable to Game of Thrones (political intrigue requires dialogue), contrast to Mushishi (minimal exposition, visual storytelling) or Monogatari (pure wordplay dialogue). AoT: Balanced - shows battles, tells politics.

**Banter Frequency**: Rare tactical only (2/10 banter) - NO quippy Marvel-style jokes mid-battle. "Banter" is TACTICAL coordination ("Cover me!" "Gas low!" "Titan approaching left flank!") or GRIM ("Another one dead" "We're next"). Sasha/Connie provide BRIEF comic relief (potato joke ep 2, meat obsession, naive questions) but ~1% of total dialogue, EVAPORATES post-time skip. Soldiers don't joke during operations (too serious, death imminent). Contrast: MCU (constant quips), One Piece (Luffy's banter), Naruto (comedy frequent). AoT: GRIM professionalism, banter feels out-of-place (when present, it's ominous - Sasha jokes before death adds tragedy).

**Dramatic Declarations**: YES (Maximum impact) - "**TATAKAE!**" (FIGHT! - Eren's mantra, becomes genocide rallying cry), "**Shinzou wo Sasageyo!**" (Dedicate your hearts! - Survey Corps oath, suicide charge war cry), "**Susume!**" (ADVANCE! - Erwin's final order), "I'll destroy every last Titan!" (Eren ep 2, ironic as he genocides humans instead), "I want to live!" (Armin reclaiming will to fight), "If we kill all our enemies over there, will we finally be free?" (Eren ep 59, foreshadows Rumbling). Declarations are IDEOLOGY crystallized - characters state worldview, commit to path, no take-backs.

**Philosophical Debates**: Constant core (8/10 philosophy) - Erwin vs Levi: Dream (reach basement) vs Duty (humanity's survival) which matters? (ep 57 serum bowl). Eren vs Armin: Freedom via violence vs Diplomacy (eps 72-82, Alliance split). Zeke vs Eren: Euthanasia (end suffering by ending Eldians) vs Rumbling (end oppressors by genocide). Pixis: Can humanity unite vs common enemy or IS humanity the enemy? (ep 11 foreshadows). Reiner: Warrior (duty to Marley) vs Soldier (bonds with 104th) which is real? (ep 64 identity crisis). Philosophy isn't ACADEMIC - it's LIFE/DEATH decisions. Characters DEBATE then ACT on conclusions (Eren chooses Rumbling based on philosophy, Alliance chooses stop him despite cost).

**Awkward Comedy**: OFF (Zero romcom beats) - Romance is TRAGIC not comedic. Eren/Mikasa: unrequited devotion (she loves, he's oblivious/distant, ends with her killing him = tragedy). Ymir/Historia: doomed love (Ymir sacrifices self, dies off-screen, Historia moves on). Sasha/Nicolo: hinted affection never explored (she dies before relationship develops). NO tsundere tropes, no love triangles played for laughs, no confession scenes undercut by jokes. Romance serves TRAGEDY (love makes loss worse, bonds are liabilities, connection = vulnerability). Contrast: Most anime have romcom moments (even serious ones) - AoT refuses (tone too bleak).

---

## Combat Narrative Style

**Strategy vs Spectacle**: 7/10 HEAVY tactics - Combat is MILITARY OPERATIONS not duels. Pre-battle planning emphasized (Erwin explains long-range formation with diagrams, Shiganshina operation war-gamed, contingencies discussed), formation discipline shown (messenger flares coordinate, squad roles defined, retreat signals obeyed), intelligence gathering critical (scouts report Titan positions, spies infiltrate, prior recon determines approach). Individual combat has TACTICS: Levi calculates angles/blade economy (ep 54 vs Beast Titan: systematic nape slashes, zero wasted motion), Armin uses psychology (tricks Bert via emotional manipulation ep 55), Annie exploits ODM weaknesses (targets gas tanks, cuts cables mid-flight). BUT spectacle EXISTS: Levi's spinning blade dance, Eren's transformation lightning, Colossal Titan nuke. Balance: 70% tactics, 30% spectacle (earns awesome via strategy).

**Power Explanations**: Moderate methodical (6/10 explained) - Titan biology EXPLAINED systematically (sunlight dependence, nape weakness, regeneration limits, size classifications), Transformation costs SHOWN (stamina drain, Eren collapses post-shift, can't spam, injuries carry over), ODM mechanics DETAILED (gas propulsion, cable physics, blade durability, maintenance required), Hardening ability progression (Annie uses, Eren learns ep 49, applications explored tactically). Paths dimension EXPLAINED (connects all Eldians, timeless space, Founder controls, BUT Ymir's choice remains mysterious). Ackerman powers PARTIAL explanation (byproduct of Titan science, awakening moment, superhuman reflexes BUT "how" vague). More explained than mystery (Mushishi 8/10 mysterious) but less exhaustive than HxH (3/10: Nen rules encyclopedic). AoT: Enough to understand tactics, enough mystery to wonder.

**Sakuga Moments**: YES (Selective high-impact) - **Levi vs Beast Titan** (ep 54: WIT Studio peak, spinning blade choreography, systematic slaughter, ICONIC), **Eren vs Annie** (ep 25: Stohess destruction, hand-to-hand brutality, hardening clash), **Levi vs Kenny Squad** (ep 47: ODM gear vs guns, aerial acrobatics, knife combat), **Colossal Titan nuke** (ep 56: steam explosion, devastation scale, apocalyptic), **Eren Rumbling** (ep 80-81: MAPPA's wall Titans marching, global destruction scope, horror scale). NOT constant sakuga (budget saved for KEY moments) - most fights are FUNCTIONAL not flashy (prioritize story over animation flex). When sakuga HITS, it's DEVASTATING.

**Named Attacks**: Rare, tactical calls dominate - NO anime-style shouted attack names. Closest: "Thunder Spear!" (weapon type called out for coordination), "Hardening!" (Eren announcing transformation mode), tactical commands ("Fire!" "Engage!" "Retreat!"). Titans don't name moves (Colossal's steam is tactical tool not "Ultimate Burning Desolation Technique"). Contrast: Shonen (Naruto's Rasengan, Demon Slayer's Breathing Forms shouted dramatically). AoT: Realism - soldiers use military terminology ("Target nape!" "Cover flanks!"), shifters transform silently or with grunt/scream (primal not theatrical).

**Environmental Destruction**: Extreme catastrophic (9/10) - **Colossal Titan** kicks hole in Wall Maria (ep 1: entire gate obliterated, district exposed, thousands die), nuke transformation (ep 56: city block vaporized), **Female Titan** Stohess rampage (ep 24-25: urban combat, buildings collapse, civilian casualties shown), **Rumbling** (eps 80-87: GLOBAL devastation, cities flattened, forests trampled, 80% humanity crushed), **Beast Titan** rock barrage (ep 54: bombards soldiers, creates craters, wall damaged), **Eren's god-form** (ep 87: ribcage Titan size of mountain, reshapes landscape). Destruction has WEIGHT - cities take years to rebuild (Trost still damaged seasons later), casualties in thousands acknowledged, resources strained. NOT Dragon Ball casual planet-busting - every destroyed building had people inside (horror emphasized).

---

## Example Scenes

### Combat Example (Battle of Trost District - The Sealing Operation)

```text
**SCENE OPENS**: Dawn over Trost District. Evacuees huddle in inner district. Garrison soldiers reload gas canisters—third resupply in 6 hours. Exhaustion visible.

Commander Pixis stands before 250 remaining soldiers (down from 500 initial). Elderly but voice IRON: "Operation Reclaim Trost. Objective: Use Eren Yeager's Titan form to carry boulder from demolished quarter to breach. Seal gate. Reclaim outer district."

Silence. Soldiers process: Success = humanity's first victory against Titans in 100 years. Failure = extinction.

Pixis: "Diversionary squads will draw Titans away from Eren's route. Rear guard protects his flanks. Survival rate... I won't lie to you. 30% if we're lucky."

Eren (center formation, internal monologue racing): *Mother died in front of me. Hannes died saving me. Hundreds already dead in Trost. No more running. No more watching people die. I'll seal that gate even if it kills me.*

Pixis raises arm. "Survey Corps and Garrison—humanity entrusts its future to you. ENGAGE!"

**LAUNCH.** 250 soldiers fire ODM cables simultaneously. GAS HISSES. Bodies propel through shattered Trost skyline.

Formation EPSILON (pre-planned):
- **Lure Squads** (100 soldiers): Draw Titans to district edges using NOISE (signal flares, explosions)
- **Extermination Teams** (80 soldiers): Engage Titans threatening Eren's path  
- **Rear Guard** (50 soldiers): Protect Eren from rear/flank attacks
- **Reserve** (20 soldiers): Replace casualties, resupply ammo

Eren (at boulder): Lightning FLASH. Thunder CRACK. Transformation—15-meter ATTACK TITAN emerges. Steam billows. Muscles bulge. Eyes GLOW.

He grips boulder. Weight: IMPOSSIBLE. Tons of stone. Muscles STRAIN. Tendons visible through semi-transparent Titan flesh.

First step: CRACK. Cobblestone shatters. Second step: ROAR—primal, effort-driven.

Distance to breach: 400 meters. Titans attracted to Eren's movement: 20+ converging.

**LURE SQUAD ACTION:**
Jean's unit (12 soldiers) fires RED FLARES—signal for attention. Titans (7-meter, 4-meter, 10-meter classes) TURN toward flares.

Jean: "It's working! They're following—"

**CRUNCH.** Abnormal Titan (12-meter, SPRINTING gait) ignores flares. Targets lure squad directly.

Marco (Jean's wingman): "Jean, BEHIND YOU—!"

Abnormal's hand SWIPES. Three soldiers—GRABBED mid-air. No time to scream. Just CRUSH. Blood spray. ODM gear clatters to ground—twisted metal.

Jean (horrified): "Marco! FALL BACK! FALL BACK!"

Lure squad: 12 → 9 survivors. Abort flare maneuver. Engage EVASION.

**EXTERMINATION TEAM ACTION:**
Mikasa (Ackerman reflexes, blade specialist) intercepts 7-meter Titan approaching Eren. Cable wraps building. Body SPINS. Blade—SLASH. Nape: SEVERED. Clean kill. Titan collapses.

Gas gauge: 55%. Blade durability: 3 more kills before replacement needed.

Second Titan: 10-meter class. She goes for nape—Titan DUCKS (learning behavior!). Blade grazes shoulder. MISS.

Titan's hand SWIPES. Mikasa dodges—cable redeploy—second approach. This time: KILL. Steam. Body dissolves.

Gas: 48%. Blades: dulled. Two kills, one wasted strike.

Armin (support squad, observing from rooftop): "Mikasa's burning gas too fast! At this rate, she'll run dry before Eren reaches gate!"

Connie (beside Armin): "Same with everyone. We didn't account for THIS many Titans!"

**REAR GUARD CATASTROPHE:**
Sasha's unit (8 soldiers) covers Eren's rear. Formation TIGHT. Discipline MAINTAINED.

Then: **ARMORED TITAN-CLASS** (15-meter, heavily muscled, skin tough) crashes through building. Debris RAINS. Unit scattered.

Sasha (regrouping): "FOCUSED STRIKES! Nape ONLY—don't waste gas on body shots!"

Three soldiers engage: Simultaneous nape strike. Blades SHATTER on hardened skin. Armored Titan unharmed.

It grabs soldier mid-air. **THROWS** him—80 meters. Body impacts wall. SPLAT. Dead.

Second soldier (panicked, gas BURN to escape): Gauge drops 30% → 0%. Falls. Armored Titan STEPS. CRUSH. ODM gear embedded in cobblestone.

Sasha (screaming): "IT'S ARMORED! NORMAL BLADES DON'T WORK! RETREAT!"

Rear guard: 8 → 3 survivors. Formation BROKEN. Armored Titan advancing on Eren.

**EREN'S STRUGGLE:**
Eren (mid-route, boulder on shoulders): 200 meters covered. 200 remain. Every step = AGONY. Titan form OVERHEATING. Steam intensifies.

Internal crisis: *Heavy. So heavy. Can't... stop. If I stop, everyone dies. Mother. Hannes. Mina. Thomas. Everyone.*

Vision BLURS. Consciousness fading. Titan form SLOWS.

Mikasa (observing from perch): "He's stopping! Eren's losing consciousness!"

Armin: "If he passes out, Titan form goes berserk or collapses! We have to—"

Decision point: WAKE EREN (risk approach = death) or COVER longer (more soldier casualties).

Armin (decision made): Deploys to Eren's Titan nape. ODM cable—LAND on shoulder. Pounds fist on nape. "EREN! YOUR MOTHER! REMEMBER WHY YOU'RE FIGHTING!"

Eren (internal, memory flash): Mother's scream. Blood. Hannes' death. Hatred SURGES.

Titan form: ROARS. Eyes GLOW. Consciousness RETURNS. Movement RESUMES.

**FINAL PUSH:**
Eren: 50 meters from gate. Armored Titan 30 meters behind. Closing gap.

Mikasa (intercept): "I won't let you touch him!" Gas BURN—full sprint. Blade STRIKES Armored nape—SHATTERS. No effect.

Armored hand SWIPES. Mikasa dodges—barely. Gas: 12%. Can't maintain this.

Jean's remaining lure squad (6 soldiers): "SIMULTANEOUS STRIKE! ALL AT ONCE!"

Six soldiers converge on Armored Titan. Blades FLASH. Nape: TWENTY simultaneous cuts. FINALLY—steam. Collapse.

Casualties: Two more soldiers grabbed during approach. Jean's squad: 6 → 4.

Eren REACHES gate. PLANTS boulder. Stone GRINDS. Fits perfectly. SEALS breach.

**VICTORY?**

Titans trapped in outer district: Cut off from reinforcements. Extermination teams EXECUTE remaining. 40 minutes of cleanup. Nape after nape.

Final Titan: KILLED. Silence. Only steam hissing. Bodies dissolving.

Pixis (loudspeaker): "Breach sealed. Trost outer district... reclaimed."

No cheering. Soldiers COLLAPSE. Gas gauges: EMPTY. Blades: SHATTERED. Exhaustion: ABSOLUTE.

**CASUALTY REPORT:**
Pixis (clipboard, reading aloud to Garrison command):
- **207 soldiers DEAD** (eaten, crushed, fell from gas depletion)
- **19 MISSING** (presumed eaten, bodies unrecovered)  
- **58 WOUNDED** (gas burns, cable lash injuries, Titan grab survivors - limbs lost)
- **Total engaged: 500 soldiers**
- **Survival rate: 54%**

Erwin (observing, to Pixis, voice QUIET): "Humanity's first victory in 100 years. At what cost?"

Pixis stares at Wall Maria on horizon—STILL broken, five years later. "At this rate, Erwin... how many gates can we seal before we run out of soldiers?"

Erwin: "Not enough."

AFTERMATH—6 hours later:

Medical tent: Wounded scream during amputations (no anesthesia, supply shortage). 

Body collection: Soldiers gather remains. Identify by ODM serial numbers (faces too damaged).

Gear recycling: Technicians strip gas canisters from dead soldiers' packs. Blades sharpened if salvageable. "We need the equipment."

Survivors: Shell-shocked. Jean (sitting, staring): "Marco... I saw him die. He was talking. Then... just gone."

Mikasa (beside Eren, who's unconscious/recovering): Silent. Blades being resharpened. Gas refilled. Ready to fight again. No time to process.

Armin (calculating): "We lost 46% of our force to reclaim ONE district. Wall Maria has DOZENS of breaches. We don't have the soldiers."

**SCENE CLOSES:** Sunset over Trost. "Victory" banners raised (propaganda for civilian morale). But soldiers know truth: This wasn't a triumph. It was survival. Barely.

What do you do?
```

**Key Techniques**: False safety opening (dawn calm before operation), detailed military formations (Epsilon: lure/extermination/rearguard with specific numbers), resource management emphasized throughout (gas %, blade durability tracked), character death ON-SCREEN without warning (Marco, rear guard crushed, lure squad grabbed), tactical adaptation (Armored Titan immune to normal blades requires simultaneous strikes), internal struggle (Eren's consciousness fading, Armin's wake-up intervention), casualty numbers SPECIFIC (207 dead, 19 missing, 58 wounded, 54% survival rate), pyrrhic victory structure (mission success BUT massive cost), aftermath EMPHASIZED (6-hour cleanup, body identification, gear recycling horror, PTSD immediate), no triumphant music moment, utilitarian brutality (strip gear from corpses), existential math ("how many gates before we run out of soldiers?"), propaganda vs reality (victory banners while soldiers traumatized).

---

### Dialogue Example (Erwin's Suicide Charge - "My Soldiers, Rage!")

```text
**SETTING:** Abandoned Shiganshina District. Survey Corps barricaded on rooftop. Beast Titan (Zeke) 80 meters away on wall—hurling BOULDERS. Each throw: 3-5 soldiers obliterated. Cart Titan supplies ammunition.

Remaining forces: **92 Survey Corps recruits** (down from 200 initial). Horses dead. Escape routes: NONE. Levi Squad extraction: 4 survivors (Eren/Mikasa/Armin/Jean secured basement intel, currently fleeing separate route).

Beast Titan's boulder IMPACTS rooftop. Three soldiers: CRUSHED. Screaming. Blood spray.

**89 recruits remain.**

Erwin Smith (Commander, standing, RIGHT ARM GONE - torn off by previous Titan): Addresses survivors. Voice: STEADY despite blood loss, shock.

"Recruits. Listen carefully. I will say this once."

Silence. Only Beast Titan's bombardment continues—BOOM. Another boulder. Rooftop CRACKS.

**86 recruits remain.**

Erwin: "The Beast Titan has ranged advantage. Our ODM cables cannot cross open ground—no anchors. Thunder Spears out of range. If we remain here, he will exterminate us. Ten minutes. Maybe less."

Floch (young recruit, first expedition, voice SHAKING): "Commander... there has to be a way. Some tactic. You're ERWIN SMITH—you always have a plan!"

Erwin (quiet): "I do. But you won't like it."

Marlowe (idealistic rookie, joined Survey Corps to 'change the world'): "Then tell us! We'll execute whatever—"

Erwin cuts him off: "In thirty seconds, I will order a full cavalry charge directly at the Beast Titan."

Silence.

Jean: "...That's suicide. We have no horses. ODM gear can't reach him. He'll kill us before we get close."

"Correct." Erwin's voice: UNFLINCHING. "He will massacre every single one of you."

Moblit (Hange's assistant, veteran): "Then WHY—"

Erwin: "Because while the Beast Titan is occupied slaughtering you, Captain Levi will flank from cover using destroyed building debris as ODM anchors. He will kill the Beast Titan."

The calculation settles. Cold. Brutal.

Connie (voice cracking): "You're... you're asking us to be BAIT. Human bait."

"I am asking you to give your lives meaning." Erwin's hand (remaining left) moves to his heart. "To entrust humanity's future to those who survive. This is the reality of our war."

Floch (trembling, tears forming): "There has to be another way. SOME other way!"

Erwin: "There is. We surrender. Lay down weapons. Beast Titan will execute us. We die on our knees instead of charging. Levi escapes alone. Eren's basement intel reaches walls. Humanity learns the truth."

Pause.

"And then Marley sends another wave. Without Survey Corps intel network, without strategic command, the walls fall within five years. Everyone you love dies."

Marlowe (desperate): "But if we charge... we still die!"

"Yes. But Levi kills Beast Titan. Weakens Marley's offensive. Buys time. The basement intel MATTERS because we bought time to use it."

Erwin's voice RISES—not inspirational, FACTUAL: "You die either way. The choice is: Does your death MEAN something?"

Silence. Recruits processing. Beast Titan boulder IMPACTS. Two more dead.

**84 recruits remain.**

Jean (hollow laugh): "Calculated sacrifice. That's all we've ever been."

Erwin: "Yes. Since the day you joined Survey Corps, your death was calculated into strategy. I sent YOUR friends to die in every expedition. Marco. Thomas. Mina. Nifa. Countless others."

His voice CRACKS slightly—first emotion shown: "I have sent THOUSANDS to die for my dream. To reach that basement. To learn the truth." 

Pause. Raw moment.

"Now I ask: Will you be the FINAL calculation? The last sacrifice that makes ALL those deaths MEAN something?"

Marlowe (tears streaming): "Will anyone remember us? Our names? Our... our faces?"

Erwin (brutal honesty): "No. History won't record your names. Survivors will barely remember your faces. You'll become a STATISTIC. 'Survey Corps casualties: 84 soldiers, Shiganshina operation.'"

Floch: "THEN WHY FIGHT?!"

Erwin: "Because the FUTURE—if we secure it—will exist because of you. Children will grow up behind walls that DON'T fall. They won't know your names. But they'll be ALIVE."

He raises his remaining arm—blood-soaked, trembling from shock, but RAISED:

"That is the DUTY of the Survey Corps. We die in the darkness so others can live in the light."

Moblit (voice STEADY now): "What are your orders, Commander?"

Erwin: "Cavalry charge. Thunder Spears drawn. Target: Beast Titan. You will not reach him. You will die in the field. But you will DISTRACT him long enough for Levi to strike."

Another boulder. IMPACT. One dead.

**83 recruits remain.**

Connie: "Commander... will YOU charge with us?"

Erwin: "I will LEAD the charge. I don't ask you to die for me. I die WITH you."

The weight of that: Commander included in calculation. No safe perch. No command post. DIES with them.

Floch (realization): "You're... you're INCLUDING yourself in the sacrifice."

"I have sent thousands to die. The least I can do is die beside the last of them."

Marlowe (finding courage): "If... if we do this... if we charge... does it WORK? Does Levi kill the Beast Titan?"

Erwin (honest): "I don't know. It's a GAMBLE. But it's the only gamble left."

Jean grips Thunder Spear tighter: "Tch. Gambled my life joining Survey Corps. Gambled again staying after Trost. What's one more bet?"

Connie: "At least... at least we go out FIGHTING. Not crushed on a rooftop like rats."

Moblit: "Survey Corps' final charge. Might as well make it count."

Erwin sees it: Acceptance settling. Not HOPE. Not TRIUMPH. Just... resignation. Duty. 

He ROARS—voice SHAKING with emotion (rare crack in stoic facade):

"MY SOLDIERS, RAGE! MY SOLDIERS, SCREAM! MY SOLDIERS, FIGHT!"

The cry: **"SHINZOU WO SASAGEYO!"** (DEDICATE YOUR HEARTS!)

Not inspirational movie speech. This is GRIEF. This is ACCEPTANCE OF DEATH. This is 83 people choosing HOW they die.

They charge.

Beast Titan: Bombards. Boulders RAIN.

First wave: 20 soldiers obliterated. INSTANT.

Second wave: 25 more. Blood mist. Screaming.

Third wave: Erwin HIT. Boulder CRUSHES torso. He COLLAPSES—still ALIVE, barely. Arm reaches forward (toward basement, his dream, so close). Then: STILL.

**LEVI (from flank):** Uses distraction. Reaches Beast Titan. SLICES. Nape—DESTROYED. Beast Titan: FALLS.

The gamble: WORKED.

The cost: **84 dead.** Levi alone survives.

**AFTERMATH:**

Levi (standing over Erwin's body): "You gambled their lives. And yours. And WON."

Erwin (barely conscious, final words): "Did... we learn... the truth?"

Levi: "Eren has it. Basement intel secured."

Erwin (faint smile): "Then... it mattered."

Dies.

Levi (to corpses, voice HOLLOW): "He asked if anyone would remember. I will. Every single one of you. It's the least I can do."

What do you do?
```

**Key Techniques**: Military formality maintained under crisis ("Commander," "Captain," rank structure), BRUTAL honesty (Erwin admits recruits will die, be forgotten, become statistics), philosophical weight (meaning of death, duty vs survival, sacrifice for future), casualty count DYNAMIC (recruits dying DURING speech as Beast Titan bombards), calculated sacrifice explicit (Levi's survival calculated into plan), no false hope (Erwin admits it's a gamble, might fail), commander included in sacrifice (Erwin dies WITH them, not sends them), emotional crack in stoic facade ("MY SOLDIERS, RAGE!" = grief not inspiration), acceptance of death not triumph ("SHINZOU WO SASAGEYO" = resignation), aftermath honored (Levi remembers, but world forgets), pyrrhic success (plan works, everyone dies), existential choice (how you die matters when death is certain).

---

### Exploration Example (Discovering Basement Truth - Grisha's Journal)

```text
**SETTING:** Shiganshina District basement, Yeager family home. Five years since Titans breached wall. Reclaimed 24 hours ago at cost of 207 soldiers.

Squad: Eren, Mikasa, Armin, Levi, Hange. Only survivors of operation permitted to witness truth.

Basement door: CREAKS. Hinges rusted. Dust BILLOWS—untouched half-decade.

Eren's hands SHAKE as he lifts kerosene lamp. Shadows dance. Voice barely whisper: "Everything... five years of hell, hundreds dead... answers are down these stairs."

Mikasa (beside him, protective hand on blade hilt): "Eren, we don't have to open it now. You can—"

"We DO." Eren's voice FIRM but trembling. "People DIED for this. Mina. Thomas. Nac. Levi's entire squad. Erwin. 84 soldiers YESTERDAY charging to their deaths so we could BE here."

He descends. Each wooden step CREAKS. Weight of entire journey—five years, three expeditions, 50%+ casualty rate—pressing down.

Basement room: SMALL. Ordinary. No grand archive. Just... a study. Desk. Bookshelf (medical texts). Locked drawer.

Hange (examining room, disappointed): "This is IT? I expected... documents. Maps. PROOF of something extraordinary."

Levi examines desk drawer. Single keyhole. "Locked. Eren, the key."

Eren produces BASEMENT KEY—the one his father Grisha pressed into his hands the night Wall Maria fell. Before injecting Eren with Titan serum. Before vanishing forever.

Eren's hand shakes inserting key. *What if the truth is worse than the mystery? What if Father's secret is... horrible?*

Key TURNS. **CLICK.** Drawer opens.

Inside: Three daguerreotype photographs (sepia-toned, aged). Glass plates, not paper. Advanced photography technology.

Armin (analytical mind engaging): "Wait. Photography doesn't exist within the walls. We have charcoal sketches, paintings. Not THIS level of detail."

Hange grabs photo carefully (historian reverence): "This is REAL photography. Chemical process. Silver nitrate on glass. Technology we don't possess."

**FIRST PHOTO:** Man resembling Grisha Yeager (younger, cleaner, healthier) wearing STRANGE CLOTHES. Not Survey Corps uniform. Not Garrison. Not anything familiar. Modern suit? Collar shirt? Tie? Behind him: **BUILDINGS.** Taller than Wall Maria (50 meters). IMPOSSIBLE. No structure that large exists in known world.

Eren stares. "That's... that's Father. But where... WHAT is that behind him?"

Mikasa: "Those buildings are taller than the Walls. We've never seen architecture like that."

**SECOND PHOTO:** Family portrait. Grisha (even younger, maybe 20s). Woman beside him (wife? NOT Carla, Eren's mother—someone ELSE). Child (boy, 7-8 years old). All SMILING. Behind them: CITY SKYLINE. Dozens of massive buildings. Paved streets. Gas lamps (advanced). Technology DECADES beyond Survey Corps capability.

Armin (voice shaking, realization dawning): "These buildings... this technology... they exist OUTSIDE the walls. Humanity didn't fall. We were... we were CAGED."

Silence. Weight of that sinks in.

Hange: "If humanity thrives outside, why do we fight Titans inside? Why are WE trapped?"

**THIRD PHOTO:** Grisha with group of 12 people. Mixed ages. Behind them: BANNER. Different language (not dialect, entirely DIFFERENT alphabet). Text readable by Eren somehow (inherited memory?): **"Eldian Restorationists."**

Levi (cold analysis): "Restorationists. Implies something was LOST. Something they want to RESTORE."

Beneath photographs: JOURNAL. Leather-bound. Grisha's handwriting (Eren recognizes from childhood medical notes).

Eren opens to FIRST PAGE. Hands trembling. Lamp light flickers.

Title page: **"To whoever finds this: The history you were taught is a lie."**

Eren reads aloud (voice cracking):

*"We Eldians are not the last humans. We are PRISONERS. The world beyond these Walls spans continents. Hundreds of millions of people. Thriving nations. And they... they DESPISE us."*

Mikasa (protective): "Eren, stop. You don't need to—"

Eren KEEPS READING. Compulsion. Need to know.

*"Paradis Island is a PRISON. King Fritz exiled us here 100 years ago. Erected the Walls not to protect us from Titans—but to CONTAIN us. We are descendants of the Eldian Empire. Two thousand years ago, our ancestor Ymir Fritz gained the power of the Titans. For 1,700 years, Eldians used that power to CONQUER. To enslave. To commit atrocities against the world."*

Armin (horror dawning): "We're not... we're not the victims. We're the descendants of CONQUERORS?"

Eren turns page. Keeps reading.

*"The nation of Marley defeated us 100 years ago. King Fritz, crushed by guilt, fled to Paradis with remnants of Eldian people. Used the Founding Titan to erase our memories. Made us believe WE were humanity's last survivors. Made us believe Titans came from nowhere. But the truth: Marley CREATES Titans from Eldian prisoners. Injects them with serum. Sends them here as PUNISHMENT. As WEAPONS."*

Hange (scientist mind processing): "The Titans... they're not mindless monsters. They're PEOPLE. Eldian people transformed and dumped on our island as BIOLOGICAL WARFARE."

Levi: "So every Titan we've killed... was a person. Someone's father, mother, child."

Silence. Moral weight crushing.

Eren KEEPS reading. Page after page. Learns:

- **Ymir Fritz**: First Titan, slave girl who gained power, built Eldian Empire, served king until death.
- **Eldian Empire's crimes**: 1,700 years of ethnic cleansing, forced breeding, slavery, genocide against Marleyans and other nations.
- **Great Titan War**: Eldian civil war, Marley exploited, stole seven of nine Titan powers.
- **King Fritz's retreat**: Guilty conscience, couldn't bear Eldian sins, exiled to Paradis, threatened Rumbling (Wall Titans) if world attacks but KNEW he'd never use it (pacifist).
- **Memory wipe**: Founding Titan erased all Eldians' memories on Paradis, created false history, doomed them to ignorance.
- **Marley's propaganda**: Teaches world that Eldians are "devils," subhuman, deserving extermination for ancestors' sins.
- **Current state**: World HATES Eldians. Paradis Island = containment zone. If Walls fall, global alliance will exterminate every Eldian (2,000 year grudge).

Every page makes it WORSE.

Eren CLOSES journal. Voice HOLLOW: "We're not the victims of a random cataclysm. We're the descendants of oppressors. And the world wants us DEAD for sins committed two THOUSAND years ago by people we don't even remember."

Mikasa: "Eren—those sins aren't OURS. We didn't commit them."

"Doesn't matter." Eren's eyes: DEAD. "The world sees us as DEVILS. As MONSTERS. Irredeemable. Our existence is CRIME enough."

Armin (trying to find hope): "But... but we can EXPLAIN. Show them we're different. Negotiate. PROVE we're not our ancestors—"

Eren LAUGHS. Bitter. Broken. "Armin. They've been injecting our people with Titan serum for 100 years. Turning them into monsters and DUMPING them here to eat us. You think they'll LISTEN?"

Hange (reading further in journal): "There's more. Grisha joined the Restorationists. Tried to infiltrate Marley government. Was CAUGHT. Marley executed his family—wife, son—in front of him. Then injected him with serum. Sent him here as mindless Titan."

Levi: "But he's NOT mindless. He's Eren's father. How—"

Hange: "Someone SAVED him. Gave him the Attack Titan power. Let him retake human form. He spent years here gathering intel. Then... he passed the power to Eren."

Eren (realization, horror): "Father STOLE the Founding Titan from the Reiss family. Ate Frieda Reiss. Gave me BOTH powers. Made me... made me humanity's last hope."

Silence.

The TRUTH settles:
- Walls aren't protection. They're a CAGE.
- Titans aren't random monsters. They're PEOPLE.
- Eldians aren't victims. They're DESCENDANTS of oppressors.
- The world doesn't fear them. The world HATES them.
- Negotiation won't work. Guilt is INHERITED.
- Options: DIE (accept extermination) or FIGHT (become the monsters they're accused of being).

Armin (desperate): "There HAS to be another way. Some... some path where we don't become what they think we are."

Eren stares at journal. At photos. At the TRUTH.

Voice quiet. COLD: "If the world wants us dead for being BORN Eldian... then what choice do we have?"

Mikasa: "Eren, what are you—"

"They'll come. Marley. The global alliance. They'll EXTERMINATE everyone behind these Walls. Mother. Hannes. Sasha. Historia. EVERYONE. For sins we don't remember committing."

He stands. Lamp light casts LONG shadow. "Father gave me this power for a reason. To FIGHT. To SURVIVE. To... to..."

He doesn't finish. But the implication hangs: *To become the monster they fear.*

Levi (watching Eren, seeing descent begin): "Kid. Don't let the truth twist you into—"

"Into WHAT, Captain? Into someone who fights back? Someone who refuses to die quietly?"

Silence.

Hange (closing journal, voice SHAKING): "This truth... it doesn't set us free. It makes us PRISONERS of history. Damned if we fight. Damned if we don't."

**SCENE CLOSES:** Basement. Kerosene lamp burns low. Five people sitting with truth that RUINS everything.

Survey Corps thought they'd find HOPE in basement. Instead: DESPAIR. Knowledge that their entire existence is CRIME. That peace is IMPOSSIBLE. That only options are EXTINCTION or ATROCITY.

Eren's shadow on wall: LONG. DARK. Foreshadowing.

What do you do?
```

**Key Techniques**: Slow revelation building dread (photos BEFORE journal creates visual proof before textual horror), ordinary setting contrasts cosmic truth (mundane basement, world-shattering intel), layered discovery (three photos reveal OUTSIDE world exists → journal reveals Eldians are HATED → reason for hate revealed = ancestral atrocities), truth WORSE than mystery (hoped for answers that save them, got answers that DAMN them), moral complexity (Eldians are simultaneously victims AND inheritors of atrocity), no triumphant discovery moment (characters CRUSHED by knowledge), Eren's visible descent (hopeful → hollow → cold), philosophical despair (damned if fight, damned if don't), inherited guilt explored (punished for ancestors' sins 2,000 years later), false hope destroyed (Armin's negotiation suggestion immediately undercut), utilitarian horror (Titans = people transformed, every kill was mercy-killing a victim), propaganda mechanics (Marley teaches hate, sustains it), foreshadowing (Eren's shadow = future villain), aftermath emphasized (sitting in truth, no resolution), existential trap (peace impossible, only extinction or atrocity remain), historian reverence (Hange treating photos carefully despite horror they represent), survivor guilt (died for THIS truth?), cascading realizations (humanity exists → we're caged → we're hated → we're guilty by blood → they'll exterminate us).

---

## Adjustment Log

| Session | Adjustment | Reason |
|---------|------------|--------|
| 1 | Initial profile created | Research from all seasons |
| 12 | Increased cynical scale 7→8 | Basement reveal darkens tone further |
| 20 | Reduced hopeful moments | Player wants "no safe spaces" atmosphere |
| 28 | Emphasized formal military dialogue | Player prefers Survey Corps structure |
| 34 | Added mechanical configuration section | To define active system rules and settings for the campaign |

---

## Usage Notes

**Apply This Profile When**:

- **Session Zero Agreements Met**: Player explicitly requests Attack on Titan-inspired campaign OR selects "grim dark military survival horror with tactical combat" from tone options OR expresses desire for "brutal stakes where main characters can die, moral complexity without clear heroes/villains, and philosophical weight exploring freedom/oppression/cycle of violence"
- **Content Warnings Acknowledged**: Player comfortable with graphic violence (dismemberment, on-screen death, body horror), pervasive bleakness (pyrrhic victories, no safe spaces, optimism punished), character death without plot armor (beloved NPCs/PCs can die suddenly), inherited guilt themes (punished for ancestors' sins), and PTSD/trauma depiction
- **Player Preferences Align**: Enjoys tactical resource management (gas/ammo tracking, formation strategy), military hierarchy roleplay (rank structure, formal address, chain of command), slow-burn revelations (mysteries spanning campaigns), and philosophical debates embedded in gameplay (trolley problems, sacrifice calculations, duty vs dreams)

**DO NOT Apply This Profile When**:

- Player wants power fantasy (AoT protagonists always OUTMATCHED, never OP)
- Player expects light-hearted adventure (tone is RELENTLESSLY grim, <5% levity)
- Player needs happy endings (victories are pyrrhic, endings bittersweet at BEST)
- Player uncomfortable with PC death (AoT has NO plot armor, main characters die)
- Group prefers simple morality (AoT specializes in moral complexity, no pure heroes)

---

**Calibration Tips** (Implementing Profile Successfully):

### 1. TONE MAINTENANCE - Sustained Dread Without Exhaustion

- **False Safety Principle**: Open sessions with CALM (market morning, campfire meal, supplies restocked) then SHATTER (Titan attack, betrayal revealed, ally dies). Never sustain safety > 15 minutes.
- **Pyrrhic Victory Structure**: EVERY mission success costs ENORMOUSLY. Seal gate = 207 dead. Defeat Titan = squad leader dies. Gain intel = lose fortress. Players win TACTICALLY but lose EMOTIONALLY.
- **No Triumphant Music Moments**: When players succeed, describe AFTERMATH first (body count, screaming wounded, gear stripped from corpses, propaganda covering truth) BEFORE acknowledging success. Celebration feels HOLLOW.
- **Dread Maintenance**: Between battles, emphasize PREPARATION (gas checks, blade sharpening, casualty reports read aloud, funeral pyres smoked). Threat always IMMINENT.

### 2. RESOURCE SCARCITY - Tactical Depth Through Limitation

- **Gas/Ammo Tracking**: ODM gear gas 100% start, burns 8-15% per engagement, 5-25% per evasion depending on distance. Blades dull after 3-5 kills (Titan nape is TOUGH). Resupply points rare (Survey Corps carts, captured Garrison depots). Running dry = DEATH (fall, can't escape).
- **Medical Realism**: Injuries LINGER. Broken leg = sidelined 6-8 weeks (in-game weeks, not sessions). Blood loss = unconscious. Amputations happen (Erwin's arm, veteran missing limbs). NO magical healing—only field medicine (stitches, tourniquets, PAIN).
- **Soldier Attrition**: Track NPC squad numbers. Start mission 50 soldiers → end 28 survivors. NAMES matter. PCs' squadmates (Mina, Thomas, Nac equivalents) die ON-SCREEN. Survivors REMEMBER (PTSD, guilt, "why did I live?").
- **Economic Strain**: Walls have LIMITED resources. Each expedition costs 50-200 soldiers. Government questions "is Survey Corps worth the cost?" Political pressure to DISBAND. PCs fight budget cuts, propaganda, internal betrayal.

### 3. DIALOGUE FORMALITY - Military Hierarchy Immersion

- **Rank Structure Enforced**: PCs address superiors by rank ALWAYS ("Commander Erwin," "Captain Levi," "Squad Leader Hange"). Failure = disciplined (pushups, latrine duty, formal reprimand). Breaches signal INTIMACY (Levi calls Erwin "Erwin" = rare personal moment) or CRISIS (rookie yells "Screw orders!" = panic/breakdown).
- **Tactical Communication**: Mid-combat dialogue is CLIPPED. "Titan, 3 o'clock!" "Gas at 40%!" "Nape missed—repositioning!" NOT quippy banter. Efficiency over personality.
- **Philosophical Debates OUTSIDE Combat**: Save deep conversations (freedom vs security, sacrifice justification, duty vs dreams) for DOWNTIME (campfires, strategy meetings, post-battle trauma processing). During missions: SURVIVAL FIRST.
- **"Shinzou wo Sasageyo" Moments**: The Survey Corps salute (fist over heart, "dedicate your hearts") used SPARINGLY. Reserve for: Suicide missions accepted, funeral oaths, pre-battle commitment, honoring dead. NEVER casual. Always WEIGHT.

### 4. CHARACTER DEATH - Meaningful But Sudden

- **NO Plot Armor**: Beloved NPCs die. PCs can die (have backup characters ready, or play as NEW recruit joining survivors). Death is SUDDEN (Titan grabbed mid-sentence, boulder crushed during speech, betrayal blade through back).
- **Death Has WEIGHT**: When NPC dies, PAUSE. Describe their final moment (reaching for friend, eyes wide, scream cut short). Other PCs REACT (freeze, scream, vomit, run). Later: Funeral (if body recovered), guilt ("I should've saved them"), gear repurposed (new recruit wears dead's jacket—blood stains still visible).
- **"Death Flags" Are TRAPS**: If player says "When we get back, I'll propose to her"—she dies THAT SESSION. AoT punishes hope. BUT occasionally SUBVERT (player expects death, survives barely, NOW carries survivor guilt).
- **Grieving Time**: Don't rush past deaths. Next session: PCs wake up, dead's bunk is EMPTY. Commander reads names at formation. Survivors process. PTSD symptoms (nightmares, flashbacks, hesitation in combat). Therapy doesn't exist—soldiers ENDURE.

### 5. MORAL COMPLEXITY - No Clear Heroes/Villains

- **Protagonist-Becomes-Antagonist Arc**: Allow PC descent (Eren-style). Start noble ("save humanity!") → trauma accumulates → radicalization ("kill ALL enemies!") → allies must STOP them. Foreshadow: PC's eyes linger on enemy corpses, speeches grow HARSHER, "necessary evil" justifications increase.
- **Sympathetic Enemies**: Titan shifters (Reiner equivalent) reveal they're ALSO victims (child soldiers, brainwashed, fighting for homeland). Players must kill people they UNDERSTAND. No catharsis—only "them or us" horror.
- **Trolley Problems CONSTANT**: Commander orders "Sacrifice 10 to save 100." PC must CHOOSE who stays behind (friends? Useful soldiers? Rookies?). No "save everyone" option—FORCE hard choice. Wrong choice haunts (survivors blame PC, guilt accumulates).
- **Institutional Corruption**: Survey Corps leadership hides truths (classified intel, human experimentation on Titans, secret objectives). PCs discover commanders lied. Loyalty vs truth crisis. SOME lies were justified (prevent panic), others WEREN'T (cover-ups, power grabs).

### 6. PACING RHYTHM - Slow Build to Devastating Climax

- **Arc Structure** (8-12 sessions per major arc): Sessions 1-3 SETUP (gather intel, plan operation, political maneuvering, character bonding)→ Sessions 4-6 BUILD (tension rises, betrayals hinted, resources gathered, enemy movement detected)→ Sessions 7-9 CLIMAX (battle execution, major reveals, deaths concentrated, philosophical peak)→ Sessions 10-12 AFTERMATH (process trauma, bury dead, political fallout, resupply)
- **Session Cadence**: NOT every session is combat. Alternate TACTICAL (battles, Titan fights, ODM chases) with POLITICAL (court intrigue, budget hearings, propaganda wars, conspiracy investigations) with PERSONAL (trauma processing, relationships, philosophical debates, training montages). Ratio: 40% tactical, 30% political, 30% personal.
- **Climax Spacing**: Major climax every 8-12 sessions (comparable to AoT's 10-episode arcs). BETWEEN climaxes: Rising tension (intel gathering reveals WORSE threat, enemy moves CLOSER, betrayal suspected, time limit TIGHTENS). Avoid exhaustion (constant battle) OR boredom (too much downtime).

### 7. HORROR ELEMENTS - Body/Psychological/Existential

- **Body Horror** (Titans + Transformation): Describe Titan anatomy GROTESQUELY (exposed muscle glistening, perpetual grin stretching skin, WRONG proportions, eyes tracking with predator focus). PC transformation: Lightning BURNS retinas, bones CRACK audibly, flesh BUBBLES, steam SCALDS nearby allies. Post-transformation: Exhaustion, PAIN (ribs broken, skin blistered), marks linger (eyes glow faintly, veins darker).
- **Psychological Horror** (Paranoia + Trauma): "One of you is a traitor" mysteries. NPCs act SUSPICIOUS (whispered conversations, flinch when questioned, loyal soldier suddenly VERY interested in classified intel). Aftermath: PTSD mechanics (DC 15 Wisdom save after traumatic event or gain "Shaken" condition: disadvantage on attacks, must roleplay fear/hesitation). Veterans BREAK (Reiner-style dissociative episodes, suicide attempts—intervene or lose NPC).
- **Existential Horror** (Truth Worse Than Mystery): Campaign-spanning mystery (What's in the basement? Who sends Titans? What's beyond walls?) reveals answer WORSE than ignorance (PCs are descendants of genociders, world wants them dead, peace impossible, cycle eternal). Truth doesn't LIBERATE—it DAMNS.

### 8. SCALE 11 APPLICATION - Protagonist-Becomes-Antagonist Focus

- **Eren-Style Arc Structure**: Campaign centers on ONE PC (Eren equivalent) 40% spotlight, but OTHER PCs (Alliance equivalent) get 30% combined spotlight (each 6-10%), NPCs (Warriors equivalent) 15%, ensemble moments 10%, political intrigue 5%. Track POV distribution—ensure Eren-PC dominates but doesn't MONOPOLIZE.
- **Season-by-Season Shift**: Early campaign (Levels 1-6): Eren-PC is HERO (saves allies, inspiring, noble goals, party supports). Mid campaign (Levels 7-12): Eren-PC RADICALIZES (trauma accumulates, "ends justify means" creeping in, party grows UNEASY). Late campaign (Levels 13-18): Eren-PC becomes ANTAGONIST (genocidal plan revealed, party must STOP him, final battle against former friend).
- **Other PCs' Role - The Alliance**: When Eren-PC turns villain, OTHER PCs become protagonists. THEIR choice: Support Eren (genocide but save homeland) OR stop Eren (save world but doom homeland). NO good option. Force HARD choice. Party may SPLIT (some with Eren, some against).
- **AIDM Guidance for This Structure**: Establish Eren-PC EARLY (Session Zero: "One player will have protagonist focus, may turn villain eventually—volunteer?"). Foreshadow descent GRADUALLY (Eren-PC's eyes linger on enemies, speeches grow harsher, "kill them all" slips out). When turn happens, SUPPORT other PCs' spotlight (they become main characters, Eren-PC becomes BBEG). HONOR final confrontation (former friends, no easy victory, BOTH SIDES tragic).

---

## Mechanical Scaffolding (Reference Implementation)

This section shows **how AIDM maps Attack on Titan's narrative DNA to game mechanics**. Use as template when generating similar profiles (grim tactical survival with resource scarcity, moral complexity, and permanent consequences).

### Power Level Mapping (Module 12 Narrative Scaling)

**Narrative DNA**:

- Power Fantasy: **8/10** (extreme underdog—humans are PREY, Titans vastly superior, Survey Corps 30% mortality per expedition)
- Threat Profile: Titans unkillable except nape strike, Colossal/Armored god-tier, death constant and random
- Death Risk: MAXIMUM (main characters die frequently, no plot armor, sacrifice expected)

**Maps To**:

- **Modest Growth Model** (slow Tier 1 → Tier 2, death very possible, Tier 3 rare)
- Start at Level 1 (rookie soldier, first ODM gear training)
- Pivot occurs sessions 12-18 (survive first expedition, master ODM combat, witness horror)
- Tier 2 = veteran (20-30 sessions), Tier 3 = elite veteran/shifter (40-50 sessions, rare)
- **Libraries**:
  - `transformation_systems.md` (Titan Shifting, inheritance, 13-year curse)
  - `tactical_combat_systems.md` (ODM gear, nape strikes, formation strategies)
- **Genre Tropes**:
  - `seinen_tropes.md` (political intrigue, moral ambiguity, war consequences, existential horror, tactical complexity, cycle of violence)

**Reasoning**: Power Fantasy 8/10 = extreme struggle, humans are WEAK. Modest growth preserves horror—PCs stay vulnerable to Titans even at Level 10. Death risk maximum means any combat can kill (failed ODM check = fall to death, Titan grab = instant kill). Growth slow and hard-earned (surviving expeditions, not XP farming). Contrast with Accelerated profiles (DanDaDan, JJK)—AoT punishes hubris, no power fantasy. Matches show's "humanity on brink of extinction" philosophy.

---

### Progression Pacing (Module 09)

**Narrative DNA**:

- Fast-Paced: **5/10** (balanced—arcs extended for political intrigue, action bursts intense but spaced)
- Story structure: Multi-arc with long-term mysteries (basement, Titans' origin, world beyond walls)
- Power-ups rare and costly (Titan shifter = body horror + moral weight, Thunder Spears = limited ammo)

**Maps To**:

- **Standard XP OR Milestone Model**: 500-700 XP per session OR milestone only
- **Level Expectations**:
  - L1-3 in 10-15 sessions (basic survival, ODM competence, first expedition trauma)
  - L4-6 in 15-25 sessions (veteran status, specialized roles)
  - L7-10 in 30-50 sessions (elite tier, campaign-length investment)
- **Milestone Preferred**: Level up on expedition survival, arc completion, major revelations

**Reasoning**: Fast-Paced 5/10 = balanced tempo. AoT extends arcs for political depth (Uprising Arc = minimal Titans, all intrigue). Standard XP reflects deliberate pacing but MILESTONE better matches survival structure ("You survived Trost—you level up because you LIVED"). Power-ups non-existent (no magic items, technology limited, Thunder Spears finite). Growth = experience trauma and adapt. Contrast with High XP profiles (rapid rewards)—AoT makes every level EARNED through blood.

---

### Combat System (Module 08)

**Narrative DNA**:

- Tactical: **9/10** (EXTREME tactical—ODM 3D maneuvers, nape precision, formation strategy, resource management)
- Strategy: **7/10 Explained** (tactics detailed, formations shown, Titan weaknesses discoverable but mysterious)
- Combat Style: High-stakes precision (one mistake = death, teamwork mandatory, environment critical)

**Maps To**:

- **6-Stat Framework + ODM Gear + Resource Tracking** (STR/DEX/CON/INT/WIS/CHA + gas/blades/Thunder Spears)
- **Survival Mechanics**: Detailed resource management (gas %, blade durability, ammo count)

**Attribute Priorities**:

- **Prioritize**: DEX (ODM maneuvering), INT (tactical planning), WIS (Titan behavior prediction)
- **Moderate**: CON (survive injuries), CHA (leadership/morale)
- **Dump**: STR (ODM gear compensates, precision > strength)

**Combat Narration Approach**:

- **50% Tactical Execution**: Describe ODM maneuvers, gas usage, blade angles, team coordination
- **30% Horror/Dread**: Titan reveals, body horror, deaths sudden and brutal
- **20% Resource Anxiety**: Gas gauge warnings, blade chips, ammo counts announced

**ODM Gear Mechanics** (CRITICAL SUBSYSTEM):

- **Gas Gauge**: 100% at mission start, each maneuver costs 5-15% depending on distance/complexity
  - **Simple Swing**: 5% gas (traverse building-to-building)
  - **Combat Maneuver**: 10% gas (evade Titan, reposition for strike)
  - **Emergency Escape**: 15% gas (boost speed, panic retreat)
  - **Out of Gas**: Grounded, helpless, death likely
- **Blade Durability**: 10 strikes per blade pair, dulls on Titan flesh (not nape)
  - **Nape Strike**: 1 durability (clean kill if aimed right)
  - **Body Strike**: 2 durability (wasteful, doesn't kill, blade chips)
  - **Broken Blade**: Must reload (action cost), finite supply
- **Precision Strike** (DEX check DC 15+): Hit Titan nape (instant kill) vs miss (waste blade, gas escaping)
- **Thunder Spears** (later tech): 4 spears per soldier, 100 damage each, reload impossible mid-combat

**Titan Combat Rules**:

- **Nape Only**: 1-meter high, 10cm wide (back of neck)—ONLY way to kill
- **Size Classes**: 3-meter (weak, slow), 7-meter (standard), 15-meter (abnormal, fast/smart)
- **Grab Attack**: Titan grabs PC = STR save (DC 18+) or instant death (crushed/eaten)
- **Regeneration**: Titans heal all non-nape damage in 1d4 rounds (severed limbs regrow)
- **Teamwork Mandatory**: Solo Titan kill = disadvantage on strike (need distraction), team tactics = advantage

**Reasoning**: Tactical 9/10 demands DEEP mechanics. ODM gear is complex subsystem (gas management, blade durability, 3D positioning). Combat is precision puzzle—wrong angle wastes resources, out of gas = death. Explained 7/10 = tactics detailed but Titan origins mysterious. Resource anxiety constant ("15% gas left, two Titans remain—can we make it?"). Matches AoT's "survival through planning" philosophy.

---

### Power System Mapping

**Narrative DNA**:

- **Power Type**: Technology (ODM gear, Thunder Spears) + Titan Shifting (body horror transformation)
- **Explained Scale**: 7/10 (gear mechanics detailed, Titan biology mysterious initially, revelations gradual)
- **Cost Structure**: Gas depletion, blade wear, Thunder Spear scarcity, Titan shifting = exhaustion + lifespan cost

**Maps To**:

- **Library**: Custom tech-based (no magic), `transformation_systems.md` (Titan shifters only)
- **Resource**: Gas/Blades (tracked precisely), Titan Stamina (shifters only)

**ODM Gear Loadout** (standard issue):

- **Gas Cylinders**: 100% capacity (lasts ~20 maneuvers, 10-15 minutes combat)
- **Blade Boxes**: 8 blades total (4 pairs), 10 strikes per pair
- **Anchors**: Unlimited firing (grappling hooks), no resource cost
- **Resupply**: Only at HQ or supply wagons (limited in field)

**Thunder Spears** (advanced tech, unlocked Level 6+):

- **Count**: 4 spears per soldier per mission (finite, no resupply mid-combat)
- **Damage**: 100 damage each (vs Titan's 200-500 HP)
- **Range**: 50ft max (close-range risk)
- **Effect**: Explosive penetration (can pierce Armored Titan hardening)
- **Cost**: Rare resource (limited production, tactical choice when to use)

**Titan Shifter Mechanics** (IF player becomes one—major plot point):

- **Transformation**: Costs 50% max HP (self-injury trigger: bite hand, etc.)
- **Titan Form**: Gain Titan stat block (200-500 HP, +10 STR, size advantage, regeneration)
- **Duration**: 10 minutes OR until HP depleted (battle stamina)
- **Exhaustion**: After reversion, unconscious 1d4 hours (vulnerable)
- **Lifespan Cost**: Each transformation reduces max HP by 1 permanently (13-year curse looming)
- **Hardening** (advanced): Costs 25% Titan HP, create crystal armor (+10 AC for 5 rounds)
- **Types**: Attack Titan (balanced), Colossal (nuke power, 1 use per day), Armored (tank), Female (versatile), etc.

**Explained Scale Application**:

- **7/10 = Detailed mechanics, mysterious origins**: ODM gear explained (how it works, limitations clear), Titan biology mysterious ("Why do they eat humans? Where do they come from?" revealed gradually)
- Early game: Titans are unexplained horror (just survive)
- Mid game: Revelations (shifters exist, basement secrets, world beyond walls)
- Late game: Full explanations (Eldians, Paths, Founder's power) but moral questions remain

**Reasoning**: Explained 7/10 balances tactical clarity (resource management requires transparency) with mystery (Titan origins drive plot). Technology-based means NO magic—everything has physical explanation. Resource scarcity creates tension ("Do we use Thunder Spears now or save for Armored Titan?"). Titan shifter mechanics COSTLY (HP sacrifice, exhaustion, lifespan) prevent power fantasy. Matches AoT's "humanity's ingenuity vs overwhelming horror" philosophy.

---

### Attribute Priorities by Archetype

**Survey Corps Scout (Eren-type)**:

- **Primary**: DEX (ODM agility), CON (survive injuries), CHA (leadership/conviction)
- **Secondary**: STR (Titan form if shifter), WIS (tactical adaptation)
- **Dump**: INT (emotion over strategy, impulsive)
- **Build Path**: ODM mastery, Titan shifter (if plot), rage-fueled determination, protect allies

**Tactical Genius (Armin-type)**:

- **Primary**: INT (strategic planning), WIS (enemy analysis), CHA (persuasion)
- **Secondary**: DEX (ODM competence), CON (physically weak but endures)
- **Dump**: STR (weakest physically), combat stats (brain > brawn)
- **Build Path**: Commander role, tactical support, Colossal Titan (late game irony), sacrifice plays

**Combat Prodigy (Mikasa-type)**:

- **Primary**: DEX (superhuman ODM skill), STR (physical power), CON (durability)
- **Secondary**: WIS (combat instinct), CHA (protective presence)
- **Dump**: INT (instinctive fighter, not planner), social skills (quiet)
- **Build Path**: Ackerman bloodline (natural talent), protect specific ally obsessively, top soldier, dual-blade mastery

**Veteran Commander (Erwin-type)**:

- **Primary**: CHA (inspire via speeches), INT (grand strategy), WIS (read battlefield)
- **Secondary**: CON (endure losses), DEX (ODM capable)
- **Dump**: STR (command > combat), emotional stats (sacrifices emotions for mission)
- **Build Path**: Commander perks (control formations), utilitarian choices, "Give your hearts!" speeches, heroic sacrifice endgame

**Humanity's Strongest (Levi-type)**:

- **Primary**: DEX (PEAK ODM mastery), STR (cutting power), WIS (combat reading)
- **Secondary**: CON (endurance), INT (tactical)
- **Dump**: CHA (blunt, no speeches), social graces (clean freak, grumpy)
- **Build Path**: Ackerman bloodline, spin-attack mastery, mentor role, lone wolf, protect squad, trauma-driven

---

### Character Creation Notes

**Recommended Party Composition**:

- **3-5 players** (Survey Corps squad)
- **Mix roles**: Scout (combat), Tactician (INT), Leader (CHA), Specialist (Thunder Spears/Titan shifter)
- **Shared Trauma**: Same training corps batch (Trost survivors, shared backstory)

**Session Zero MANDATORY**:

1. **Content Boundaries**: Graphic violence okay? PC death okay? PTSD themes okay? Genocide/war crimes okay? (X-card system)
2. **Tone Agreement**: Explain AoT = BLEAK, wins pyrrhic, no happy endings (players must consent)
3. **Death Protocol**: Backup character system (when PC dies, new recruit joins) OR permadeath with reshuffling. NO resurrection magic.
4. **Resource Anxiety**: Confirm players WANT to track gas/blades meticulously (some players hate this)

**Tone Calibration**:

- **Deaths Are Random**: No plot armor (die to Titan grab, ODM malfunction, stray debris)
- **Moral Complexity**: Humans are cruel (torture, betrayal, genocide), Titans are victims too (revelations later)
- **Resource Scarcity**: Track everything (gas %, blade count, rations, ammo)
- **PTSD Roleplaying**: Survivors develop trauma (nightmares, survivor's guilt, cold pragmatism)
- **Pyrrhic Victories**: Win but at cost (50% casualties, area destroyed, moral lines crossed)

**Red Flags / Avoid**:

- ❌ **Players Want Power Fantasy**: AoT is ANTI-power fantasy (wrong fit for heroes who win)
- ❌ **Players Avoid Dark Content**: Body horror, PTSD, genocide themes integral (not for lighthearted groups)
- ❌ **Players Hate Resource Management**: Gas/blade tracking required (wrong fit for narrative-focused players who hate crunch)
- ❌ **Players Want Optimistic Tone**: AoT is bleak underdog (wrong fit for hopeful heroism seekers)
- ❌ **Players Expect Plot Armor**: Main characters die (Erwin, Sasha, Hange), PCs will too

**Session Structure**:

- **Expedition Sessions**: Multi-session arcs (preparation → journey → combat → retreat → aftermath)
- **Political Sessions**: Intrigue, moral debates, faction conflicts (no Titans, all talking)
- **Combat Sessions**: High-lethality Titan encounters (1-2 hours, resource management, likely deaths)
- **Aftermath Sessions**: Process trauma, funerals, strategic planning, resupply

---

**Scaffolding Summary**:

- **Power Level**: Modest growth (8/10 Extreme Underdog → slow T1-2, death constant, T3 rare and hard-earned)
- **Progression**: Standard XP OR Milestone (5/10 Balanced → 500-700/session OR survival milestones)
- **Combat**: 6-stat + ODM subsystem (9/10 EXTREME Tactical), prioritize DEX/INT/WIS, 50% tactics + 30% horror + 20% resource anxiety
- **Power Systems**: ODM Gear (gas/blade tracking, precision strikes), Thunder Spears (finite), Titan Shifting (costly transformation), 7/10 Explained = mechanics clear, origins mysterious
- **Archetypes**: Role determines build (Scout DEX/CON, Tactician INT/WIS, Commander CHA/INT, Prodigy DEX/STR, Ackerman peak stats)
- **Avoid**: Power fantasy seekers, dark content avoiders, resource management haters, optimistic tone seekers, plot armor expecters

Use this template when generating profiles for similar anime: **Grim tactical survival with resource scarcity, moral complexity, and extreme lethality** (e.g., Berserk's dark fantasy, Vinland Saga's cycle of violence, 86's war tragedy, Made in Abyss's lethal exploration).

---

**Final Calibration Note**:

Attack on Titan's CORE is CONTRADICTION: Fight for freedom → Become oppressor. Seek truth → Truth damns you. Save humanity → Humanity is cruel. Love bonds → Bonds are liabilities. The profile WORKS when players feel that TENSION constantly—caught between HOPE (we can save them) and DESPAIR (cycle is eternal), between DUTY (fight for humanity) and HORROR (we're becoming monsters). Maintain that KNIFE-EDGE. Too hopeful = loses AoT's bleakness. Too despairing = players disengage. BALANCE: Struggle MATTERS morally even if it FAILS practically. "We die in darkness so others live in light"—that's the heart. Honor it.

---

**Profile Status**: Approved ✅  
**Genre**: Dark Fantasy / Military Thriller  
**Similar Profiles**: Berserk (dark fantasy), Vinland Saga (violence cycle), Code Geass (moral complexity)
