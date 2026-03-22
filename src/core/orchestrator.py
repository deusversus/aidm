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

        # Resolve to integer campaign_id — prefer session-based lookup to avoid splits
        _real_session_id = session_id if (session_id and session_id != profile_id) else None
        if _real_session_id:
            self.campaign_id = StateManager.get_or_create_campaign_by_session(
                session_id=_real_session_id,
                profile_id=profile_id,
                profile_name=f"{self.profile.name} Campaign"
            )
        else:
            # Legacy fallback: no real session UUID available
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
        self.state.set_profile_world_tier(self.profile.world_tier or "T8")

        # Cache the campaign's media UUID for frontend media polling
        from src.db.models import Campaign
        from src.db.session import create_session as create_db_session
        _db = create_db_session()
        try:
            _campaign = _db.query(Campaign).filter(Campaign.id == self.campaign_id).first()
            self.campaign_media_uuid = _campaign.media_uuid if _campaign else None
        finally:
            _db.close()

        # Initialize Context Layer - keyed by integer campaign_id
        self.memory = MemoryStore(self.campaign_id)
        self.rules = RuleLibrary()
        self.context_selector = ContextSelector(self.memory, self.rules)

        # Initialize agents
        self.intent_classifier = IntentClassifier()
        self.outcome_judge = OutcomeJudge()
        # Load voice journal from bible if available (step 13)
        _bible = self.state.get_campaign_bible()
        _voice_journal = (_bible.planning_data or {}).get("voice_journal") if _bible else None
        self.key_animator = KeyAnimator(self.profile, voice_journal=_voice_journal)
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

        # Meta conversation state (out-of-character dialogue with player)
        self._in_meta_conversation = False

        # Crash recovery check (Gap 9): detect incomplete prior turns
        self._check_incomplete_turns()

    def _check_incomplete_turns(self) -> None:
        """Check for turns where background processing didn't complete (crash recovery)."""
        try:
            from src.db.session import get_session
            from src.db.session_zero_artifacts import get_active_artifact

            with get_session() as db:
                checkpoint = get_active_artifact(
                    db, str(self.campaign_id), "gameplay_turn_checkpoint"
                )
                if checkpoint:
                    import json
                    data = json.loads(checkpoint.content) if isinstance(checkpoint.content, str) else checkpoint.content
                    if not data.get("background_completed", True):
                        logger.warning(
                            "CRASH RECOVERY: Turn %d background processing was incomplete. "
                            "Some bookkeeping (memory, progression, foreshadowing) may be missing.",
                            data.get("turn_number", "?"),
                        )
        except Exception:
            pass  # Non-fatal — don't block init

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

    async def async_close(self) -> None:
        """Async teardown: writes KA voice journal and Director session memo, then closes."""
        try:
            from ..context.session_memory_writer import SessionMemoryWriter
            writer = SessionMemoryWriter()
            db_context = self.state.get_context()
            bible = self.state.get_campaign_bible()
            planning = bible.planning_data or {} if bible else {}

            # Gather inputs
            recent_narrative = ""
            try:
                compaction = self.state.get_compaction_text() if hasattr(self.state, 'get_compaction_text') else ""
                recent_narrative = compaction or ""
            except Exception:
                pass
            meta_feedback = ""
            try:
                meta_history = self.state.get_meta_conversation_history()
                meta_feedback = " ".join(
                    m.get("content", "") for m in (meta_history or []) if m.get("role") == "user"
                )[-2000:]
            except Exception:
                pass

            active_seeds: list[dict] = []
            try:
                seeds = self.foreshadowing.get_active_seeds()
                active_seeds = [
                    {"description": s.description, "status": s.status.value} for s in seeds
                ]
            except Exception:
                pass

            npc_debt: list[dict] = []
            try:
                npcs = self.state.get_all_npcs()
                npc_debt = sorted(
                    [{"name": n.name, "scene_count": n.scene_count} for n in npcs if n.scene_count > 0],
                    key=lambda x: -x["scene_count"],
                )[:10]
            except Exception:
                pass

            # Flush NPC block updates for all NPCs that appeared this session.
            # Covers NPCs that gained scenes but didn't hit the periodic trigger thresholds.
            try:
                from ..context._block_triggers import create_or_update_npc_block
                from ..utils.tasks import safe_create_task
                session_npcs = list(self.state._session_npc_updates)
                if session_npcs:
                    logger.info("[async_close] Flushing NPC block updates for %d NPC(s)", len(session_npcs))
                    for npc_id in session_npcs:
                        safe_create_task(
                            create_or_update_npc_block(self.campaign_id, npc_id, db_context.turn_number),
                            name=f"npc_block_session_flush_{npc_id}",
                        )
            except Exception:
                logger.exception("[async_close] NPC block session flush failed (non-fatal)")

            voice_journal_task = asyncio.create_task(writer.write_voice_journal(
                campaign_id=self.campaign_id,
                recent_narrative=recent_narrative,
                meta_feedback=meta_feedback,
                profile_name=getattr(self.profile, 'name', self.profile_id),
                existing_journal=planning.get("voice_journal", ""),
            ))
            director_memo_task = asyncio.create_task(writer.write_director_memo(
                campaign_id=self.campaign_id,
                arc_phase=db_context.arc_phase or "",
                current_arc=planning.get("current_arc", ""),
                director_notes=db_context.director_notes or "",
                active_seeds=active_seeds,
                npc_spotlight_debt=npc_debt,
                planning_data=planning,
            ))

            voice_journal, director_memo = await asyncio.gather(
                voice_journal_task, director_memo_task, return_exceptions=True
            )

            updates: dict = {}
            if voice_journal and not isinstance(voice_journal, Exception):
                updates["voice_journal"] = voice_journal
            if director_memo and not isinstance(director_memo, Exception):
                updates["director_session_memo"] = director_memo
            if updates:
                self.state.update_campaign_bible(updates, db_context.turn_number)
                logger.info("[async_close] Saved voice_journal + director_session_memo to bible")
        except Exception:
            logger.exception("[async_close] Session memory write failed (non-fatal)")
        finally:
            self.close()

    async def run_director_startup(
        self,
        session_zero_summary: str,
        character_name: str = "Unknown",
        character_concept: str = "",
        starting_location: str = "Unknown",
        power_tier: str | None = None,
        tension_source: str | None = None,
        power_expression: str | None = None,
        narrative_focus: str | None = None,
        composition_name: str | None = None,
        timeline_mode: str | None = None,
        canon_cast_mode: str | None = None,
        event_fidelity: str | None = None,
        opening_state_package=None,
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
            power_tier=power_tier,
            tension_source=tension_source,
            power_expression=power_expression,
            narrative_focus=narrative_focus,
            composition_name=composition_name,
            timeline_mode=timeline_mode,
            canon_cast_mode=canon_cast_mode,
            event_fidelity=event_fidelity,
            opening_state_package=opening_state_package,
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

    async def generate_opening_scene(
        self,
        opening_state_package: "Any | None" = None,
        recent_messages: list | None = None,
    ) -> tuple[str, dict[str, str]]:
        """Generate the pilot episode opening scene via dedicated KA pathway.

        Uses the compiled OpeningStatePackage and the Director's stored output from
        the campaign bible to produce a targeted cinematic first scene without routing
        through the full gameplay turn pipeline.

        Falls back to an empty result if the package is None (caller should use
        process_turn() fallback instead).

        Returns:
            (narrative, portrait_map)
        """
        if opening_state_package is None:
            raise ValueError("generate_opening_scene requires a non-None opening_state_package")

        # Retrieve Director output from campaign bible
        director_output = None
        try:
            bible = self.state.get_campaign_bible()
            if bible and bible.planning_data:
                from ..agents.director import DirectorOutput
                director_output = DirectorOutput.model_validate(bible.planning_data)
        except Exception:
            pass  # director_output stays None; KA will work without it

        narrative, portrait_map = await self.key_animator.generate_opening_scene(
            opening_state_package=opening_state_package,
            director_output=director_output,
            profile=self.profile,
            campaign_id=self.campaign_id,
            recent_messages=recent_messages,
        )
        return narrative, portrait_map



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
