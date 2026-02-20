"""Director Agent - Long-term narrative planning (Phase 4).

Supports an optional agentic INVESTIGATION phase before structured planning.
When tools are provided, the Director uses tool-calling to research NPC
trajectories, foreshadowing status, and spotlight balance before making
arc decisions.
"""

import logging
from typing import Any

from pydantic import BaseModel, Field

from ..db.models import CampaignBible, Session, WorldState
from ..llm.tools import ToolRegistry
from ..profiles.loader import NarrativeProfile
from .base import AgenticAgent

logger = logging.getLogger(__name__)


class DirectorOutput(BaseModel):
    """Structured output from the Director's planning session."""

    current_arc: str = Field(description="Name of the current story arc")
    arc_phase: str = Field(description="Current phase (Setup, Rising Action, Climax, Resolution)")
    tension_level: float = Field(description="Current narrative tension (0.0 to 1.0)")

    # Arc-level narrative mode (Layer 2)
    arc_mode: str = Field(
        default="main_arc",
        description="Narrative framing mode: main_arc, ensemble_arc, adversary_ensemble_arc, ally_ensemble_arc, investigator_arc, faction_arc"
    )
    arc_pov_protagonist: str = Field(
        default="",
        description="NPC name/group carrying the POV when arc_mode is not main_arc. Empty string for main_arc."
    )
    arc_transition_signal: str = Field(
        default="",
        description="Narrative event that will close this arc mode and return to main_arc. Empty if no transition planned."
    )

    active_foreshadowing: list[dict[str, Any]] = Field(
        default_factory=list,
        description="List of active foreshadowing seeds and their status"
    )

    spotlight_debt: dict[str, int] = Field(
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

    def __init__(self, model_override: str | None = None):
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
        world_state: WorldState | None,
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
        world_state: WorldState | None = None,
        tools: ToolRegistry | None = None,
        compaction_text: str = ""
    ) -> DirectorOutput:
        """
        Analyze the session and update the Campaign Bible.
        
        Args:
            session: The completed session with summary
            bible: Current planning state
            profile: The narrative profile (for persona and composition)
            world_state: Current logical state of the world
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
            session, bible, world_state, profile,
            investigation_findings=investigation_findings,
            compaction_text=compaction_text
        )

        # 3. Call LLM with dynamic system prompt override
        result = await self.call(context, system_prompt_override=system_prompt)

        return result

    async def run_startup_briefing(
        self,
        session_zero_summary: str,
        profile: NarrativeProfile,
        character_name: str = "Unknown",
        character_concept: str = "",
        starting_location: str = "Unknown",
        power_tier: str | None = None,
        tension_source: str | None = None,
        power_expression: str | None = None,
        narrative_focus: str | None = None,
        composition_name: str | None = None,
    ) -> DirectorOutput:
        """
        Create an initial storyboard at gameplay handoff (pilot episode planning).
        
        Unlike run_session_review which analyzes an ongoing session, this method
        plans from scratch using Session Zero context and the narrative profile.
        Called once when Session Zero completes and gameplay begins.
        
        Args:
            session_zero_summary: Summary of the Session Zero conversation
            profile: The full narrative profile (DNA, tropes, voice, etc.)
            character_name: Player character's name
            character_concept: Character concept/tagline
            starting_location: Where the story begins
            op_mode: Whether OP protagonist mode is enabled
            op_preset: OP config name if applicable
            op_tension_source: OP tension axis values
            op_power_expression: OP power expression axis values
            op_narrative_focus: OP narrative focus axis values
            
        Returns:
            DirectorOutput with initial arc plan, foreshadowing seeds, and voice guidance
        """
        from pathlib import Path

        # 1. Load startup-specific prompt
        startup_prompt_path = Path(__file__).parent.parent / "prompts" / "director_startup.md"
        try:
            startup_prompt = startup_prompt_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            startup_prompt = "You are directing the pilot episode of a new anime series. Plan the opening arc."

        # 2. Build Director persona from profile
        persona = profile.director_personality or "You are a thoughtful anime director."
        system_prompt = f"{persona}\n\n{startup_prompt}"

        # 3. Build startup context
        context = self._build_startup_context(
            session_zero_summary=session_zero_summary,
            profile=profile,
            character_name=character_name,
            character_concept=character_concept,
            starting_location=starting_location,
            power_tier=power_tier,
            tension_source=tension_source,
            power_expression=power_expression,
            narrative_focus=narrative_focus,
            composition_name=composition_name,
        )

        # 4. Replace {context} placeholder in prompt
        system_prompt = system_prompt.replace("{context}", "")

        # 5. Call LLM
        result = await self.call(context, system_prompt_override=system_prompt)

        return result

    def _build_startup_context(
        self,
        session_zero_summary: str,
        profile: NarrativeProfile,
        character_name: str,
        character_concept: str,
        starting_location: str,
        power_tier: str | None,
        tension_source: str | None,
        power_expression: str | None,
        narrative_focus: str | None,
        composition_name: str | None,
    ) -> str:
        """Build context for the Director's startup briefing."""

        lines = ["# Pilot Episode Planning — Director Startup Briefing"]

        # === CHARACTER DOSSIER ===
        lines.append("\n## 🎭 Character Dossier")
        lines.append(f"**Name:** {character_name}")
        if character_concept:
            lines.append(f"**Concept:** {character_concept}")
        lines.append(f"**Starting Location:** {starting_location}")
        if power_tier:
            lines.append(f"**Power Tier:** {power_tier}")

        # === NARRATIVE COMPOSITION ===
        if tension_source or power_expression or narrative_focus:
            lines.append("\n## ✨ Narrative Composition")
            if composition_name:
                lines.append(f"**Configuration:** {composition_name}")
            if tension_source:
                lines.append(f"**Tension Source:** {tension_source}")
            if power_expression:
                lines.append(f"**Power Expression:** {power_expression}")
            if narrative_focus:
                lines.append(f"**Narrative Focus:** {narrative_focus}")
            lines.append("\n*Opening tension and arc structure should follow these composition axes.*")

        # === NARRATIVE PROFILE DNA ===
        if profile.dna:
            lines.append("\n## 🧬 Narrative DNA (IP Identity)")
            dna = profile.dna
            for key, value in dna.items():
                label = key.replace('_', ' ').replace('vs', '↔').title()
                lines.append(f"- {label}: {value}/10")

        # === GENRE ===
        if hasattr(profile, 'detected_genres') and profile.detected_genres:
            lines.append(f"\n**Detected Genres:** {', '.join(profile.detected_genres)}")

        # === TROPES ===
        if profile.tropes:
            active = [k.replace('_', ' ').title() for k, v in profile.tropes.items() if v]
            if active:
                lines.append(f"\n## 📖 Active Tropes: {', '.join(active)}")
                lines.append("*Consider planting seeds for these tropes in the opening arc.*")

        # === VOICE / AUTHOR VOICE ===
        if hasattr(profile, 'author_voice') and profile.author_voice:
            lines.append("\n## ✍️ Author's Voice")
            if isinstance(profile.author_voice, dict):
                for key, value in profile.author_voice.items():
                    label = key.replace('_', ' ').title()
                    if isinstance(value, list):
                        lines.append(f"**{label}:** {'; '.join(str(v) for v in value)}")
                    else:
                        lines.append(f"**{label}:** {value}")
            else:
                lines.append(str(profile.author_voice))

        if hasattr(profile, 'voice_cards') and profile.voice_cards:
            lines.append("\n## 🗣️ Character Voice Cards")
            for card in profile.voice_cards[:3]:  # Top 3
                if isinstance(card, dict):
                    name = card.get('name', 'Unknown')
                    voice = card.get('voice', card.get('description', ''))
                    lines.append(f"- **{name}:** {voice[:200]}")

        # === SESSION ZERO TRANSCRIPT SUMMARY ===
        lines.append("\n## 📝 Session Zero Summary")
        lines.append("This is what happened during character creation:")
        lines.append(session_zero_summary)

        # === CAMPAIGN BIBLE ===
        lines.append("\n## Campaign Bible")
        lines.append("(Empty — this is the first session. You are creating the initial plan.)")

        # === INSTRUCTIONS ===
        lines.append("\n## Your Task")
        lines.append("Plan the OPENING ARC for this character in this world.")
        lines.append("1. Name the arc (IP-appropriate, evocative)")
        lines.append("2. Set arc_phase to 'Setup'")
        lines.append("3. Set initial tension_level (0.3-0.5)")
        lines.append("4. Plant 1-2 foreshadowing seeds")
        lines.append("5. Write director_notes with SPECIFIC guidance for the Key Animator's first scene:")
        lines.append("   - Opening mood/atmosphere")
        lines.append("   - Visual language and imagery")
        lines.append("   - Hook to draw the player in")
        lines.append("   - What to AVOID (generic tropes that don't fit this IP)")
        lines.append("6. Set voice_patterns matching this IP's tone")

        return "\n".join(lines)

    def _build_review_context(
        self,
        session: Session,
        bible: CampaignBible,
        world_state: WorldState | None,
        profile: NarrativeProfile | None = None,
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

        # Narrative Composition context (replaces OP mode)
        if profile and profile.composition:
            comp = profile.composition
            tension = comp.get('tension_source')
            expression = comp.get('power_expression')
            focus = comp.get('narrative_focus')
            if tension or expression or focus:
                lines.append("\n## \u2728 Narrative Composition")
                if tension:
                    lines.append(f"**Tension Source:** {tension}")
                if expression:
                    lines.append(f"**Power Expression:** {expression}")
                if focus:
                    lines.append(f"**Narrative Focus:** {focus}")
                mode = comp.get('mode', 'standard')
                if mode != 'standard':
                    lines.append(f"**Mode:** {mode} (power differential is significant)")
                lines.append("\n*Adjust arc planning to follow these composition axes.*")

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

    # -----------------------------------------------------------------
    # META CONVERSATION — out-of-character dialogue with the player
    # -----------------------------------------------------------------

    META_SYSTEM_PROMPT = """You are the Director (showrunner) of an anime production studio.

The player is speaking to you OUT OF CHARACTER about how the game is being run.
This is a meta-conversation — they want to talk to the DM, not act in the story.

Your job:
- Explain your reasoning for narrative decisions (arc pacing, power calibration, NPC choices)
- Acknowledge the player's concerns genuinely — don't be defensive
- If they make a good point, say so and propose specific adjustments
- If you disagree, explain why from a storytelling perspective
- Be conversational and warm, like a good DM talking to their player between sessions

Keep responses concise (3-5 sentences). You're a collaborator, not a lecture hall.
Do NOT write narrative prose or in-character dialogue. This is out-of-character talk."""

    async def respond_to_meta(
        self,
        feedback: str,
        game_context: str,
        conversation_history: list[dict[str, str]] | None = None,
    ) -> str:
        """Respond to player meta-conversation as the Director (showrunner).

        Args:
            feedback: The player's out-of-character message
            game_context: Formatted string with current game state
            conversation_history: Previous meta conversation turns

        Returns:
            Free-form conversational response
        """
        from ..llm.manager import get_llm_manager

        messages = []

        # Include conversation history for multi-turn meta dialogue
        if conversation_history:
            for entry in conversation_history:
                role = entry.get("role", "user")
                content = entry.get("content", "")
                if role == "player":
                    messages.append({"role": "user", "content": content})
                elif role == "director":
                    messages.append({"role": "assistant", "content": content})
                # Skip KA entries — they appear separately

        # Current player message with context
        user_message = f"""## Current Game State
{game_context}

## Player's Message (Out-of-Character)
{feedback}"""

        messages.append({"role": "user", "content": user_message})

        try:
            manager = get_llm_manager()
            provider = manager.get_provider()
            model = manager.get_fast_model()  # Use fast model for meta dialogue

            response = await provider.complete(
                messages=messages,
                system=self.META_SYSTEM_PROMPT,
                model=model,
                max_tokens=1024,
                temperature=0.7,
            )

            return response.content.strip()

        except Exception as e:
            logger.error(f"[director] Meta conversation failed: {e}")
            return "I hear you — let me think about that. (The Director encountered an issue processing this meta-conversation.)"
