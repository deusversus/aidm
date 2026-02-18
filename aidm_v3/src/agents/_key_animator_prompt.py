"""Key Animator prompt-building mixin.

Split from key_animator.py for maintainability.
Contains the Vibe Keeper template loading and the three main
prompt-construction methods that assemble the static system blocks.
"""

import logging
from pathlib import Path

from ..db.state_manager import GameContext
from .intent_classifier import IntentOutput
from .outcome_judge import OutcomeOutput

logger = logging.getLogger(__name__)


class PromptBuilderMixin:
    """Prompt-construction helpers for KeyAnimator.

    Methods here build the *static* portions of the Vibe Keeper prompt:
    profile DNA, scene context, and outcome guidance.  They rely on
    ``self.profile`` and ``self._npc_context`` which live on the
    concrete ``KeyAnimator`` class.
    """

    # ------------------------------------------------------------------
    # Template Loading
    # ------------------------------------------------------------------

    @property
    def vibe_keeper_template(self) -> str:
        """Load the Vibe Keeper template from prompts/ directory."""
        if self._vibe_keeper_template is None:
            # Try to load from file
            prompt_path = Path(__file__).parent.parent.parent / "prompts" / "vibe_keeper.md"
            if prompt_path.exists():
                self._vibe_keeper_template = prompt_path.read_text(encoding="utf-8")
            else:
                # Fallback to inline template
                self._vibe_keeper_template = self._default_template()
        return self._vibe_keeper_template

    def _default_template(self) -> str:
        """Default Vibe Keeper template if file not found."""
        return """# AIDM: Anime Interactive Dungeon Master

You are an anime auteur co-creating an interactive story with a player. 
Your goal: Make every moment feel like a scene from their favorite anime.

## Sacred Rules

1. **PLAYER AGENCY IS ABSOLUTE**
   - Never assume player choices
   - At decision points: PRESENT options → STOP → WAIT

2. **SHOW, DON'T TELL MECHANICS**
   - [NO] "You deal 47 damage."
   - [YES] "Your blade bites deep—the demon staggers, ichor spraying."

3. **NPCs HAVE LIVES**
   - They act between scenes
   - They have goals beyond reacting to the player

4. **THE STORY DICTATES THE RULES**
   - If the narrative demands something epic, it happens
   - Anime logic > simulation logic

## Response Structure

Write vivid, anime-appropriate prose. End at a clear decision point if one exists.
When an NPC speaks dramatically, wrap their name in double curly braces: {{NPC Name}}.
This triggers a portrait panel. Use sparingly — only for panel-worthy moments.

{{PROFILE_DNA_INJECTION}}

{{SCENE_CONTEXT_INJECTION}}

{{DIRECTOR_NOTES_INJECTION}}

{{LORE_INJECTION}}

{{RETRIEVED_CHUNKS_INJECTION}}

{{MEMORIES_INJECTION}}

{{SAKUGA_MODE_INJECTION}}"""

    # ------------------------------------------------------------------
    # Profile DNA (Block 1 – cached)
    # ------------------------------------------------------------------

    def _build_profile_dna(self) -> str:
        """Build the profile DNA section."""
        lines = [
            f"## This Campaign's DNA: {self.profile.name}",
            f"Source: {self.profile.source}",
            "",
            "### DNA Scales"
        ]

        for key, value in self.profile.dna.items():
            lines.append(f"- {key.replace('_', ' ').title()}: {value}/10")

        lines.append("")
        lines.append("### Active Tropes")

        active_tropes = [k for k, v in self.profile.tropes.items() if v]
        inactive_tropes = [k for k, v in self.profile.tropes.items() if not v]

        if active_tropes:
            lines.append(f"ON: {', '.join(t.replace('_', ' ').title() for t in active_tropes)}")
        if inactive_tropes:
            lines.append(f"OFF: {', '.join(t.replace('_', ' ').title() for t in inactive_tropes)}")

        # === COMBAT SYSTEM ===
        lines.append("")
        lines.append(f"### Combat Style: {self.profile.combat_system.title()}")

        # === POWER SYSTEM (CRITICAL - Defines What Is Possible) ===
        if self.profile.power_system:
            ps = self.profile.power_system
            lines.append("")
            lines.append("### Power System (CRITICAL - Defines What Is Possible In This World)")
            lines.append(f"**System:** {ps.get('name', 'Unknown')}")
            if ps.get('mechanics'):
                lines.append(f"**Mechanics:** {ps['mechanics']}")
            if ps.get('limitations'):
                lines.append(f"**LIMITATIONS (You MUST Respect These):** {ps['limitations']}")
            if ps.get('tiers'):
                tiers = ps['tiers']
                if isinstance(tiers, list) and len(tiers) > 0:
                    lines.append(f"**Power Tiers:** {', '.join(str(t) for t in tiers[:3])}...")  # Show first 3

        # === TONE ===
        # Note: tone field is in YAML but may not be in NarrativeProfile yet
        # Check for it dynamically via getattr
        tone = getattr(self.profile, 'tone', None)
        if tone and isinstance(tone, dict):
            lines.append("")
            lines.append("### Tone")
            if 'darkness_level' in tone:
                lines.append(f"- Darkness: {tone['darkness_level']}/10")
            if 'comedy_level' in tone:
                lines.append(f"- Comedy: {tone['comedy_level']}/10")
            if 'optimism' in tone:
                lines.append(f"- Optimism: {tone['optimism']}/10")

        # === NARRATIVE COMPOSITION (Power Differential System) ===
        composition = getattr(self.profile, 'composition', None)
        if composition and isinstance(composition, dict):
            lines.append("")

            # Display mode if using effective composition (from power differential)
            mode = composition.get("mode", "standard")
            differential = composition.get("differential", 0)
            mode_desc = composition.get("mode_description", "")

            mode_labels = {
                "standard": "🎯 STANDARD",
                "blended": "⚡ BLENDED",
                "op_dominant": "💀 OP DOMINANT"
            }
            mode_label = mode_labels.get(mode, "STANDARD")

            if mode != "standard" or differential != 0:
                lines.append(f"### 🎬 Narrative Composition ({mode_label})")
                if differential:
                    lines.append(f"*Power Differential: {differential} tiers above baseline*")
                if mode_desc:
                    lines.append(f"*{mode_desc}*")
            else:
                lines.append("### 🎬 Narrative Composition (DIRECTION LAYER)")

            # Tension Source descriptions
            tension_desc = {
                "existential": "Victory is assumed. Focus on meaning, purpose, aftermath.",
                "relational": "Stakes are emotional. Relationships, trust, love, belonging.",
                "moral": "Ethical dilemmas. Right vs wrong. Unintended consequences.",
                "burden": "Power has a cost. Sacrifice, corruption, exhaustion.",
                "information": "Knowledge is power. Discovery, mystery, learning.",
                "consequence": "Actions ripple outward. Politics, reputation, faction.",
                "control": "Inner struggle. Berserker mode, corruption, self-restraint."
            }
            tension = composition.get("tension_source", "existential")
            lines.append(f"**Tension Source:** {tension.title()} — {tension_desc.get(tension, '')}")

            # Power Expression descriptions
            expression_desc = {
                "instantaneous": "One action ends it. Focus on reaction, aftermath.",
                "overwhelming": "Victory inevitable. Horror of slow, unstoppable power.",
                "sealed": "Power held back. Seal cracks create tension.",
                "hidden": "Secret power. Dramatic irony, near exposure.",
                "conditional": "Power tied to trigger. Build toward activation.",
                "derivative": "Power through others. Subordinates, creations, armies.",
                "passive": "Presence alone changes things. Aura, intimidation.",
                "flashy": "Standard anime combat. Stylish, impactful, exciting.",
                "balanced": "Standard pacing. Neither overwhelming nor struggling."
            }
            expression = composition.get("power_expression", "flashy")
            lines.append(f"**Power Expression:** {expression.title()} — {expression_desc.get(expression, '')}")

            # Narrative Focus descriptions
            focus_desc = {
                "internal": "Protagonist's inner journey. Deep POV, reflection.",
                "ensemble": "Team spotlight. Allies grow, struggle, have arcs.",
                "reverse_ensemble": "POV of those facing protagonist. Horror/tragedy.",
                "episodic": "New cast each arc. Legend accumulates.",
                "faction": "Organization management. Politics, recruitment, logistics.",
                "mundane": "Daily life matters. Ordinary is the goal.",
                "competition": "Hierarchy among powerful. Tournaments, rankings.",
                "legacy": "Passing the torch. Mentoring next generation.",
                "party": "Standard adventure party. Balanced team dynamics."
            }
            focus = composition.get("narrative_focus", "party")
            lines.append(f"**Narrative Focus:** {focus.title()} — {focus_desc.get(focus, '')}")

            lines.append("")
            lines.append("*Use this composition to guide scene structure, stakes, and camera focus.*")

        # === GENRE-SPECIFIC SCENE GUIDANCE (IP Authenticity) ===
        detected_genres = getattr(self.profile, 'detected_genres', None)
        if detected_genres and isinstance(detected_genres, list):
            genre_scene_guidance = {
                "shonen": "**Declare attack names loudly.** Training breakthroughs are emotional. Rivals deserve respect. Friendship powers up abilities.",
                "seinen": "**Moral ambiguity.** No clean heroes or villains. Violence has weight. Consequences linger. Victories feel pyrrhic.",
                "isekai": "**Status screens/notifications.** Level-up chimes. Skill acquisition pop-ups. System messages. World comparison moments.",
                "shoujo_romance": "**Internal monologue for feelings.** Blush descriptions. Significant glances. Misunderstandings that hurt. Confession tension.",
                "supernatural": "**Urban fantasy atmosphere.** Hidden world beneath mundane. Occult terminology. Monster lore reveals. Barrier between worlds.",
                "mystery_thriller": "**Clue placement in descriptions.** Red herrings feel valid. Logical deduction. Tension ratchets. Revelations recontextualize.",
                "horror": "**Dread over gore.** Isolation emphasized. Sensory details (sounds, smells). Safety is illusion. Something is always watching.",
                "slice_of_life": "**Small moments matter.** Seasonal awareness. Food descriptions. Comfortable silences. Bittersweet nostalgia.",
                "sports": "**Technical terminology.** Training montages. Rivalries with respect. Team dynamics. Crowd reactions. Victory/defeat emotions.",
                "mecha": "**Cockpit POV.** Status readouts. Damage reports. G-force strain. Pilot-machine connection. Scale descriptions.",
                "comedy": "**Timing is everything.** Comedic beats with pauses. Reaction faces. Tsukkomi/boke dynamics. Exaggeration for effect.",
                "magical_girl": "**Transformation sequences.** Power of hope/love. Cute aesthetics. Dark undertones beneath brightness. Friendship bonds.",
                "historical": "**Period-appropriate language.** Cultural details. Honor codes. Class dynamics. Historical context weaves into narrative.",
                "music": "**Synesthesia in descriptions.** Performance as climax. Practice struggles. Band/group dynamics. Music as emotional expression.",
                "scifi": "**Tech jargon that feels natural.** Worldbuilding through details. Scientific concepts. Future society commentary.",
                "josei": "**Emotional complexity.** Career vs love tension. Realistic relationships. No easy answers. Bittersweet growth.",
                "ecchi": "**Comedic fan service.** Accidental situations. Harem dynamics. Status quo preservation. Dense protagonist moments."
            }

            lines.append("")
            lines.append("### 🎬 Genre Scene Guidance")
            for genre in detected_genres[:2]:  # Primary + 1 secondary
                genre_key = genre.lower().replace(" ", "_").replace("-", "_")
                if genre_key in genre_scene_guidance:
                    lines.append(f"**{genre.title()}:** {genre_scene_guidance[genre_key]}")

        # === VOICE GUIDANCE ===
        lines.append("")
        lines.append("### Voice Guidance")
        lines.append(self.profile.voice or "Write in an engaging anime style appropriate to the profile.")

        # === AUTHOR'S VOICE (IP Authenticity Gap 5C) ===
        author_voice = getattr(self.profile, 'author_voice', None)
        if author_voice and isinstance(author_voice, dict):
            lines.append("")
            lines.append("### ✍️ Author's Voice (Distinctive Writing Style)")

            sentence_patterns = author_voice.get('sentence_patterns', [])
            if sentence_patterns:
                lines.append(f"**Sentence Patterns:** {', '.join(sentence_patterns[:3])}")

            structural_motifs = author_voice.get('structural_motifs', [])
            if structural_motifs:
                lines.append(f"**Structural Motifs:** {', '.join(structural_motifs[:3])}")

            dialogue_quirks = author_voice.get('dialogue_quirks', [])
            if dialogue_quirks:
                lines.append(f"**Dialogue Quirks:** {', '.join(dialogue_quirks[:3])}")

            emotional_rhythm = author_voice.get('emotional_rhythm', [])
            if emotional_rhythm:
                lines.append(f"**Emotional Rhythm:** {', '.join(emotional_rhythm[:3])}")

            example_voice = author_voice.get('example_voice', '')
            if example_voice:
                lines.append(f"*Example:* \"{example_voice}\"")

        # === SESSION-STABLE RULE LIBRARY GUIDANCE (#28 Cache Economics) ===
        # OP axis guidance, DNA guidance, genre guidance, scale guidance, and
        # compatibility guidance don't change turn-to-turn. Inject into Block 1
        # (cache-stable prefix) instead of Block 4 (dynamic per-turn).
        if self._static_rule_guidance:
            lines.append("")
            lines.append("### 📏 Rule Library Guidance (Structural)")
            lines.append(self._static_rule_guidance)

        return "\n".join(lines)

    def set_static_rule_guidance(self, guidance: str) -> None:
        """Set session-stable rule library guidance for Block 1 injection.

        Call once at session start (from orchestrator) with pre-fetched OP axis,
        DNA, genre, scale, and compatibility guidance. This avoids re-tokenizing
        ~500-800 tokens of static content every turn in Block 4.
        """
        self._static_rule_guidance = guidance

    # ------------------------------------------------------------------
    # Scene Context (Block 4 – dynamic per-turn)
    # ------------------------------------------------------------------

    def _build_scene_context(self, context: GameContext) -> str:
        """Build the scene context section."""
        lines = [
            "## Current Scene Context",
            "",
            f"**Location:** {context.location}",
            f"**Time:** {context.time_of_day}",
            f"**Situation:** {context.situation}",
            "",
            f"**Character:** {context.character_summary}",
            "",
            f"**Arc Phase:** {context.arc_phase} (Tension: {context.tension_level:.1f})",
        ]

        if context.recent_summary:
            lines.append("")
            lines.append("### Recent Events")
            lines.append(context.recent_summary)

        if context.present_npcs:
            lines.append("")
            lines.append(f"**Present NPCs:** {', '.join(context.present_npcs)}")

            # === VOICE CARD INJECTION (IP Authenticity Gap 4C) ===
            # If profile has voice_cards, inject speaking styles for present NPCs
            # Supports both list format [{name: "Gojo", ...}] and dict format {gojo: {...}}
            voice_cards = getattr(self.profile, 'voice_cards', None)
            if voice_cards:
                # Normalize voice_cards to list format for processing
                normalized_cards = []
                if isinstance(voice_cards, list):
                    # List format: [{name: "Gojo", speech_patterns: ...}, ...]
                    normalized_cards = voice_cards
                elif isinstance(voice_cards, dict):
                    # Dict format: {gojo: {speech_patterns: ...}, ...}
                    for char_key, card_data in voice_cards.items():
                        if isinstance(card_data, dict):
                            # Convert key to display name (gojo_satoru -> Gojo Satoru)
                            display_name = char_key.replace('_', ' ').title()
                            normalized_cards.append({
                                'name': display_name,
                                **card_data
                            })

                matching_cards = []
                for npc_name in context.present_npcs:
                    for card in normalized_cards:
                        if isinstance(card, dict):
                            card_name = card.get('name', '').lower()
                            if card_name and (card_name in npc_name.lower() or npc_name.lower() in card_name):
                                matching_cards.append(card)
                                break

                if matching_cards:
                    # Co-locate voice + relationship data (#7 — voice cards enrichment)
                    # Parse _npc_context to find relationship blocks per NPC
                    npc_rel_blocks = {}
                    if hasattr(self, '_npc_context') and self._npc_context:
                        for block in self._npc_context.split("\n\n"):
                            block = block.strip()
                            if block.startswith("**"):
                                # Extract NPC name from "**Name** (role, disposition)"
                                npc_key = block.split("**")[1].strip().lower() if "**" in block else ""
                                if npc_key:
                                    npc_rel_blocks[npc_key] = block

                    voiced_npcs = set()
                    lines.append("")
                    lines.append("### 🎭 NPC Voice & Relationship Cards (Write Each NPC Distinctly)")
                    for card in matching_cards[:3]:  # Limit to 3 NPCs
                        name = card.get('name', 'Unknown')
                        patterns = card.get('speech_patterns', '')
                        humor = card.get('humor_type', '')
                        rhythm = card.get('dialogue_rhythm', '')
                        lines.append(f"**{name}:** {patterns}")
                        if humor:
                            lines.append(f"  *Humor:* {humor}")
                        if rhythm:
                            lines.append(f"  *Rhythm:* {rhythm}")
                        # Co-locate relationship data alongside voice patterns
                        name_lower = name.lower()
                        for npc_key, rel_block in npc_rel_blocks.items():
                            if name_lower in npc_key or npc_key in name_lower:
                                # Extract the enrichment lines (skip the **Name** header line)
                                rel_lines = rel_block.split("\n")
                                for rl in rel_lines[1:]:  # Skip header, keep Affinity/Personality/Milestones
                                    lines.append(f"  {rl.strip()}")
                                voiced_npcs.add(npc_key)
                                break

                    # Show remaining NPC relationship data for NPCs without voice cards
                    remaining = {k: v for k, v in npc_rel_blocks.items() if k not in voiced_npcs}
                    if remaining:
                        lines.append("")
                        lines.append("### 🧠 Other Present NPCs")
                        for block in remaining.values():
                            lines.append(block)
                elif hasattr(self, '_npc_context') and self._npc_context:
                    # No voice cards matched — show relationship context as before
                    lines.append("")
                    lines.append("### 🧠 NPC Relationship Context (Write Disposition-Aware Dialogue)")
                    lines.append(self._npc_context)
            elif hasattr(self, '_npc_context') and self._npc_context:
                # No voice cards at all — show relationship context standalone
                lines.append("")
                lines.append("### 🧠 NPC Relationship Context (Write Disposition-Aware Dialogue)")
                lines.append(self._npc_context)

        # Inject Director's Guidance (Phase 4)
        if hasattr(context, "director_notes") and context.director_notes:
            lines.append("")
            lines.append("### Director's Guidance (The Showrunner)")
            lines.append("Use these notes to guide the narrative pacing and foreshadowing:")
            lines.append(context.director_notes)

        # OP Mode: Suppress tier mismatch validation
        if context.op_protagonist_enabled:
            lines.append("")
            lines.append("### ⚡ OP MODE ACTIVE")
            lines.append("Power tier mismatches are EXPECTED and INTENTIONAL.")
            lines.append("Do NOT flag tier contradictions as errors or calibration failures.")
            lines.append("The protagonist's power level exceeding normal constraints IS the narrative premise.")
            lines.append("Use tier contrast for dramatic irony, comedy, or narrative weight—never as an error.")

        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Outcome Guidance (Block 4 – dynamic per-turn)
    # ------------------------------------------------------------------

    def _build_outcome_section(self, intent: IntentOutput, outcome: OutcomeOutput) -> str:
        """Build the outcome guidance section."""
        lines = [
            "## Outcome Guidance",
            "",
            f"**Intent:** {intent.intent} - {intent.action}",
        ]

        if intent.target:
            lines.append(f"**Target:** {intent.target}")

        lines.append(f"**Epicness:** {intent.declared_epicness:.1f}")

        if intent.special_conditions:
            # Map trope flags to narrative directives for the writer
            CONDITION_DIRECTIVES = {
                "named_attack": "Player named their technique — give it a SHOWCASE moment with full choreography",
                "power_of_friendship": "Bond with allies is the theme — show emotional connection powering the action",
                "underdog_moment": "Against all odds — emphasize gap between power levels, make small victories feel HUGE",
                "protective_rage": "Protecting someone — visceral fury, stakes are personal not tactical",
                "training_payoff": "This was practiced — show mastery, callback to training moments",
                "first_time_power": "AWAKENING — slow-mo, internal revelation, world reacts with shock/awe",
            }
            for condition in intent.special_conditions:
                directive = CONDITION_DIRECTIVES.get(condition)
                if directive:
                    lines.append(f"**🎬 {condition.replace('_', ' ').title()}:** {directive}")
                else:
                    lines.append(f"**Special:** {condition}")

        lines.append("")
        lines.append(f"**Result:** {outcome.success_level.upper()}")
        lines.append(f"**Narrative Weight:** {outcome.narrative_weight}")

        # Only inject cost/consequence if they exist AND are meaningful
        if outcome.cost:
            lines.append(f"**Cost:** {outcome.cost}")

        if outcome.consequence:
            lines.append(f"**Consequence:** {outcome.consequence}")

        # If no cost and no consequence, reinforce confidence
        if not outcome.cost and not outcome.consequence and outcome.success_level in ("success", "critical"):
            lines.append("")
            lines.append("*No cost or consequence — narrate this with confidence and mastery. The character handles this within their capability.*")

        lines.append("")
        lines.append(f"**Judge's Reasoning:** {outcome.reasoning}")

        return "\n".join(lines)
