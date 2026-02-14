"""Main orchestrator for the AIDM v3 turn loop."""

import asyncio
import time
from typing import Optional

from ..agents.intent_classifier import IntentClassifier
from ..agents.outcome_judge import OutcomeJudge
from ..agents.key_animator import KeyAnimator
from ..db.state_manager import StateManager
from ..profiles.loader import load_profile, NarrativeProfile
from ..agents.director import DirectorAgent
from .turn import TurnResult

from ..context.memory import MemoryStore
from ..context.rule_library import RuleLibrary
from ..agents.validator import ValidatorAgent
from ..agents.context_selector import ContextSelector
from ..agents.combat import CombatAgent
from ..agents.progression import ProgressionAgent
from ..agents.scale_selector import ScaleSelectorAgent
from ..agents.relationship_analyzer import RelationshipAnalyzer

# Phase 4: Foreshadowing
from .foreshadowing import ForeshadowingLedger

# Phase 2: Pre-turn Pacing (#1)
from ..agents.pacing_agent import PacingAgent, PacingDirective

# Phase 3: Session recap (#18)
from ..agents.recap_agent import RecapAgent

# Override Handler (META/OVERRIDE commands)
from ..agents.override_handler import OverrideHandler
from ..db.session import create_session


class Orchestrator:
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
        print(f"[Director Startup] Beginning pilot episode planning...")
        
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
        
        print(f"[Director Startup] Opening arc: '{director_output.current_arc}' "
              f"(phase: {director_output.arc_phase}, tension: {director_output.tension_level:.1f})")
        print(f"[Director Startup] Director notes: {director_output.director_notes[:200]}...")
        if director_output.active_foreshadowing:
            print(f"[Director Startup] Foreshadowing seeds: {len(director_output.active_foreshadowing)}")

    async def process_turn(self, player_input: str, recent_messages: list = None, compaction_text: str = "") -> TurnResult:
        """Process a single turn.
        
        Args:
            player_input: The player's action/input
            recent_messages: Last N messages from session for working memory (every turn)
            compaction_text: Flattened compaction buffer (narrative beats from messages
                that fell off the sliding window). Always present, cached.
            
        Returns:
            TurnResult with narrative and agent decisions
        """
        start = time.time()
        
        # Wait for previous turn's background processing to finish
        # (almost never blocks — users take ~5-10s between turns)
        if self._bg_lock.locked():
            print(f"[Orchestrator] Waiting for previous turn's background processing...")
            async with self._bg_lock:
                pass  # Just wait for release
        
        # 1. Get current DB context (fast, sync)
        db_context = self.state.get_context()
        
        # #17: Expire old consequences at turn start
        self.state.expire_consequences(db_context.turn_number)
        
        # =====================================================================
        # PHASE 1a: Intent Classification (fast, ~1s)
        # Run first to determine memory tier for RAG
        # =====================================================================
        intent = await self.intent_classifier.call(
            player_input,
            current_situation=db_context.situation,
            character_state=db_context.character_summary,
            location=db_context.location
        )
        
        # =====================================================================
        # HANDLE META/OVERRIDE COMMANDS (early exit - skip normal turn flow)
        # =====================================================================
        if intent.intent == "META_FEEDBACK":
            result = self.override_handler.process_meta(
                content=intent.action,
                campaign_id=self.campaign_id,
                session_number=db_context.session_id  # GameContext has session_id, not session_number
            )
            return TurnResult(
                narrative=result["message"],
                intent=intent,
                outcome=None,
                state_changes={},
                latency_ms=int((time.time() - start) * 1000),
                cost_usd=0.0
            )
        
        if intent.intent == "OVERRIDE_COMMAND":
            # Handle special override subcommands
            action_lower = intent.action.lower()
            if action_lower == "list":
                overrides = self.override_handler.list_overrides(self.campaign_id)
                if overrides:
                    lines = ["**Active Overrides:**"]
                    for o in overrides:
                        status = "✓" if o["active"] else "✗"
                        lines.append(f"  {status} [{o['id']}] {o['category']}: {o['description']}")
                    message = "\n".join(lines)
                else:
                    message = "No overrides active."
            elif action_lower.startswith("remove "):
                override_id = action_lower.replace("remove ", "").strip()
                try:
                    if self.override_handler.remove_override(int(override_id), self.campaign_id):
                        message = f"✓ Override {override_id} removed."
                    else:
                        message = f"⚠️ Override {override_id} not found."
                except ValueError:
                    message = f"⚠️ Invalid override ID: {override_id}"
            else:
                result = self.override_handler.process_override(
                    content=intent.action,
                    campaign_id=self.campaign_id,
                    target=intent.target
                )
                message = result["message"]
            
            return TurnResult(
                narrative=message,
                intent=intent,
                outcome=None,
                state_changes={},
                latency_ms=int((time.time() - start) * 1000),
                cost_usd=0.0
            )
        
        if intent.intent == "OP_COMMAND":
            action_lower = intent.action.lower()
            if action_lower.startswith("accept"):
                # Extract preset from action or target
                preset = intent.target or action_lower.replace("accept", "").strip()
                
                # Preset mapping to 3-axis system
                preset_mapping = {
                    "bored_god": ("existential", "instantaneous", "internal"),
                    "restrainer": ("control", "sealed", "ensemble"),
                    "hidden_ruler": ("consequence", "derivative", "faction"),
                    "burden_bearer": ("burden", "hidden", "mundane"),
                    "muscle_wizard": ("moral", "instantaneous", "competition"),
                    "sealed_apocalypse": ("control", "sealed", "mundane"),
                    "wandering_legend": ("relational", "passive", "episodic"),
                    "nation_builder": ("consequence", "derivative", "faction"),
                    "disguised_god": ("relational", "hidden", "mundane"),
                    "time_looper": ("information", "conditional", "internal"),
                    "immortal": ("burden", "passive", "internal"),
                    # Legacy aliases for migration
                    "saitama": ("existential", "instantaneous", "internal"),
                    "mob": ("control", "sealed", "ensemble"),
                    "overlord": ("consequence", "derivative", "faction"),
                    "saiki": ("burden", "hidden", "mundane"),
                    "mashle": ("moral", "instantaneous", "competition"),
                    "wang_ling": ("control", "sealed", "mundane"),
                    "vampire_d": ("relational", "passive", "episodic"),
                    "rimuru": ("consequence", "derivative", "faction"),
                    "disguised_god": ("relational", "hidden", "mundane"),
                }
                
                if preset and preset.lower() in preset_mapping:
                    tension, expression, focus = preset_mapping[preset.lower()]
                    # Enable OP mode with this preset
                    db_context.op_protagonist_enabled = True
                    db_context.op_tension_source = tension
                    db_context.op_power_expression = expression
                    db_context.op_narrative_focus = focus
                    db_context.op_preset = preset.lower()
                    db_context.pending_op_suggestion = None
                    self.state.update_op_mode(
                        enabled=True, 
                        tension_source=tension,
                        power_expression=expression,
                        narrative_focus=focus,
                        preset=preset.lower()
                    )
                    message = f"✨ **OP Protagonist Mode Activated!**\n\n**Preset**: {preset.replace('_', ' ').title()}\n- Tension: {tension}\n- Expression: {expression}\n- Focus: {focus}\n\nYour adventure style will now be tuned for overwhelming power done right."
                else:
                    valid_presets = "bored_god, restrainer, hidden_ruler, burden_bearer, muscle_wizard, sealed_apocalypse, wandering_legend, nation_builder, disguised_god, time_looper, immortal"
                    message = f"⚠️ Unknown preset: {preset or 'none specified'}\n\nValid presets: {valid_presets}"
                    
            elif action_lower == "dismiss":
                db_context.op_suggestion_dismissed = True
                db_context.pending_op_suggestion = None
                self.state.update_op_suggestion_dismissed(True)
                message = "👋 OP mode suggestion dismissed. We won't ask again (unless you reset)."
            else:
                message = f"⚠️ Unknown /op command: {intent.action}\n\nUsage:\n  `/op accept [preset]` - Enable OP mode\n  `/op dismiss` - Dismiss suggestion"
            
            return TurnResult(
                narrative=message,
                intent=intent,
                outcome=None,
                state_changes={},
                latency_ms=int((time.time() - start) * 1000),
                cost_usd=0.0
            )
        
        # =====================================================================
        # PHASE 1a.5: WORLD_BUILDING Detection and Validation
        # When players assert facts about NPCs, items, locations, etc.
        # =====================================================================
        world_building_context = ""
        if intent.intent == "WORLD_BUILDING":
            from ..agents.world_builder import WorldBuilderAgent
            world_builder = WorldBuilderAgent()
            
            # Get established facts from memory for consistency checking
            established_facts = ""
            try:
                fact_memories = self.memory.query(
                    "established world facts npcs items locations",
                    memory_types=["fact"],
                    limit=5
                )
                if fact_memories:
                    established_facts = "\n".join([m["content"] for m in fact_memories])
            except Exception:
                pass
            
            wb_result = await world_builder.call(
                player_input=player_input,
                character_context=db_context.character_summary,
                canonicality={
                    "timeline_mode": db_context.timeline_mode,
                    "canon_cast_mode": db_context.canon_cast_mode,
                    "event_fidelity": db_context.event_fidelity,
                },
                power_tier=db_context.character_summary.split(",")[1].strip() if "," in (db_context.character_summary or "") else "T10",
                established_facts=established_facts,
                profile_id=self.profile_id
            )
            
            print(f"[Orchestrator] WORLD_BUILDING: {len(wb_result.entities)} entities, status={wb_result.validation_status}")
            
            if wb_result.validation_status == "rejected":
                # Return a natural rejection narrative
                return TurnResult(
                    narrative=wb_result.rejection_reason or "That doesn't quite fit the story as established...",
                    intent=intent,
                    outcome=None,
                    state_changes={"world_building": "rejected"},
                    latency_ms=int((time.time() - start) * 1000),
                    cost_usd=0.0
                )
            
            if wb_result.validation_status == "needs_clarification":
                # Ask the player to clarify
                return TurnResult(
                    narrative=wb_result.clarification_question or "Tell me more about that...",
                    intent=intent,
                    outcome=None,
                    state_changes={"world_building": "clarification_needed"},
                    latency_ms=int((time.time() - start) * 1000),
                    cost_usd=0.0
                )
            
            # Apply accepted entities
            for entity in wb_result.entities:
                if entity.is_new:
                    await self._apply_world_building_entity(entity, db_context.turn_number)
            
            # Build context for KeyAnimator
            if wb_result.entities:
                entity_descs = []
                for e in wb_result.entities:
                    entity_descs.append(f"- {e.entity_type.upper()}: {e.name}")
                world_building_context = f"[World Building] Player established:\n" + "\n".join(entity_descs)
                if wb_result.narrative_integration:
                    world_building_context += f"\nIntegration note: {wb_result.narrative_integration}"
        
        # =====================================================================
        # PHASE 1b: RAG Base Retrieval (uses intent for dynamic memory tiering)
        # Tier 1 (mundane): 3 candidates, Tier 2 (normal): 6, Tier 3 (epic): 9
        # =====================================================================
        rag_base = await self.context_selector.get_base_context(
            game_id=str(self.campaign_id),
            player_input=player_input,
            state_context=db_context,
            profile_id=self.profile_id,
            intent=intent  # Pass intent for tiered memory retrieval
        )
        
        # Initialize Turn object
        from .turn import Turn
        current_turn = Turn(input_text=player_input, intent=intent)
        
        # =====================================================================
        # PHASE 2: Run Outcome Judgment and Memory Ranking in PARALLEL
        # - Outcome needs Intent (available from Phase 1)
        # - Memory Ranking needs RAG Base (available from Phase 1)
        # - TIER 0 FAST-PATH: Skip for trivial actions
        # =====================================================================
        
        # Check for Tier 0 (trivial action) fast-path
        is_trivial = self.context_selector.is_trivial_action(intent)
        
        if is_trivial:
            # TIER 0 FAST-PATH: Skip OutcomeJudge, memory ranking, and pacing
            print(f"[Orchestrator] TIER 0 fast-path: trivial action, skipping Outcome/Memory/Pacing")
            
            # Synthetic auto-success outcome for trivial actions
            from ..agents.outcome_judge import OutcomeOutput
            outcome = OutcomeOutput(
                should_succeed=True,
                difficulty_class=5,
                modifiers={},
                calculated_roll=15,
                success_level="success",
                narrative_weight="minor",
                cost=None,
                consequence=None,
                reasoning="Trivial action auto-success"
            )
            ranked_memories = "No relevant past memories found."
            pacing_directive = None  # Skip pacing for trivial actions
            recap_result = None  # #18: No recap on trivial actions
        else:
            # Normal path: parallel OutcomeJudge and MemoryRanker
            # Build power context for the Outcome Judge
            power_context = f"Character Power Tier: {db_context.power_tier or 'T10'}. "
            if db_context.op_protagonist_enabled:
                power_context += "OP MODE IS ACTIVE — this character is intentionally overpowered. Routine power use should be trivial (DC 5, no cost, no consequence). "
            power_context += f"World Tier: {self.profile.world_tier or 'T8'}."
            
            outcome_task = asyncio.create_task(
                self.outcome_judge.call(
                    f"Action: {intent.action}\nTarget: {intent.target or 'N/A'}",
                    intent=intent.model_dump_json(),
                    profile_tropes=str(self.profile.tropes),
                    arc_phase=db_context.arc_phase,
                    recent_events=db_context.recent_summary,
                    difficulty_context=f"Situation: {db_context.situation}. Location: {db_context.location}",
                    power_context=power_context
                )
            )
            
            memory_rank_task = asyncio.create_task(
                self.context_selector.rank_memories(
                    rag_base["raw_memories"],
                    db_context.situation,
                    intent=intent  # Pass intent for conditional skip
                )
            )
            
            # Pre-turn pacing micro-check (#1) — runs in parallel
            pacing_task = asyncio.create_task(
                self.pacing_agent.check(
                    player_input=player_input,
                    intent_summary=f"{intent.intent}: {intent.action}",
                    bible_notes=db_context.director_notes,
                    arc_phase=db_context.arc_phase,
                    tension_level=db_context.tension_level,
                    situation=db_context.situation,
                    recent_summary=db_context.recent_summary,
                    turns_in_phase=db_context.turns_in_phase,  # #3: pacing gates
                )
            )
            
            # Wait for all three to complete (parallel execution)
            recap_task = None
            
            # #18: Session recap on first gameplay turn (non-blocking)
            if not self._recap_generated and db_context.turn_number <= 2:
                bible = self.state.get_campaign_bible()
                arc_history = []
                if bible and bible.planning_data:
                    arc_history = bible.planning_data.get('arc_history', [])
                
                # Only generate recap if we have story to recap
                if arc_history or db_context.director_notes:
                    # Get top narrative_beat memories
                    beat_mems = []
                    try:
                        beat_results = self.memory.search(
                            "important emotional narrative moment",
                            limit=5, min_heat=20.0,
                            memory_type="narrative_beat",
                            boost_on_access=False
                        )
                        beat_mems = [m['content'] for m in beat_results] if beat_results else []
                    except Exception:
                        pass
                    
                    recap_task = asyncio.create_task(
                        self.recap_agent.generate_recap(
                            arc_history=arc_history,
                            narrative_beats=beat_mems,
                            director_notes=db_context.director_notes,
                            current_situation=db_context.situation,
                            character_name=db_context.character_name,
                            arc_phase=db_context.arc_phase,
                        )
                    )
            
            tasks_to_gather = [outcome_task, memory_rank_task, pacing_task]
            if recap_task:
                tasks_to_gather.append(recap_task)
            
            phase2_results = await asyncio.gather(
                *tasks_to_gather,
                return_exceptions=True
            )
            
            # Handle potential exceptions
            outcome = phase2_results[0]
            ranked_memories = phase2_results[1]
            pacing_directive = phase2_results[2]
            
            if isinstance(outcome, Exception):
                raise RuntimeError(f"Outcome judgment failed: {outcome}")
            if isinstance(ranked_memories, Exception):
                print(f"[Orchestrator] Memory ranking failed: {ranked_memories}, using unranked")
                ranked_memories = "No relevant past memories found."
            if isinstance(pacing_directive, Exception):
                print(f"[Orchestrator] Pacing micro-check failed (non-fatal): {pacing_directive}")
                pacing_directive = None
            elif pacing_directive:
                print(f"[PacingAgent] Beat: {pacing_directive.arc_beat}, Tone: {pacing_directive.tone}, Escalation: {pacing_directive.escalation_target:.0%}")
            
            # #18: Extract recap result (index 3, if present)
            recap_result = None
            if recap_task and len(phase2_results) > 3:
                recap_result = phase2_results[3]
                if isinstance(recap_result, Exception):
                    print(f"[Orchestrator] Recap generation failed (non-fatal): {recap_result}")
                    recap_result = None
                elif recap_result:
                    print(f"[RecapAgent] Recap generated: {len(recap_result.recap_text)} chars")
        
        current_turn.outcome = outcome
        
        # =====================================================================
        # #23: PRE-NARRATIVE COMBAT RESOLUTION
        # Combat MUST resolve before KeyAnimator so narrative reflects actual
        # mechanical outcomes (hit/miss/damage). HP/state changes are applied
        # in _post_narrative_processing to keep critical path fast.
        # =====================================================================
        combat_occurred = False
        combat_result = None
        if intent.intent == "COMBAT" or "attack" in intent.action.lower():
            combat_occurred = True
            combat_action = self.combat.parse_combat_action(intent, player_input)
            character = self.state.get_character()
            target = self.state.get_target(combat_action.target)
            
            if character and target:
                # Pre-validate resource costs via StateTransaction
                if combat_action.action_type in ("spell", "skill"):
                    resource_path = "resources.mp.current" if combat_action.action_type == "spell" else "resources.sp.current"
                    resource_cost = 20 if combat_action.action_type == "spell" else 15
                    
                    with self.state.begin_transaction(f"{combat_action.action_type.title()} resource cost") as txn:
                        txn.subtract(resource_path, resource_cost, reason=f"{combat_action.action_type.title()} cost")
                        validation = txn.validate()
                        if not validation.is_valid:
                            combat_occurred = False
                            for err in validation.errors:
                                print(f"[Transaction] Pre-validation failed: {err.message}")
                            txn.rollback()
                        # If valid, txn auto-commits on exit
                
                if combat_occurred:
                    combat_result = await self.combat.resolve_action(
                        action=combat_action,
                        attacker=character,
                        target_entity=target,
                        context=db_context,
                        profile=self.profile
                    )
                    print(f"[Combat] Pre-narrative resolution: {combat_result.damage_dealt} damage, hit={combat_result.hit}")
        
        # Store for _post_narrative_processing bookkeeping
        self._last_combat_occurred = combat_occurred
        self._last_combat_result = combat_result
        
        # Assemble final RAG context
        rag_context = {
            "memories": ranked_memories,
            "rules": rag_base["rules"],
            "short_term": rag_base["short_term"]
        }
        
        # Inject pacing directive if available (#1)
        if pacing_directive and isinstance(pacing_directive, PacingDirective):
            rag_context["pacing_directive"] = pacing_directive
        
        # Calculate power imbalance with context modifiers (Module 12)
        target_tier = getattr(outcome, 'target_tier', None)
        if intent.intent == "COMBAT" and target_tier:
            character = self.state.get_character()
            player_tier = character.power_tier if character else "T10"
            
            power_result = await self.scale_selector.calculate_power_imbalance(
                player_tier=player_tier,
                threat_tier=target_tier,
                situation=db_context.situation,
                op_preset=db_context.op_preset,
                op_tension_source=db_context.op_tension_source,
                location=db_context.location,
                has_allies=len(db_context.present_npcs) > 0
            )
            
            # Update context with calculated imbalance
            db_context.power_imbalance = power_result.effective_imbalance
            
            # Log modifiers
            if power_result.context_modifiers:
                print(f"[Module 12] Power imbalance: {power_result.raw_imbalance:.1f} → {power_result.effective_imbalance:.1f}")
                print(f"[Module 12] Context modifiers: {', '.join(power_result.context_modifiers)}")
            
            # =====================================================================
            # PROGRESSIVE OP MODE: Track high-imbalance encounters
            # If player consistently dominates (imbalance > 10), suggest OP Mode
            # =====================================================================
            if power_result.effective_imbalance > 10 and not db_context.op_protagonist_enabled:
                # Increment counter
                count = self.state.increment_high_imbalance_count()
                print(f"[Progressive OP] High-imbalance encounter #{count}")
                
                # Check for suggestion trigger
                if (count >= 3 
                    and not db_context.op_suggestion_dismissed 
                    and not db_context.pending_op_suggestion):
                    
                    # Get recent actions for behavior analysis
                    recent_memories = self.memory.search("player action", limit=20, min_heat=0)
                    behavior_history = [m["content"] for m in recent_memories]
                    
                    # Call preset suggestion LLM
                    suggestion = await self.scale_selector.suggest_op_preset(
                        behavior_history=behavior_history,
                        character_tier=player_tier,
                        high_imbalance_count=count
                    )
                    
                    if suggestion and suggestion.get("should_prompt"):
                        db_context.pending_op_suggestion = suggestion
                        print(f"[Progressive OP] Suggesting preset: {suggestion.get('preset', 'unknown')} (confidence: {suggestion.get('confidence', 0):.0%})")
            
            # Add to RAG context for Key Animator
            if power_result.triggers_tension_shift:
                rag_context["power_analysis"] = (
                    f"Power Imbalance: {power_result.threshold.upper()} ({power_result.effective_imbalance:.1f})\n"
                    f"Modifiers: {', '.join(power_result.context_modifiers) or 'None'}\n"
                    f"Recommendation: {power_result.recommended_scale_shift or 'Continue current scale'}"
                )
        
        # Inject OP Mode guidance if enabled (uses 3-axis system)
        # #28 Cache Economics: OP axis guidance is session-stable → Block 1 via set_static_rule_guidance()
        if db_context.op_protagonist_enabled and db_context.op_tension_source:
            if not self.key_animator._static_rule_guidance:
                # First turn: compute once, store on KeyAnimator for Block 1 injection
                tension_guidance = self.rules.get_op_axis_guidance("tension", db_context.op_tension_source)
                expression_guidance = self.rules.get_op_axis_guidance("expression", db_context.op_power_expression)
                focus_guidance = self.rules.get_op_axis_guidance("focus", db_context.op_narrative_focus)

                static_parts = []
                if tension_guidance:
                    static_parts.append(f"## Tension Source: {db_context.op_tension_source.upper()}\n{tension_guidance}")
                if expression_guidance:
                    static_parts.append(f"## Power Expression: {db_context.op_power_expression.upper()}\n{expression_guidance}")
                if focus_guidance:
                    static_parts.append(f"## Narrative Focus: {db_context.op_narrative_focus.upper()}\n{focus_guidance}")

                if static_parts:
                    self.key_animator.set_static_rule_guidance("\n\n".join(static_parts))
                    print(f"[OP Mode] Set static 3-axis guidance in Block 1 (cache-stable): "
                          f"{db_context.op_tension_source}/{db_context.op_power_expression}/{db_context.op_narrative_focus}")
        
        # =====================================================================
        # OP MODE COMPOSITION REQUIREMENT: Auto-suggest if missing axes
        # OP Mode should never be on without composition selected
        # =====================================================================
        elif db_context.op_protagonist_enabled and not db_context.op_tension_source:
            # Need to suggest an OP composition based on character concept
            if not db_context.pending_op_suggestion:
                character = self.state.get_character()
                character_concept = character.backstory if character else ""
                
                # Use LLM to suggest preset based on character
                suggestion = await self.scale_selector.suggest_op_preset(
                    behavior_history=[f"Character concept: {character_concept}", 
                                     f"Character name: {db_context.character_name}"],
                    character_tier="T7",  # Assume mid-tier for OP
                    high_imbalance_count=3  # Force suggestion threshold
                )
                
                if suggestion:
                    db_context.pending_op_suggestion = suggestion
                    print(f"[OP Mode] Missing composition! Suggesting: {suggestion.get('preset', 'unknown')}")
            
            # Inject tension guidance for high power imbalance
            power_imbalance = db_context.power_imbalance
            if power_imbalance > 3:
                tension_guidance = self.rules.get_op_axis_guidance("tension", db_context.op_tension_source or "existential")
                if tension_guidance:
                    rag_context["tension_guidance"] = tension_guidance
                    print(f"[OP Mode] Injected tension guidance (imbalance: {power_imbalance:.1f})")
        
        # Inject NPC behavior context for present NPCs
        if db_context.present_npcs:
            npc_contexts = []
            for npc_name in db_context.present_npcs:
                npc = self.state.get_npc_by_name(npc_name)
                if npc:
                    npc_context = self.state.get_npc_behavior_context(
                        npc.id, 
                        db_context.situation,
                        db_context.narrative_scale
                    )
                    if npc_context:
                        npc_contexts.append(npc_context)
            
            if npc_contexts:
                rag_context["npc_guidance"] = "\n\n---\n\n".join(npc_contexts)
        
        # Inject player overrides (hard constraints)
        override_context = self.override_handler.format_overrides_for_context(self.campaign_id)
        if override_context:
            rag_context["player_overrides"] = override_context
            print(f"[Overrides] Injected {len(self.override_handler.get_active_overrides(self.campaign_id))} active overrides")
        
        # Inject faction context for faction-focused OP modes
        if db_context.op_narrative_focus == "faction":
            faction_context = self.state.get_faction_context_for_op_mode(
                db_context.op_narrative_focus, 
                db_context.op_preset
            )
            if faction_context:
                rag_context["faction_guidance"] = faction_context
        
        # =====================================================================
        # #13: RULE LIBRARY WIRING — Structural guidance from dead methods
        # =====================================================================
        
        # 1. DNA Narration Guidance + 2. Genre Guidance
        # #28 Cache Economics: profile-derived guidance is session-stable → Block 1
        # Compute once on first turn, append to KeyAnimator's static rule guidance.
        if not self.key_animator._static_rule_guidance:
            static_rule_parts = []

            # DNA Narration Guidance: extreme DNA scales (≤3 or ≥7)
            if self.profile.dna:
                dna_parts = []
                extreme_scales = sorted(
                    self.profile.dna.items(),
                    key=lambda x: abs(x[1] - 5),
                    reverse=True
                )[:3]
                for scale_name, value in extreme_scales:
                    if value <= 3 or value >= 7:
                        guidance = self.rules.get_dna_guidance(scale_name, value)
                        if guidance:
                            level = "HIGH" if value >= 7 else "LOW"
                            dna_parts.append(f"**{scale_name.title()} ({level}, {value}/10):** {guidance}")
                if dna_parts:
                    static_rule_parts.append(
                        "## 🧬 DNA Narration Style\n"
                        "Adapt your writing to match these narrative DNA settings:\n\n"
                        + "\n\n".join(dna_parts)
                    )
                    print(f"[RuleLibrary] DNA guidance for {len(dna_parts)} extreme scales → Block 1 (cache-stable)")

            # Genre Guidance: structural storytelling guidance for detected genres
            if self.profile.detected_genres:
                genre_parts = []
                for genre in self.profile.detected_genres[:2]:
                    guidance = self.rules.get_genre_guidance(genre)
                    if guidance:
                        genre_parts.append(f"**{genre.title()}:** {guidance}")
                if genre_parts:
                    static_rule_parts.append(
                        "## 📚 Genre Framework\n"
                        "Structure scenes according to these genre conventions:\n\n"
                        + "\n\n".join(genre_parts)
                    )
                    print(f"[RuleLibrary] Genre guidance → Block 1 (cache-stable): {', '.join(g for g in self.profile.detected_genres[:2])}")

            if static_rule_parts:
                # Merge with any existing static guidance (e.g. OP axis set earlier)
                existing = self.key_animator._static_rule_guidance or ""
                combined = existing + ("\n\n" if existing else "") + "\n\n".join(static_rule_parts)
                self.key_animator.set_static_rule_guidance(combined)
        
        # 3. Scale Guidance: narrative scale for current story scope
        if db_context.narrative_scale:
            scale_guidance = self.rules.get_scale_guidance(db_context.narrative_scale)
            if scale_guidance:
                rag_context["scale_guidance"] = (
                    f"## 🌍 Narrative Scale: {db_context.narrative_scale.upper()}\n"
                    f"{scale_guidance}"
                )
                print(f"[RuleLibrary] Injected scale guidance: {db_context.narrative_scale}")
        
        # 4. Compatibility Guidance: tier×scale combo guidance for Director-aware narration
        power_tier_str = db_context.power_tier or self.profile.world_tier or "T8"
        try:
            tier_num = int(power_tier_str.replace("T", "").replace("t", ""))
        except (ValueError, AttributeError):
            tier_num = 8
        if db_context.narrative_scale:
            compat_guidance = self.rules.get_compatibility_guidance(tier_num, db_context.narrative_scale)
            if compat_guidance:
                rag_context["compatibility_guidance"] = (
                    f"## ⚖️ Power×Scale: T{tier_num} at {db_context.narrative_scale}\n"
                    f"{compat_guidance}"
                )
                print(f"[RuleLibrary] Injected compatibility guidance: T{tier_num} × {db_context.narrative_scale}")
        
        # #17: Inject active consequences for narrative awareness
        active_consequences = self.state.get_active_consequences(limit=8)
        if active_consequences:
            consequence_lines = []
            for c in active_consequences:
                severity_icon = {"minor": "•", "moderate": "▸", "major": "★", "catastrophic": "⚠"}.get(c["severity"], "•")
                consequence_lines.append(
                    f"{severity_icon} [{c['category'].title()}] {c['description']} *(turn {c['turn']})*"
                )
            rag_context["active_consequences"] = (
                "## 📋 Active World Consequences\n"
                "These are narrative consequences still in effect. Reference them for continuity:\n\n"
                + "\n".join(consequence_lines)
            )
            print(f"[Consequence] Injected {len(active_consequences)} active consequences into context")
        
        # #23: Inject pre-resolved combat result for KeyAnimator
        if combat_result:
            combat_text = (
                f"## ⚔️ Combat Resolution (pre-computed)\n"
                f"**Hit:** {'Yes' if combat_result.hit else 'Miss'}\n"
                f"**Damage Dealt:** {combat_result.damage_dealt}\n"
            )
            if hasattr(combat_result, 'damage_type') and combat_result.damage_type:
                combat_text += f"**Damage Type:** {combat_result.damage_type}\n"
            if hasattr(combat_result, 'critical') and combat_result.critical:
                combat_text += f"**CRITICAL HIT!**\n"
            if hasattr(combat_result, 'description') and combat_result.description:
                combat_text += f"**Mechanical Detail:** {combat_result.description}\n"
            combat_text += "\n*Narrate the above mechanical result. Do NOT contradict these numbers.*"
            rag_context["combat_result"] = combat_text
            print(f"[Combat] Injected combat result into KeyAnimator context")
        
        # 3b. Validation Loop
        # Check if the outcome makes sense. If not, retry outcome generation with feedback.
        # Limit retries to avoid infinite loops.
        max_retries = 1
        for _ in range(max_retries):
            validation = await self.validator.validate(
                 turn=current_turn,
                 context={
                     "rules_summary": self.rules.get_relevant_rules(
                         f"{intent.action} {db_context.situation}", limit=2
                     ) or "Standard Physics + Anime Logic",
                     "character_state": db_context.character_summary
                 }
            )
            
            if validation.is_valid:
                break
                
            # If invalid, regenerate outcome with correction
            print(f"Validation failed: {validation.correction}. Retrying...")
            outcome = await self.outcome_judge.call(
                f"Action: {intent.action} (RETRY)",
                intent=intent.model_dump_json(),
                profile_tropes=str(self.profile.tropes),
                arc_phase=db_context.arc_phase,
                recent_events=db_context.recent_summary,
                correction_feedback=validation.correction,
                power_context=power_context
            )
            current_turn.outcome = outcome

        # 4. Generate narrative (KeyAnimator with optional Sakuga Mode)
        # Determine if this is a sakuga moment (climactic, high intensity)
        use_sakuga = False
        if outcome.narrative_weight == "climactic":
            use_sakuga = True
        elif intent.intent == "COMBAT" or outcome.calculated_roll >= 20: # Natural 20 or high
            use_sakuga = True
        # Special conditions auto-trigger sakuga
        elif any(cond in intent.special_conditions for cond in ("named_attack", "first_time_power")):
            use_sakuga = True
            print(f"[Orchestrator] Auto-sakuga triggered by special condition: {intent.special_conditions}")
        
        # Single narrative path - KeyAnimator handles both normal and sakuga modes
        
        # === UNIFIED POWER DIFFERENTIAL: Calculate effective composition ===
        # Blends profile composition with character OP settings based on power tier gap
        # #15: Per-scene recalculation — pass current threat tier when available
        from ..profiles.loader import get_effective_composition
        current_threat = getattr(outcome, 'target_tier', None)
        prev_mode = (self.profile.composition or {}).get('mode', 'standard')
        effective_comp = get_effective_composition(
            profile_composition=self.profile.composition or {},
            world_tier=self.profile.world_tier or "T8",
            character_tier=db_context.power_tier or "T10",
            character_op_enabled=db_context.op_protagonist_enabled,
            character_op_tension=db_context.op_tension_source,
            character_op_expression=db_context.op_power_expression,
            character_op_focus=db_context.op_narrative_focus,
            current_threat_tier=current_threat  # #15: encounter-responsive composition
        )
        # Inject effective composition into profile for KeyAnimator
        self.profile.composition = effective_comp
        new_mode = effective_comp.get('mode', 'standard')
        # #15: Log mode transitions (per-scene awareness for Director)
        if prev_mode != new_mode:
            print(f"[Composition] Mode transition: {prev_mode} → {new_mode} (threat: {current_threat or 'world baseline'})")
        print(f"[Orchestrator] Power Differential: {effective_comp.get('differential', 0)} tiers, mode={new_mode}")
        
        # === NPC CONTEXT CARDS (Module 04) ===
        # Build structured NPC relationship data for disposition-aware narration
        npc_context = ""
        pre_narr_npcs = self.state.detect_npcs_in_text(
            player_input + " " + (db_context.situation or "")
        )
        if pre_narr_npcs:
            npc_context = self.state.get_present_npc_cards(pre_narr_npcs)
            # Add spotlight debt hints for narrative balancing
            spotlight = self.state.compute_spotlight_debt()
            if spotlight:
                underserved = [f"{name} (+{debt})" for name, debt in spotlight.items() if debt > 0]
                if underserved:
                    npc_context += f"\n\n[Spotlight Hint] These NPCs need more screen time: {', '.join(underserved)}"
            print(f"[Orchestrator] NPC context: {len(pre_narr_npcs)} NPCs present")
        
        # === FORESHADOWING CALLBACKS (#9) ===
        # Surface seeds that are ready for payoff to the KeyAnimator
        callback_seeds = self.foreshadowing.get_callback_opportunities(db_context.turn_number)
        if callback_seeds:
            callbacks = []
            for seed in callback_seeds[:3]:  # Cap at 3 to avoid context bloat
                seed_type_val = seed.seed_type.value if hasattr(seed.seed_type, 'value') else str(seed.seed_type)
                callbacks.append(
                    f"- **{seed_type_val}**: {seed.description} "
                    f"(planted turn {seed.planted_turn}, payoff: {seed.expected_payoff})"
                )
            rag_context["foreshadowing_callbacks"] = (
                "## \U0001f3ad Callback Opportunities\n"
                "These story threads are READY for payoff. Weave them into the narrative "
                "if the situation permits \u2014 don't force them.\n\n"
                + "\n".join(callbacks)
            )
            print(f"[Foreshadowing] Injected {len(callbacks)} callback opportunities for KeyAnimator")
        
        # === AGENTIC RESEARCH TOOLS (Module 2) ===
        # Build gameplay tools for KeyAnimator's optional research phase
        from ..agents.gameplay_tools import build_gameplay_tools
        from ..context.profile_library import get_profile_library
        gameplay_tools = build_gameplay_tools(
            memory=self.memory,
            state=self.state,
            session_transcript=recent_messages,
            profile_library=get_profile_library(),
            profile_id=self.profile_id,
        )
        
        narrative = await self.key_animator.generate(
            player_input=player_input,
            intent=intent,
            outcome=outcome,
            context=db_context,
            retrieved_context=rag_context,
            recent_messages=recent_messages,
            sakuga_mode=use_sakuga,
            npc_context=npc_context or None,
            tools=gameplay_tools,
            compaction_text=compaction_text
        )
        
        # DEBUG: Log narrative generation
        print(f"[Orchestrator] Narrative generated:")
        print(f"[Orchestrator]   - type: {type(narrative)}")
        print(f"[Orchestrator]   - length: {len(narrative) if narrative else 0}")
        print(f"[Orchestrator]   - empty: {not narrative or narrative.strip() == ''}")
        
        current_turn.narrative = narrative
        
        # =====================================================================
        # #18: Prepend session recap on first gameplay turn
        # =====================================================================
        if not self._recap_generated and recap_result is not None:
            self._recap_generated = True
            recap_text = (
                f"---\n\n"
                f"**\U0001f3ac Previously On...**\n\n"
                f"{recap_result.recap_text}\n\n"
            )
            if recap_result.key_threads:
                recap_text += "**Active Threads:** " + " \u2022 ".join(recap_result.key_threads) + "\n\n"
            recap_text += "---\n\n"
            narrative = recap_text + narrative
            print(f"[Orchestrator] Recap prepended ({len(recap_text)} chars)")
        
        # =====================================================================
        # CRITICAL PATH: OP suggestion display (mutates narrative before return)
        # =====================================================================
        if db_context.pending_op_suggestion:
            suggestion = db_context.pending_op_suggestion
            preset = suggestion.get('preset', suggestion.get('archetype', 'unknown'))
            
            if db_context.op_protagonist_enabled and not db_context.op_tension_source:
                suggestion_text = (
                    f"\n\n---\n"
                    f"**⚠️ OP MODE COMPOSITION REQUIRED ⚠️**\n\n"
                    f"You have **OP Protagonist Mode** enabled, but no composition selected!\n\n"
                    f"Suggested Preset: **{preset.replace('_', ' ').title()}** "
                    f"(confidence: {suggestion.get('confidence', 0.7):.0%})\n\n"
                    f"*\"{suggestion.get('reasoning', 'Based on your character concept')}\"*\n\n"
                    f"Type `/op accept {preset}` to confirm, or choose another:\n"
                    f"`bored_god` | `restrainer` | `hidden_ruler` | `burden_bearer` | `muscle_wizard` | `nation_builder`\n"
                    f"---"
                )
            else:
                suggestion_text = (
                    f"\n\n---\n"
                    f"**🌟 OP MODE SUGGESTION 🌟**\n\n"
                    f"Based on your recent commanding victories, you might enjoy **OP Protagonist Mode!**\n\n"
                    f"Suggested Preset: **{preset.replace('_', ' ').title()}** "
                    f"(confidence: {suggestion.get('confidence', 0.7):.0%})\n\n"
                    f"*\"{suggestion.get('reasoning', 'Your playstyle fits this power fantasy')}\"*\n\n"
                    f"Type `/op accept {preset}` to enable, or `/op dismiss` to ignore.\n"
                    f"---"
                )
            narrative = narrative + suggestion_text
        
        # Measure latency NOW (before background work)
        latency = int((time.time() - start) * 1000)
        print(f"[Orchestrator] FINAL narrative length: {len(narrative) if narrative else 0} (latency: {latency}ms)")
        
        # =====================================================================
        # FIRE-AND-FORGET: All post-narrative processing runs in background
        # The user gets the narrative immediately while bookkeeping continues
        # =====================================================================
        asyncio.create_task(
            self._post_narrative_processing(
                narrative=narrative,
                player_input=player_input,
                intent=intent,
                outcome=outcome,
                db_context=db_context,
                recent_messages=recent_messages,
                use_sakuga=use_sakuga,
                compaction_text=compaction_text,
                latency_ms=latency
            )
        )
        
        return TurnResult(
            narrative=narrative,
            intent=intent,
            outcome=outcome,
            latency_ms=latency
        )
    
    async def _post_narrative_processing(
        self,
        narrative: str,
        player_input: str,
        intent,
        outcome,
        db_context,
        recent_messages: list,
        use_sakuga: bool,
        compaction_text: str,
        latency_ms: int
    ):
        """Background post-narrative processing. All bookkeeping that doesn't
        affect the current turn's response runs here.
        
        Protected by _bg_lock so the next turn waits for this to finish
        before reading state.
        """
        async with self._bg_lock:
            bg_start = time.time()
            try:
                # =============================================================
                # 1. ENTITY EXTRACTION + RELATIONSHIP ANALYSIS (PARALLEL)
                # Both only need the narrative text
                # =============================================================
                if narrative:
                    entity_task = asyncio.create_task(self._bg_extract_entities(
                        narrative, db_context.turn_number
                    ))
                    rel_task = asyncio.create_task(self._bg_relationship_analysis(
                        narrative, player_input, outcome, db_context.turn_number
                    ))
                    await asyncio.gather(entity_task, rel_task, return_exceptions=True)
                
                # =============================================================
                # TRANSACTIONAL BLOCK: Steps 2-7
                # All SQL mutations in this block commit atomically.
                # ChromaDB writes (steps 8-9) are outside this block.
                # =============================================================
                with self.state.deferred_commit():
                    # =============================================================
                    # 2. COMBAT BOOKKEEPING (#23: resolution moved pre-narrative)
                    # Apply HP/state changes from pre-resolved combat result
                    # =============================================================
                    combat_occurred = getattr(self, '_last_combat_occurred', False)
                    combat_result = getattr(self, '_last_combat_result', None)
                    if combat_occurred and combat_result:
                        if combat_result.damage_dealt > 0:
                            character = self.state.get_character()
                            target = self.state.get_target(getattr(combat_result, 'target_name', None))
                            if character and target:
                                self.state.apply_combat_result(combat_result, target)
                                
                                char_state = {
                                    "hp_current": character.hp_current,
                                    "hp_max": character.hp_max,
                                    "mp_current": getattr(character, 'mp_current', 50),
                                    "mp_max": getattr(character, 'mp_max', 50),
                                }
                                post_validation = self.validator.validate_state_integrity(char_state)
                                if not post_validation.is_valid:
                                    for error in post_validation.errors:
                                        print(f"[Validator] {error.severity.value}: {error.description}")
                        # Clear instance state
                        self._last_combat_occurred = False
                        self._last_combat_result = None
                
                    # =============================================================
                    # 3. CONSEQUENCE + PROGRESSION
                    # =============================================================
                    if outcome.consequence:
                        self.state.apply_consequence(
                            consequence=outcome.consequence,
                            turn_number=db_context.turn_number,
                            source_action=intent.action,
                            narrative_weight=outcome.narrative_weight,
                            category=getattr(outcome, 'consequence_category', None)
                        )
                    
                    character = self.state.get_character()
                    progression_result = None
                    should_calculate_progression = (
                        combat_occurred or
                        use_sakuga or
                        outcome.narrative_weight in ["significant", "climactic"] or
                        (hasattr(outcome, 'quest_progress') and outcome.quest_progress)
                    )
                    
                    if character and should_calculate_progression:
                        turn_result_data = {
                            "combat_occurred": combat_occurred,
                            "boss_fight": combat_result.narrative_weight == "climactic" if combat_result else False,
                            "sakuga_moment": combat_result.sakuga_moment if combat_result else use_sakuga,
                            "quest_completed": outcome.quest_progress if hasattr(outcome, 'quest_progress') else False,
                            "significant_roleplay": outcome.narrative_weight in ["significant", "climactic"],
                        }
                        progression_result = await self.progression.calculate_progression(
                            character=character,
                            turn_result=turn_result_data,
                            profile=self.profile
                        )
                        if progression_result.xp_awarded > 0:
                            self.state.apply_progression(progression_result)
                    elif character and not should_calculate_progression:
                        print(f"[Background] Skipping progression: no XP-worthy events")
                
                    # =============================================================
                    # 4. TURN RECORDING + EVENT MEMORY
                    # =============================================================
                    self.state.record_turn(
                        player_input=player_input,
                        intent=intent.model_dump(),
                        outcome=outcome.model_dump() if outcome else None,
                        narrative=narrative,
                        latency_ms=latency_ms
                    )
                    self.memory.add_memory(
                        content=f"Turn {db_context.turn_number}: Player input '{player_input}'. Result: {narrative[:500]}...",
                        memory_type="event",
                        turn_number=db_context.turn_number
                    )
                    
                    # =============================================================
                    # 5. NPC INTELLIGENCE BATCH
                    # =============================================================
                    if db_context.present_npcs:
                        npc_lookup = {}
                        for npc_name in db_context.present_npcs:
                            npc = self.state.get_npc_by_name(npc_name)
                            if npc:
                                npc_lookup[npc_name] = npc
                                self.state.increment_npc_interaction(npc.id)
                        
                        if npc_lookup:
                            try:
                                print(f"[Background] Batch NPC analysis for {len(npc_lookup)} NPCs")
                                batch_results = await self.relationship_analyzer.analyze_batch(
                                    npc_names=list(npc_lookup.keys()),
                                    action=intent.action,
                                    outcome=outcome.consequence or "No specific outcome",
                                    narrative_excerpt=narrative[:400]
                                )
                                
                                for rel_result in batch_results:
                                    npc = npc_lookup.get(rel_result.npc_name)
                                    if not npc:
                                        continue
                                    
                                    interaction_count = self.state.get_npc_interaction_count(npc.id)
                                    
                                    if rel_result.affinity_delta != 0:
                                        milestone = self.state.update_npc_affinity(
                                            npc.id,
                                            rel_result.affinity_delta,
                                            f"Turn {db_context.turn_number}: {rel_result.reasoning}"
                                        )
                                        if milestone:
                                            self.memory.add_memory(
                                                content=f"Relationship milestone with {npc.name}: {milestone['description']}",
                                                memory_type="relationship",
                                                turn_number=db_context.turn_number,
                                                heat=8
                                            )
                                            print(f"[NPC] Disposition threshold crossed: {milestone['event']}")
                                    
                                    if rel_result.emotional_milestone:
                                        event = self.state.record_emotional_milestone(
                                            npc.id,
                                            rel_result.emotional_milestone,
                                            context=narrative[:200],
                                            session_id=db_context.session_id
                                        )
                                        if event:
                                            trust_milestone = rel_result.emotional_milestone in ["first_sacrifice", "first_trust_test"]
                                            self.state.evolve_npc_intelligence(npc.id, interaction_count, trust_milestone)
                                    else:
                                        self.state.evolve_npc_intelligence(npc.id, interaction_count, False)
                                    
                                    if rel_result.affinity_delta != 0 or rel_result.emotional_milestone:
                                        print(f"[RelationshipAnalyzer] {rel_result.npc_name}: delta={rel_result.affinity_delta}, milestone={rel_result.emotional_milestone}")
                                
                            except Exception as e:
                                print(f"[RelationshipAnalyzer] Batch error: {e}")
                                for npc_name, npc in npc_lookup.items():
                                    interaction_count = self.state.get_npc_interaction_count(npc.id)
                                    self.state.evolve_npc_intelligence(npc.id, interaction_count, False)
                            
                            for npc_name in npc_lookup.keys():
                                self.state.increment_npc_scene_count(npc_name, db_context.turn_number)
                
                    # =============================================================
                    # 6. FORESHADOWING DETECTION + AUTO-RESOLVE (#9)
                    # =============================================================
                    mentioned_seeds = self.foreshadowing.detect_seed_in_narrative(
                        narrative=narrative,
                        current_turn=db_context.turn_number
                    )
                    overdue_seeds = self.foreshadowing.get_overdue_seeds(db_context.turn_number)
                    
                    # Auto-resolve: if a callback/overdue seed was mentioned, it's been paid off
                    for seed_id in mentioned_seeds:
                        seed = self.foreshadowing._seeds.get(seed_id)
                        if seed and seed.status.value in ("callback", "overdue"):
                            self.foreshadowing.resolve_seed(
                                seed_id, db_context.turn_number,
                                resolution_narrative=f"Paid off in turn {db_context.turn_number} narrative"
                            )
                            print(f"[Foreshadowing] Auto-resolved seed '{seed_id}': {seed.description}")
                    
                    # #12: Overdue seeds escalate world tension
                    if overdue_seeds:
                        tension_bump = len(overdue_seeds) * 0.05  # +0.05 per overdue seed
                        world = self.state.get_world_state()
                        current_tension = getattr(world, 'tension_level', 0.5) if world else 0.5
                        current_tension = current_tension or 0.5
                        new_tension = min(1.0, current_tension + tension_bump)
                        self.state.update_world_state(tension_level=new_tension)
                        print(f"[Foreshadowing] {len(overdue_seeds)} overdue seeds → tension {current_tension:.2f} → {new_tension:.2f}")
                    
                    # #3: Increment turns_in_phase counter (resets on phase change via Director)
                    self.state.update_world_state(
                        turns_in_phase=(db_context.turns_in_phase or 0) + 1
                    )
                    
                    # =============================================================
                    # 7. DIRECTOR HYBRID TRIGGER
                    # =============================================================
                    self._accumulated_epicness += intent.declared_epicness
                    
                    arc_events_this_turn = []
                    if mentioned_seeds:
                        arc_events_this_turn.append(f"foreshadowing_mentioned:{len(mentioned_seeds)}")
                    if progression_result and getattr(progression_result, 'level_up', False):
                        arc_events_this_turn.append("level_up")
                    if use_sakuga:
                        arc_events_this_turn.append("sakuga_moment")
                    if combat_occurred and combat_result and combat_result.narrative_weight == "climactic":
                        arc_events_this_turn.append("boss_defeat")
                    
                    self._arc_events_since_director.extend(arc_events_this_turn)
                    
                    turns_since_director = db_context.turn_number - self._last_director_turn
                    should_run_director = (
                        db_context.turn_number > 0 and
                        turns_since_director >= 3 and (
                            self._accumulated_epicness >= 2.0 or
                            len(self._arc_events_since_director) > 0 or
                            turns_since_director >= 8
                        )
                    )
                    
                    if should_run_director:
                        trigger_reason = []
                        if self._accumulated_epicness >= 2.0:
                            trigger_reason.append(f"epicness:{self._accumulated_epicness:.1f}")
                        if self._arc_events_since_director:
                            trigger_reason.append(f"events:{self._arc_events_since_director}")
                        if turns_since_director >= 8:
                            trigger_reason.append("max_interval")
                        
                        print(f"[Director] HYBRID TRIGGER at turn {db_context.turn_number}: {trigger_reason}")
                        
                        session = self.state.get_current_session_model()
                        bible = self.state.get_campaign_bible()
                        world_state = self.state.get_world_state()
                        
                        if session and bible:
                            op_preset = db_context.op_preset
                            op_mode_guidance = None
                            if db_context.op_tension_source:
                                tension_guidance = self.rules.get_op_axis_guidance("tension", db_context.op_tension_source)
                                expression_guidance = self.rules.get_op_axis_guidance("expression", db_context.op_power_expression)
                                focus_guidance = self.rules.get_op_axis_guidance("focus", db_context.op_narrative_focus)
                                parts = [g for g in [tension_guidance, expression_guidance, focus_guidance] if g]
                                op_mode_guidance = "\n\n".join(parts) if parts else None
                            
                            from ..agents.director_tools import build_director_tools
                            from ..context.profile_library import get_profile_library
                            director_tools = build_director_tools(
                                memory=self.memory,
                                state=self.state,
                                foreshadowing=self.foreshadowing,
                                current_turn=db_context.turn_number,
                                session_number=db_context.session_id,
                                session_transcript=recent_messages,
                                profile_library=get_profile_library(),
                                profile_id=self.profile_id,
                            )
                            
                            director_output = await self.director.run_session_review(
                                session=session,
                                bible=bible,
                                profile=self.profile,
                                world_state=world_state,
                                op_preset=op_preset,
                                op_tension_source=db_context.op_tension_source,
                                op_mode_guidance=op_mode_guidance,
                                tools=director_tools,
                                compaction_text=compaction_text
                            )
                            
                            spotlight_debt = self.state.compute_spotlight_debt()
                            planning_data = director_output.model_dump()
                            planning_data["spotlight_debt"] = spotlight_debt
                            
                            self.state.update_campaign_bible(planning_data, db_context.turn_number)
                            self.state.update_world_state(
                                arc_phase=director_output.arc_phase,
                                tension_level=director_output.tension_level
                            )
                            
                            self._last_director_turn = db_context.turn_number
                            self._accumulated_epicness = 0.0
                            self._arc_events_since_director = []
                            
                            print(f"[Director] Checkpoint at turn {db_context.turn_number}: {director_output.arc_phase} (tension: {director_output.tension_level:.1f})")
                
                # END deferred_commit block — single atomic SQL commit here
                # =============================================================
                # 8. MEMORY COMPRESSION (every 10 turns)
                # ChromaDB error recovery (#29): independent try/except
                # =============================================================
                try:
                    if db_context.turn_number > 0 and db_context.turn_number % 10 == 0:
                        compression_result = await self.memory.compress_cold_memories()
                        if compression_result.get("compressed"):
                            print(f"[Memory] Compressed {compression_result['memories_removed']} memories into {compression_result['summaries_created']} summaries")
                except Exception as e:
                    print(f"[ChromaDB Recovery] Memory compression failed (will retry next cycle): {e}")
                
                # =============================================================
                # 9. EPISODIC MEMORY
                # ChromaDB error recovery (#29): independent try/except
                # =============================================================
                try:
                    turn_number = db_context.turn_number if hasattr(db_context, 'turn_number') else 0
                    location = db_context.location if hasattr(db_context, 'location') else "Unknown"
                    action_summary = player_input[:80].strip()
                    outcome_summary = narrative[:120].strip().replace('\n', ' ') if narrative else "No outcome"
                    self.memory.add_episode(
                        turn=turn_number,
                        location=location,
                        summary=f"Player: {action_summary}. Outcome: {outcome_summary}"
                    )
                    print(f"[Background] Episodic memory written for turn {turn_number}")
                except Exception as e:
                    print(f"[ChromaDB Recovery] Episodic write failed (idempotent, will retry): {e}")
                
                bg_elapsed = int((time.time() - bg_start) * 1000)
                print(f"[Background] Post-narrative processing complete ({bg_elapsed}ms)")
                
            except Exception as e:
                print(f"[Background] Post-narrative processing FAILED: {e}")
                import traceback
                traceback.print_exc()
    
    async def _bg_extract_entities(self, narrative: str, turn_number: int):
        """Background entity extraction + narrative beat indexing from DM narrative."""
        # Run entity extraction and narrative beat extraction in parallel
        entity_task = self._extract_world_entities(narrative, turn_number)
        beat_task = self._extract_narrative_beats(narrative, turn_number)
        await asyncio.gather(entity_task, beat_task, return_exceptions=True)
        
        # #24: Check NPC intelligence evolution for NPCs present in scene
        try:
            from ..db.models import NPC
            db = self.state._get_db()
            campaign_npcs = db.query(NPC).filter(
                NPC.campaign_id == self.state.campaign_id
            ).all()
            
            for npc in campaign_npcs:
                # Only check NPCs who appeared this turn (scene_count just incremented)
                if npc.last_appeared == turn_number:
                    evolution = self.state.evolve_npc_intelligence(npc.id)
                    if evolution:
                        # Only store narrative beats for major transitions
                        if evolution["new_stage"] in ("anticipatory", "autonomous"):
                            beat_text = (
                                f"{evolution['npc_name']} has evolved to {evolution['new_stage']} intelligence "
                                f"— they now {evolution['behavior_desc']}."
                            )
                            # Store as a high-importance memory for future narrative injection
                            if self.memory:
                                await self.memory.add_memory(
                                    text=beat_text,
                                    metadata={
                                        "type": "npc_evolution",
                                        "npc_name": evolution["npc_name"],
                                        "stage": evolution["new_stage"],
                                        "turn": turn_number,
                                        "importance": "high"
                                    },
                                    turn_number=turn_number
                                )
                            print(f"[NPC Evolution] Stored narrative beat: {beat_text}")
        except Exception as e:
            print(f"[NPC Evolution] Intelligence check failed (non-fatal): {e}")
    
    async def _extract_world_entities(self, narrative: str, turn_number: int):
        """Extract world-building entities (NPCs, locations, items) from narrative."""
        try:
            from ..agents.world_builder import WorldBuilderAgent
            extractor = WorldBuilderAgent()
            dm_entities = await extractor.call(
                player_input=narrative[:800],
                mode="extract_only"
            )
            for entity in dm_entities.entities:
                if entity.is_new:
                    await self._apply_world_building_entity(entity, turn_number)
            if dm_entities.entities:
                print(f"[Background] Extracted {len(dm_entities.entities)} entities from narrative")
        except Exception as e:
            print(f"[Background] Entity extraction failed: {e}")
    
    async def _extract_narrative_beats(self, narrative: str, turn_number: int):
        """Extract narrative beats from DM narrative and index to ChromaDB.
        
        Identifies emotionally significant moments, character revelations,
        and world-changing events. Also classifies each beat as plot-critical
        or not (PLAN #6: auto-detect plot-critical memories).
        """
        try:
            from pydantic import BaseModel, Field
            from typing import List
            from ..llm import get_llm_manager
            
            class NarrativeBeat(BaseModel):
                description: str = Field(description="One-sentence summary of the beat")
                npcs: List[str] = Field(default_factory=list, description="NPC names involved")
                location: str = Field(default="", description="Where this happened")
                is_plot_critical: bool = Field(
                    default=False,
                    description="True if losing this memory would break narrative continuity"
                )
            
            class NarrativeBeatsOutput(BaseModel):
                beats: List[NarrativeBeat] = Field(
                    default_factory=list,
                    description="1-3 narrative beats extracted from the text"
                )
            
            manager = get_llm_manager()
            fast_provider = manager.fast_provider
            fast_model = manager.get_fast_model()
            
            system = (
                "You extract narrative beats from RPG game master narration. "
                "A narrative beat is an emotionally significant moment, character revelation, "
                "world-changing event, or dramatic turning point. "
                "Extract 1-3 beats. Skip mundane descriptions. "
                "Mark a beat as plot_critical ONLY if losing it would break narrative continuity "
                "(e.g., a character death, a major alliance formed, a secret revealed)."
            )
            
            result = await fast_provider.complete_with_schema(
                messages=[{"role": "user", "content": narrative[:800]}],
                schema=NarrativeBeatsOutput,
                system=system,
                model=fast_model,
                max_tokens=512,
            )
            
            if not result.beats:
                return
            
            # Index each beat to ChromaDB
            for beat in result.beats:
                try:
                    flags = ["plot_critical"] if beat.is_plot_critical else []
                    self.memory.add_memory(
                        content=beat.description,
                        memory_type="narrative_beat",
                        turn_number=turn_number,
                        metadata={
                            "npcs_involved": ",".join(beat.npcs),
                            "location": beat.location,
                        },
                        flags=flags,
                    )
                except Exception as e:
                    print(f"[ChromaDB Recovery] Narrative beat write failed: {e}")
            
            critical_count = sum(1 for b in result.beats if b.is_plot_critical)
            print(
                f"[Background] Extracted {len(result.beats)} narrative beats "
                f"({critical_count} plot-critical) from turn {turn_number}"
            )
        except Exception as e:
            print(f"[Background] Narrative beat extraction failed (non-fatal): {e}")
    
    async def _bg_relationship_analysis(self, narrative: str, player_input: str, outcome, turn_number: int):
        """Background NPC relationship analysis from narrative."""
        try:
            post_narr_npcs = self.state.detect_npcs_in_text(narrative)
            if post_narr_npcs:
                rel_results = await self.relationship_analyzer.analyze_batch(
                    npc_names=post_narr_npcs,
                    action=player_input,
                    outcome=str(outcome.narrative_weight) if outcome else "neutral",
                    narrative_excerpt=narrative[:600]
                )
                for rel in rel_results:
                    self.state.update_npc_relationship(
                        npc_name=rel.npc_name,
                        affinity_delta=rel.affinity_delta,
                        turn_number=turn_number,
                        emotional_milestone=rel.emotional_milestone,
                        milestone_context=rel.reasoning
                    )
                if rel_results:
                    print(f"[Background] Relationship analysis: {len(rel_results)} NPCs updated")
        except Exception as e:
            print(f"[Background] Relationship analysis failed (non-fatal): {e}")
    
    def close(self):
        """Clean up resources."""
        self.state.close()
    
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
    
    async def _apply_world_building_entity(self, entity, turn_number: int = 0):
        """Apply a world-building entity to game state.
        
        Creates NPCs, adds items to inventory, indexes locations/events to memory.
        
        Args:
            entity: WorldBuildingEntity from WorldBuilderAgent
            turn_number: Current turn number for memory indexing
        """
        from ..agents.world_builder import WorldBuildingEntity
        
        if entity.entity_type == "npc":
            # Create NPC in database
            try:
                self.state.create_npc(
                    name=entity.name,
                    role=entity.details.get("role", "acquaintance"),
                    relationship_notes=entity.implied_backstory
                )
                print(f"[WorldBuilding] Created NPC: {entity.name}")
            except Exception as e:
                print(f"[WorldBuilding] Failed to create NPC {entity.name}: {e}")
            
            # Index to memory
            self.memory.add_memory(
                content=f"NPC {entity.name}: {entity.implied_backstory or entity.details.get('description', 'No details.')}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "npc"]
            )
        
        elif entity.entity_type == "item":
            # Add to character inventory
            try:
                self.state.add_inventory_item(entity.name, entity.details)
                print(f"[WorldBuilding] Added item: {entity.name}")
            except Exception as e:
                print(f"[WorldBuilding] Failed to add item {entity.name}: {e}")
            
            # Index to memory
            self.memory.add_memory(
                content=f"Item: {entity.name} - {entity.implied_backstory or 'No history.'}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "item"]
            )
        
        elif entity.entity_type == "location":
            # Locations are indexed as memories (no DB table yet)
            self.memory.add_memory(
                content=f"Location: {entity.name} - {entity.details.get('description', '')} {entity.implied_backstory or ''}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "location"]
            )
            print(f"[WorldBuilding] Indexed location: {entity.name}")
        
        elif entity.entity_type == "faction":
            # 1. Create faction in SQLite database
            try:
                self.state.create_faction(
                    name=entity.name,
                    description=entity.details.get('description', entity.implied_backstory or ''),
                    pc_controls=False
                )
                print(f"[WorldBuilding] Created faction in DB: {entity.name}")
            except Exception as e:
                print(f"[WorldBuilding] Faction DB creation failed: {e}")
            
            # 2. Index faction to ChromaDB memory
            self.memory.add_memory(
                content=f"Faction: {entity.name} - {entity.details.get('description', '')} {entity.implied_backstory or ''}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "faction"]
            )
            print(f"[WorldBuilding] Indexed faction: {entity.name}")
        
        elif entity.entity_type == "event":
            # Past events are indexed as backstory
            self.memory.add_memory(
                content=f"Past Event: {entity.name} - {entity.implied_backstory or entity.details.get('description', '')}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "backstory", "event"]
            )
            print(f"[WorldBuilding] Indexed event: {entity.name}")
        
        elif entity.entity_type == "relationship":
            # Relationships modify NPC or are indexed
            self.memory.add_memory(
                content=f"Relationship: {entity.name} - {entity.implied_backstory or entity.details.get('description', '')}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "relationship"]
            )
            print(f"[WorldBuilding] Indexed relationship: {entity.name}")
        
        elif entity.entity_type == "ability":
            # Abilities mentioned but not in list - flag for later
            self.memory.add_memory(
                content=f"Referenced Ability: {entity.name} - {entity.implied_backstory or 'Player referenced this ability.'}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "ability", "unverified"]
            )
            print(f"[WorldBuilding] Indexed ability reference: {entity.name}")

