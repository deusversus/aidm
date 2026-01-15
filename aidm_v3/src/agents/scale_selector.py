"""
Scale Selector Agent for AIDM v3.

Determines which narrative scale applies based on power tiers and context.
Per Module 12: 9 narrative scales for different power situations.

Replaces hardcoded tier threshold logic with LLM-informed selection.
"""

from typing import Optional, List, Literal, Dict, Any
from pydantic import BaseModel, Field
from enum import Enum

from .base import BaseAgent


class NarrativeScale(str, Enum):
    """The 9 narrative scales from Module 12."""
    TACTICAL = "tactical"           # HxH style - every move matters
    ENSEMBLE = "ensemble"           # Team dynamics, role balance
    SPECTACLE = "spectacle"         # DBZ style - visual impact
    EXISTENTIAL = "existential"     # Philosophical weight
    UNDERDOG = "underdog"           # David vs Goliath
    SLICE_OF_LIFE = "slice_of_life" # Low stakes, character focus
    HORROR = "horror"               # Atmosphere, vulnerability
    MYSTERY = "mystery"             # Information control
    COMEDY = "comedy"               # Rule of funny


# Compatibility Matrix per Module 12
# OK = recommended, ACCEPTABLE = works but not ideal, DISCOURAGED = tricky, FORBIDDEN = never
# Format: {tier_range: {scale: compatibility}}
SCALE_COMPATIBILITY = {
    # Tier 11-10: Human level
    "human": {
        "tactical": "OK", "ensemble": "OK", "spectacle": "FORBIDDEN",
        "existential": "FORBIDDEN", "underdog": "ACCEPTABLE", "slice_of_life": "OK",
        "horror": "OK", "mystery": "OK", "comedy": "OK",
    },
    # Tier 9: Athletic/Peak human
    "athletic": {
        "tactical": "OK", "ensemble": "OK", "spectacle": "DISCOURAGED",
        "existential": "FORBIDDEN", "underdog": "OK", "slice_of_life": "OK",
        "horror": "ACCEPTABLE", "mystery": "OK", "comedy": "OK",
    },
    # Tier 8-7: Superhuman (Wall to Building)
    "superhuman": {
        "tactical": "ACCEPTABLE", "ensemble": "OK", "spectacle": "ACCEPTABLE",
        "existential": "ACCEPTABLE", "underdog": "OK", "slice_of_life": "OK",
        "horror": "ACCEPTABLE", "mystery": "OK", "comedy": "OK",
    },
    # Tier 6: Mountain/Island level
    "city": {
        "tactical": "DISCOURAGED", "ensemble": "OK", "spectacle": "OK",
        "existential": "ACCEPTABLE", "underdog": "ACCEPTABLE", "slice_of_life": "OK",
        "horror": "DISCOURAGED", "mystery": "ACCEPTABLE", "comedy": "OK",
    },
    # Tier 5: Planetary level
    "planetary": {
        "tactical": "FORBIDDEN", "ensemble": "OK", "spectacle": "OK",
        "existential": "OK", "underdog": "FORBIDDEN", "slice_of_life": "ACCEPTABLE",
        "horror": "FORBIDDEN", "mystery": "ACCEPTABLE", "comedy": "OK",
    },
    # Tier 4-2: Cosmic level
    "cosmic": {
        "tactical": "FORBIDDEN", "ensemble": "ACCEPTABLE", "spectacle": "OK",
        "existential": "OK", "underdog": "FORBIDDEN", "slice_of_life": "ACCEPTABLE",
        "horror": "FORBIDDEN", "mystery": "ACCEPTABLE", "comedy": "ACCEPTABLE",
    },
    # Tier 1-0: Boundless
    "boundless": {
        "tactical": "FORBIDDEN", "ensemble": "FORBIDDEN", "spectacle": "ACCEPTABLE",
        "existential": "OK", "underdog": "FORBIDDEN", "slice_of_life": "ACCEPTABLE",
        "horror": "FORBIDDEN", "mystery": "FORBIDDEN", "comedy": "ACCEPTABLE",
    },
}


