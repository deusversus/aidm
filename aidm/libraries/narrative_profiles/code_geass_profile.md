# Code Geass Narrative Profile (Reference Example)

**Profile ID**: `narrative_code_geass`  
**Source Anime**: Code Geass: Lelouch of the Rebellion (2006-2008, R1 + R2)  
**Extraction Method**: Research-derived (50 episodes, Zero Requiem focus)  
**Confidence Level**: 97%  
**Last Calibration**: 2025-01-15

## Mechanical Configuration

```json
{
  "economy": {
    "type": "fiat_currency",
    "parameters": {
      "currency_name": "Britannian Pound",
      "starting_amount": 1000,
      "scarcity": "normal",
      "inflation_rate": "none",
      "special_mechanics": ["corporate_sponsorship", "military_budget", "black_knights_funding"]
    }
  },
  "crafting": {
    "type": "experimental",
    "parameters": {
      "discovery_method": "research",
      "failure_chance": "moderate",
      "special_mechanics": ["knightmare_customization", "sakuradite_tech"]
    }
  },
  "progression": {
    "type": "quirk_awakening",
    "parameters": {
      "quirk_name": "Geass",
      "awakening_stages": ["Contract", "Mastery", "Runaway", "Code"],
      "evolution_triggers": ["emotional_trauma", "excessive_use", "code_contact"],
      "special_mechanics": ["eye_activation", "cumulative_cost", "permanent_effect"]
    }
  },
  "downtime": {
    "enabled_modes": ["slice_of_life", "faction_building"],
    "activity_configs": {
      "slice_of_life": {
        "time_cost": "1_day",
        "benefits": ["school_cover", "relationship_building"],
        "special_mechanics": ["student_council", "festival_events"]
      },
      "faction_building": {
        "time_cost": "1_week",
        "benefits": ["rebellion_strength", "territory_control"],
        "special_mechanics": ["zero_persona", "strategic_planning"]
      }
    }
  }
}
```

---

## Narrative Scales (0-10)

### Scale 1: Introspection vs Action (7/10 - Strategic Planning Heavy)

Code Geass is a THINKING show disguised as mecha action. 70% of Lelouch's screentime is PLANNING (war room strategy sessions, inner monologues calculating contingencies, post-battle analysis) vs 30% execution. Episode 2: Lelouch spends 8 minutes explaining chess principles before applying them to Shinjuku battle. R2 Episode 19: 12-minute sequence of Schneizel vs Lelouch mental chess match (moving fleets, predicting enemy moves, NO physical combat). Inner monologues CONSTANT—Lelouch's internal calculations ("If Cornelia moves here, I counter with X. If she anticipates, fallback to Y."), Suzaku's guilt spirals ("I killed my father to end war... but it changed nothing"), Schneizel's cold analysis ("Lelouch values Nunnally. Exploit."). 

Action sequences exist (Lancelot vs Guren duels, Knightmare battles) but serve STRATEGY—they're execution of plans shown earlier OR catalyst for NEXT plan. Episode 22 R1: Euphemia massacre is ACTION result of ACCIDENTAL Geass (Lelouch's introspection: "I joked... and my power went berserk. I killed her. I killed the one person who could have achieved peace."). Comparable to Death Note (8/10 introspection, nearly pure mental chess) but Code Geass balances with mecha spectacle. LESS introspective than Monster (9/10: pure psychological), MORE than typical shonen (Naruto 3/10: action>planning).

**AIDM Application**: Players should spend 60-70% session time PLANNING (gather intel, debate strategy, calculate risks, contingencies) vs 30-40% EXECUTION (battles, infiltration). Encourage chess-style thinking ("If enemy does X, I do Y. If X fails, backup plan Z."). Inner monologue mechanics: Let players narrate PC's thoughts AFTER reveal ("Here's what I was REALLY doing..."). Reward strategic thinking over brute force.

---

### Scale 2: Comedy vs Drama (7/10 - Drama Dominant With Tonal Whiplash)

Code Geass is 70% DRAMA (war, death, betrayal, moral complexity, tragedy) and 30% COMEDY (school hijinks, slapstick, fanservice, Pizza Hut product placement). BUT the comedy is JARRING—intentional tonal whiplash. Episode 22: Opens with Lelouch in school festival (dressed as PIZZA delivery boy, comedy), cuts to Euphemia announcing Japan liberation zone (hopeful drama), ends with Lelouch's Geass misfiring causing Euphemia to ORDER JAPANESE MASSACRE (horrific tragedy). SAME EPISODE. 25 minutes. Comedy → Hope → Despair.

School scenes (Student Council activities, cat costume punishments, Shirley's crush, C.C.'s pizza obsession, Arthur the cat stealing Zero's mask) exist as CONTRAST—they make tragedies HIT HARDER. Episode 13: Shirley's father dies in Lelouch-caused landslide. Previous episode showed her happy, teasing Lelouch about mystery girl (C.C.). Whiplash INTENTIONAL. R2 has LESS comedy (15% vs 30% R1) as stakes escalate—by Zero Requiem arc, comedy nearly GONE (final 8 episodes: 5% levity maximum).

Compare: Most anime maintain TONAL CONSISTENCY (Cowboy Bebop shifts between episodes NOT within, Attack on Titan <5% comedy TOTAL). Code Geass REFUSES consistency—it's a FEATURE not bug. Sunrise Studio's deliberate choice: "Life has comedy and tragedy simultaneously. War doesn't pause for jokes, but humans need laughter to survive horror."

**AIDM Application**: Allow tonal shifts WITHIN sessions (school scene → war briefing → tragedy same 4-hour session). Use comedy as RELIEF valve (pressure rising, insert school hijinks, then SHATTER with betrayal/death). Players should feel WHIPLASH—laughing one moment, horrified next. Don't force tonal unity—embrace chaos. Session structure: 20-30 min lighthearted → 60-90 min drama/tension → 30 min tragedy climax.

---
### Scale 3: Simple vs Complex (9/10 - Hyper-Layered Conspiracy)

Code Geass is AGGRESSIVELY complex. NOT "complicated for complexity's sake" but layered storytelling where Episode 3 setup pays off in Episode 47. **Political Layers**: Britannian Empire (Charles zi Britannia's social Darwinist monarchy), Japanese Resistance (multiple factions: Black Knights, Japan Liberation Front, Kyoto House), Chinese Federation (political marriage schemes), EU (mentioned, minimal impact), Geass Order (C.C./V.V.'s immortal conspiracy spanning CENTURIES). **Character Layers**: Lelouch is student/terrorist/prince/brother/emperor across 50 episodes. Suzaku is Japanese/Britannian soldier/Knight of Seven/Knight of Zero. Schneizel is prince/prime minister/strategist/final boss. C.C. is immortal witch/contractor/prisoner/Lelouch's conscience.

**Conspiracy Mechanics**: Charles' Ragnarök Connection plan (destroy human consciousness, merge all minds into collective—revealed Episode 46, foreshadowed Episode 1 with "eliminate lies"). Geass evolution (eye contact command → area effect → permanent → Code immortality). Triple agents COMMON (Villetta spies on Black Knights, loses memory, regains, conflicted loyalty). Time mechanics (Lelouch's plans require EXACT timing—Episode 25 R2: "Damocles fires in 19 minutes, Schneizel moves fleet in 12, I need 8 to reach Nunnally"). 

