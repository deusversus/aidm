"""Director Agent - Long-term narrative planning (Phase 4)."""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from pathlib import Path

from .base import BaseAgent
from ..db.models import Session, CampaignBible, WorldState
from ..profiles.loader import NarrativeProfile

class DirectorOutput(BaseModel):
    """Structured output from the Director's planning session."""
    
    current_arc: str = Field(description="Name of the current story arc")
    arc_phase: str = Field(description="Current phase (Setup, Rising Action, Climax, Resolution)")
    tension_level: float = Field(description="Current narrative tension (0.0 to 1.0)")
    
    active_foreshadowing: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="List of active foreshadowing seeds and their status"
    )
    
    spotlight_debt: Dict[str, int] = Field(
        default_factory=dict, 
        description="Map of Character/NPC names to spotlight score (negative = needs screen time)"
    )
    
    director_notes: str = Field(
        description="High-level guidance for the Key Animator for the next session/segment"
    )
    
    voice_patterns: str = Field(
        default="",
        description="Key voice traits to maintain: humor style (sarcastic/earnest), sentence rhythm (punchy/flowing), narrator distance (intimate/cinematic)"
    )
    
    analysis: str = Field(description="Reasoning behind these decisions")


class DirectorAgent(BaseAgent):
    """
    The Showrunner. Plans arcs, tracks foreshadowing, and manages pacing.
    Runs asynchronously at session boundaries or intervals.
    """
    
    agent_name = "director"
    
    def __init__(self, model_override: Optional[str] = None):
        super().__init__(model_override=model_override)
        
        # Load the base system prompt
        prompt_path = Path(__file__).parent.parent.parent / "prompts" / "director.md"
        if prompt_path.exists():
            self._base_prompt = prompt_path.read_text(encoding="utf-8")
        else:
            self._base_prompt = "You are the Director. Plan the campaign flow."

    @property
    def system_prompt(self):
        """Default system prompt (can be overridden per-call)."""
        return self._base_prompt
    
    @property
    def output_schema(self):
        return DirectorOutput

    async def run_session_review(
        self, 
        session: Session, 
        bible: CampaignBible,
        profile: NarrativeProfile,
        world_state: Optional[WorldState] = None,
        op_preset: Optional[str] = None,
        op_tension_source: Optional[str] = None,
        op_mode_guidance: Optional[str] = None
    ) -> DirectorOutput:
        """
        Analyze the session and update the Campaign Bible.
        
        Args:
            session: The completed session with summary
            bible: Current planning state
            profile: The narrative profile (for persona)
            world_state: Current logical state of the world
            op_preset: Optional OP preset (e.g., "bored_god", "hidden_ruler")
            op_tension_source: Optional OP tension source axis
            op_mode_guidance: Optional RAG-retrieved 3-axis guidance
        """
        
        # 1. Build Director Persona
        persona = profile.director_personality or "You are a thoughtful anime director."
        system_prompt = f"{persona}\n\n{self._base_prompt}"
        
        # 2. Build Context
        context = self._build_review_context(
            session, bible, world_state, profile, op_preset, op_tension_source, op_mode_guidance
        )
        
        # 3. Call LLM with dynamic system prompt override
        result = await self.call(context, system_prompt_override=system_prompt)
        
        return result

    def _build_review_context(
        self, 
        session: Session, 
        bible: CampaignBible,
        world_state: Optional[WorldState],
        profile: Optional[NarrativeProfile] = None,
        op_preset: Optional[str] = None,
        op_tension_source: Optional[str] = None,
        op_mode_guidance: Optional[str] = None
    ) -> str:
        """Construct the context prompt for the Director."""
        
        lines = ["# Campaign Status Review"]
        
        # =====================================================================
        # Narrative DNA (Calibrate Arc Pacing)
        # =====================================================================
        if profile and profile.dna:
            lines.append("\n## 🎭 Narrative DNA (Guide Your Arc Decisions)")
            dna = profile.dna
            
            # Key scales for Director decisions
            comedy_drama = dna.get('comedy_vs_drama', 5)
            fast_slow = dna.get('fast_paced_vs_slow_burn', 5)
            hopeful_cynical = dna.get('hopeful_vs_cynical', 5)
            ensemble = dna.get('ensemble_vs_solo', 5)
            
            lines.append(f"- Comedy/Drama: {comedy_drama}/10 {'(serious, minimal humor)' if comedy_drama <= 3 else '(comedic, lighthearted)' if comedy_drama >= 7 else ''}")
            lines.append(f"- Pacing: {fast_slow}/10 {'(FAST - short arcs, rapid escalation)' if fast_slow <= 3 else '(SLOW - long arcs, gradual build)' if fast_slow >= 7 else ''}")
            lines.append(f"- Hopeful/Cynical: {hopeful_cynical}/10 {'(optimistic resolutions)' if hopeful_cynical <= 3 else '(pyrrhic victories, dark endings)' if hopeful_cynical >= 7 else ''}")
            lines.append(f"- Ensemble/Solo: {ensemble}/10 {'(team-focused, share spotlight)' if ensemble <= 3 else '(single protagonist focus)' if ensemble >= 7 else ''}")
            
            # Interpretation guidance
            if fast_slow >= 7:
                lines.append("\n*PACING: This IP uses SLOW BURN. Plan 4-6 session arcs. Plant seeds early. Payoffs should feel earned.*")
            elif fast_slow <= 3:
                lines.append("\n*PACING: This IP is FAST. Plan 2-3 session arcs. Escalate quickly. Don't linger.*")
        
        # =====================================================================
        # Active Tropes (Arc Planning Hooks)
        # =====================================================================
        if profile and profile.tropes:
            active = [k for k, v in profile.tropes.items() if v]
            inactive = [k for k, v in profile.tropes.items() if not v]
            
            if active:
                lines.append("\n## 📖 Active Tropes (Plan These Into Arcs)")
                for trope in active:
                    trope_name = trope.replace('_', ' ').title()
                    # Add guidance for key tropes
                    if trope == 'mentor_death':
                        lines.append(f"- **{trope_name}**: The mentor WILL die. Foreshadow this. Make their wisdom meaningful.")
                    elif trope == 'betrayal':
                        lines.append(f"- **{trope_name}**: An ally will betray. Plant seeds of doubt. Make it hurt.")
                    elif trope == 'tournament_arc':
                        lines.append(f"- **{trope_name}**: Consider a tournament arc. Great for introducing rivals.")
                    elif trope == 'redemption_arc':
                        lines.append(f"- **{trope_name}**: Keep one villain redeemable. Give them sympathetic moments.")
                    elif trope == 'tragic_backstory':
                        lines.append(f"- **{trope_name}**: NPCs hint at dark pasts. Reveal slowly for emotional impact.")
                    elif trope == 'sacrifice':
                        lines.append(f"- **{trope_name}**: Someone may sacrifice themselves. Build relationships first.")
                    else:
                        lines.append(f"- {trope_name}")
                
            if inactive and 'power_of_friendship' in inactive:
                lines.append("\n*NOTE: `power_of_friendship` is OFF. Victories come from skill, not bonds. Teamwork is tactical, not magical.*")
        
        # OP Mode context (if active)
        if op_preset and op_mode_guidance:
            lines.append("\n## ⚡ OP Protagonist Mode Active")
            lines.append(f"**Preset:** {op_preset.replace('_', ' ').title()}")
            if op_tension_source:
                lines.append(f"**Tension Source:** {op_tension_source}")
            lines.append(op_mode_guidance)
            lines.append("\n*IMPORTANT: Adjust arc planning for this composition. Reduce combat focus, "
                        "increase stakes matching the tension source.*")
        
        # Previous Plans
        if bible.planning_data:
            lines.append("\n## Current Campaign Bible (Previous)")
            lines.append(str(bible.planning_data))
        else:
            lines.append("\n## Current Campaign Bible")
            lines.append("(No data yet - Initial Planning)")
            
        # Recent Events
        lines.append(f"\n## Session Summary (ID: {session.id})")
        lines.append(session.summary or "(Session just finished, summary pending parsing)")
        
        # World Context
        if world_state:
            lines.append("\n## World State")
            lines.append(f"Location: {world_state.location}")
            if world_state.situation:
                lines.append(f"Situation: {world_state.situation}")
        
        lines.append("\n## Instructions")
        lines.append("Analyze the session events. Specific focus on:")
        lines.append("1. Did we advance the current arc?")
        lines.append("2. Were any planted seeds paid off?")
        lines.append("3. Who was the MVP? Who was invisible?")
        if op_preset:
            lines.append(f"4. Are we honoring the {op_preset.replace('_', ' ').title()} composition? (tension from right sources?)")
        lines.append("Update the Bible accordingly.")
        
        return "\n".join(lines)
