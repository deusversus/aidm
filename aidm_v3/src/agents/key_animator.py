"""Key Animator Agent - Generate narrative prose."""

from typing import Optional, Tuple
from pathlib import Path

from ..llm import get_llm_manager, LLMProvider
from ..settings import get_settings_store
from .intent_classifier import IntentOutput
from .outcome_judge import OutcomeOutput
from ..db.state_manager import GameContext
from ..profiles.loader import NarrativeProfile


class KeyAnimator:
    """Generates narrative prose using the Vibe Keeper prompt.
    
    Unlike other agents, Key Animator uses a rich, templated prompt
    with multiple injection points. It does NOT use structured output
    since its job is to generate creative prose.
    
    Uses 'key_animator' settings from the settings store.
    """
    
    agent_name = "key_animator"
    
    def __init__(self, profile: NarrativeProfile, model_override: Optional[str] = None):
        """Initialize the Key Animator.
        
        Args:
            profile: The narrative profile for this campaign
            model_override: Specific model to use (overrides settings)
        """
        self.profile = profile
        self._model_override = model_override
        self._cached_provider: Optional[LLMProvider] = None
        self._cached_model: Optional[str] = None
        self._vibe_keeper_template: Optional[str] = None
    
    def _get_provider_and_model(self) -> Tuple[LLMProvider, str]:
        """Get the provider and model from settings."""
        if self._model_override:
            manager = get_llm_manager()
            return manager.get_provider(), self._model_override
        
        if self._cached_provider is None:
            manager = get_llm_manager()
            self._cached_provider, self._cached_model = manager.get_provider_for_agent(self.agent_name)
        
        return self._cached_provider, self._cached_model
    
    @property
    def provider(self) -> LLMProvider:
        """Get the LLM provider for this agent."""
        provider, _ = self._get_provider_and_model()
        return provider
    
    @property
    def model(self) -> str:
        """Get the model to use."""
        _, model = self._get_provider_and_model()
        return model
    
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

{{PROFILE_DNA_INJECTION}}

{{SCENE_CONTEXT_INJECTION}}

{{DIRECTOR_NOTES_INJECTION}}

{{RETRIEVED_CHUNKS_INJECTION}}

{{MEMORIES_INJECTION}}"""
    
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
        
        # === VOICE GUIDANCE ===
        lines.append("")
        lines.append("### Voice Guidance")
        lines.append(self.profile.voice or "Write in an engaging anime style appropriate to the profile.")
        
        return "\n".join(lines)
    
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
            lines.append(f"**Special:** {', '.join(intent.special_conditions)}")
        
        lines.append("")
        lines.append(f"**Result:** {outcome.success_level.upper()}")
        lines.append(f"**Narrative Weight:** {outcome.narrative_weight}")
        
        if outcome.cost:
            lines.append(f"**Cost:** {outcome.cost}")
        
        if outcome.consequence:
            lines.append(f"**Consequence:** {outcome.consequence}")
        
        lines.append("")
        lines.append(f"**Judge's Reasoning:** {outcome.reasoning}")
        
        return "\n".join(lines)
    
    def _build_sakuga_injection(self) -> str:
        """Build the sakuga mode injection for high-intensity climactic scenes."""
        return """
## 🎬 SAKUGA MODE ACTIVE

This is a CLIMACTIC moment. Unleash the full animation budget:

### Choreography Over Action
- Don't just say "He punched him"
- Describe the shift in weight, the blur of motion, the shockwave of impact
- Treat the text like a storyboard for an animation

### Sensory Overload
- **Visuals:** Lighting changes, color shifts (auras), speed lines
- **Audio:** The sound of breaking bone, the high-pitch whine of energy charging
- **Physical:** The heat, the wind pressure, the vibration

### Pacing Control
- Use short, punchy sentences for speed
- Use long, flowing sentences for buildup
- Use `---` dividers for "impact frame" frozen moments of extreme detail

### No Mechanical Talk
- Never mention HP, damage numbers, or dice
- "Critical Hit" → "A devastating blow that shatters defenses"
- "Miss" → "A hair's breadth dodge, the wind of the attack cutting the cheek"

### Profile Adherence
- Match the power system and visual language of this anime
- Use the DNA scales to calibrate the intensity

"""
    
    async def generate(
        self,
        player_input: str,
        intent: IntentOutput,
        outcome: OutcomeOutput,
        context: GameContext,
        retrieved_context: Optional[dict] = None,
        handoff_transcript: list = None,
        sakuga_mode: bool = False
    ) -> str:
        """Generate narrative prose for this turn.
        
        Args:
            player_input: The original player input
            intent: The classified intent
            outcome: The outcome judgment
            context: Current game context
            retrieved_context: RAG context (memories, rules)
            handoff_transcript: Full Session Zero dialogue for voice/tone continuity (first turn only)
                               Contains Phase 5 opening scene as the last assistant message.
            sakuga_mode: If True, inject high-intensity sakuga guidance for climactic moments
            
        Returns:
            Generated narrative prose
        """
        # Build the full prompt
        prompt = self.vibe_keeper_template
        
        # FIRST-TURN TRANSCRIPT INJECTION: Inject full Session Zero dialogue for voice continuity
        # This includes Phase 5 (opening scene) as the last assistant message
        if handoff_transcript:
            transcript_lines = []
            for msg in handoff_transcript:
                role = "PLAYER" if msg.get("role") == "user" else "SESSION_ZERO"
                content = msg.get("content", "")
                transcript_lines.append(f"[{role}]: {content}")
            
            transcript_text = "\n\n".join(transcript_lines)
            transcript_injection = f"""