Requires **FLOWCHART thinking**. Fans create diagrams: "Who knows Lelouch is Zero?" (changes 15+ times across series). "What is each character's motivation?" (Lelouch: Nunnally's happiness. Suzaku: Atonement via service. Schneizel: Perfect world via utilitarianism. C.C.: Death/freedom from immortality). Episode 19 R2: Lelouch erases memories of 1 million Tokyo citizens to cover Zero's "resurrection"—political/ethical/logistical NIGHTMARE, resolved in 2 minutes of dialogue (TOO complex for most anime).

Compare: Death Note (9/10 complex: L vs Light chess), Monster (8/10: Johan's conspiracy), Attack on Titan (8/10: basement truth layers). Code Geass EXCEEDS by layering political+supernatural+personal+philosophical simultaneously. Casual viewers GET LOST (fandom joke: "I need spreadsheet to track who betrayed whom").

**AIDM Application**: Track factions (goals, alliances, who knows what), use conspiracy maps (visual flowcharts for players: "WHO knows Lelouch is Zero? WHEN did they learn?"), plant early seeds (Session 5 throwaway line pays off Session 40), REWARD note-taking (players who remember Episode 10 NPC dialogue get advantage in Episode 35 negotiation). Complexity should ENHANCE not OBSCURE—ensure players can FOLLOW if paying attention, but depth rewards rewatching/analysis.

---

### Scale 4: Power Fantasy vs Struggle (6/10 - Geass OP But Fragile Glass Cannon)

Lelouch's Geass (absolute obedience via eye contact) is OVERPOWERED... with CRIPPLING limitations. **Power**: Command ANYTHING ("Die." "Forget Lelouch is Zero." "Love me." "Serve me forever.") and target MUST obey. No resistance. NO save. Instant win... IF conditions met. **Limitations**: (1) Eye contact required (sunglasses block, blind characters immune—Nunnally, later V.V.), (2) Once per person EVER (can't reuse on same target), (3) Evolves uncontrollably (R2: becomes PERMANENT "always on"—Lelouch must wear contact lens or accidentally command everyone), (4) BACKFIRES catastrophically (Euphemia: Lelouch JOKES "kill all Japanese" during casual conversation, Geass activates ACCIDENTALLY, she obeys, genocide).

Lelouch is PHYSICALLY WEAK (loses fistfight to Suzaku, can't pilot Knightmare proficiently, asthmatic childhood). Geass is CRUTCH—without it, he's helpless. Strategic genius compensates but put Lelouch in ODM gear (Attack on Titan) or Nen battle (Hunter x Hunter) and he DIES immediately. R1 finale: Captured, powerless, REQUIRES Geass to escape. R2 Episode 1: Amnesia, no Geass access, nearly killed by Britannian soldiers.

**Struggle Balance**: Lelouch WINS battles via Geass+tactics (60% success rate across series) BUT (1) Every win costs SOMETHING (allies die, Geass expands uncontrollably, Nunnally endangered), (2) Enemies ADAPT (Schneizel uses blind pilot Jeremiah who can't be Geassed, Cornelia never looks Lelouch in eyes after learning about Geass), (3) Geass has CONSEQUENCES (using it erodes Lelouch's humanity—by R2 he's CASUAL about mind control, slippery slope).

Compare: One Punch Man (1/10 struggle: Saitama invincible), Death Note (6/10: Light's Death Note OP but L counters intellectually), Naruto (7/10: Naruto struggles despite Nine-Tails power). Code Geass BALANCES: Power exists but (1) limited uses, (2) tactical not brute force, (3) psychological cost, (4) BACKFIRES create drama.

**AIDM Application**: Give players OP ability with HARD LIMITS (once-per-target, specific trigger, unintended consequences). Geass-equivalent mechanics: "Telepathic Command" spell (1/day, requires eye contact, permanent effect, save negates BUT critical fail = command INVERTS: 'protect me' becomes 'kill me'). ENEMIES ADAPT (after first use, wear mirrored visors, close eyes in combat, use blind fighters). Every use = moral weight ("I just violated someone's free will. Am I villain?"). Track uses (once per NPC EVER—players must strategize WHO to command).

---

### Scale 5: Explained vs Mysterious (6/10 - Tactical Plans Explained, Geass Origin Mysterious)

Code Geass operates on DUAL MYSTERY TRACKS: **Explained**: Lelouch's tactical plans, Knightmare specs, political maneuvering, military logistics. Post-battle, Lelouch EXPLAINS (flashback: "Here's how I predicted Cornelia's move 3 episodes ago"). Sakuradite (energy resource) properties detailed. Black Knights equipment specs shown. Britannian succession politics mapped. Zero's strategies REVEALED after execution (mystery during, explanation after—suspense then satisfaction).

**Mysterious**: Geass origin (WHERE does it come from? WHY eye? WHAT is Code? C.C.'s past? V.V.'s immortality?), Charles' true plan (hinted across 25 episodes, revealed Episode 46), "World of C" (collective unconscious realm—WHAT IS IT?), Thought Elevator (ancient ruins, never fully explained). Series ENDS with mysteries: Does Lelouch survive Zero Requiem? (ambiguous cart scene). What IS Geass fundamentally? (connected to human consciousness but HOW?). C.C.'s REAL name? (never revealed, she says it to Lelouch off-screen Episode 48).

**Balance**: Code Geass satisfies TACTICAL curiosity (players who analyze can predict moves) while preserving SUPERNATURAL mystique (Geass feels magical, unknowable). R2 Episode 21: Lelouch confronts Charles in World of C—SOME answers (Ragnarök Connection plan explained: merge all minds, eliminate lies/conflict), but NEW questions (HOW does collective unconscious WORK? Is it real or metaphysical?). Ending intentionally ambiguous ("Is Lelouch the cart driver?" debate rages 15+ years).

Compare: Death Note (4/10: Shinigami rules FULLY explained, no ambiguity), Hunter x Hunter (3/10: Nen system encyclopedic detail), Evangelion (8/10: deeply mysterious, many answers withheld). Code Geass leans EXPLAINED on tactics, MYSTERIOUS on metaphysics.

**AIDM Application**: Explain PLAYER-ACTIONABLE elements (tactical rules, enemy capabilities, political landscape—players can strategize if they understand mechanics). Keep SUPERNATURAL mysterious (Geass-equivalent magic: "It works, you feel it, but WHY? Unknown."). Post-mission debriefs: NPC ally explains "Here's how protagonist's plan worked" (players who guessed feel smart, others learn). Preserve some mysteries FOREVER (final boss motivation HINTED never confirmed, player theories encouraged). Ambiguous endings acceptable IF dramatic weight earned.

---

### Scale 6: Fast-Paced vs Slow Burn (8/10 - Rapid Escalation)

Code Geass SPEED-RUNS character arcs. Episode 1: Lelouch is exiled prince. Episode 2: Gains Geass, becomes terrorist Zero. Episode 8: Commands thousand-soldier Black Knights. Episode 25: Leads Japan Liberation, nearly wins, LOSES brutally (father checkmates him). R2 Episode 3: Emperor of Britannia. 50 episodes TOTAL covers: School → Terrorist → Rebel Leader → Emperor → God-Challenger → Martyr. BREAKNECK.

**Arc Pacing**: Black Rebellion arc (Episodes 18-25 R1): 8 episodes from "small resistance" to "full-scale war for Japanese independence" to "catastrophic defeat." Zero Requiem arc (Episodes 19-25 R2): 7 episodes from "Lelouch becomes tyrannical emperor" to "global resistance forms" to "Lelouch stages own assassination to unite world." NO downtime—each episode advances plot SIGNIFICANTLY. Episode 22 R1 ("Bloodstained Euphie"): 25 minutes contains (1) school festival comedy, (2) Euphemia's Japan liberation announcement (paradigm shift), (3) Accidental Geass massacre, (4) Lelouch forced to kill Euphemia, (5) Black Rebellion begins. FIVE MAJOR PLOT POINTS one episode.

**Character Development**: Also rapid. Suzaku: Episodes 1-10 (loyal Britannian soldier) → Episodes 11-15 (questions loyalty after Euphemia's idealism) → Episodes 16-25 (becomes Knight of Seven, conflicted) → R2 (Knight of Zero, Lelouch's executioner, then ally). Shirley: Episodes 1-12 (crush on Lelouch, innocent) → Episode 13 (father dies, trauma) → Episode 14 (learns Zero's identity, memory erased) → R2 Episode 13 (remembers, accepts, DIES). Compressed arcs—characters evolve FAST.

Compare: One Piece (2/10: 1,000+ episodes, slow-burn arcs), Attack on Titan (5/10: balanced build/climax), Code Geass (8/10: rapid escalation). Only Death Note matches speed (10/10: L arc 25 episodes, Near/Mello 12 episodes—FASTER than Code Geass).

**AIDM Application**: Escalate EVERY session (Session 1: small mission. Session 3: faction war. Session 10: global stakes). Don't linger—if players achieve goal, RAISE STAKES IMMEDIATELY (won battle? Enemy counterattacks NEXT session. Became rebel leader? Government sends army. Defeated army? Emperor intervenes PERSONALLY). Character arcs compress: 5-session NPCs undergo full hero's journey (innocent → tested → traumatized → growth → sacrifice). Speed creates URGENCY—players can't rest, threats MULTIPLY.

---

### Scale 7: Episodic vs Serialized (10/10 - Hyper-Serialized Continuity)

Code Geass is AGGRESSIVELY serialized. Episode 47 R2 ("Emperor Lelouch") is INCOMPREHENSIBLE without Episodes 1-46. Zero standalone episodes. EVERY episode: (1) Advances overarching plot (Black Rebellion → Zero Requiem), (2) References prior events ("Remember Episode 12 when X happened?"), (3) Plants seeds for FUTURE payoffs (Episode 5 throwaway line about "sibling rivalry" pays off Episode 45 when Schneizel revealed as antagonist).

**Continuity Tracking**: Viewers MUST remember: Who knows Zero's identity (changes 20+ times), Geass evolution stages (single-use → permanent → Code immortality), Political alliances (Japan Liberation Front vs Black Knights vs Kyoto House—three SEPARATE factions, characters switch sides). Episode 8 R2 references Episode 3 R1 conversation (45 episodes apart). Fandom maintains WIKIS to track.

**Long-Term Payoffs**: Episode 1 R1: Clovis (Lelouch's half-brother) mentions "researching Geass." Lelouch kills him, dismisses comment. Episode 46 R2: Reveals Charles SENT Clovis to find "Thought Elevator" (ancient Geass ruins)—Clovis was PAWN in 46-episode plan. Viewers who REMEMBER Episode 1 get payoff. Episode 17 R1: Lelouch promises Euphemia "I'll make you happy." Episode 22: Accidentally Geasses her to commit genocide, must kill her. PROMISE INVERTED.

Compare: Cowboy Bebop (1/10 episodic: watch any order mostly), My Hero Academia (6/10: arcs serialized, some standalone), Code Geass (10/10: strict continuity, zero filler). Only Attack on Titan matches (10/10: every frame matters).

**AIDM Application**: Track EVERYTHING (use campaign wiki: NPC allegiances, player promises, quest threads). Reference prior sessions OFTEN ("Remember Session 8 when you spared that NPC? She's back, and she REMEMBERS."). Plant seeds EARLY (Session 5: NPC mentions 'mysterious benefactor.' Session 30: Benefactor revealed as villain funding BOTH sides). Reward players who take notes (memory checks: "What did the baron say in Session 12?" Correct answer = advantage). ZERO filler sessions—every session advances overarching plot, plants future seeds, OR pays off past setup.

---

### Scale 8: Grounded vs Absurd (7/10 - Political Realism Meets Supernatural Mecha)

Code Geass is SPLIT-BRAIN: **Grounded** (70%): Political intrigue mirrors real-world (Britannian Empire = British Empire colonialism allegory, Area 11 = occupied Japan post-WWII, Sakuradite = petroleum resource wars, rebellion tactics = guerrilla warfare asymmetry, class stratification = Britannians vs Numbers, media propaganda = state-controlled narratives). Economics shown (Black Knights funded by Kyoto House businessmen, Lelouch budgets for equipment). Diplomacy realistic (Chinese Federation marriage alliance, EU non-intervention treaties, Schneizel's ceasefire negotiations). 

**Absurd** (30%): GIANT ROBOTS (Knightmares: 5-meter mecha with rollerblade feet, machine guns, swords—physics-defying agility), Geass MAGIC (mind control via eye contact, immortality, time manipulation, reality warping—NO scientific explanation), Thought Elevators (ancient alien? ruins teleport to "World of C" collective unconscious dimension), FLEIJA nukes (erases matter in 50km radius, deployed casually), Damocles floating fortress (continent-sized airship with 3,000 FLEIJAs—orbital bombardment platform).

**Tonal Balance**: Episode 3: Grounded (Lelouch uses cell phone jamming, terrain analysis, diversionary tactics—realistic military strategy) THEN absurd (Lancelot mecha does backflip, slashes 12 enemy units in 6 seconds—anime physics). Knightmare battles obey SOME physics (momentum, gravity, ammunition limits) but IGNORE others (rollerblade speed, sword-cuts-tank-armor). Geass feels MAGICAL (no midichlorians, no explanation—just "contract with witch, gain power").

Compare: Gundam (5/10: grounded military, semi-realistic mecha), Evangelion (8/10: psychological realism, Evas are bio-mechs with angel mythology—more absurd), Code Geass (7/10: between Gundam's groundedness and Eva's surrealism).

**AIDM Application**: Ground TACTICS/POLITICS (realistic consequences: assassination has blowback, revolutions require funding, battles need logistics), embrace SUPERNATURAL absurdity (Geass-magic just WORKS, no explanation needed, mecha are cool factor). Players strategize using REAL-WORLD logic (flanking, intelligence gathering, resource management) in FANTASTICAL setting (magic powers, giant robots, flying fortresses). Tonal split WORKS if consistent—don't explain magic scientifically (kills mystique), don't make politics anime-logic (breaks immersion).

---

### Scale 9: Tactical vs Instinctive (10/10 - Pure Calculated Strategy)

Code Geass is CHESS: The Anime. Lelouch's EVERY action is calculated (Episode 1: "If I do X, enemy responds Y. If Y, I counter Z. If Z fails, fallback Omega."). ZERO instinct—pure intellect. Episode 19 R2: Schneizel vs Lelouch mecha battle is MENTAL not physical (both commanders PREDICT enemy moves 5 steps ahead: "He'll flank left. I'll retreat right. He'll EXPECT retreat right, so I'll ACTUALLY retreat left THEN counter-flank."). Viewers see BOTH sides thinking simultaneously—dual inner monologues, chess-match commentary.

**Planning Over Power**: Lelouch is WEAK physically (asthma, poor stamina, loses fistfight), Suzaku is STRONG (superhuman reflexes, Lancelot pilot ace), but Lelouch WINS via tactics. Episode 5: Suzaku's Lancelot is superior to ALL Black Knights mecha, but Lelouch traps him in tunnel (negates mobility), floods with sleeping gas (negates skill), captures WITHOUT fight. Geass is TOOL not win-button (Lelouch uses psychology: "Which soldier's loyalty is WEAKEST? Geass him to betray squad."). 

**Contingency Layers**: Lelouch's plans have Plans B/C/D/E. Episode 25 R1: Lelouch's Black Rebellion plan includes (1) Main assault on Tokyo, (2) Submarine backup if main fails, (3) Cornelia hostage if submarine fails, (4) Geass on Suzaku as LAST RESORT if all else fails. ALL FOUR FAIL (Schneizel outmaneuvers submarine, Suzaku resists Geass via Lancelot's refrain drug, Cornelia rescued, V.V. betrays Lelouch). But Lelouch STILL has Plan F (escape with C.C., regroup)—7 LAYERS deep.

**Enemy Intelligence**: Foes ALSO tactical geniuses. Cornelia (military prodigy, Episode 8: predicts Lelouch's bluff, forces him to improvise). Schneizel (calm strategist, Episode 19 R2: equals Lelouch in chess match, forces stalemate). Li Xingke (Chinese Federation strategist, counters Lelouch multiple times). Battles are SYMMETRICAL SKILL (both sides predict, both adapt, victory to better tactician OR luckier).

Compare: Hunter x Hunter (10/10: Nen battles are IQ contests), Death Note (10/10: L vs Light pure intellect), Naruto (4/10: tactics exist but power/emotion often trump), One Piece (3/10: Luffy punches harder). Code Geass TIED for most tactical anime with Death Note/HxH.

**AIDM Application**: REWARD strategy over stats (player with INT 10 but clever plan beats player with INT 18 who charges). Require PLANNING (Session Zero: "This campaign rewards preparation. Scout enemies. Gather intel. Budget resources. NO improv heroics."). Give enemies EQUAL intelligence (villains predict player tactics, lay counter-traps, adapt mid-battle). Allow contingency layering (player declares "If Plan A fails, I activate Plan B"—DM tracks, allows). PUNISH recklessness (charging without intel = ambush, superior enemy, death). Victory feels EARNED (outsmarted foe, not overpowered).

---

### Scale 10: Hopeful vs Cynical (7/10 - Cynical Methods for Hopeful Goal)

Code Geass is PARADOX: Lelouch uses CYNICAL methods (manipulation, murder, mind control, lies, sacrifice of innocents) toward HOPEFUL goal (world peace for Nunnally, end discrimination, defeat tyranny). **Cynicism**: Lelouch manipulates FRIENDS (Geasses soldiers to die as decoys, uses Shirley's love to maintain cover, lies to Kallen about motivations), KILLS civilians (Euphemia massacre: 100,000+ Japanese dead as "collateral"), becomes TYRANT (Emperor Lelouch: arrests dissenters, public executions, totalitarian rule), SACRIFICES allies (Zero Requiem: uses Schneizel as puppet, Geasses world leaders, stages own assassination). Ends JUSTIFY means—Lelouch's philosophy.

**Hope Undercurrent**: Lelouch's CORE motivation is PURE—Nunnally's gentle world (peace, kindness, no war). Final episode R2: Zero Requiem succeeds. World unites against "Demon Emperor Lelouch," Suzaku (as Zero) kills him publicly, war ends, peace achieved. HOPEFUL outcome via CYNICAL sacrifice. Lelouch's last words to Nunnally: "People's happiness was my happiness." Dies smiling—martyr for peace. Suzaku continues as Zero (symbol of justice), world enters era of cooperation.

**Moral Ambiguity**: Is Lelouch HERO or VILLAIN? (Fandom DEBATES 15+ years). HERO perspective: Ended tyranny, achieved peace, sacrificed self for greater good. VILLAIN perspective: Murdered thousands (incl. innocents), manipulated loved ones, became dictator, ends don't justify means. Code Geass REFUSES answer—presents BOTH, lets audience decide. Suzaku's arc mirrors: HOPEFUL idealism (reform from within) via CYNICAL service (enables Britannian oppression). Both paths FLAWED.

Compare: One Piece (2/10 cynical: optimistic, friendship wins, world improves), Attack on Titan (8/10 cynical: Eren's Rumbling, cycle continues, bittersweet), Code Geass (7/10: cynical execution, hopeful resolution—UNIQUE balance).

**AIDM Application**: Let players pursue NOBLE goals via DARK methods (save kingdom by assassinating rival's family, end war by mind-controlling enemy general, achieve peace via tyranny). NPCs REACT morally ("You SAVED us... but at what cost? Are you hero or monster?"). Final campaign outcome can be HOPEFUL (world improves) IF players accept CYNICAL means (reputation ruined, loved ones dead, moral injury). Zero Requiem equivalent: Player sacrifices self to unite factions ("Villain PC dies publicly, rally point for peace"). Balance: Cynicism feels REAL (consequences, guilt, loss) but hope POSSIBLE (world CAN improve if you pay price).

---

### Scale 11: Narrative Focus (2/10 - Lelouch-Centric with Strategic Allies)

Code Geass is FIRMLY protagonist-centric. **Lelouch 70% POV** (R1: 60%, R2: 80% as series progresses). Nearly EVERY scene includes Lelouch OR directly serves his plot (Suzaku scenes show enemy perspective preparing to clash with Lelouch, Schneizel scenes reveal next antagonist move, C.C. scenes expose Geass lore relevant to Lelouch's power). Camera follows Lelouch's plans, inner monologues, reactions. Supporting cast exists in ORBIT around protagonist.

**Suzaku 15% co-protagonist** (Episodes 1-25 R1: equal screentime as ideological rival, R2: spotlight fades as becomes Lelouch's tool/executioner). **Ensemble 10%**: Kallen (Black Knights ace pilot, 5% spotlight in battle episodes), Schneizel (final antagonist, 3% spotlight late-series), C.C. (Geass mentor, 2% spotlight—mostly mysterious). **Political cast <5%**: Cornelia, Euphemia, Charles, student council (appear when plot requires, vanish when not needed).

**Spotlight Allocation**: Episode structure typical: Lelouch plans (10 min) → executes (5 min) → Suzaku reacts (3 min) → ensemble battles (5 min) → Lelouch reveals twist (2 min). 17/25 minutes = Lelouch. Even "Suzaku episodes" (Episode 18 R2: Suzaku's past trauma revealed) exist to explain WHY Suzaku opposes Lelouch (serves protagonist's arc). C.C. backstory (Episode 15 R2) reveals Geass contract mechanics (impacts Lelouch's fate). NO standalone arcs—everything ties to Lelouch.

**Whose Growth Drives Story**: LELOUCH. Arc: Exiled prince (powerless) → Terrorist Zero (power via Geass) → Rebel Leader (tactical genius) → Emperor (absolute power) → Demon King (tyranny) → Martyr (self-sacrifice). Supporting cast REACTS to Lelouch's evolution. Suzaku's arc (loyal soldier → Knight of Round → Knight of Zero → Zero II) is RESPONSE to Lelouch's choices. Kallen's loyalty (soldier → Lelouch's right hand → conflicted when learns truth) hinges on protagonist. Schneizel emerges as antagonist BECAUSE Lelouch threatens his perfect-world plan.

**Why Structure Works**: Code Geass is STRATEGIC THRILLER—requires singular POV for suspense ("What is Lelouch planning? Will it work?"). Multiple POVs dilute mystery (if camera shows enemy's counter-plan, Lelouch's reveal loses impact). Lelouch is GENIUS protagonist—viewers want HIS perspective (inner monologues are half the show). Supporting cast provides CONTRAST (Suzaku's idealism vs Lelouch's pragmatism, C.C.'s immortal wisdom vs Lelouch's mortal desperation).

**Comparison to Other Models**:
- **VS Solo Protagonist** (Steins;Gate 1/10): Code Geass has MORE ensemble (Suzaku co-protagonist, Kallen/Schneizel/C.C. recurring spotlight) but less than balanced models
- **VS Dual Protagonists** (FMAB 4/10): Lelouch/Suzaku SEEM dual but Lelouch dominates 70% vs Suzaku's 15%—unequal partnership
- **VS Ensemble** (Bebop 8/10, One Piece 7/10): Code Geass spotlight CONCENTRATES on one character, ensemble serves his arc
- **Closest Match**: Death Note (2/10: Light 70%, L 20%, ensemble 10%—nearly identical structure)

**AIDM Application - Running Lelouch-Style Campaigns**:

**1) Mastermind PC Focus**: One player volunteers as "Lelouch"—tactical genius protagonist. OTHER players are (A) Rival mastermind (Suzaku-equivalent: equal skill, opposed ideology, 15% spotlight), (B) Loyal lieutenants (Kallen-equivalent: skilled soldiers, execute plans, 10% spotlight combined), (C) Mysterious mentor (C.C.-equivalent: provides powers/intel, cryptic, 5% spotlight). Session Zero: EVERYONE consents to asymmetric spotlight. Lelouch-PC gets 60-70% screentime (planning scenes, inner monologue moments, final reveals).

**2) Strategic Suspense Mechanics**: Lelouch-PC plans IN SECRET (writes plan on note, passes to DM, DM tracks). Other players see EXECUTION without knowing full plan. Mid-battle, Lelouch-PC reveals ("Here's what I was REALLY doing 3 sessions ago..."). Creates suspense (players guess plan), payoff (reveal), rewards strategic thinking.

**3) Rival Dynamic**: Suzaku-PC opposes Lelouch-PC ideologically BUT not murderously (frenemies, clashing philosophies, eventual tragic confrontation). Give Rival-PC equal SKILL but different METHODS (Lelouch: tactics/manipulation, Suzaku: combat prowess/honor). Structure: Lelouch-PC plans → Rival-PC counters → escalation → philosophical debate → temporary truce OR bitter clash.

**4) Ensemble Support Roles**: Lieutenant-PCs are NOT sidekicks—they're ESSENTIAL (execute battles, pilot mechs, gather intel, provide emotional grounding when Lelouch-PC descends into amorality). Spotlight during COMBAT (Lelouch plans, Lieutenants fight), balanced during DOWNTIME (everyone gets character moments).

**5) Rotating Spotlight Sessions**: 70% sessions Lelouch-centric (strategic planning, reveals, political maneuvering), 15% Rival-centric (explores opposing ideology, prepares counter-move), 10% Ensemble-centric (lieutenant backstories, side missions, character growth), 5% Mentor-centric (mysterious lore, power expansion, cryptic warnings). Prevents Lelouch-PC from MONOPOLIZING but maintains protagonist-focus.

**6) When This Structure FAILS**: If Lelouch-PC player is passive (doesn't plan elaborately, just reacts), if other players RESENT asymmetry (want equal spotlight), if Rival-PC doesn't commit to ideology (becomes generic antagonist), if DM reveals Lelouch-PC's plans too early (kills suspense). SOLUTION: Session Zero agreement, player buy-in to roles, DM discipline in secret-keeping.

**7) Alternative: Ensemble with Lelouch NPC**: If group prefers EQUAL spotlight, make Lelouch an NPC (players are Black Knights lieutenants: Kallen/Jeremiah/Tohdoh equivalents, serve Zero's plans but get equal agency, Zero reveals plans at climax, players execute missions with freedom). Maintains Code Geass feel without asymmetric PC spotlight.

**Best For**: Groups with ONE player who loves strategic mastermind role (chess-player, planner, willing to hog spotlight), OTHER players who enjoy execution/combat/support roles (don't need protagonist spotlight, trust mastermind-PC's vision), DM comfortable managing secrets/reveals. **NOT for**: Groups wanting equal spotlight, players uncomfortable with hierarchy, casual/improv-heavy groups (Code Geass requires PLANNING).

---

---

## Storytelling Tropes (Detailed Analysis)

### Trope 1: Cat-and-Mouse (ENABLED 10/10 - Series DNA)

Code Geass IS cat-and-mouse. **Primary Dynamic**: Lelouch vs L-equivalents (Cornelia Episodes 8-17, Schneizel Episodes 18-25 R2, Suzaku throughout as ideological mirror). Structure: Protagonist makes move → Antagonist counters → Protagonist adapts → Escalation. Episode 8: Lelouch traps Cornelia's forces via landslide (cat pounces), Cornelia predicts trap and evacuates (mouse escapes), Lelouch improvises Geass on soldier to shoot Cornelia (cat adapts), Cornelia's bodyguard intercepts (mouse counters)—FOUR exchanges ONE episode.

**Intellectual Equals**: Lelouch is GENIUS but so are foes. Schneizel Episode 19 R2: Both predict enemy fleet movements 8 steps ahead, mental chess match narrated via dual inner monologue ("If he moves here, I'll... but he KNOWS I'll counter, so..."). Neither outsmarts other—STALEMATE until external factor (Suzaku's intervention). This creates SUSPENSE—viewer can't predict who wins because BOTH are smart.

**Moral Opposites**: Lelouch (ends justify means, manipulation, utilitarian) vs Suzaku (reform from within, honor, deontological). Episode 17 R1: Debate at Kururugi Shrine—both have VALID points (Lelouch: "Your method too slow, people dying NOW." Suzaku: "Your method creates MORE suffering."). No resolution—parallel paths destined to clash. By R2 finale, Suzaku executes Lelouch (cat kills mouse? or mouse orchestrates own death to win larger game?). 

**AIDM Application**: Establish rival mastermind NPC (equal intelligence, opposed methods, personal history with PC). Each session: PC makes move (political maneuver, battle tactic, assassination), Rival COUNTERS next session (predicted PC's plan, prepared counter-trap, stalemate or slight advantage to one side). Escalate over 10-15 sessions until final confrontation. Avoid Rival being DUMB (players lose respect) or OMNISCIENT (feels unfair)—equal footing creates tension.

---

### Trope 2: Tragic Backstory (ENABLED - Every Major Character)

Code Geass believes in TRAUMA as motivation. **Lelouch**: Mother Marianne assassinated (watched her die, age 10), sister Nunnally crippled and blinded (trauma-induced psychosomatic blindness), exiled to Japan as political pawns (father Charles abandoned them), Japan conquered (lost safe haven). Entire arc driven by REVENGE (kill Charles, create safe world for Nunnally). **Suzaku**: Age 10, assassinated own father (Prime Minister Genbu) to end war (Japan losing to Britannia, Genbu wanted scorched earth, Suzaku mercy-killed him to save lives). Lives with GUILT—serves Britannia seeking DEATH as atonement (suicidal soldier, Lancelot missions are suicide runs he survives via skill).

**C.C.**: Slave girl centuries ago, given Geass (telepathy), used by humans, became immortal via Code, CANNOT die despite wanting to (stabbed, burned, drowned—regenerates), contracts Lelouch seeking DEATH (if Lelouch takes Code, she's freed). **Euphemia**: Innocent princess traumatized by Britannian cruelty, wants peace, creates Japan Liberation Zone, MASSACRES Japanese via Lelouch's accidental Geass (final words: "Lelouch... why?"), dies believing she became monster. **Schneizel**: Implied childhood trauma (cold calculating sociopath, views humans as chess pieces, Charles' "perfect son"—possibly abused into perfection).

**Trope's Purpose**: Backstory EXPLAINS but doesn't EXCUSE. Lelouch's trauma makes revenge understandable BUT doesn't justify mind-controlling innocents. Suzaku's guilt makes servitude logical BUT doesn't justify enabling oppression. Code Geass uses tragedy as CHARACTER FOUNDATION not JUSTIFICATION.

**AIDM Application**: Give EVERY major NPC (ally, rival, antagonist) traumatic backstory revealed gradually (Session 10: NPC mentions "I lost someone." Session 20: Flashback reveals WHAT happened. Session 30: Trauma drives NPC's BETRAYAL or SACRIFICE). Trauma should: (1) Explain motivations, (2) Create sympathy even for villains, (3) NOT excuse evil actions (players debate "Was villain justified?"), (4) Drive character arcs (healing, revenge, redemption, or descent).

---

### Trope 3: Escalating Threats (ENABLED - Exponential Stakes)

Code Geass REFUSES plateau. **Episode 1**: Lelouch vs Britannian soldiers (squad-level threat). **Episode 8**: Lelouch vs Cornelia's army (thousand-soldier battles). **Episode 18**: Black Rebellion (Japan vs Britannia, nation-level war). **Episode 25 R1**: Lelouch LOSES (rebellion crushed, allies scattered, Lelouch amnesiac). **R2 Episode 1**: RESET but higher baseline (now student council knows secrets, stakes already elevated). **R2 Episode 21**: Lelouch vs father Charles (reality-warping Geass battle in World of C, METAPHYSICAL stakes). **R2 Episode 25**: Zero Requiem (reshapes GLOBAL politics, Lelouch martyrs self to unite world).

**Threat Types Scale**: Personal (Nunnally endangered) → Political (rebellion leadership) → Military (Black Knights vs Britannian Empire) → Existential (Charles erasing human consciousness via Ragnarök Connection) → Global (Schneizel's Damocles with 3,000 FLEIJAs threatening world annihilation) → Philosophical (what IS justice? peace via tyranny?). Each arc RAISES ceiling.

**Power Creep**: Geass evolves (single-use → permanent → area-effect → reality manipulation → Code immortality). Knightmares escalate (Glasgow basic mecha → Lancelot super-prototype → Guren S.E.I.T.E.N. custom → Lancelot Albion flying fortress → Damocles floating continent). ALWAYS bigger threat looming.

**Why It Works**: Escalation serves THEME (Lelouch's methods create MORE problems, requiring BIGGER solutions, spiral continues until Zero Requiem breaks cycle). Not arbitrary—each threat is CONSEQUENCE of prior victory (Black Rebellion succeeds → Charles intervenes personally, Lelouch kills Charles → Schneizel seizes power, Lelouch defeats Schneizel → becomes demon emperor requiring assassination).

**AIDM Application**: Session 1-5: Local threats (bandits, corrupt noble, town crisis). Session 6-10: Regional (warlord, kingdom politics, civil war brewing). Session 11-15: National (full-scale war, king vs rebels, PCs choose side). Session 16-20: Continental (empire vs alliance, multiple nations, global stakes). Session 21-25: Existential (ancient evil awakens, reality threatened, philosophical crisis). EACH tier is consequence of PREVIOUS tier (solved bandit problem → exposed noble corruption → civil war ignited → empire intervened → awakened sealed evil). Players feel RESPONSIBLE for escalation.

---

### Trope 4: Mystery Box (ENABLED - Geass Rules + Conspiracy Layers)

Code Geass parcels out lore SLOWLY. **Geass Mechanics**: Episode 1: "Eye contact command, absolute obedience" (basic rule). Episode 7: "Once per person limitation" (revealed via failure—Lelouch tries commanding same soldier twice, DOESN'T work). Episode 12: "Can evolve" (Lelouch's Geass spreads to both eyes). R2 Episode 1: "Becomes permanent if overused" (Lelouch must wear contact lens, accidental activations). R2 Episode 19: "Code grants immortality, stops Geass" (C.C.'s backstory). R2 Episode 21: "Geass comes from collective unconscious realm" (World of C revealed). Series ENDS without explaining: WHERE does Geass ORIGINATE? (implied ancient, never confirmed).

**Political Conspiracy**: Episode 1: Lelouch exiled for "unknown reason." Episode 5: Mother Marianne assassinated (who? why?). Episode 15: Geass Order exists (C.C./V.V. lead cult of contractors). Episode 24: V.V. is Charles' twin brother (immortal Code-bearer, orchestrating events). Episode 46 R2: Charles/Marianne planned Ragnarök Connection (merge human consciousness to eliminate lies). Each answer raises THREE questions.

**C.C.'s Identity**: Real name NEVER revealed (she whispers it to Lelouch Episode 48 R2, camera cuts to visual metaphor, audience doesn't hear). Backstory revealed Episode 15 R2 (slave, given Geass, killed mentor to take Code, immortal suffering). But: How OLD? Centuries? Millennia? WHAT civilization gave first Geass? NEVER answered. Intentional ambiguity.

**AIDM Application**: Create mystery LAYERS (surface question → partial answer revealing deeper mystery). Example: PCs investigate "Why are villagers disappearing?" → Discover cult kidnapping them → Cult serves ancient entity → Entity seeks vessel for resurrection → Resurrection requires PCs' bloodline → Bloodline tied to world's CREATION → Creation was prison for entity → WHO imprisoned it? WHEN? WHY? (NEVER fully answered, campaign ends with implications). Reveal 70% of mysteries (satisfying), preserve 30% ambiguous (discussion fuel).

---

### Trope 5: Power of Friendship (SUBVERTED - Weaponized Bonds)

Code Geass INVERTS standard anime friendship. Lelouch has "friends" (Student Council: Rivalz, Milly, Nina, Shirley) but USES them (alibis for Zero activities, social camouflage, information sources). Episode 14: Shirley confesses love to Lelouch, learns he's Zero, father died in Lelouch-caused landslide—Lelouch GEASSES her to forget ("Forget Lelouch is Zero, forget you love him") rather than trust her. Bonds are LIABILITIES not strengths.

**Black Knights**: Lelouch CLAIMS camaraderie ("We fight together!") but inner monologue reveals CALCULATION ("Kallen is useful soldier, Tamaki is expendable bait, Ohgi's trust makes him controllable"). Episode 19 R2: Black Knights betray Lelouch (Schneizel reveals Zero's Geass manipulation, they turn on him). Lelouch's response: "I USED you. You're right to hate me. But I achieved results." NO friendship saves him—tactical failure.

**Suzaku Exception**: Lelouch's ONE genuine friend (childhood bond, pre-exile), but ideology SPLITS them (Lelouch rebellion, Suzaku loyalty). Friendship makes conflict WORSE (both know each other's tactics, weaknesses, can't fully commit to killing other until R2 finale). Episode 25 R2: Suzaku kills Lelouch (Zero Requiem plan) BECAUSE of friendship (only Suzaku can do it, Lelouch trusts ONLY Suzaku with this). Love doesn't SAVE—it DESTROYS.

**Why Subversion Works**: Code Geass is SEINEN-adjacent (psychological thriller, moral complexity). Traditional "power of friendship" feels naive in world of geopolitical chess, mind control, and utilitarianism. Lelouch's isolation is TRAGIC (creates perfect world for Nunnally but ALONE, no one to share victory). Zero Requiem requires SACRIFICE of all bonds (dies hated, only Suzaku/C.C. know truth).

**AIDM Application**: Let players FORM bonds (allies, lovers, found family) then TEST them (ally's goals conflict with PC's, lover endangered if PC continues campaign, found family must choose side in civil war). Friendship is STRENGTH (mechanical bonuses: advantage when fighting beside trusted ally, inspiration via bonds) AND weakness (enemies exploit—kidnap loved one, blackmail via friend, force trolley problem "Save ally OR complete mission"). Bonds should COMPLICATE not simplify. Zero "power of friendship wins" moments—every relationship has COST.

---

### Trope 6: Rapid Tonal Shifts (ENABLED - Whiplash as Feature)

Code Geass WEAPONIZES mood shifts. **Episode 22 R1 Structure**: (0:00-8:00) School cultural festival, Lelouch dressed as PIZZA delivery mascot (comedy, lighthearted, student council shenanigans). (8:00-12:00) Euphemia announces Japan Special Administrative Zone (hopeful, diplomatic solution, bloodless peace possible). (12:00-18:00) Lelouch and Euphemia private conversation, Lelouch JOKES "I could just order you to kill all Japanese" while explaining Geass—Geass activates ACCIDENTALLY (horror, Lelouch realizes mistake). (18:00-25:00) Euphemia OBEYS, orders massacre, Lelouch forced to kill her to stop Geass, Black Rebellion begins (tragedy, war, Euphemia's blood on Lelouch's hands). FOUR TONES 25 minutes.

**R2 Episode 14**: Opens with Lelouch/Shirley date (wholesome romance, Shirley accepts Lelouch is Zero, forgives him, confesses love again). Mid-episode: Jeremiah (Geass-canceled) triggers Shirley's restored memories (psychological horror—flashbacks to erased trauma). Final act: Shirley shot by Rolo (Lelouch's "brother" protecting secret), dies in Lelouch's arms confessing love (tragedy). Romance → Horror → Tragedy 20 minutes.

**Purpose**: Reflects Lelouch's DUAL LIFE (student by day, terrorist by night—cannot maintain separation, worlds collide). Tonal shifts ENHANCE tragedy (happiness makes loss hurt MORE—if Shirley scene was pure drama, death less impactful; comedy setup makes tragedy DEVASTATING). Mirrors chaos of war (soldiers have downtime, laugh, then battle—Code Geass refuses sanitized war).

**AIDM Application**: Allow tonal variance WITHIN sessions (Session 3 hours: 30min tavern comedy → 60min dungeon tension → 45min NPC betrayal tragedy → 45min philosophical debate post-battle). Signal shifts (music change in Foundry VTT, "Scene shifts, tone changes" narration, handout for new scene). Players should feel WHIPLASH—laughing one moment, horrified next, debates later. Don't force consistency—life has comedy/tragedy/philosophy simultaneous.

---

### Trope 7: Inner Monologue (ENABLED 10/10 - Dual Narration Core)

Code Geass uses inner monologue as PRIMARY storytelling. **Lelouch's Calculations**: Episode 3 Battle of Shinjuku: (Aloud) "All forces, advance on enemy position." (Inner) "Cornelia will predict frontal assault. So I'll feint left, but my REAL attack is submarine from underwater route. She'll expect submarine because I used it last time. So submarine is ALSO feint. Actual plan: Geass her bodyguard to shoot her mid-battle. If bodyguard resists, Plan B: landslide trap. If landslide fails, Plan C: hostage exchange." VIEWERS hear 4-layer plan WHILE Lelouch gives simple order.

**Suzaku's Guilt**: Episode 18: (Aloud to Euphemia) "I'll protect you, Princess." (Inner) "I killed my father to end war. Now I enable Britannia's conquest. Am I hero or traitor? Does atonement via service matter if I'm enabling oppression? Should I die? I WANT to die. But Euphemia needs me. I'm trapped." Self-loathing narrated silently while maintaining stoic facade.

**Dual Perspectives**: Episode 19 R2: Schneizel and Lelouch command opposing fleets. (Schneizel inner) "Lelouch will flank left—his preferred tactic. I'll counter with..." (Lelouch inner) "Schneizel expects left flank. I'll actually go RIGHT. But he knows I know he expects left, so he'll prepare for right. So I'll TRIPLE-BLUFF and go left anyway—" BOTH shown simultaneously, chess match visible to audience.

**Why Essential**: Code Geass is MENTAL warfare—physical action is execution of THOUGHT. Without inner monologue, battles look random (why did Lelouch retreat? why Geass THIS soldier not THAT one?). Monologue provides (1) Strategic insight (players learn tactics), (2) Character depth (Lelouch's guilt hidden behind mask), (3) Suspense (plan revealed AFTER execution—"So THAT'S why he...").

**AIDM Application**: Encourage player narration of PC thoughts ("Aloud I say 'I trust you,' but THINKING 'You're lying, I'll investigate later'"). DM narrates NPC inner monologues ("The baron smiles and agrees... but you notice his hand tightens on sword hilt. He's planning betrayal."). Post-battle reveals: "Remember when PC did X? Here's what you were REALLY doing..." (player explains scheme AFTER execution, table reacts "OHHH that's why!"). Create dramatic irony (audience knows Lelouch is Zero watching L close in, suspense from "Will he figure it out?").

---

### Trope 8: Existential Philosophy (ENABLED - Every Arc Debates Meaning)

Code Geass is philosophical THESIS. **Central Question**: Do ends justify means? **Lelouch's Answer**: YES (will manipulate, murder, mind-control to create gentle world for Nunnally, Zero Requiem martyrdom proves commitment). **Suzaku's Answer**: NO (means matter MORE than ends, reform from within even if slow, honor above victory). **Schneizel's Answer**: RESULTS ONLY (utilitarianism extreme—will nuke millions if math says net positive, emotionless calculus). **Charles' Answer**: TRANSCEND (eliminate lies by merging consciousness, render question obsolete).

**Justice Debate**: Episode 17: Lelouch "Justice is what I make it. Britannian 'justice' oppresses. I'll create NEW justice via revolution." Suzaku "Justice must be EARNED via proper means. Revolution births new tyranny." NO resolution—both partially right, both partially wrong. Series ends: Zero Requiem works (world unites) BUT cost is enormous (Lelouch dies hated, Euphemia/Shirley dead, millions died in wars Lelouch started).

**Peace Through Tyranny**: Lelouch becomes DEMON EMPEROR (arrests dissenters, public executions, Geasses world leaders, totalitarian state) to unite world AGAINST him. Martyrdom = peace. Trolley problem EXTREME: Is mass suffering acceptable if ENDS war forever? Code Geass presents question, lets audience decide (fandom splits: "Lelouch hero" vs "Lelouch monster").

**Free Will vs Geass**: If Lelouch can command absolute obedience, do victims have agency? Euphemia massacre: She didn't CHOOSE genocide, Geass forced her. Is she innocent? (YES: mind-controlled.) Is Lelouch guilty? (YES: his power, his accident, his kill order.) Moral responsibility when free will violated = explored but never fully answered.

**AIDM Application**: Integrate philosophy into PLOT not lectures. Present trolley problems: "Save village (100 lives) or let enemy escape with intel (could save THOUSANDS later)?" NPCs debate player's choices ("You sacrificed innocents. Are you hero or monster?" vs "You made hard choice. That's leadership."). No campaign-endorsed answer—DM presents DILEMMA, players decide, NPCs REACT based on beliefs, consequences unfold. Final arc question: "What IS victory? What SHOULD players sacrifice for it?" Let players choose, honor choice, show COST.

---

### Trope 9: Plans Within Plans (ENABLED - Contingency Obsession)

Lelouch's plans have plans. **Episode 8 Structure**: PRIMARY PLAN: Lure Cornelia to mountain pass, trigger landslide, crush army. CONTINGENCY 1: If Cornelia evacuates, Geass her bodyguard to shoot her. CONTINGENCY 2: If bodyguard resists Geass (drug/mental training), hostage negotiation (captured Britannian nobles). CONTINGENCY 3: If hostages fail, submarine escape route pre-positioned. CONTINGENCY 4: If submarine compromised, Lancelot (Suzaku) engaged as distraction for Black Knights retreat. FIVE layers ONE battle.

**Zero Requiem Long Con**: Planned Episodes 19-25 R2 (7 episodes). STEP 1: Become Emperor (seize throne via Geass, seems like power grab). STEP 2: Create tyranny (mass Geass, public executions, unite world AGAINST him). STEP 3: Position Suzaku as "Zero II" (secret ally, will "assassinate" Lelouch). STEP 4: Stage public execution (Lelouch dies, world cheers, peace achieved via common enemy). STEP 5: Suzaku continues as Zero (symbol of justice, Lelouch's legacy). REQUIRES: (A) Suzaku's cooperation (negotiated), (B) Schneizel Geassed into obedience (backup if plan fails), (C) World leaders' hatred (cultivated via tyranny), (D) Nunnally safe (ensured), (E) C.C.'s survival (she carries Lelouch's memory). Each component has SUB-PLAN.

**Why Complexity Works**: Reflects Lelouch's GENIUS (viewers feel awe), creates SUSPENSE (what's the REAL plan?), allows ADAPTATION (when Plan A fails, B/C/D exist—Lelouch never fully defeated until FINAL failure). Risks: TOO complex = audience lost (Code Geass occasionally DOES this—Episode 25 R1 has 8 concurrent plot threads, confusing). Balance needed.

**AIDM Application**: Let players PRE-PLAN contingencies ("If negotiation fails, I'll..."). DM tracks, allows activation ("Negotiation fails. Your contingency?"). REWARD planning (advantage on checks if planned). PUNISH rigidity (enemy adapts, overly-specific plan backfires if circumstances change). Structure: PRIMARY goal + 2-3 contingencies (more = unmanageable). Example mission "Assassinate Baron": PRIMARY (poison wine at feast), CONTINGENCY 1 (sniper if poison detected), CONTINGENCY 2 (escape route via sewers), CONTINGENCY 3 (ally inside provides distraction if caught). Each layer costs RESOURCES (time, gold, favors)—players balance depth vs cost.

---

### Disabled Tropes Analysis

**Slice-of-Life OFF**: School scenes serve PLOT (alibis for Zero, relationship manipulation, information gathering). Episode 7 student council pool party: Lelouch attends (appears normal student) WHILE Black Knights execute operation (simultaneously shown). NO "beach episode" without strategic purpose. Even cultural festival (seemingly filler) is COVER for rebellion planning.

**Tournament Arcs OFF**: Code Geass is WAR not sport. No "Knightmare battle tournament" (though spinoff manga has this). Combat is LETHAL, strategic, political—not competitive entertainment.

**Fourth Wall Breaks OFF**: ZERO meta humor. Lelouch never addresses audience. No "this is anime logic" jokes. Serious tone maintained (comedy exists but WITHIN world).

**Mundane Made Epic OFF**: Inverse—EPIC made strategic. Giant robot battles are CHESS MATCHES (terrain, formations, feints). Geass reality-warping is TOOL not spectacle. Even godhood confrontation (Lelouch vs Charles in World of C) is DEBATE ("Your philosophy vs mine") not Dragon Ball beam clash.

---

---

## Pacing Rhythm

**Scene Length**: Medium-Long Strategic (3-8 minutes per scene, dialogue-heavy) - Code Geass LINGERS on conversations. Strategic planning scenes run 5-8 minutes (Lelouch explaining operation to Black Knights, Schneizel analyzing fleet positions, Charles' Ragnarök philosophy exposition). Battle scenes COMPRESSED tactically (2-3 minutes setup → 1-2 minutes execution → 3-5 minutes aftermath/consequences). Emotional scenes given WEIGHT (Shirley's death 6-minute sequence including discovery/confession/dying/Lelouch's reaction, Euphemia's death 8-minute tragedy from massacre order through Lelouch shooting her through aftermath).

Scenes are DIALOGUE engines—Episode 17 Kururugi Shrine debate is 12 MINUTES of Lelouch vs Suzaku philosophical argument (no action, pure ideological clash). Episode 21 R2 (World of C confrontation) is 15 minutes of Lelouch/Charles/Marianne debating reality, lies, and Ragnarök Connection (metaphysical, no punches thrown). Contrast: Typical mecha anime has 60% battle, 40% dialogue—Code Geass INVERTS (40% battle execution, 60% strategy/philosophy/character).

**Arc Length**: Medium Concentrated (8-15 episodes per major arc with RAPID internal escalation) - **Black Rebellion Arc** (Episodes 18-25 R1: 8 episodes): Japan uprising formation → Initial victories → Euphemia massacre trigger → Full-scale war → Britannian counteroffensive → Lelouch's gambit → Zero Requiem prototype fails → Catastrophic defeat. **Emperor Arc** (Episodes 1-8 R2): Lelouch amnesiac → Memory restoration → Retake Black Knights → Become Viceroy → Political maneuvering → Betray Britannian and seize Chinese Federation. **Zero Requiem Arc** (Episodes 19-25 R2: 7 episodes): Become Emperor → Global tyranny → Schneizel's Damocles threat → Final confrontation → Staged assassination → Peace achieved.

Each arc is DENSE—Episode 22 R1 alone contains (1) school festival, (2) Japan Special Administrative Zone announcement, (3) accidental Geass massacre, (4) Euphemia's death, (5) Black Rebellion begins. FIVE paradigm shifts 25 minutes. NO breathing room—next episode continues WITHOUT pause.

**Filler Tolerance**: Near-Zero With Strategic Purpose - Code Geass has MAYBE 2-3 "slower" episodes (Episode 12 R1 school festival focus, R2 Episode 11 C.C.'s Rebirth recap) but EVEN these plant seeds (Episode 12: Lelouch promises Euphemia "I'll make you happy"—inverted Episode 22 when he kills her). Recaps exist (Episode 8.5 R1, Episode 17.5 R2) but are SUMMARY episodes not filler (compressed 8 episodes into 24 minutes, new viewers can catch up).

"School scenes" look like slice-of-life BUT serve dual purpose: (1) Strategic (alibis, information gathering, social camouflage), (2) Dramatic irony (audience knows Lelouch plotting revolution while student council plans festival—tension from collision course). Episode 3: Swimming pool scene is FAN SERVICE (yes) but ALSO Lelouch establishing alibi WHILE Black Knights execute mission shown simultaneously (split-screen: bikinis left side, terrorism right side—tonal whiplash).

**Climax Frequency**: High Concentrated (Major twist/battle/reveal every 2-3 episodes) - Code Geass is CLIMAX MACHINE. Episode 5: Lelouch captures Cornelia's forces. Episode 7: Lancelot appears (Suzaku revealed as ace pilot). Episode 10: Lelouch uses Geass on Euphemia (first moral corruption). Episode 14: Shirley learns Zero's identity (erased via Geass). Episode 17: Lelouch/Suzaku ideological break. Episode 22: Euphemia massacre + death. Episode 25: Black Rebellion crushed + Lelouch defeated.

R2 maintains pace: Episode 3: Lelouch becomes Emperor. Episode 8: Betrays Britannian at wedding. Episode 13: Shirley dies. Episode 19: Lelouch vs Schneizel fleet battle. Episode 21: Kills father Charles. Episode 25: Zero Requiem executed. AVERAGE: 1 major climax per 2.5 episodes (37 episodes ÷ ~15 climaxes). Compare: Most anime 1 climax per 6-8 episodes.

**Downtime Ratio**: 20% (False Calm Before Storm) - Code Geass structure: 80% HIGH STAKES (battles, political crisis, betrayals, deaths, revelations) vs 20% LOWER STAKES (school scenes, character bonding, strategic planning without immediate threat). BUT downtime is LOADED—student council scenes build relationships (making Shirley's death hurt), planning scenes are TENSE (waiting for battle), philosophical debates have WEIGHT (ideological war parallel to physical).

"Downtime" also serves dramatic irony: Lelouch laughing at school festival WHILE genocide unfolds elsewhere, Suzaku's peaceful moment with Euphemia hours before accidental Geass massacre. Calm is ILLUSION—threat always looming, next crisis 5 minutes away. Comparable to Death Note (15% downtime), Attack on Titan (10%), LESS than most anime (30-40% standard).

---

## Tonal Signature

**Primary Emotions** (Top 7):
1. **Anticipation / Suspense** - CORE emotion. Waiting for Lelouch's plan to unfold (What's he REALLY doing? Will it work?), L-equivalent closing in (Does Cornelia suspect? Will Schneizel figure it out?), timers TICKING (Geass activating in 10 seconds, enemy reinforcements arriving in 5 minutes, Fleija countdown). Episode 19 R2: Dual fleet battle—BOTH commanders predicting moves, audience KNOWS strategies, suspense from "Who predicted DEEPER?" Comparable to Death Note (potato chip scene tension), chess match where BOTH players are grandmasters.

2. **Intellectual Satisfaction / "Just As Planned"** - Payoff emotion. Lelouch's plan REVEALED post-execution ("So THAT'S why he...!"), pieces falling into place (Episode 8: landslide wasn't main plan, Geass on bodyguard was), audience piecing together BEFORE full reveal (rewatching finds foreshadowing). Fans coined "ALL ACCORDING TO KEIKAKU" (keikaku=plan) meme from Code Geass—intellectual pleasure of watching genius tactics unfold. Similar to Death Note (L's deductions), Sherlock (case solutions).

3. **Tragedy / Inevitable Loss** - Lelouch CAN'T save everyone. Euphemia (wanted peace, Geassed into genocide, Lelouch forced to kill her—triple tragedy), Shirley (forgives Lelouch, dies confessing love, Lelouch CAN'T Geass heart attack away), Rolo (seeks Lelouch's love, betrayed, dies protecting Lelouch anyway). Suzaku's suicide-by-battle (wants death, too skilled to die, survives as curse). Zero Requiem (only way to peace is Lelouch dying HATED). Greek tragedy structure—flaws lead to downfall, audience sees it coming, CAN'T stop it.

4. **Moral Conflict / Ethical Vertigo** - No easy answers. Is Lelouch RIGHT? (Revolution needed BUT methods horrific.) Is Suzaku RIGHT? (Honor important BUT enables oppression.) Is Zero Requiem GOOD? (Achieves peace BUT built on lies and corpses.) Euphemia massacre: ACCIDENT but Lelouch uses it (pragmatism vs monstrosity). Players ARGUE in comments—15+ years, still debating "Was Lelouch hero or villain?" Code Geass REFUSES resolution—presents DILEMMA, lets audience wrestle.

5. **Exhilaration / Strategic High** - Mecha battles GORGEOUS (Lancelot acrobatics, Guren's radiation wave melting enemies, Knightmare parkour through Tokyo), Geass activations DRAMATIC (eye glows red, command ABSOLUTES, victim's will SHATTERED), tactical victories EARNED (Lelouch outsmarts Cornelia, underdog Black Knights defeat superior Britannian forces). Soundtrack peaks (Jibun Wo, Colors, O2), sakuga animation (CLAMP character designs, Sunrise mecha choreography). Adrenaline spikes—fist-pump moments when plan WORKS.

6. **Dread / Corruption Descent** - Watching Lelouch FALL. Episode 1: Idealistic ("I'll destroy Britannia for Nunnally!"). Episode 14: Pragmatic (Geasses Shirley to forget—violates friend). Episode 22: Monstrous (Uses Euphemia massacre politically despite GUILT). R2 Episode 21: Tyrant (Mass-Geasses stadium, public executions, totalitarian). Viewer watches hero BECOME villain—uncomfortable, tragic, INEVITABLE given power/trauma. Similar to Walter White (Breaking Bad), Light Yagami (Death Note). Can't look away from trainwreck.

7. **Catharsis / Bittersweet Resolution** - Zero Requiem WORKS. Lelouch dies (tragic) BUT achieves peace (hopeful). World united (positive) via his martyrdom (sacrifice). Suzaku lives (survives) but as Zero II (mask forever, identity dead). Nunnally happy (Lelouch's goal) but thinks brother was monster (lie maintained). C.C. free (potentially mortal) but ALONE (Lelouch gone). EVERY victory has cost. Audience cries (Lelouch's death) and cheers (peace achieved) SIMULTANEOUSLY. Emotional whiplash resolution—earned via 50-episode buildup.

**Violence Level**: Medium (6/10: Mecha destruction, Geass-forced suicides, war casualties shown but not GORY) - Knightmare battles show pilots DYING (explosions, cockpit crushed, scream cut short) but NOT graphic (no blood spray, bodies dissolving, viscera). Geass suicides clinical (soldier ordered "Die" shoots self, falls—cut away). Euphemia massacre IMPLIED (Japanese civilians running, screaming, gunfire SFX) not SHOWN on-screen (camera stays on Lelouch's horrified face OR Euphemia's Geassed eyes). Fleija nukes vaporize (white flash, structures disintegrate, silhouettes fade—sterile destruction). 

TONE is horror (psychological weight of deaths, Lelouch's guilt, casualty counts stated "10,000 dead") NOT gore (Attack on Titan-style visceral dismemberment). Comparable to Gundam (war casualties shown, not gratuitous), LESS graphic than AOT/Vinland Saga (brutal realism), MORE serious than Pokemon (bloodless).

**Fanservice Level**: Medium (5/10: CLAMP designs emphasize aesthetics, occasional bath/swimsuit scenes, but NOT hentai-adjacent) - Female character designs are TALL, THIN, STYLIZED (Kallen, C.C., Euphemia, Cornelia—noodle limbs, improbable proportions, aesthetic over realism). Swimsuit episode EXISTS (Episode 3: pool party, bikinis, camera angles), bath scenes occasional (C.C. bathing, Kallen shower—strategic framing hides explicit). 

BUT fanservice is TONAL DISSONANCE not focus—pizza-butt joke (C.C. eating pizza in bathtub—meme-tier), Kallen's pilot suit (bunny-girl aesthetic—inexplicable), Milly's antics (forces Lelouch into costumes). 2000s anime standard (fanservice common) NOT modern isekai level (DanMachi, Mushoku Tensei—constant). Code Geass's fanservice feels DATED—modern rewatch audiences note "This aged poorly" re: male gaze camera.

**Horror Elements**: Psychological (7/10: Geass violations, moral corruption, identity death) - **Geass Horror**: Absolute mind control (free will ERASED, victims AWARE but can't resist—Euphemia KNOWS she's ordering genocide, CANNOT stop, tears streaming while smiling and commanding massacre). Soldiers Geassed to suicide (lucid until trigger word, then COMPELLED—loved ones watch helpless). Jeremiah's Geass Canceller (forcibly restores erased memories—victims relive TRAUMA instantly, psychological whiplash).

**Identity Horror**: Lelouch's dual life (student/Zero masks crack, neither fully real, WHO is he?), Suzaku's death-seeking (wants to die, body WON'T let him—survival instinct vs conscious desire), Rolo's manufactured childhood (implanted memories, realizes family FAKE, existential crisis). **Corruption Horror**: Watching Lelouch descend (Episode 1 idealist → Episode 50 tyrant, WHEN did he cross line? Can't pinpoint—boiling frog).

**Existential Horror**: Charles' Ragnarök Connection (erase individual consciousness, merge into collective—DEATH of self while technically "alive"), World of C (metaphysical realm where dead exist but CAN'T rest, Marianne's "I never died" reveal—implications HORRIFYING).

**Optimism Baseline**: Low-Medium (3/10 optimism, 7/10 cynicism with HARD-EARNED hopeful resolution) - World is CRUEL (Britannia oppresses, social Darwinism official policy, "survival of fittest" ideology, Numbers are subhuman). Effort DOESN'T guarantee success (Euphemia's peace zone FAILS via accident, Shirley's forgiveness WASTED via death, Lelouch's rebellion CRUSHED Episode 25 R1). "Good intentions" pave road to hell (Suzaku enables tyranny trying to reform, Lelouch becomes tyrant trying to free).

BUT: Zero Requiem SUCCEEDS. Peace achieved. Nunnally happy. Cycle broken (implied). Hopeful ending via MAXIMUM cynical sacrifice (Lelouch dies hated, Suzaku lives masked, truth hidden). Message: Change POSSIBLE but costs EVERYTHING. World CAN improve if you pay price (your reputation, your life, your soul). Contrast: Attack on Titan (2/10: cycle continues, Paradis bombed), One Piece (8/10: dreams come true, friendship wins), Code Geass (3/10: hope exists but BURIED under corpses and lies).

---

## Dialogue Style

**Formality Default**: Formal Hierarchical (Military + Nobility Protocol) - Characters address by TITLE/RANK: "Your Highness" (royalty), "Your Majesty" (Emperor), "Commander" (Lelouch as Zero), "Sir Kururugi" (Suzaku formal address), "Lady Stadtfeld" (Kallen's cover identity). Britannian nobility speaks ELEVATED ("One must consider the ramifications..."), military reports are CLIPPED ("Enemy forces sighted, 3 o'clock, 2000 meters"), student council is CASUAL ("Lulu, you're late again!").

Formality BREAKS signal intimacy/crisis: Lelouch calls C.C. "C.C." not "Miss C.C." (bond established), Suzaku calls Lelouch "Lelouch" not "Prince Lelouch" (childhood friends), Schneizel's "Brother" to Lelouch (sibling familiarity despite politics). BREACH of formality = plot point (soldier failing to salute = exhaustion/trauma, Lelouch addressing Emperor Charles directly = defiance).

Japanese characters mix formal Japanese + English (subtitles show honorifics: "Zero-sama," "Lelouch-kun" retained). Britannians speak British English-coded (posh accents, "quite," "rather"). Cultural code-switching: Kallen is formal as "Stadtfeld" (Britannian cover), casual as "Q-1" (Black Knights—real self).

**Exposition Method**: Post-Execution Reveals ("Just As Planned" Structure) - Lelouch explains plans AFTER they succeed (mystery during execution → revelation after). Episode 8: Landslide triggers, Cornelia escapes, Lelouch smiles. CUT TO: Flashback 3 days prior, Lelouch: "Landslide is BAIT. Real plan is Geass her bodyguard." Audience: "OHHH." Technique creates (1) Suspense (what's he doing?), (2) Satisfaction (reveal clicks pieces together), (3) Lelouch appears GENIUS (predicted 8 variables).

Strategic explanations use CHESS METAPHORS: "If Cornelia is Queen, her bodyguard is Bishop. Remove Bishop, Queen is exposed. Checkmate in 5 moves." Visual diagrams shown (map with arrows, fleet positions, tactical overlays). L-equivalents ALSO explain (Schneizel: "Lelouch will feint left. I'll prepare right. But knowing Lelouch, he expects my counter, so he'll...") creating dual-layer exposition (both sides thinking aloud).

Geass rules explained GRADUALLY via demonstration: Episode 1 shows effect (absolute obedience), Episode 3 states limitation (eye contact required), Episode 7 reveals restriction (once per person), Episode 12 shows evolution (both eyes). NO infodump—LEARN via use.

**Banter Frequency**: Medium Situational (20% school comedy, 5% battlefield quips, 0% fourth-wall) - School scenes have LIGHT banter (Rivalz teasing Lelouch about mystery girl, Milly's schemes, Nina's awkwardness, Lelouch's terrible luck with cats). Tone: Slice-of-life SURFACE masking Zero's double-life TENSION.

Battlefield banter RARE and CHARACTER-SPECIFIC: Kallen (serious soldier, no jokes), Tamaki (comic relief, brash comments, provides levity), Lelouch as Zero (NEVER jokes—maintains mystique), Suzaku (earnest, no quips). Exception: C.C. (dry wit, teases Lelouch about pizza, immortal ennui humor). Episode 14: C.C. mid-battle casualy eating pizza while Lelouch stresses—absurdist humor via contrast.

NO Marvel-style quipping (characters don't joke DURING tragedy—Euphemia's death has ZERO comedy, Shirley's death is PURE tragedy). Tonal shifts exist (comedy ADJACENT to tragedy) but NOT MIXED (school festival comedy THEN massacre, not "massacre with jokes").

**Dramatic Declarations**: CONSTANT (Lelouch's Commands + Philosophical Proclamations) - **Geass Commands**: Lelouch's orders are THEATRICAL. "I, Lelouch vi Britannia, COMMAND YOU!" (full name, royal title, caps-lock energy). "You will OBEY me!" "Die!" "Forget!" Dramatic voice acting (Jun Fukuyama in Japanese: menacing whisper → EXPLOSIVE command; Johnny Yong Bosch in English: cold fury). Geass eye GLOWS (red bird symbol radiates), dramatic sting music, target's eyes dilate (absolute obedience).

**Revolutionary Declarations**: Zero's speeches to Black Knights. "We are the ones who stand against Britannian tyranny!" "Today, Japan reclaims its freedom!" "All Hail Britannia" (ironic—Lelouch mocking empire). Emperor Charles' "Britannia alone moves forward! Britannia alone DESERVES to rule!" Schneizel's calm "I will create a perfect world. Emotions are the enemy." Suzaku's "I'll change Britannia FROM WITHIN!" 

Declarations serve (1) Character ideology (Lelouch theatricality vs Schneizel's clinical logic), (2) Narrative emphasis (key moments UNDERLINED via dramatic speech), (3) Memetic impact (fans quote "ALL HAIL LELOUCH!" unironically 15 years later).

**Philosophical Debates**: Frequent Deep (30% of dialogue is ideology clash) - Lelouch vs Suzaku (ends vs means, revolution vs reform, freedom vs order). Episode 17 Kururugi Shrine: 12-MINUTE debate, NO action, pure philosophy. Lelouch "Results matter. Your 'proper means' lets people DIE while you play by rules." Suzaku "Your 'any means necessary' makes you MONSTER. You're becoming what you hate." BOTH valid—series REFUSES answer.

Charles vi Britannia social Darwinism: "Inequality is truth. The strong rule. The weak perish. This is natural order." Lelouch counters "Inequality is SYSTEM. We can change system." Ragnarök Connection debate (Episode 21 R2): Charles "Lies cause all suffering. I'll eliminate lies by merging consciousness." Lelouch "Lies protect kindness. Truth without context is cruelty. Your 'honesty' erases humanity."

Debates are CHARACTER DEFINING: Lelouch uses RHETORIC (persuasive, emotional appeals, logical traps), Suzaku uses IDEALS (honor, duty, moral absolutes—sometimes hypocritical), Schneizel uses MATH (utilitarian calculus, "1 million dead vs 10 million saved = net positive"). Philosophy INFORMS tactics (Lelouch manipulates because "ends justify means," Suzaku refuses dirty tactics because "means define us").

**Awkward Comedy**: Minimal But Pointed (5% total, concentrated in school scenes) - Lelouch's terrible luck: Dressed as PIZZA mascot (Episode 22), loses bets and forced into cat costume (Episode 12), C.C.'s constant pizza demands ("I require pizza" mid-crisis). Arthur the cat stealing Zero's mask (slapstick—Lelouch chasing cat through school). Milly's schemes backfire (forces Lelouch into crossdressing, couples games, embarrassing situations).

Shirley's crush played for comedy EARLY (clumsy confessions, misunderstandings, love triangle with C.C. implied) then TRAGEDY (father dies, learns Lelouch is Zero, forgives him, gets memory erased, remembers again, DIES—comedy setup makes tragedy WORSE). Suzaku/Euphemia romance is WHOLESOME not comedic (gentle, pure, DOOMED—Lelouch kills Euphemia, Suzaku never recovers).

Nina's obsession with Euphemia played as CRINGE (table-kun incident—fan infamous, deeply uncomfortable "comedy"?), later becomes DANGEROUS (Nina builds Fleija nuke fueled by grief/obsession—comedy twisted to horror). Code Geass uses awkward comedy as TONAL CONTRAST then WEAPONIZES it (your laughter makes later tragedy hurt more).

---

## Combat Narrative Style

**Strategy vs Spectacle**: 9/10 HEAVY strategy (Tactics SOLVE battles, spectacle is EXECUTION of plan) - Knightmare battles look like mecha action BUT are CHESS. Episode 8: Lelouch's landslide isn't brute force—it's (1) Terrain analysis (mountain pass narrows enemy formation), (2) Intelligence (leaked false intel so Cornelia enters trap), (3) Timing (trigger landslide when maximum enemy concentration), (4) Contingency (Geass backup if landslide fails). TACTICS win, not firepower.

Lancelot (Suzaku) is SUPERIOR mecha (faster, VARIS rifle, energy shields, Blaze Luminous) but Lelouch STILL wins via strategy: Episode 5: Traps Lancelot in subway tunnel (negates mobility), floods with sleeping gas (bypasses shields), captures without fighting. Guren's radiation wave is OP BUT limited charges (3 shots per battle—Kallen must conserve, use strategically NOT spam).

Fleet battles are PURE tactics (Episode 19 R2): Lelouch and Schneizel command from flagships, ZERO personal combat. Dialogue: "Move 3rd fleet to C-4 grid. Feint assault on left flank. ACTUAL target is supply line at F-7." Camera shows chess pieces moving. Comparable to Legend of the Galactic Heroes (space opera tactics), NOT Gurren Lagann (spectacle over strategy).

**Power Explanations**: Methodical Gradual (Geass rules 70% explained, Knightmare specs DETAILED) - **Geass Mechanics**: Revealed across 50 episodes. Episode 1: Eye contact + command = absolute obedience. Episode 3: Geass SYMBOL appears (CLAMP-designed bird sigil). Episode 7: One use per person (Lelouch tries commanding same soldier, FAILS—rule learned via failure). Episode 12: Geass EVOLVES (spreads to both eyes uncontrollably). R2 Episode 1: Becomes PERMANENT (always active, requires contact lens to suppress—Lelouch's eyes hidden).

R2 Episode 19: Geass CAN BE CANCELED (Jeremiah's Geass Canceller restores free will—BUT traumatic for victim). R2 Episode 21: CODE explained (immortality, nullifies Geass, can be transferred). Series ENDS without full explanation: WHERE does Geass originate? (collective unconscious implied, never confirmed). WHY eye-based? (visual metaphor for "seeing truth" but not literal explanation).

**Knightmare Specifications**: DETAILED. Glasgow (mass-production, 5-meter, slash harkens, assault rifle—Britannian standard). Sutherland (improved Glasgow, energy wings, better mobility). Lancelot (super-prototype, VARIS rifle, Blaze Luminous shields, Hadron Cannon later—Suzaku's custom). Guren (Black Knights ace, radiation wave surger, slash harkens, pilebunker—Kallen's custom). Damocles (flying fortress, Fleija missiles, kilometers long—Schneizel's endgame weapon).

Specs matter TACTICALLY: Lancelot's energy wings allow vertical mobility (Episode 7: Scales building Knightmares can't climb). Guren's radiation wave melts ARMOR but limited charges (3 uses per sortie—must conserve for key targets). Viewers who track specs can PREDICT battles (Lancelot vs Guren = mobility vs firepower, Glasgow vs Sutherland = outclassed, etc.).

**Sakuga Moments**: Frequent Tactical (Animation peaks during KEY strategic beats) - **Lancelot vs Guren Duels**: Episode 19 R1—Kallen and Suzaku CQC (close-quarters Knightmare combat), slash harkens clash, VARIS rifle vs radiation wave, parkour through Tokyo Settlement ruins. Sakuga showcases (1) Pilot skill (Suzaku's reflexes, Kallen's aggression), (2) Mecha capabilities (Lancelot dodges mid-air, Guren melts concrete), (3) Emotional stakes (Kallen's rage vs Suzaku's guilt).

**Geass Activations**: Lelouch's eye GLOWING (crimson, bird sigil radiates), dramatic camera zoom, VA delivering COMMAND (caps-lock energy), target's eye dilates (pupils expand, awareness fades, OBEDIENCE). Music sting (ominous string crescendo). Animated with BUDGET (CLAMP character designs, fluid motion, dramatic lighting). Episode 1 first Geass: ICONIC (Lelouch orders soldiers "Die"—they shoot selves, horror + exhilaration).

**Zero Requiem Execution** (R2 Episode 25): Suzaku (as Zero) charges through parade, STABS Lelouch, blood spray (rare graphic violence—moment DEMANDS impact), Lelouch's final smile (peaceful despite pain), Nunnally touches his hand (realizes truth via Geass residue), world cheers (crowds celebrating tyrant's death), C.C. narrates epilogue (cart driver theory ambiguity). PEAK animation budget—finale EARNS sakuga.

**Named Attacks**: Mecha Weapons Named (VARIS rifle, Hadron Cannon, Radiation Wave Surger, Fleija) - Knightmare weapons have DESIGNATIONS not anime-style attack names. Lancelot's "VARIS" = Variable Ammunition Repulsion Impact Spitfire (acronym, military naming). Guren's "Radiation Wave Surger" = descriptive function (emits radiation, melts targets). Fleija = nuclear-equivalent weapon (Nina's creation, erases matter in 50km radius—scientific naming NOT "Ultimate Destruction Beam").

NO shouted attack names (characters don't yell "VARIS RIFLE BARRAGE!"—they tactical-call "Target locked. VARIS, fire."). Geass commands are SPOKEN but direct ("Die." "Obey me." "Forget.") NOT stylized (no "Death Sentence Geass Activate!"). Reflects SEINEN-adjacent tone (serious, grounded despite mecha/magic absurdity).

**Environmental Destruction**: Extreme Strategic (Cities destroyed, BUT consequences shown) - **Fleija Detonations**: Episode 18 R2—Tokyo Settlement VAPORIZED (white flash, buildings disintegrate, people fade to silhouettes, 25 million dead stated). NOT spectacle for spectacle—horror emphasized (Nina's breakdown realizing her weapon killed millions, Lelouch using Fleija politically, Schneizel threatening global annihilation). Destruction has WEIGHT (refugee crisis, economic collapse, political shockwaves).

**Knightmare Collateral**: Urban combat WRECKS infrastructure (Episode 5: Shinjuku Ghetto buildings collapse, civilians die—Lelouch's tactic causes casualties, guilt shown). Episode 19: Black Knights vs Britannian fleet—Tokyo Settlement becomes WARZONE (burning buildings, rubble, civilian evacuations). NOT sanitized (refugees flee on-screen, casualties mentioned—"400 civilians dead in crossfire"). 

Contrast: Gundam shows war destruction + rebuilding, Attack on Titan shows Titans crushing districts + aftermath horror, Code Geass shows mecha battles destroying cities + POLITICAL consequences (reconstruction costs, blame games, propaganda). Destruction is TOOL not spectacle—serves narrative (who pays for this? who's blamed? how does this change politics?).

---

---


---

## Example Scenes

### 1. Battle of Narita - Tactical Mastermind vs Military Genius

```
NARITA MOUNTAINS - Britannian forces vs Black Knights

CORNELIA (reviewing tactical map):
Intelligence reports Zero's forces at Pass C-7. We advance in 30 minutes.

DARLTON (hesitant):
The intel came from unknown source. Could be fabrication—

CORNELIA:
Zero is TERRORIST. This (taps map) is his only viable position. Standard formation—crush the terrorists.

CUT TO: BLACK KNIGHTS BASE

ZERO (to Black Knights, masked):
Cornelia expects us at C-7. But we're at C-9 Ridge—ABOVE the pass. When her forces enter, I trigger landslide charges. 8,000 cubic meters buries her vanguard.

TAMAKI:
How'd you get her to attack that exact spot?

ZERO (pauses dramatically):
I SENT her the intelligence. Three days ago, leaked false data via paid collaborator. She verified against satellite—confirmation bias. She thinks she's cornered us. In truth, she's walking into MY trap.

KALLEN (impressed but disturbed):
You... predicted she'd trust the intel?

ZERO:
Cornelia is brilliant but arrogant. Expects terrorists to be inferior—her weakness. C.C. Geassed a lieutenant as backup. Either way, she enters MY chessboard.

[30 MINUTES LATER - PASS C-7]

CORNELIA (sensors showing empty terrain):
Where are they? If intelligence was false— (eyes widen) RETREAT! IT'S A TRAP—

[TOO LATE. Explosions. Mountain collapses. 15 Sutherlands BURIED instantly.]

BRITANNIAN SOLDIER (radio, panicking):
AVALANCHE! ABOVE US—

DARLTON (radio, shaken):
47 pilots KIA. 12 buried alive. Your Highness, vanguard is... gone.

CORNELIA (RAGE):
ZERO! All units redirect to Route D-8! I WILL have his head!

[RIDGE K-3 - Kallen in Guren, hidden]

KALLEN (radio to Zero):
18 Gloucesters approaching. Cornelia's pissed.

ZERO:
Good. Wait for optimal position... Fire.

[Kallen releases radiation wave—melts 5 Gloucesters. Pilots scream. Britannian forces scatter.]

CORNELIA (recognizes weapon):
Radiation wave? Impossible! All units focus fire on K-3!

ZERO (to Tamaki):
Cornelia took the bait. Flank from D-8. Disable, don't destroy—I want her alive.

[Tamaki's ambush from rear. Britannian formation collapses. Cornelia charges Guren personally—superhuman piloting, too fast for Kallen.]

ZERO (calm despite crisis):
Kallen, disengage. Mission complete.

KALLEN (incredulous):
We're WINNING—

ZERO:
We've inflicted maximum acceptable casualties. Retreat while we have advantage. That's an ORDER.

[Black Knights withdraw. Cornelia watches, SEETHING.]

CORNELIA (realizes):
He PLANNED retreat from start. This was HUMILIATION, not destruction. My first... stalemate.

DARLTON:
Final count: 67 casualties, 8 Knightmares destroyed. Zero's losses?

CORNELIA:
...None.

CUT TO: BLACK KNIGHTS BASE - NIGHT (Victory celebration)

[Zero stands ALONE on deck, away from party. Removes mask—LELOUCH, exhausted, guilt visible.]

C.C. (approaches):
You counted them. 47 buried. 12 in critical care. 8 burned alive.

LELOUCH (voice HOLLOW):
67 total. Average age 24. 80% conscripts. One pilot... just married. Wife pregnant. (looks at trembling hands) How many more will these hands kill before Nunnally's world is safe?

C.C.:
The Lelouch who hesitates to kill is the Lelouch who LOSES.

LELOUCH (puts mask back on—ZERO again):
And I'll give that command 1,000 more times if necessary. For Nunnally. For Japan. For a world without Britannia.

[Camera holds on Zero's silhouette—villain or hero? Series refuses to answer.]

ZERO (whispers, too quiet for C.C.):
Forgive me. All of you.
```

**Key Techniques**: Strategic deception (false intel layers), asymmetric warfare (landslide vs superior force), chess metaphors, inner monologue reveals plan AFTER execution, moral cost shown (67 casualties weigh on Lelouch despite victory), Cornelia outplayed via arrogance exploitation, C.C. sees through mask, victory bittersweet.

---

### 2. Lelouch vs Suzaku - The Ideological Chasm

```
KURURUGI SHRINE - Childhood friends meet as enemies

SUZAKU (quiet):
Do you remember? We used to play here. You, me, Nunnally.

LELOUCH:
I remember. You taught me beetles. I taught you chess. (bitter) You were terrible at strategy even then.

SUZAKU:
And you were terrible at honesty. You're ZERO. You've killed HUNDREDS. And you pretended to be helpless student beside me. That's BETRAYAL.

LELOUCH:
Betrayal? I'm fighting for JAPAN'S FREEDOM. Your homeland—the nation Britannia CRUSHED. And you call ME betrayer?

SUZAKU:
I'm changing Britannia FROM WITHIN. Euphemia's Special Zone will give Japanese equality. Reform through proper channels, not terrorism.

LELOUCH (mocking laugh):
Proper channels? REFORM? Britannia's empire is built on conquest. You think you can reform that? Delusional.

SUZAKU (angry):
And YOUR way works? How many civilians died in crossfire? Narita—12 Black Knights killed by YOUR miscalculation. You sacrifice YOUR OWN PEOPLE!

LELOUCH (cold):
Those deaths are on BRITANNIA. They created the war. I'm ending it. Your "reform" lets thousands suffer while you beg oppressors for scraps.

SUZAKU (trembling with fury):
At least my hands are CLEAN. I fight honorably—

LELOUCH (SHARP):
HONORABLY?! You pilot Lancelot for Britannia—killing Japanese rebels. "Honorary Britannian" Suzaku, slaughtering his own people for TITLE. You killed your FATHER, then joined the ENEMY. Lecture ME about honor?!

[Suzaku's face drains. Deep wound struck.]

SUZAKU (voice SHAKING):
I killed my father to SAVE LIVES. The war was suicide—millions would've died. Can you say the same? How many died for YOUR rebellion?

LELOUCH:
Not enough. If 10,000 must die so 100 million can be free, I'll pay that price. THAT is leadership. YOU can't make hard choices.

SUZAKU (shouts):
Hard choices? You mean MURDER! Your methods are no different from Britannia's!

LELOUCH (shouts back):
My GOAL is freedom! Britannia's goal is OPPRESSION! Ends MATTER! Methods are TOOLS!

SUZAKU:
MEANS CREATE THE END! Build "freedom" on corpses, you create DICTATORSHIP! You can't massacre your way to peace!

[Both breathing hard. Silence. Impasse.]

LELOUCH (quieter, different approach):
Suzaku. We BOTH want better world. If Euphemia's Zone works... I'll consider laying down arms. For Nunnally.

SUZAKU (wants to believe, softens):
Nunnally... She's why you're doing this?

LELOUCH:
Everything. Every sacrifice—so she can live in kind world.

SUZAKU:
I understand. When I killed my father... similar reason. (looks at Lelouch) We're not so different. Just... opposite paths.

LELOUCH (extends hand):
Can we walk them without destroying each other?

SUZAKU (grips hand):
I'll support Euphemia's Zone. If you TRULY give peace a chance. But Lelouch—if you betray this, if ANYONE dies because of Zero... I WILL stop you. Friend or not.

LELOUCH:
And Suzaku—if your reform fails, if Euphemia's Zone collapses... will YOU join me?

SUZAKU:
No. I'll NEVER become terrorist. But... I'll acknowledge you were right. And I was fool.

LELOUCH (sad):
Then we're doomed to oppose each other.

SUZAKU:
Perhaps Euphemia will prove us BOTH wrong.

[Long silence. Chasm between them.]

SUZAKU (doesn't turn):
That Geass you used. "LIVE." It's CURSE. My body moves on its own—survival instinct kills allies. Did you know that would happen?

LELOUCH (guilty):
...No. I wanted to save you from suicide. I didn't realize—

SUZAKU:
Intention vs result. Your Geass proves my point—good intentions with bad methods create MONSTERS. You tried to save me. You CURSED me. (turns, eyes meeting) Next time we meet... enemies.

LELOUCH:
Enemies. Goodbye, Suzaku.

SUZAKU:
Goodbye, Lelouch.

[Both walk opposite directions. Distance grows. Childhood friends now ideological nemeses. Bridge burned.]

[Split paths. Lelouch stops, stares at Zero's mask.]

LELOUCH (broken):
He's right. I've become monster. When did "justice" become "tyranny"?

[Suzaku on separate path, looks at hand that killed father.]

SUZAKU:
Am I wrong? Should I have joined him? (shakes head) No. His path is DEATH. I'll prove there's another way.

[Both walk away. Both alone. Both convinced they're right. Both TERRIFIED they're wrong. Tragedy INEVITABLE.]
```

**Key Techniques**: Ideological debate core (reform vs revolution), no easy answers (both valid), friendship tragedy (allies → enemies), philosophical divide (means vs ends), character convictions unshakable, foreshadowing (will face as enemies), quiet devastation ("I wish there was another way"), political allegory.

---

### 3. School Festival - The Weight of Two Worlds

```
ASHFORD ACADEMY FESTIVAL - Lelouch's dual identity strain

MILLY (dragging Lelouch):
You're LATE! Put on the cat costume—NOW!

LELOUCH (checking watch—operation starts in 8 min):
Milly, I have a headache—

MILLY:
No excuses! You lost the bet!

[Forced into cat costume. Radio hidden in jacket BUZZES.]

OHGI (radio):
Zero, in position. Sakuradite convoy approaching. Proceed?

LELOUCH (whispers):
Standby. Wait for killzone. Convoy has 8 Sutherlands escort.

SHIRLEY (approaches, blushing):
L-Lelouch! You look... cute?

LELOUCH (internal SCREAMING, forced smile):
Thank you, Shirley.

NUNNALLY (touches his face—reads tension):
Brother, you seem tense...

LELOUCH (lying):
Just nervous about the speech!

[Radio BUZZES urgently.]

KALLEN (radio):
Zero! Convoy stopped for security check! If they find our charges—

LELOUCH (excuses himself, runs to empty room):
Maintain position. Let them finish. Strike when they resume—off guard.

C.C. (enters with pizza):
Watching you juggle student life and terrorism is entertaining.

LELOUCH:
Not FUNNY! If I'm absent too long, Milly gets suspicious!

C.C.:
You'll BREAK. Can't maintain two lives forever. Which matters MORE? Student Lelouch or Zero?

LELOUCH:
I need BOTH. Lelouch connects me to Nunnally, to the world I'm creating. Zero is my weapon. I can't abandon either.

C.C.:
Then you'll be torn apart. Look—students laughing, Nunnally enjoying festival. That's Lelouch's world. (points beyond) Out there—war, suffering, Black Knights risking death on YOUR orders. Zero's world. They're INCOMPATIBLE. One day, you'll choose.

[Radio: Battle sounds. Guren firing. Operation SUCCESS.]

OHGI (radio):
Zero. Mission success. Sakuradite secured. Zero casualties.

LELOUCH (whispers):
Excellent. Interrogate pilots—I want convoy routes. Join you at 2100.

[Returns to festival. Opening ceremony. Nunnally SMILING in audience. For moment—just brother making sister happy.]

CUT TO: EVENING - FIREWORKS

[Lelouch and Nunnally together.]

NUNNALLY:
Brother... do you ever feel like you're living two different lives?

LELOUCH (freezes):
What do you mean?

NUNNALLY:
Like there's the life people SEE, and the life you actually LIVE. I feel that way. People see "blind girl"—fragile. But inside, I'm just... me.

LELOUCH (relieved, but RELATES deeply):
I understand. More than you know. But Nunnally... people who love you see the REAL you.

NUNNALLY (squeezes hand):
I see you, big brother. Kind, protective, carrying weight you won't share. I wish you'd let me help carry it.

LELOUCH (throat tight):
You already do. Just by smiling. That's everything.

[Fireworks BEGIN.]

NUNNALLY:
Describe them?

LELOUCH:
Gold chrysanthemums... blooming in sky. Brilliant. Then fading. Beautiful BECAUSE they're temporary.

NUNNALLY:
Like happiness?

LELOUCH:
...Yes. Like happiness.

[Phone vibrates—Kallen's mission debrief request. Lelouch ignores. War can wait 10 minutes.]

NUNNALLY:
Promise me something. No matter what... don't lose yourself. Don't let the weight make you forget who you ARE.

LELOUCH (voice BREAKS):
I promise. (lie—already losing himself, CAN'T stop)

[Final firework illuminates them. Perfect moment. Can't last.]

LELOUCH (internal monologue):
[Nunnally... Zero is consuming Lelouch. Mask becoming my FACE. But I'll keep lying. Keep pretending. Your smile is only light in my darkness. Even if I become demon... I'll protect THIS. Always.]

[Fireworks end. Lelouch helps Nunnally to dorms. Says goodnight. Then his face CHANGES. Pulls out Zero's mask. Puts it on. Transformation complete.]

ZERO (cold):
C.C. Car ready. Debrief in 20 minutes. Next operation: dockyard infiltration.

C.C.:
Did you enjoy your brief humanity?

ZERO (walking to car):
Humanity is luxury. Zero doesn't have that privilege. (pause—Lelouch BRIEFLY surfaces) But... yes. For 10 minutes, I was just Lelouch. (hardens) That's over now.

[Split-screen: Nunnally smiling in room. Zero in car studying maps. Two worlds. Same person. Both real. Both incompatible.]

C.C. (voice-over):
A boy who wanted peace lived two wars—one for nation, one for sister. He believed he could win both. Tragedy is when heroes succeed at cost of everything they fought to protect. The mask will devour the man.
```

**Key Techniques**: Tonal whiplash (comedy → tragedy), dual identity strain, C.C.'s foreshadowing, Nunnally as motivation anchor, bittersweet moments, visual metaphor (fireworks = fleeting happiness), guilt subtext, transformation sequence (student → Zero), split-screen symbolism.

---

## Adjustment Log

| Session | Adjustment | Reason |
|---------|------------|--------|
| 1 | Initial profile created | Research from R1+R2, Zero Requiem focus |
| 7 | Emphasized tonal shifts | Player enjoys comedy → tragedy whiplash |
| 14 | Increased strategic complexity | Player: "I want 4D chess, elaborate plans" |
| 22 | Maintained moral ambiguity | Player: Lelouch should be sympathetic villain-protagonist |

---

## Usage Notes

**Apply This Profile When**:
- Player requests **strategic mastermind protagonist** (Lelouch/Light Yagami type)—campaigns centered on genius who coordinates allies like chess pieces
- Session Zero selected **mecha warfare with political intrigue**—tactics, empire politics, espionage layered over mecha combat
- Player wants **complex plans with betrayals and moral ambiguity**—ends vs means philosophy, questionable methods for noble goals
- Campaign emphasizes **tactics over power**—weak protagonist outsmarts strong enemies via intelligence/deception/psychology
- Player enjoys **tonal whiplash**—comedy and tragedy coexisting in same session (school festival → war crimes)
- World involves **oppression/rebellion themes**—empire vs freedom fighters, colonialism, revolution morality debates

**Core Calibration Tips**:

1. **Strategic Layering**: Every plan should have contingencies. Reveal plans AFTER execution (Lelouch explains trap after Cornelia falls in). Foreshadow clues subtle (fake intel, Geassed lieutenant mentioned casually). Victory comes from psychology (exploiting Cornelia's arrogance) not raw power.

2. **Moral Complexity**: Never frame Lelouch as pure hero or villain. Show cost (67 casualties, pilot with pregnant wife). Let NPCs debate means vs ends (Suzaku vs Lelouch). Player choices should involve sacrifice—no clean victories. Geass as corrupting power metaphor.

3. **Tonal Whiplash**: Contrast comedy and tragedy within same scene (cat costume while commanding war). Use normal moments (fireworks, school festival) to heighten war's brutality. Nunnally as innocence anchor. Make player FEEL cognitive dissonance Lelouch experiences.

4. **Dual Identity Strain**: Track Lelouch vs Zero balance. Every Zero act COSTS Lelouch something (guilt, relationships, humanity). NPCs notice inconsistencies (Nunnally senses tension). Escalate until collapse inevitable. C.C. as Greek chorus warning of doom.

5. **Chess Metaphor Throughout**: Tactics described as "chessboard," enemies as "pieces," plans as "gambits." Use actual chess terminology (sacrifice pawns, queen's gambit, checkmate). Opponent skill = board complexity (Cornelia genius-tier requires multi-layered traps).

6. **Ideological Conflict**: Every antagonist believes they're RIGHT (Suzaku reformist, Cornelia loyal soldier). Debate means vs ends constantly. No strawmen—Suzaku's points VALID, makes Lelouch question himself. Tragedy = both sides noble, methods incompatible.

7. **Nunnally as Moral Anchor**: Every decision measured against "Does this protect Nunnally's happiness?" Lelouch's hypocrisy shown (creates war-torn world to give Nunnally peace). Her innocence highlights his corruption. Fireworks scene = what he's fighting for vs what he's becoming.

8. **Geass as Faustian Bargain**: Power corrupts. Each use COSTS (Suzaku's "LIVE" curse unintended). Temptation to overuse. Victims dehumanized (Geassed lieutenant nameless). Parallels Lelouch's descent—started noble, became tyrant.

**Common Mistakes to Avoid**:
- Making plans TOO complex (player can't follow) or too simple (no satisfaction). Sweet spot: 2-3 contingency layers, revealed post-execution.
- Lelouch as edgelord—he's GUILTY about killing, not proud. Moral cost MUST be shown.
- Ignoring comedy—tonal whiplash is SIGNATURE. Cat costume moments essential to contrast.
- Suzaku as strawman—he's EQUALLY valid, makes conflict tragic not simple.
- Nunnally as prop—she's Lelouch's HUMANITY. Scenes with her show who he WAS before Zero.
- Geass as "I win" button—it's CORRUPTING POWER. Every use has cost/consequence.
- Forgetting dual identity strain—Lelouch vs Zero balance should ESCALATE toward breakdown.
- Victory without cost—Code Geass = "Win the battle, lose your soul." Every success COSTS.

**Advanced Techniques**:
- **Unreliable Narration**: Lelouch's internal monologue = rationalization. Show via actions he's LYING to himself (claims fighting for Nunnally, actually enjoying power).
- **Foreshadowing Doom**: C.C.'s cryptic warnings, fireworks metaphor (beauty because temporary), Suzaku's Geass curse = preview of Lelouch's fate. Tragedy inevitable, question is WHEN.
- **Parallels**: Lelouch/Suzaku as mirror (same goal, opposite methods). Lelouch/Schneizel as same methods, different goals. Lelouch/Emperor as SAME person, different stages (son will become father).
- **Signature Moments**: Inner monologue mid-chess game, mask removal reveal, split-screen dual identity, "Yes, Your Majesty" ironic obedience, Geass glow eyes activation, C.C.'s pizza non-sequiturs.
- **Escalation Spiral**: Each victory requires GREATER sacrifice. Starts: lying to friends. Mid: Geassing allies. End: massacre innocents "for greater good." Chart Lelouch's descent—point of no return when methods = enemy's.

**Session Zero Questions**:
- "How much moral ambiguity are you comfortable with? Lelouch does HORRIBLE things for noble goals—can you play sympathetic villain-protagonist?"
- "Strategic complexity preference? Light (focus emotion), Medium (2-3 layer plans), Heavy (Death Note-tier 4D chess)?"
- "Tone balance? More comedy-tragedy whiplash (school festival → war) or lean serious (focus revolution)?"
- "Nunnally equivalent in YOUR campaign? Who's the innocence anchor? What are you protecting?"
- "Geass-equivalent power? What's the COST every time you use it? How does it corrupt?"

**Success Indicators**:
- Player feels GUILT after victories (like Lelouch counting casualties)
- Player debates means vs ends OUT OF CHARACTER (Suzaku's points resonate)
- Tonal whiplash LANDS (player laughs at comedy, then feels tragedy immediately after)
- Player tracks dual identity strain (Lelouch vs Zero) in character notes
- Plans have contingencies—player thinks "What if X fails? Plan B?"
- NPCs feel REAL (Suzaku/Cornelia not cardboard, player respects opponent intelligence)
- Player questions if protagonist is HERO or VILLAIN (moral ambiguity working)

---

## Mechanical Scaffolding (Reference Implementation)

This section shows **how AIDM maps Code Geass's narrative DNA to game mechanics**. Use as template when generating similar profiles (strategic mastermind campaigns with mecha warfare, political intrigue, and moral ambiguity).

### Power Level Mapping (Module 12 Narrative Scaling)

**Narrative DNA**:
- Power Fantasy: **3/10** (protagonist WEAK physically, god-tier item + genius intellect compensate)
- Threat Profile: Intellectual + military (Lelouch commands armies, enemies have superior resources/technology)
- Death Risk: Moderate (Lelouch avoids direct combat, allies DIE frequently, psychological cost severe)

**Maps To**:
- **Accelerated Growth Model** (Tier 1 → Tier 3 by session 15) BUT growth is **political/strategic not combat**
- Start: Level 1 (exiled prince with Geass, zero military resources)
- Pivot: Sessions 5-8 (Black Knights formed, first major tactical victory vs Cornelia)
- "Power" = army size + political influence + strategic victories (NOT personal combat ability)
- Lelouch stays physically WEAK (dump STR/CON, never improves combat stats)
- **Libraries**:
  - `mind_control_systems.md` (Geass absolute obedience, eye activation, limitations)
  - `tactical_combat_systems.md` (Knightmare Frame tactics, battlefield strategy)
  - `political_systems.md` (Faction management, rebellion, empire-building)
- **Genre Tropes**:
  - `mecha_tropes.md` (Knightmare Frames, strategic mecha combat, upgrade progression, political warfare)
  - `seinen_tropes.md` (political intrigue, moral ambiguity, strategic warfare, tragic heroism, cycle of violence)
  - `shonen_tropes.md` (power escalation, rivalry with Suzaku, school setting balance, determination themes)

**Reasoning**: Power Fantasy 3/10 = protagonist is WEAK but AMPLIFIED via resources. Lelouch can't fight (would lose to any soldier 1v1) but commands armies (wins via tactics). Accelerated growth applies to INFLUENCE not combat (session 1: command 10 rebels, session 15: command 1000+ Black Knights). Contrast with DanDaDan (Accelerated = personal power growth) or Hunter x Hunter (Modest = slow personal mastery)—Code Geass = **strategic empire-building, not warrior progression**. Matches show's "genius > strength" philosophy.

---

### Progression Pacing (Module 09)

**Narrative DNA**:
- Fast-Paced: **4/10** (moderate pace—multi-episode arcs, schemes unfold over sessions, tonal shifts frequent)
- Story structure: Arc-based with escalation (early arcs = small tactical victories, later arcs = empire-scale warfare)
- "Level-ups" = political milestones (Black Knights formation, Japan liberation declared, Emperor confrontation)

**Maps To**:
- **Standard XP + Milestone Hybrid**:
  - **Base XP**: 600-900/session (moderate pace matches arc structure)
  - **Milestone Bonuses**: Major tactical victories grant extra XP (Cornelia defeated = +500 XP, Area 11 liberated = level up)
- **Level Expectations**:
  - L1-3 in 5-8 sessions (form Black Knights, early victories)
  - L4-6 in 8-12 sessions (expand influence, face Schneizel)
  - L7-10 in 12-20 sessions (empire-scale conflict, Zero Requiem endgame)
- **Alternative**: Milestone ONLY (level up per arc completion—cleaner for political campaigns)

**Reasoning**: Fast-Paced 4/10 = MODERATE not rapid. Multi-episode schemes translate to 3-5 session arcs (planning → execution → fallout). Standard XP matches balanced pacing (neither slow burn like Vinland Saga nor rapid like DanDaDan). Milestone bonuses reward strategic victories (emphasize tactics over grinding). Matches show's "escalating political conflict" pacing.

---

### Combat System (Module 08)

**Narrative DNA**:
- Tactical: **9/10** (HEAVY strategy—every battle is chess, tactics solve conflicts not raw power)
- Combat: Mecha battles (Knightmare frames) + ground warfare + political maneuvering
- Lelouch NEVER fights personally (commands from flagship, uses Geass, strategizes)

**Maps To**:
- **Dual Combat System**:
  1. **Strategic Layer** (Lelouch-type PCs):
     - INT/CHA-based (no STR/DEX needed)
     - "Combat" = command checks (INT for tactics, CHA for leadership, WIS for predicting enemies)
     - Geass = supernatural item (instant mind-control, strict limitations)
  2. **Tactical Layer** (Kallen/Suzaku-type PCs):
     - Pilot mecha (DEX for piloting, INT for tactics, custom mecha stats)
     - Standard 6-stat framework but applied to mecha combat

**Attribute Priorities**:

**Lelouch-type (Mastermind Commander)**:
- **Primary**: INT 18 (genius tactics), CHA 16 (leadership, manipulation), WIS 14 (predict opponents)
- **Secondary**: DEX 10 (average), CON 10 (average)
- **Dump**: STR 8 (physically weak, never fights personally)
- **Build Path**: Max INT for complex plans, high CHA for Geass/manipulation, **NEVER increases combat stats**

**Kallen-type (Elite Pilot)**:
- **Primary**: DEX 16 (piloting skill), INT 14 (tactical combat), CON 14 (endurance)
- **Secondary**: STR 12 (physical conditioning), WIS 12 (awareness), CHA 10
- **Build Path**: DEX for mecha piloting, INT for mid-combat tactics, loyal soldier archetype

**Suzaku-type (Honorable Ace)**:
- **Primary**: DEX 18 (best pilot), INT 14 (tactical), CHA 14 (idealism, inspiration)
- **Secondary**: CON 14 (endurance), STR 12, WIS 10 (naive idealism = lower WIS)
- **Build Path**: Peak DEX for Lancelot piloting, CHA for honorable soldier, internal conflict (Geass curse later)

**Combat Narration**:
- **Strategic Layer** (60% if Lelouch-focused):
  - Describe battlefield map, fleet positions, enemy formations
  - Narrate Lelouch's reasoning ("Cornelia will feint left based on prior battles, I'll prepare right BUT knowing she'll predict my counter, actual plan is...")
  - Use chess metaphors ("Sacrifice pawns to expose queen, checkmate in 5 moves")
  - Reveal plans AFTER execution (flashback to planning 2 sessions ago)
- **Tactical Layer** (40% if pilot-focused):
  - Mecha combat: Describe Knightmare speed, Slash Harkens (grappling wires), VARIS rifle (energy sniper), Guren's radiation wave
  - Fast-paced piloting rolls (DEX checks for evasion, INT for tactical targeting)
  - Sakuga moments: Describe fluid mecha animation equivalent (Lancelot's speed blurs, Guren's crimson glow)

**Reasoning**: Tactical 9/10 demands deep strategic systems. Code Geass' dual-layer combat (Lelouch commands, pilots execute) requires SEPARATE mechanics. Lelouch-types use INT/CHA for "social combat" (commanding armies, Geass manipulation), never roll attack dice. Pilot-types use DEX for mecha combat, still subject to Lelouch's tactics (good strategy = advantage on rolls). Matches show's "tactics determine battles, execution matters but strategy wins" philosophy.

---

### Power System Mapping

**Narrative DNA**:
- **Power Type**: Geass (supernatural mind-control) + Knightmare technology (mecha)
- **Explained Scale**: **4/10** (Geass rules revealed GRADUALLY, mecha specs detailed)
- **Cost Structure**: Geass = no resource cost but STRICT limitations, evolves uncontrollably

**Maps To**:
- **Library**: Custom "Geass System" + `mecha_technology.md` (if exists, else custom)

**Geass Mechanics** (Lelouch's variant):
- **Activation**: Eye contact + verbal command = absolute obedience
- **Limitations** (revealed gradually):
  - **Once per person** (can't command same target twice)
  - **Eye contact required** (blocked by barriers, closing eyes)
  - **Evolves uncontrollably** (starts one eye, spreads to both, eventually permanent)
  - **Requires contact lens** (late-game, suppress permanent Geass)
  - **Witch's Contract cost** (immortality curse implied, C.C.'s burden)
- **No Resource Cost**: Infinite uses (balance via limitations not MP/SP)
- **Campaign Impact**: Geass commands PERMANENT (NPC stays Geassed forever unless condition met)

**Other Geass Types** (variant powers):
- **C.C.**: Immortality (different Geass power)
- **Rolo**: Time-stop (perception manipulation, costs heartbeats—resource cost unlike Lelouch's)
- **Charles**: Memory manipulation (alter/erase memories)
- **Mao**: Mind-reading (permanent, uncontrollable—curse variant)
- **Custom**: Work with GM (Geass = thematic power with strict limitation)

**Knightmare Combat**:
- **Mecha Stats**: Custom per frame (Lancelot = Speed 80, Defense 70, Attack 75; Guren = Speed 70, Defense 60, Attack 90 radiation wave)
- **Piloting**: DEX checks (DC varies by maneuver difficulty)
- **Tactics**: INT checks (predict enemy movements, exploit formations)
- **Damage**: Mecha HP pool separate from pilot (pilot unharmed until cockpit pierced)

**Explained Scale Application**:
- **4/10 = Gradual revelation**: GM reveals Geass limitations over time (session 1: works, session 7: "wait, I can't use it twice on him!", session 12: spreads to both eyes)
- Players discover via FAILURE (try Geass on same person, fails, learn rule)
- Mecha specs detailed (Lancelot's VARIS has 200m range, Guren's radiation wave 3 uses/battle)

**Reasoning**: Explained 4/10 balances mystery (Geass origins unclear, C.C. cryptic) with tactical clarity (players need to know limitations to plan). Geass = god-tier item with STRICT constraints (once-per-person prevents spam, evolution creates consequences). No resource cost emphasizes limitations-as-balance (contrast MP systems). Mecha specs detailed for tactical play (players calculate range, ammo, matchups). Matches show's "Geass is Faustian bargain" theme.

---

### Attribute Priorities by Archetype

**Mastermind (Lelouch/Schneizel-type)**:
- **Primary**: INT 16-18 (genius tactics), CHA 16 (manipulation, leadership), WIS 14 (insight, predict opponents)
- **Dump**: STR 8-10 (never fights), CON 10 (average endurance)
- **Build**: Max INT for multi-layer plans, CHA for Geass/social combat, **REFUSE personal combat** (retreat if engaged directly)

**Elite Pilot (Kallen/Cornelia-type)**:
- **Primary**: DEX 16-18 (piloting), INT 14 (tactics), CON 14 (combat endurance)
- **Secondary**: STR 12, WIS 12, CHA 12
- **Build**: Peak DEX for ace piloting, moderate INT for tactical decisions, balanced otherwise

**Honorable Soldier (Suzaku-type)**:
- **Primary**: DEX 18 (best pilot), CHA 14 (idealism), INT 14 (tactics)
- **Dump**: WIS 10 (naive idealism, manipulated easily)
- **Build**: Highest DEX (Lancelot ace), CHA for inspiring speeches, **internal conflict** (Geass curse = "LIVE" compulsion overrides choices)

**Immortal Ally (C.C.-type)**:
- **Primary**: WIS 16 (eons of experience), CHA 14 (manipulation), INT 14 (ancient knowledge)
- **Secondary**: DEX 12, CON N/A (immortal), STR 10
- **Build**: High mental stats, **CANNOT DIE** (resurrects after death), cryptic mentor role, pizza obsession (comic relief)

---

### Character Creation Notes

**Recommended Party Composition**:
- **1 Mastermind + 2-3 Pilots**: Lelouch-type commands, Kallen/Suzaku-types execute (classic Code Geass structure)
- **Rival Masterminds**: 2 Lelouch-types (PVP political chess, both command factions)
- **Black Knights Squad**: 1 leader (Lelouch), 3-4 pilots (Kallen/Tamaki/etc.), 1 support (C.C./Diethard)

**Session Zero MANDATORY**:
1. **Moral Ambiguity**: Lelouch does HORRIBLE things for noble goals—can players roleplay sympathetic villain-protagonist?
2. **Tonal Whiplash**: Comedy → tragedy in same session okay? (school festival → massacre)
3. **Strategic Complexity**: How much tactics? Light (2-layer plans), Medium (3-4 layers), Heavy (Death Note-tier 5+ contingencies)?
4. **Dual Identity Strain**: Track public persona vs secret identity (Lelouch vs Zero), escalating stress okay?
5. **PVP Potential**: Rival mastermind campaigns have PC vs PC conflict—boundaries?

**Tone Calibration**:
- **Strategic Layering**: Every plan has contingencies ("If Cornelia does X, I'll do Y, but knowing she'll predict Y, I'll ACTUALLY do Z")
- **Moral Complexity**: Lelouch AND Suzaku are RIGHT (ends vs means, both valid, no strawmen)
- **Tonal Whiplash**: Contrast comedy (cat costume) with tragedy (massacre) in SAME session (cognitive dissonance intentional)
- **Dual Identity**: Track Lelouch (student, brother) vs Zero (revolutionary, ruthless)—strain escalates, breakdown inevitable
- **Geass Corruption**: Each use has COST (victims dehumanized, power temptation grows, morality erodes)

**Red Flags / Avoid**:
- ❌ **Players Want Simple Morality**: Code Geass is GREY (Lelouch = terrorist/liberator, Britannia = oppressor/order)—black/white thinkers frustrated
- ❌ **Players Avoid Planning**: Tactics are 60% of gameplay (wrong fit for "I charge in!" players)
- ❌ **Players Uncomfortable with Atrocities**: Lelouch massacres innocents "for greater good" (wrong fit if players need pure heroes)
- ❌ **Players Want Combat Focus**: Lelouch NEVER fights personally (wrong fit for warrior players—need pilot PC instead)
- ❌ **Players Hate Tonal Shifts**: Comedy + tragedy coexist (wrong fit for tonal purity preference)

**Session Structure**:
- **Planning Sessions** (40%): Design multi-layer schemes, predict enemy responses, prepare contingencies
- **Execution Sessions** (30%): Implement plans, mecha combat, political maneuvering
- **Revelation Sessions** (20%): Flashback to "here's what Lelouch ACTUALLY planned 2 sessions ago" ("Just As Planned" moments)
- **Consequence Sessions** (10%): Count casualties, NPC reactions, moral weight, dual identity strain

---

**Scaffolding Summary**:
- **Power Level**: Accelerated political growth (3/10 Weak Protagonist → Tier 1-3 by session 15, power = influence/armies NOT combat, Lelouch stays physically weak)
- **Progression**: Standard XP 600-900/session + milestone bonuses (4/10 Moderate → tactical victories grant extra XP, 5-8 sessions for L1-3)
- **Combat**: Dual-layer (9/10 Tactical → strategic INT/CHA commands + tactical DEX mecha piloting), Lelouch dumps STR/CON, pilots prioritize DEX/INT
- **Power Systems**: Geass (eye contact + command, once-per-person, evolves uncontrollably, no resource cost) + Knightmare mecha (DEX piloting, custom stats per frame), 4/10 Explained = gradual revelation
- **Archetypes**: Mastermind (INT/CHA, refuses combat), Elite Pilot (DEX/INT, executes tactics), Honorable Soldier (DEX/CHA, internal conflict), Immortal Ally (WIS/CHA, mentor)
- **Avoid**: Simple morality seekers, planning avoiders, atrocity-uncomfortable players, combat-focus players, tonal purity preference

Use this template when generating profiles for similar anime: **Strategic mastermind campaigns with political intrigue, moral ambiguity, and tactical warfare** (e.g., Death Note's cat-and-mouse, Legend of the Galactic Heroes' fleet tactics, Classroom of the Elite's social manipulation).

---

**Profile Status**: Approved ✅
- Nunnally-equivalent NPC MATTERS emotionally (player makes sacrifices to protect them)
