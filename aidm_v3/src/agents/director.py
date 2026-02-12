"""Director Agent - Long-term narrative planning (Phase 4).

Supports an optional agentic INVESTIGATION phase before structured planning.
When tools are provided, the Director uses tool-calling to research NPC
trajectories, foreshadowing status, and spotlight balance before making
arc decisions.
"""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field

from .base import AgenticAgent
from ..llm import get_llm_manager
from ..llm.tools import ToolRegistry
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


class DirectorAgent(AgenticAgent):
    """
    The Showrunner. Plans arcs, tracks foreshadowing, and manages pacing.
    Runs asynchronously at session boundaries or intervals.
    """
    
    agent_name = "director"
    
    def __init__(self, model_override: Optional[str] = None):
        super().__init__(model_override=model_override)
        
        # Load the base system prompt via shared helper
        self._base_prompt = self._load_prompt_file(
            "director.md", "You are the Director. Plan the campaign flow."
        )

    @property
    def system_prompt(self):
        """Default system prompt (can be overridden per-call)."""
        return self._base_prompt
    
    @property
    def output_schema(self):
        return DirectorOutput

    async def _investigation_phase(
        self,
        session: Session,
        world_state: Optional[WorldState],
        tools: ToolRegistry,
    ) -> str:
        """Run investigation using tool-calling before arc planning.
        
        Uses FAST model (via AgenticAgent.research_with_tools) to gather NPC
        trajectories, foreshadowing status, and spotlight balance data.
        
        Returns:
            Investigation findings as text, or empty string on failure
        """
        location = world_state.location if world_state else "Unknown"
        situation = world_state.situation if world_state else "Unknown"
        session_summary = session.summary or "(No summary yet)"
        
        investigation_prompt = f"""You are a narrative analyst investigating the current state 
of an anime RPG campaign to help the Director plan the next arc.

Session summary: {session_summary[:500]}
Current location: {location}
Current situation: {situation}

Using the tools available, investigate:
1. Get the campaign bible to understand previous Director decisions
2. Check active foreshadowing — any seeds ready for callback or overdue?
3. Run a spotlight analysis — which NPCs need more or less screen time?
4. For the top 1-2 underserved NPCs, get their full trajectory
5. Search memory for any unresolved plot threads

Provide a CONCISE investigation report structured as:
- ARC CONTINUITY: What did the last Director pass plan? Are we on track?
- FORESHADOWING STATUS: Seeds ready for payoff, seeds going stale
- NPC SPOTLIGHT: Who needs attention, who's overexposed
- UNRESOLVED THREADS: Plot hooks that need addressing
- RECOMMENDATION: What should the next arc beat focus on?"""
        
        # Set tools and delegate to AgenticAgent.research_with_tools()
        self.set_tools(tools)
        return await self.research_with_tools(
            research_prompt=investigation_prompt,
            system="You are a narrative analyst. Use tools to gather data, then write a concise investigation report.",
            max_tool_rounds=4,
        )
    
    async def run_session_review(
        self, 
        session: Session, 
        bible: CampaignBible,
        profile: NarrativeProfile,
        world_state: Optional[WorldState] = None,
        op_preset: Optional[str] = None,
        op_tension_source: Optional[str] = None,
        op_mode_guidance: Optional[str] = None,
        tools: Optional[ToolRegistry] = None,
        compaction_text: str = ""
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
            tools: Optional ToolRegistry for investigation phase
        """
        
        # === AGENTIC INVESTIGATION PHASE (optional) ===
        investigation_findings = ""
        if tools:
            investigation_findings = await self._investigation_phase(
                session=session,
                world_state=world_state,
                tools=tools,
            )
        
        # 1. Build Director Persona
        persona = profile.director_personality or "You are a thoughtful anime director."
        system_prompt = f"{persona}\n\n{self._base_prompt}"
        
        # 2. Build Context (with investigation findings and compaction if available)
        context = self._build_review_context(
            session, bible, world_state, profile, op_preset, op_tension_source, op_mode_guidance,
            investigation_findings=investigation_findings,
            compaction_text=compaction_text
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
        op_mode_guidance: Optional[str] = None,
        investigation_findings: str = "",
        compaction_text: str = ""
    ) -> str:
        """Construct the context prompt for the Director."""
        
        lines = ["# Campaign Status Review"]
        
        # === INVESTIGATION FINDINGS (from agentic research) ===
        if investigation_findings:
            lines.append("\n## 🔍 Investigation Report (Tool-Based Research)")
            lines.append(investigation_findings)
            lines.append("")
        
        # === NARRATIVE INTELLIGENCE (from compaction buffer) ===
        if compaction_text:
            lines.append("\n## 📜 Narrative Intelligence (Compacted History)")
            lines.append("These are narrative beats from earlier in the session that are no longer")
            lines.append("in verbatim memory. Use for arc awareness, emotional trajectory, and continuity.")
            lines.append(compaction_text)
            lines.append("")
        
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
        
        # =====================================================================
        # Genre-Specific Arc Templates (IP Authenticity)
        # =====================================================================
        if profile and hasattr(profile, 'detected_genres') and profile.detected_genres:
            lines.append("\n## 🎬 Genre Arc Templates")
            genre_arc_templates = {
                "shonen": [
                    "**Training Arc**: Intro→Struggle→Breakthrough→Demonstrate in combat",
                    "**Tournament Arc**: R1 fodder→R2 rival→R3 unexpected→Finals antagonist",
                    "**Rescue Mission**: Assemble team→Infiltrate→Fight minions→Boss→Escape"
                ],
                "seinen": [
                    "**Moral Dilemma Arc**: Present impossible choice→Show consequences→No clean answer",
                    "**Conspiracy Unravel**: Clues→Paranoia→Betrayal reveal→Systemic corruption",
                    "**Survival Horror**: Isolation→Mounting dread→Deaths→Narrow escape"
                ],
                "isekai": [
                    "**Power Discovery**: Weakness→System awakens→Experiment→First victory",
                    "**Kingdom Building**: Gain territory→Recruit NPCs→Defend→Expand influence",
                    "**World Comparison**: Fish out of water→Culture clash→Adapt→Homesickness"
                ],
                "shoujo_romance": [
                    "**Love Triangle**: Meet both→Compare→Crisis→Choice",
                    "**Slow Burn**: Meet cute→Misunderstandings→Confession fake-out→True confession",
                    "**Rivals to Lovers**: Antagonism→Forced proximity→Vulnerability→Feelings"
                ],
                "supernatural": [
                    "**Monster of Week**: Investigation→Hunt→Battle→Lore reveal",
                    "**Occult Mystery**: Strange events→Research→Summoning/ritual→Confrontation",
                    "**Possession Arc**: Subtle changes→Discovery→Fight for control→Exorcism"
                ],
                "mystery_thriller": [
                    "**Whodunit**: Crime→Suspects→Red herrings→Revelation→Confrontation",
                    "**Cat and Mouse**: Establish genius antagonist→Close calls→Trap→Reversal",
                    "**Conspiracy**: Small clue→Bigger picture→Everyone involved→Trust no one"
                ],
                "horror": [
                    "**Survival Horror**: Isolation→First death→Dwindling resources→Escape attempt",
                    "**Psychological**: Reality questions→Paranoia→Reveal→Ambiguous ending",
                    "**Monster Hunt**: Learn weakness→Prepare→Confront→Pyrrhic victory"
                ],
                "slice_of_life": [
                    "**Festival Arc**: Preparation→Event→Bonding→Bittersweet ending",
                    "**New Member**: Introduction→Friction→Understanding→Acceptance",
                    "**Seasonal Change**: Summer vacation→School trip→Cultural festival→Graduation"
                ],
                "sports": [
                    "**Tournament**: Qualifiers→Group stage→Semifinals→Finals",
                    "**Rivalry Match**: Train for specific opponent→Analyze→Close game→Growth",
                    "**Team Building**: Recruit→Train together→First loss→Comeback"
                ],
                "mecha": [
                    "**First Sortie**: Reluctant pilot→Emergency→Awakening→Victory",
                    "**Upgrade Arc**: Defeat→New unit development→Training→Revenge match",
                    "**Final Defense**: Overwhelming odds→Sacrifices→Last stand→Decisive blow"
                ],
                "comedy": [
                    "**Misunderstanding Spiral**: Small confusion→Escalates→Chaos peak→Anticlimax resolution",
                    "**Competition Gone Wrong**: Simple contest→Ridiculous stakes→Cheating→Everyone loses",
                    "**Fish Out of Water**: New environment→Culture clash→Hilarious failures→Adaptation"
                ],
                "magical_girl": [
                    "**Awakening Arc**: Normal life→Mascot appears→First transformation→Defeat monster→Accept destiny",
                    "**Team Assembly**: Solo→Meet second→Rivalry→Friendship→Full team",
                    "**Dark Magical Girl**: Enemy magical girl→Tragic backstory→Redemption or sacrifice"
                ],
                "historical": [
                    "**Political Intrigue**: Stable court→Conspiracy hints→Factions form→Climactic confrontation",
                    "**War Campaign**: March to war→Skirmishes→Major battle→Aftermath",
                    "**Honor Duel**: Insult→Challenge→Training/preparation→Duel→Consequences"
                ],
                "music": [
                    "**First Performance**: Form group→Practice struggles→Stage fright→Breakthrough performance",
                    "**Competition Arc**: Rivals introduced→Preparation→Preliminaries→Finals→Growth over victory",
                    "**Creative Block**: Success→Pressure→Block→Inspiration→Comeback"
                ],
                "scifi": [
                    "**First Contact**: Discovery→Communication attempts→Misunderstanding→Understanding or conflict",
                    "**AI Dilemma**: AI introduced→Grows→Questions humanity→Crisis→Resolution",
                    "**Colony Crisis**: Isolated→Systems fail→Survival→Rescue or self-sufficiency"
                ],
                "josei": [
                    "**Workplace Drama**: New job→Culture shock→Mentor→Challenge→Success or growth",
                    "**Reunion Romance**: Meet again→Reignite feelings→Address past→Decide→Move forward",
                    "**Quarter-Life Crisis**: Routine→Disruption→Question everything→Experiment→New direction"
                ],
                "ecchi": [
                    "**New Suitor Arc**: Mysterious stranger→Reveal interest→Rivalry→Integration into group",
                    "**Vacation Episode**: Group trip→Compromising situations→Bonding moments→Return closer",
                    "**Confession Dodge**: Building feelings→Confession attempt→Interruption→Progress anyway"
                ]
            }
            
            for genre in profile.detected_genres[:2]:  # Primary + 1 secondary
                genre_key = genre.lower().replace(" ", "_").replace("-", "_")
                if genre_key in genre_arc_templates:
                    lines.append(f"\n**{genre.title()} Templates:**")
                    for template in genre_arc_templates[genre_key]:
                        lines.append(f"  {template}")
            
            lines.append("\n*Use these templates as arc structure guides. Adapt to current story.*")
        
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