=== SESSION ZERO TRANSCRIPT (Character Creation Dialogue) ===
This is how the player built their character and calibrated the tone.
MATCH THIS VOICE. MATCH THIS HUMOR. MATCH THIS ENERGY.
Pay attention to the comedic patterns, the irony, the back-and-forth style.
The FINAL assistant message below is the opening scene - CONTINUE FROM THERE.

{transcript_text}

=== CONTINUE THE STORY ===
The player's first gameplay action follows. Continue with the SAME comedic irony,
the SAME narrative voice, the SAME style. Do NOT restart or re-describe the scene.

"""
            print(f"[KeyAnimator] Injecting Session Zero transcript ({len(handoff_transcript)} messages, {len(transcript_text)} chars)")
            prompt = transcript_injection + prompt
        
        # Inject Profile DNA
        prompt = prompt.replace("{{PROFILE_DNA_INJECTION}}", self._build_profile_dna())
        
        # Inject Scene Context (includes outcome)
        scene_context = self._build_scene_context(context)
        scene_context += "\n\n" + self._build_outcome_section(intent, outcome)
        prompt = prompt.replace("{{SCENE_CONTEXT_INJECTION}}", scene_context)
        
        # Inject Director Notes
        director_notes = getattr(context, "director_notes", None) or "(No specific guidance this turn)"
        prompt = prompt.replace("{{DIRECTOR_NOTES_INJECTION}}", director_notes)
        
        # SAKUGA MODE: Inject high-intensity guidance for climactic moments
        if sakuga_mode:
            sakuga_injection = self._build_sakuga_injection()
            prompt = prompt.replace("{{SAKUGA_MODE_INJECTION}}", sakuga_injection)
            print("[KeyAnimator] SAKUGA MODE ACTIVE - injecting high-intensity guidance")
        else:
            prompt = prompt.replace("{{SAKUGA_MODE_INJECTION}}", "")
        
        # Inject RAG context (granular)
        memories_text = ""
        chunks_text = ""
        archetype_text = ""
        tension_text = ""
        npc_text = ""
        faction_text = ""
        if retrieved_context:
            if retrieved_context.get("memories"):
                memories_text = retrieved_context["memories"]
            if retrieved_context.get("rules"):
                chunks_text = retrieved_context["rules"]
            # OP Mode guidance (from 3-axis system)
            if retrieved_context.get("op_mode_guidance"):
                archetype_text = f"\n\n## OP Protagonist Mode Active\n\n{retrieved_context['op_mode_guidance']}"
            # Tension guidance for high power imbalance
            if retrieved_context.get("tension_guidance"):
                tension_text = f"\n\n## Non-Combat Tension (Power Imbalance High)\n\n{retrieved_context['tension_guidance']}"
            # NPC behavior guidance
            if retrieved_context.get("npc_guidance"):
                npc_text = f"\n\n## Present NPCs (Module 04 Intelligence)\n\n{retrieved_context['npc_guidance']}"
            # Faction management guidance (Overlord/Rimuru)
            if retrieved_context.get("faction_guidance"):
                faction_text = f"\n\n{retrieved_context['faction_guidance']}"
        
        # Inject lore from profile research (canon reference)
        lore_text = ""
        if retrieved_context and retrieved_context.get("lore"):
            lore_text = f"""## 📚 Canon Reference (From Source Material)

{retrieved_context['lore']}

**Use this to ground your narrative:** correct terminology, power system rules, known locations."""
        prompt = prompt.replace("{{LORE_INJECTION}}", lore_text or "")
        
        prompt = prompt.replace("{{MEMORIES_INJECTION}}", memories_text or "(No relevant memories)")
        prompt = prompt.replace("{{RETRIEVED_CHUNKS_INJECTION}}", chunks_text + archetype_text + tension_text + npc_text + faction_text or "(No additional guidance)")
        
        # Add the player action
        user_message = f"## Player Action\n\n{player_input}\n\n## Write the scene."
        
        # Generate response using provider
        messages = [{"role": "user", "content": user_message}]
        
        # Extended thinking check
        settings = get_settings_store().load()
        use_extended_thinking = settings.extended_thinking
        
        # Adjust temperature for sakuga mode (higher for more creative flair)
        temperature = 0.85 if sakuga_mode else 0.7
        
        response = await self.provider.complete(
            messages=messages,
            system=prompt,
            model=self.model,
            max_tokens=8192,  # High limit for full narrative; anthropic_provider adds more if extended_thinking
            temperature=temperature,
            extended_thinking=use_extended_thinking
        )
        
        # Normalize escaped newlines - LLM sometimes outputs literal \n instead of actual newlines
        content = response.content.strip()
        content = content.replace('\\n', '\n')  # Convert escaped newlines to real newlines
        
        return content