class ScaleOutput(BaseModel):
    """Output from the Scale Selector Agent."""
    
    primary_scale: NarrativeScale = Field(
        description="The main narrative scale to use"
    )
    secondary_scale: Optional[NarrativeScale] = Field(
        default=None,
        description="Optional secondary scale for hybrid moments"
    )
    
    # Power analysis
    power_imbalance: float = Field(
        default=0.0,
        description="-1.0 (player much weaker) to +1.0 (player much stronger)"
    )
    tier_gap: int = Field(
        default=0,
        description="Tier difference between combatants (positive = player stronger)"
    )
    
    # Context flags
    is_climactic: bool = Field(
        default=False,
        description="Is this a climactic story moment?"
    )
    is_training: bool = Field(
        default=False,
        description="Is this a training/growth moment?"
    )
    
    # Narrative guidance
    recommended_techniques: List[str] = Field(
        default_factory=list,
        description="Specific techniques for this scale"
    )
    tension_source: str = Field(
        default="",
        description="Where tension comes from at this scale"
    )
    
    # Justification
    reasoning: str = Field(
        default="",
        description="Why this scale was selected"
    )


class PowerImbalanceOutput(BaseModel):
    """
    Output from power imbalance calculation.
    
    Per Module 12: Effective Imbalance = (PC Raw × Context) ÷ Threat Raw
    """
    
    # Raw calculation
    raw_imbalance: float = Field(
        description="Raw power ratio (PC tier ÷ threat tier)"
    )
    effective_imbalance: float = Field(
        description="After context modifiers applied"
    )
    
    # Context modifiers detected (Module 12)
    context_modifiers: List[str] = Field(
        default_factory=list,
        description="Active modifiers: environmental, secret_id, self_limiter, mentor, political, genre"
    )
    total_modifier: float = Field(
        default=1.0,
        description="Combined modifier multiplier (0.1 to 1.0)"
    )
    
    # Threshold result (Module 12)
    threshold: str = Field(
        description="balanced (0.5-1.5), moderate (1.5-3), significant (3-10), overwhelming (10+)"
    )
    recommended_scale_shift: Optional[str] = Field(
        default=None,
        description="Recommended scale if threshold crossed"
    )
    
    # Trigger flags
    triggers_op_mode: bool = Field(
        default=False,
        description="True if imbalance > 10 (suggest OP Mode)"
    )
    triggers_tension_shift: bool = Field(
        default=False,
        description="True if imbalance > 3 (shift to non-combat tension)"
    )
    
    # Reasoning
    reasoning: str = Field(
        default="",
        description="Why these modifiers were detected"
    )


