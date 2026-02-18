"""Main orchestrator for the AIDM v3 turn loop.

Composed from two domain-specific mixins:

    TurnPipelineMixin  – The main process_turn pipeline
    BackgroundMixin    – Post-narrative fire-and-forget processing

This file retains only initialization and lifecycle methods.
"""

import asyncio
import logging

from ..agents.combat import CombatAgent
from ..agents.context_selector import ContextSelector
from ..agents.director import DirectorAgent
from ..agents.intent_classifier import IntentClassifier
from ..agents.key_animator import KeyAnimator
from ..agents.outcome_judge import OutcomeJudge

# Override Handler (META/OVERRIDE commands)
from ..agents.override_handler import OverrideHandler

# Phase 2: Pre-turn Pacing (#1)
from ..agents.pacing_agent import PacingAgent
from ..agents.progression import ProgressionAgent

# Phase 3: Session recap (#18)
from ..agents.recap_agent import RecapAgent
from ..agents.relationship_analyzer import RelationshipAnalyzer
from ..agents.scale_selector import ScaleSelectorAgent
from ..agents.validator import ValidatorAgent
from ..context.memory import MemoryStore
from ..context.rule_library import RuleLibrary
from ..db.session import create_session
from ..db.state_manager import StateManager
from ..profiles.loader import NarrativeProfile, load_profile
from ._background import BackgroundMixin

# Domain-specific mixins
from ._turn_pipeline import TurnPipelineMixin

# Phase 4: Foreshadowing
from .foreshadowing import ForeshadowingLedger

logger = logging.getLogger(__name__)

class Orchestrator(TurnPipelineMixin, BackgroundMixin):
    """Main turn loop for AIDM v3.
    
    Coordinates:
    1. Intent classification (what does the player want?)
    2. Outcome judgment (should this succeed?)
    3. Narrative generation (tell the story)
    4. State updates (persist changes)
    """

    def __init__(self, profile_id: str, session_id: str = None):
        """Initialize the orchestrator.
        
        Args:
            profile_id: The narrative profile ID (e.g., "hunterxhunter", "demon_slayer")
            session_id: The unique session ID for memory isolation. If None, falls back to profile_id.
        """
        self.profile_id = profile_id
        self.session_id = session_id or profile_id  # Fallback for backward compatibility

        # Load profile first to get display name
        self.profile: NarrativeProfile = load_profile(profile_id)

        # Resolve profile_id to integer campaign_id
        self.campaign_id = StateManager.get_or_create_campaign_by_profile(
            profile_id=profile_id,
            profile_name=f"{self.profile.name} Campaign"
        )

        # Initialize state manager with resolved campaign_id
        self.state = StateManager(self.campaign_id)
        self.state.ensure_campaign_exists(
            name=f"{self.profile.name} Campaign",
            profile_id=profile_id
        )

        # Initialize Context Layer - use session_id for memory isolation
        self.memory = MemoryStore(self.session_id)
        self.rules = RuleLibrary()
        self.context_selector = ContextSelector(self.memory, self.rules)

        # Initialize agents
        self.intent_classifier = IntentClassifier()
        self.outcome_judge = OutcomeJudge()
        self.key_animator = KeyAnimator(self.profile)
        self.validator = ValidatorAgent()

        # Phase 4: Director
        self.director = DirectorAgent()

        # Phase 3: Combat & Progression
        self.combat = CombatAgent()
        self.progression = ProgressionAgent()

        # Phase 4: Foreshadowing (DB-backed, #10)
        self.foreshadowing = ForeshadowingLedger(self.campaign_id, state_manager=self.state)

        # Scale Selector (Module 12)
        self.scale_selector = ScaleSelectorAgent()

        # Pre-turn Pacing micro-check (#1)
        self.pacing_agent = PacingAgent()

        # Session recap (#18)
        self.recap_agent = RecapAgent()
        self._recap_generated = False  # True after first turn's recap

        # Relationship Analyzer (NPC Intelligence, fast model)
        self.relationship_analyzer = RelationshipAnalyzer()

        # Director hybrid trigger tracking
        self._accumulated_epicness = 0.0
        self._last_director_turn = 0
        self._arc_events_since_director = []  # Track arc-relevant events

        # Override Handler (META/OVERRIDE commands)
        db = create_session()
        self.override_handler = OverrideHandler(db=db, memory_store=self.memory)

        # Background processing lock — ensures previous turn's post-narrative
        # work completes before the next turn reads state
        self._bg_lock = asyncio.Lock()

    def close(self):
        """Release resources held by the orchestrator.

        Called by ``reset_orchestrator()`` and the application lifespan
        shutdown handler.  Closes the DB session opened in ``__init__``
        and logs the teardown.
        """
        try:
            if hasattr(self, 'override_handler') and hasattr(self.override_handler, 'db'):
                self.override_handler.db.close()
                logger.info("Orchestrator DB session closed")
        except Exception as e:
            logger.warning("Orchestrator close — DB session close failed: %s", e)
        try:
            self.state.close()
        except Exception as e:
            logger.warning("Orchestrator close — state close failed: %s", e)
        logger.info("Orchestrator for '%s' shut down", self.profile_id)

    async def run_director_startup(
        self,
        session_zero_summary: str,
        character_name: str = "Unknown",
        character_concept: str = "",
        starting_location: str = "Unknown",
        op_mode: bool = False,
        op_preset: str = None,
        op_tension_source: str = None,
        op_power_expression: str = None,
        op_narrative_focus: str = None,
    ):
        """
        Run the Director's startup briefing at gameplay handoff.
        
        Creates an initial storyboard (arc plan, foreshadowing, voice guidance)
        from Session Zero context + the narrative profile. Called once when
        Session Zero completes, before the first gameplay turn.
        """
        logger.info("Beginning pilot episode planning...")

        # Run the Director's startup briefing
        director_output = await self.director.run_startup_briefing(
            session_zero_summary=session_zero_summary,
            profile=self.profile,
            character_name=character_name,
            character_concept=character_concept,
            starting_location=starting_location,
            op_mode=op_mode,
            op_preset=op_preset,
            op_tension_source=op_tension_source,
            op_power_expression=op_power_expression,
            op_narrative_focus=op_narrative_focus,
        )

        # Persist to Campaign Bible
        planning_data = director_output.model_dump()
        self.state.update_campaign_bible(planning_data, turn_number=0)

        # Seed world state with Director's arc phase and tension
        self.state.update_world_state(
            arc_phase=director_output.arc_phase,
            tension_level=director_output.tension_level
        )

        # Mark Director as having run at turn 0
        self._last_director_turn = 0
        self._arc_events_since_director = []

        logger.info(f"[Director Startup] Opening arc: '{director_output.current_arc}' "
              f"(phase: {director_output.arc_phase}, tension: {director_output.tension_level:.1f})")
        logger.info(f"Director notes: {director_output.director_notes[:200]}...")
        if director_output.active_foreshadowing:
            logger.info(f"Foreshadowing seeds: {len(director_output.active_foreshadowing)}")

    def get_profile(self) -> NarrativeProfile:
        """Get the current narrative profile."""
        return self.profile

    def get_context_summary(self) -> str:
        """Get a summary of current game context."""
        context = self.state.get_context()
        return (
            f"Location: {context.location}\n"
            f"Situation: {context.situation}\n"
            f"Character: {context.character_name}\n"
            f"Arc Phase: {context.arc_phase}"
        )