class ScaleSelectorAgent(BaseAgent):
    """
    Selects appropriate narrative scale based on power dynamics.
    
    Per Module 12, the scale affects:
    - How combat is narrated (tactical analysis vs spectacle)
    - Where tension comes from (physical danger vs existential)
    - Which techniques apply (teamwork vs solo spotlight)
    """
    
    agent_name = "scale_selector"
    
    @property
    def system_prompt(self):
        return """You are the Narrative Scale Selector for an anime JRPG.

Your role is to analyze the current situation and select the appropriate narrative scale.

## The 9 Scales (from Module 12):

1. **TACTICAL** - Every move matters. Explain mechanics. HxH exam/Nen fights.
   - Use when: Similar power levels, strategic combat
   - Tension: Outsmarting opponent

2. **ENSEMBLE** - Team dynamics. Balance spotlight. Fairy Tail, MHA team battles.
   - Use when: Multiple combatants, varied abilities
   - Tension: Coordination, covering weaknesses

3. **SPECTACLE** - Visual impact over tactics. DBZ, Gurren Lagann.
   - Use when: Large power displays, hype moments
   - Tension: Escalation, will they win?

4. **EXISTENTIAL** - Philosophical weight. AoT, Evangelion.
   - Use when: Questioning purpose, moral dilemmas
   - Tension: Internal conflict, meaning of actions

5. **UNDERDOG** - David vs Goliath. Early Naruto, HxH exam.
   - Use when: Player significantly weaker (2+ tiers below)
   - Tension: Survival, clever solutions

6. **SLICE_OF_LIFE** - Low stakes, character focus. Konosuba downtime.
   - Use when: No combat, relationship building
   - Tension: Interpersonal, comedy of errors

7. **HORROR** - Atmosphere, vulnerability. Made in Abyss, early AoT.
   - Use when: Overwhelming threat, unknown danger
   - Tension: Fear, helplessness

8. **MYSTERY** - Information control. Death Note, Monster.
   - Use when: Deduction, hidden truths
   - Tension: What are they hiding?

9. **COMEDY** - Rule of funny. One Punch Man, Konosuba.
   - Use when: Profile supports it, absurd situations
   - Tension: Comic timing, subverted expectations

## Power Imbalance Detection:

- Compare player tier to opponent tier
- 2+ tiers below = UNDERDOG or HORROR
- Similar tiers = TACTICAL or ENSEMBLE
- 2+ tiers above = SPECTACLE or COMEDY (OP protagonist)

Select the scale that best fits the current moment."""
    
    async def select_scale(
        self,
        player_tier: str,
        opponent_tier: Optional[str],
        situation: str,
        profile_combat_style: str,
        arc_phase: str,
        is_boss_fight: bool = False
    ) -> ScaleOutput:
        """
        Select the appropriate narrative scale.
        
        Args:
            player_tier: Player's power tier (e.g., "T9", "T5")
            opponent_tier: Opponent's tier if in combat, None otherwise
            situation: Current narrative situation
            profile_combat_style: Profile's combat style preference
            arc_phase: Current arc phase (rising, climax, falling)
            is_boss_fight: Whether this is a boss encounter
            
        Returns:
            ScaleOutput with selected scale and guidance
        """
        # Calculate tier gap
        tier_gap = 0
        if opponent_tier:
            player_num = self._tier_to_num(player_tier)
            opponent_num = self._tier_to_num(opponent_tier)
            tier_gap = opponent_num - player_num  # Positive = player stronger
        
        # Build context
        context = f"""# Scale Selection Request

## Power Analysis
- Player Tier: {player_tier}
- Opponent Tier: {opponent_tier or "N/A (non-combat)"}
- Tier Gap: {tier_gap} (positive = player stronger)

## Situation
{situation}

## Profile
- Combat Style: {profile_combat_style}
- Arc Phase: {arc_phase}
- Boss Fight: {"Yes" if is_boss_fight else "No"}

## Task
Select the most appropriate narrative scale.
Consider: power dynamics, profile style, current arc phase.
If this is a climactic moment, prioritize dramatic scales.
If the player is significantly outmatched (2+ tiers below), consider UNDERDOG or HORROR.
If the player is significantly stronger (2+ tiers above), consider SPECTACLE or COMEDY (OP mode)."""
        
        result = await self.call(context)
        
        # Ensure tier_gap is set
        if isinstance(result, ScaleOutput):
            result.tier_gap = tier_gap
            result.power_imbalance = max(-1.0, min(1.0, tier_gap / 5.0))
        
        return result
    
    def _tier_to_num(self, tier: str) -> int:
        """Convert tier string to number (T10=0, T1=9)."""
        try:
            # Handle "T10", "T9", etc.
            num = int(tier.replace("T", "").strip())
            return 10 - num  # T10 → 0, T1 → 9
        except:
            return 0  # Default to lowest power
    
    async def calculate_power_imbalance(
        self,
        player_tier: str,
        threat_tier: str,
        situation: str,
        op_preset: Optional[str] = None,
        op_tension_source: Optional[str] = None,
        location: str = "",
        has_allies: bool = False
    ) -> PowerImbalanceOutput:
        """
        Calculate effective power imbalance with context modifiers.
        
        Per Module 12: Effective = (PC Raw × Context) ÷ Threat Raw
        
        Context modifiers are detected by LLM (judgment = API call):
        - Environmental: 0.1-0.5 (can't use full power in location)
        - Secret ID: 0.1-0.3 (hiding true abilities)
        - Self-Limiter: 0.2-0.5 (character restrains themselves)
        - Mentor: 0.5 (protecting weaker allies)
        - Political: 0.3-0.7 (consequences for showing power)
        - Genre: 0.1-0.5 (slice-of-life = combat inappropriate)
        
        OPTIMIZATION: Skip LLM call if raw imbalance is balanced (≤ 1.5).
        Context modifiers only reduce imbalance, so a balanced fight stays balanced.
        
        Args:
            player_tier: Player's power tier
            threat_tier: Current threat's tier
            situation: Current narrative context
            op_preset: If OP mode, which preset
            op_tension_source: If OP mode, which tension source
            location: Current location (for environmental)
            has_allies: Whether weaker allies are present
            
        Returns:
            PowerImbalanceOutput with effective imbalance and recommendations
        """
        # Calculate raw imbalance (higher = player stronger)
        player_num = self._tier_to_num(player_tier)
        threat_num = self._tier_to_num(threat_tier)
        
        # Raw ratio: T5 vs T10 = 9/0 → clamped | T10 vs T5 = 0/9 → 0
        if threat_num == 0:
            raw_imbalance = player_num * 2  # High advantage
        else:
            raw_imbalance = player_num / max(1, threat_num)
        
        # OPTIMIZATION: Skip LLM only for SAME-TIER fights
        # Any tier difference warrants modifier detection (tiers are planet-scale differences)
        # raw_imbalance == 1.0 means exact same tier (player_num / threat_num == 1)
        if raw_imbalance == 1.0:
            print(f"[ScaleSelector] Same tier fight, skipping modifier detection")
            return PowerImbalanceOutput(
                raw_imbalance=raw_imbalance,
                effective_imbalance=raw_imbalance,
                context_modifiers=[],
                total_modifier=1.0,
                threshold="balanced",
                recommended_scale_shift=None,
                triggers_op_mode=False,
                triggers_tension_shift=False,
                reasoning="Same tier fight - no modifier detection needed"
            )
        
        # Build prompt for context modifier detection
        context = f"""# Power Imbalance Context Analysis

## Power Levels
- Player Tier: {player_tier} (power level {player_num})
- Threat Tier: {threat_tier} (power level {threat_num})
- Raw Imbalance: {raw_imbalance:.2f} (higher = player stronger)

## Situation
{situation}

## Additional Context
- Location: {location or "Unknown"}
- Has Weaker Allies: {"Yes" if has_allies else "No"}
- OP Preset: {op_preset or "None"}
- OP Tension: {op_tension_source or "None"}

## Task
Detect which context modifiers apply. For each, provide a multiplier (0.1 to 1.0).

### Context Modifiers (Module 12)
- **environmental**: Can't use full power here (collateral damage, fragile environment)
- **secret_id**: Hiding true abilities (disguised god, secret OP)
- **self_limiter**: Character restrains themselves (Mob, Wang Ling style)
- **mentor**: Protecting weaker allies (reduce power to let them grow)
- **political**: Consequences for showing power (diplomacy, organization standing)
- **genre**: Current tone discourages combat (slice-of-life moment, date scene)

Return which modifiers apply and the combined multiplier."""

        # LLM call to detect modifiers (judgment = API call)
        result = await self._detect_context_modifiers(context, raw_imbalance, player_tier, threat_tier)
        
        return result
    
    async def _detect_context_modifiers(
        self, 
        context: str, 
        raw_imbalance: float,
        player_tier: str,
        threat_tier: str
    ) -> PowerImbalanceOutput:
        """
        Use LLM to detect context modifiers from situation.
        """
        from pydantic import BaseModel as PydanticModel, Field as PydanticField
        from typing import List as TypingList
        
        class ModifierDetection(PydanticModel):
            """Context modifier detection."""
            detected_modifiers: TypingList[str] = PydanticField(
                description="List of active modifiers: environmental, secret_id, self_limiter, mentor, political, genre"
            )
            modifier_values: dict = PydanticField(
                default_factory=dict,
                description="Modifier name -> multiplier (0.1 to 1.0)"
            )
            reasoning: str = PydanticField(
                description="Why these modifiers were detected"
            )
        
        # Store original schema, use modifier detection
        original_schema = self._output_schema_override
        self._output_schema_override = ModifierDetection
        
        try:
            detection = await self.call(context)
        finally:
            self._output_schema_override = original_schema
        
        # Calculate total modifier
        if not isinstance(detection, ModifierDetection):
            # Fallback if LLM fails
            detection = ModifierDetection(
                detected_modifiers=[],
                modifier_values={},
                reasoning="Fallback: no modifiers detected"
            )
        
        total_modifier = 1.0
        for mod, value in detection.modifier_values.items():
            if isinstance(value, (int, float)) and 0.1 <= value <= 1.0:
                total_modifier *= value
        
        # Calculate effective imbalance
        effective_imbalance = raw_imbalance * total_modifier
        
        # Determine threshold (Module 12)
        if effective_imbalance <= 1.5:
            threshold = "balanced"
            recommended_shift = None
        elif effective_imbalance <= 3.0:
            threshold = "moderate"
            recommended_shift = "strategic→ensemble"
        elif effective_imbalance <= 10.0:
            threshold = "significant"
            recommended_shift = "ensemble or spectacle"
        else:
            threshold = "overwhelming"
            recommended_shift = "spectacle/concept/op_mode"
        
        return PowerImbalanceOutput(
            raw_imbalance=raw_imbalance,
            effective_imbalance=effective_imbalance,
            context_modifiers=detection.detected_modifiers,
            total_modifier=total_modifier,
            threshold=threshold,
            recommended_scale_shift=recommended_shift,
            triggers_op_mode=effective_imbalance > 10,
            triggers_tension_shift=effective_imbalance > 3,
            reasoning=detection.reasoning
        )
    
    _output_schema_override = None
    
    @property
    def output_schema(self):
        if self._output_schema_override:
            return self._output_schema_override
        return ScaleOutput
    
    def get_scale_techniques(self, scale: NarrativeScale) -> List[str]:
        """Get recommended narration techniques for a scale."""
        techniques = {
            NarrativeScale.TACTICAL: [
                "Explain ability mechanics",
                "Show strategic thinking",
                "Detail positioning and timing",
                "Reference previous information",
                "Highlight resource management"
            ],
            NarrativeScale.ENSEMBLE: [
                "Balance team member spotlight",
                "Show combo attacks",
                "Highlight unique roles",
                "Create team coordination moments",
                "Include team banter"
            ],
            NarrativeScale.SPECTACLE: [
                "Describe visual impact",
                "Use exclamations and emphasis",
                "Scale up the environment",
                "Focus on power displays",
                "Hype energy over tactics"
            ],
            NarrativeScale.EXISTENTIAL: [
                "Internal monologue",
                "Question purpose",
                "Reference past trauma",
                "Explore moral implications",
                "Moments of doubt"
            ],
            NarrativeScale.UNDERDOG: [
                "Emphasize the gap",
                "Celebrate small wins",
                "Show determination",
                "Find clever solutions",
                "Build hope against odds"
            ],
            NarrativeScale.SLICE_OF_LIFE: [
                "Focus on character moments",
                "Small talk and banter",
                "Environmental details",
                "Relationship development",
                "Mundane made charming"
            ],
            NarrativeScale.HORROR: [
                "Describe sensory details",
                "Limit information",
                "Emphasize vulnerability",
                "Build dread slowly",
                "Use silence and stillness"
            ],
            NarrativeScale.MYSTERY: [
                "Plant clues subtly",
                "Raise questions",
                "Control information flow",
                "Show deduction process",
                "Reveal strategically"
            ],
            NarrativeScale.COMEDY: [
                "Subvert expectations",
                "Exaggerate reactions",
                "Use comedic timing",
                "Self-aware humor",
                "Rule of funny over logic"
            ]
        }
        return techniques.get(scale, [])
    
    def get_tension_source(self, scale: NarrativeScale) -> str:
        """Get the tension source for a scale."""
        sources = {
            NarrativeScale.TACTICAL: "Will their strategy work?",
            NarrativeScale.ENSEMBLE: "Can the team coordinate in time?",
            NarrativeScale.SPECTACLE: "How far can they push their power?",
            NarrativeScale.EXISTENTIAL: "What will they choose to become?",
            NarrativeScale.UNDERDOG: "Can they survive against the odds?",
            NarrativeScale.SLICE_OF_LIFE: "Will they connect with each other?",
            NarrativeScale.HORROR: "What lurks in the unknown?",
            NarrativeScale.MYSTERY: "What is the truth they're missing?",
            NarrativeScale.COMEDY: "What absurdity comes next?"
        }
        return sources.get(scale, "Narrative tension")
    
    def _tier_to_range(self, tier: str) -> str:
        """Convert tier to tier range for compatibility lookup."""
        try:
            tier_num = int(tier.replace("T", "").strip())
        except:
            return "human"
        
        if tier_num >= 10:
            return "human"
        elif tier_num == 9:
            return "athletic"
        elif tier_num >= 7:
            return "superhuman"
        elif tier_num == 6:
            return "city"
        elif tier_num == 5:
            return "planetary"
        elif tier_num >= 2:
            return "cosmic"
        else:
            return "boundless"
    
    def check_scale_compatibility(self, scale: NarrativeScale, tier: str) -> str:
        """
        Check if a scale is compatible with a power tier.
        
        Args:
            scale: The narrative scale to check
            tier: The power tier (e.g., "T5")
            
        Returns:
            "OK", "ACCEPTABLE", "DISCOURAGED", or "FORBIDDEN"
        """
        tier_range = self._tier_to_range(tier)
        scale_name = scale.value if isinstance(scale, NarrativeScale) else scale
        
        compatibility = SCALE_COMPATIBILITY.get(tier_range, {})
        return compatibility.get(scale_name, "ACCEPTABLE")
    
    def validate_scale(self, scale: NarrativeScale, tier: str) -> Dict[str, Any]:
        """
        Validate a scale choice and suggest alternatives if forbidden.
        
        Args:
            scale: The chosen scale
            tier: The power tier
            
        Returns:
            Dict with is_valid, compatibility, and alternative if needed
        """
        compatibility = self.check_scale_compatibility(scale, tier)
        tier_range = self._tier_to_range(tier)
        
        result = {
            "is_valid": compatibility != "FORBIDDEN",
            "compatibility": compatibility,
            "scale": scale.value if isinstance(scale, NarrativeScale) else scale,
            "tier": tier,
            "tier_range": tier_range,
            "alternative": None,
            "warning": None
        }
        
        if compatibility == "FORBIDDEN":
            # Find best alternative
            alternatives = SCALE_COMPATIBILITY.get(tier_range, {})
            ok_scales = [s for s, c in alternatives.items() if c == "OK"]
            if ok_scales:
                result["alternative"] = ok_scales[0]
            result["warning"] = f"{scale} is FORBIDDEN at {tier}. Consider: {', '.join(ok_scales[:3])}"
        elif compatibility == "DISCOURAGED":
            result["warning"] = f"{scale} is DISCOURAGED at {tier}. Proceed with caution."
        
        return result
    
    async def suggest_op_preset(
        self,
        behavior_history: List[str],
        character_tier: str,
        high_imbalance_count: int
    ) -> Optional[Dict[str, Any]]:
        """
        Suggest an OP preset based on observed player behavior.
        
        Per Module 12: Auto-suggest preset after 3+ high-imbalance encounters.
        
        Args:
            behavior_history: List of recent action descriptions
            character_tier: Current power tier
            high_imbalance_count: Number of encounters with imbalance > 10
            
        Returns:
            Suggestion dict with preset and reasoning, or None if not ready
        """
        # Need 3+ high-imbalance encounters to suggest
        if high_imbalance_count < 3:
            return None
        
        # Need to be at least T7 (building level)
        tier_num = self._tier_to_num(character_tier)
        if tier_num < 3:  # T7 or lower
            return None
        
        # Behavior patterns that suggest presets
        behavior_text = "\n".join(behavior_history[-20:])  # Last 20 actions
        
        context = f"""# OP Preset Suggestion

## Player Behavior Analysis
{behavior_text}

## Power Context
- Current Tier: {character_tier}
- High-Imbalance Encounters: {high_imbalance_count}

## Task
Based on observed behavior, suggest the most appropriate OP Protagonist preset:

1. **bored_god** - Humor/casual in combat, seems bored, instant victories (Saitama)
2. **restrainer** - Many defensive actions, restraint, emotional focus (Mob)
3. **hidden_ruler** - Strategic, manages others, hides true power (Overlord)
4. **burden_bearer** - Trying to stay hidden, avoids attention, wants normal life (Saiki K)
5. **muscle_wizard** - Absurd simplicity, earnest reactions, physical solutions (Mashle)
6. **sealed_apocalypse** - Seals power, school/life focus, secret identity (Wang Ling)
7. **wandering_legend** - Mysterious, wandering, episodic encounters (Vampire D)
8. **nation_builder** - Building/recruiting focus, nation management, collecting allies (Rimuru)
9. **disguised_god** - Disguised god, romance/coffee focus, comedic contrast (Deus)
10. **time_looper** - Iteration, learning, death as reset (Re:Zero, Steins;Gate)
11. **immortal** - Can't die, burden of eternity (Ajin, Highlander)

Analyze the behavior patterns and recommend the best fit."""

        from pydantic import BaseModel as PydanticModel, Field as PydanticField
        
        class PresetSuggestion(PydanticModel):
            suggested_preset: str = PydanticField(
                description="One of: bored_god, restrainer, hidden_ruler, burden_bearer, muscle_wizard, etc."
            )
            tension_source: str = PydanticField(
                description="The tension source axis: existential, relational, moral, burden, information, consequence, control"
            )
            power_expression: str = PydanticField(
                description="The power expression axis: instantaneous, overwhelming, sealed, hidden, conditional, derivative, passive"
            )
            narrative_focus: str = PydanticField(
                description="The narrative focus axis: internal, ensemble, reverse_ensemble, episodic, faction, mundane, competition, legacy"
            )
            confidence: float = PydanticField(
                description="0.0 to 1.0 confidence in suggestion"
            )
            reasoning: str = PydanticField(
                description="Why this preset fits the observed behavior"
            )
        
        original_schema = self._output_schema_override
        self._output_schema_override = PresetSuggestion
        
        try:
            suggestion = await self.call(context)
        finally:
            self._output_schema_override = original_schema
        
        if isinstance(suggestion, PresetSuggestion):
            return {
                "preset": suggestion.suggested_preset,
                "tension_source": suggestion.tension_source,
                "power_expression": suggestion.power_expression,
                "narrative_focus": suggestion.narrative_focus,
                "confidence": suggestion.confidence,
                "reasoning": suggestion.reasoning,
                "should_prompt": suggestion.confidence >= 0.7
            }
        
        return None


# Convenience function
def get_scale_selector() -> ScaleSelectorAgent:
    """Get a ScaleSelectorAgent instance."""
    return ScaleSelectorAgent()
