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
        
        # Phase 4: Foreshadowing
        self.foreshadowing = ForeshadowingLedger(self.campaign_id)
        
        # Scale Selector (Module 12)
        self.scale_selector = ScaleSelectorAgent()
        
        # Relationship Analyzer (NPC Intelligence, fast model)
        self.relationship_analyzer = RelationshipAnalyzer()
        
        # Director hybrid trigger tracking
        self._accumulated_epicness = 0.0
        self._last_director_turn = 0
        self._arc_events_since_director = []  # Track arc-relevant events
        
        # Override Handler (META/OVERRIDE commands)
        db = create_session()
        self.override_handler = OverrideHandler(db=db, memory_store=self.memory)
    
    async def process_turn(self, player_input: str, handoff_transcript: list = None) -> TurnResult:
        """Process a single turn.
        
        Args:
            player_input: The player's action/input
            handoff_transcript: Full Session Zero transcript for voice continuity (first turn only)
            
        Returns:
            TurnResult with narrative and agent decisions
        """
        start = time.time()
        
        # 1. Get current DB context (fast, sync)
        db_context = self.state.get_context()
        
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
                session_number=db_context.session_number
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
                established_facts=established_facts
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
            # TIER 0 FAST-PATH: Skip OutcomeJudge and memory ranking
            print(f"[Orchestrator] TIER 0 fast-path: trivial action, skipping Outcome/Memory")
            
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
        else:
            # Normal path: parallel OutcomeJudge and MemoryRanker
            outcome_task = asyncio.create_task(
                self.outcome_judge.call(
                    f"Action: {intent.action}\nTarget: {intent.target or 'N/A'}",
                    intent=intent.model_dump_json(),
                    profile_tropes=str(self.profile.tropes),
                    arc_phase=db_context.arc_phase,
                    recent_events=db_context.recent_summary,
                    difficulty_context=f"Situation: {db_context.situation}. Location: {db_context.location}"
                )
            )
            
            memory_rank_task = asyncio.create_task(
                self.context_selector.rank_memories(
                    rag_base["raw_memories"],
                    db_context.situation,
                    intent=intent  # Pass intent for conditional skip
                )
            )
            
            # Wait for both to complete (parallel execution)
            phase2_results = await asyncio.gather(
                outcome_task, memory_rank_task, return_exceptions=True
            )
            
            # Handle potential exceptions
            outcome = phase2_results[0]
            ranked_memories = phase2_results[1]
            
            if isinstance(outcome, Exception):
                raise RuntimeError(f"Outcome judgment failed: {outcome}")
            if isinstance(ranked_memories, Exception):
                print(f"[Orchestrator] Memory ranking failed: {ranked_memories}, using unranked")
                ranked_memories = "No relevant past memories found."
        
        current_turn.outcome = outcome
        
        # Assemble final RAG context
        rag_context = {
            "memories": ranked_memories,
            "rules": rag_base["rules"],
            "short_term": rag_base["short_term"]
        }
        
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
        if db_context.op_protagonist_enabled and db_context.op_tension_source:
            # Get guidance for each axis
            tension_guidance = self.rules.get_op_axis_guidance("tension", db_context.op_tension_source)
            expression_guidance = self.rules.get_op_axis_guidance("expression", db_context.op_power_expression)
            focus_guidance = self.rules.get_op_axis_guidance("focus", db_context.op_narrative_focus)
            
            op_guidance_parts = []
            if tension_guidance:
                op_guidance_parts.append(f"## Tension Source: {db_context.op_tension_source.upper()}\n{tension_guidance}")
            if expression_guidance:
                op_guidance_parts.append(f"## Power Expression: {db_context.op_power_expression.upper()}\n{expression_guidance}")
            if focus_guidance:
                op_guidance_parts.append(f"## Narrative Focus: {db_context.op_narrative_focus.upper()}\n{focus_guidance}")
            
            if op_guidance_parts:
                rag_context["op_mode_guidance"] = "\n\n".join(op_guidance_parts)
                print(f"[OP Mode] Injected 3-axis guidance: {db_context.op_tension_source}/{db_context.op_power_expression}/{db_context.op_narrative_focus}")
        
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
        
        # 3b. Validation Loop
        # Check if the outcome makes sense. If not, retry outcome generation with feedback.
        # Limit retries to avoid infinite loops.
        max_retries = 1
        for _ in range(max_retries):
            validation = await self.validator.validate(
                 turn=current_turn,
                 context={
                     "rules_summary": "Standard Physics + Anime Logic",  # TODO: Get from RuleLibrary
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
                correction_feedback=validation.correction
            )
            current_turn.outcome = outcome

        # 4. Generate narrative (KeyAnimator with optional Sakuga Mode)
        # Determine if this is a sakuga moment (climactic, high intensity)
        use_sakuga = False
        if outcome.narrative_weight == "climactic":
            use_sakuga = True
        elif intent.intent == "COMBAT" or outcome.calculated_roll >= 20: # Natural 20 or high
            use_sakuga = True
        
        # Single narrative path - KeyAnimator handles both normal and sakuga modes
        
        # === UNIFIED POWER DIFFERENTIAL: Calculate effective composition ===
        # Blends profile composition with character OP settings based on power tier gap
        from ..profiles.loader import get_effective_composition
        effective_comp = get_effective_composition(
            profile_composition=self.profile.composition or {},
            world_tier=self.profile.world_tier or "T8",
            character_tier=db_context.power_tier or "T10",
            character_op_enabled=db_context.op_protagonist_enabled,
            character_op_tension=db_context.op_tension_source,
            character_op_expression=db_context.op_power_expression,
            character_op_focus=db_context.op_narrative_focus
        )
        # Inject effective composition into profile for KeyAnimator
        self.profile.composition = effective_comp
        print(f"[Orchestrator] Power Differential: {effective_comp.get('differential', 0)} tiers, mode={effective_comp.get('mode', 'standard')}")
        
        narrative = await self.key_animator.generate(
            player_input=player_input,
            intent=intent,
            outcome=outcome,
            context=db_context,
            retrieved_context=rag_context,
            handoff_transcript=handoff_transcript,
            sakuga_mode=use_sakuga
        )
        
        # DEBUG: Log narrative generation
        print(f"[Orchestrator] Narrative generated:")
        print(f"[Orchestrator]   - type: {type(narrative)}")
        print(f"[Orchestrator]   - length: {len(narrative) if narrative else 0}")
        print(f"[Orchestrator]   - empty: {not narrative or narrative.strip() == ''}")
        
        current_turn.narrative = narrative
        
        # 5. Combat Resolution (if applicable)
        combat_occurred = False
        combat_result = None
        if intent.intent == "COMBAT" or "attack" in intent.action.lower():
            combat_occurred = True
            # Parse combat action
            combat_action = self.combat.parse_combat_action(intent, player_input)
            
            # Get character and target
            character = self.state.get_character()
            target = self.state.get_target(combat_action.target)
            
            if character and target:
                # 5a. Pre-action validation (M10 Error Recovery)
                if combat_action.action_type == "spell":
                    mp_cost = 20  # TODO: Get from skill data
                    pre_validation = self.validator.validate_resource_cost(
                        resource_name="MP",
                        current=getattr(character, 'mp_current', 50),
                        cost=mp_cost
                    )
                    if not pre_validation.is_valid:
                        # Block action, return validation error as narrative
                        current_turn.narrative = pre_validation.correction
                        combat_occurred = False
                        combat_result = None
                elif combat_action.action_type == "skill":
                    sp_cost = 15  # TODO: Get from skill data
                    pre_validation = self.validator.validate_resource_cost(
                        resource_name="SP",
                        current=getattr(character, 'sp_current', 50),
                        cost=sp_cost
                    )
                    if not pre_validation.is_valid:
                        current_turn.narrative = pre_validation.correction
                        combat_occurred = False
                        combat_result = None
                
                # Execute combat if validation passed
                if combat_occurred:
                    combat_result = await self.combat.resolve_action(
                        action=combat_action,
                        attacker=character,
                        target_entity=target,
                        context=db_context,
                        profile=self.profile
                    )
                    
                    # Apply combat results to state
                    if combat_result.damage_dealt > 0:
                        self.state.apply_combat_result(combat_result, target)
                    
                    # 5b. Post-action validation (M10 Error Recovery)
                    char_state = {
                        "hp_current": character.hp_current,
                        "hp_max": character.hp_max,
                        "mp_current": getattr(character, 'mp_current', 50),
                        "mp_max": getattr(character, 'mp_max', 50),
                    }
                    post_validation = self.validator.validate_state_integrity(char_state)
                    if not post_validation.is_valid:
                        # Log and auto-correct
                        for error in post_validation.errors:
                            print(f"[Validator] {error.severity.value}: {error.description}")
        
        # 6. Update state (if there are consequences)
        if outcome.consequence:
            self.state.apply_consequence(outcome.consequence)
        
        # 7. Progression (XP calculation) - LAZY: only when XP-worthy events occur
        character = self.state.get_character()
        progression_result = None
        
        # Determine if progression check is needed
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
            
            # Apply XP and level-up
            if progression_result.xp_awarded > 0:
                self.state.apply_progression(progression_result)
        elif character and not should_calculate_progression:
            print(f"[Orchestrator] Skipping progression: no XP-worthy events")
        
        # 6. Record turn & Memory
        latency = int((time.time() - start) * 1000)
        self.state.record_turn(
            player_input=player_input,
            intent=intent.model_dump(),
            outcome=outcome.model_dump() if outcome else None,
            narrative=narrative,
            latency_ms=latency
        )
        
        # Store comprehensive memory of this turn
        self.memory.add_memory(
            content=f"Turn {db_context.turn_number}: Player input '{player_input}'. Result: {narrative[:500]}...",
            memory_type="event",
            turn_number=db_context.turn_number
        )
        
        # =====================================================================
        # NPC INTELLIGENCE: Track interactions and evolve cognition
        # Uses RelationshipAnalyzer agent (judgment = API call policy)
        # BATCH PROCESSING: Single LLM call for all NPCs present
        # =====================================================================
        if db_context.present_npcs:
            # Build NPC lookup for processing results
            npc_lookup = {}
            for npc_name in db_context.present_npcs:
                npc = self.state.get_npc_by_name(npc_name)
                if npc:
                    npc_lookup[npc_name] = npc
                    # Increment interaction count
                    self.state.increment_npc_interaction(npc.id)
            
            if npc_lookup:
                # BATCH: Single LLM call for all NPCs
                try:
                    print(f"[Orchestrator] Batch NPC analysis for {len(npc_lookup)} NPCs")
                    batch_results = await self.relationship_analyzer.analyze_batch(
                        npc_names=list(npc_lookup.keys()),
                        action=intent.action,
                        outcome=outcome.consequence or "No specific outcome",
                        narrative_excerpt=narrative[:400]
                    )
                    
                    # Process each result
                    for rel_result in batch_results:
                        npc = npc_lookup.get(rel_result.npc_name)
                        if not npc:
                            continue
                        
                        interaction_count = self.state.get_npc_interaction_count(npc.id)
                        
                        # Apply affinity changes
                        if rel_result.affinity_delta != 0:
                            milestone = self.state.update_npc_affinity(
                                npc.id, 
                                rel_result.affinity_delta, 
                                f"Turn {db_context.turn_number}: {rel_result.reasoning}"
                            )
                            if milestone:
                                # Threshold crossed! Create a memory of this moment
                                self.memory.add_memory(
                                    content=f"Relationship milestone with {npc.name}: {milestone['description']}",
                                    memory_type="relationship",
                                    turn_number=db_context.turn_number,
                                    heat=8  # High importance
                                )
                                print(f"[NPC] Disposition threshold crossed: {milestone['event']}")
                        
                        # Record emotional milestone if detected
                        if rel_result.emotional_milestone:
                            event = self.state.record_emotional_milestone(
                                npc.id,
                                rel_result.emotional_milestone,
                                context=narrative[:200],
                                session_id=db_context.session_id
                            )
                            if event:
                                # Trust milestone triggers cognitive evolution
                                trust_milestone = rel_result.emotional_milestone in ["first_sacrifice", "first_trust_test"]
                                self.state.evolve_npc_intelligence(
                                    npc.id, 
                                    interaction_count,
                                    trust_milestone
                                )
                        else:
                            # Regular evolution check
                            self.state.evolve_npc_intelligence(npc.id, interaction_count, False)
                        
                        if rel_result.affinity_delta != 0 or rel_result.emotional_milestone:
                            print(f"[RelationshipAnalyzer] {rel_result.npc_name}: delta={rel_result.affinity_delta}, milestone={rel_result.emotional_milestone}")
                    
                except Exception as e:
                    # Fallback: just evolve intelligence, no relationship changes
                    print(f"[RelationshipAnalyzer] Batch error: {e}")
                    for npc_name, npc in npc_lookup.items():
                        interaction_count = self.state.get_npc_interaction_count(npc.id)
                        self.state.evolve_npc_intelligence(npc.id, interaction_count, False)
                
                # Increment scene counts for spotlight tracking
                for npc_name in npc_lookup.keys():
                    self.state.increment_npc_scene_count(npc_name, db_context.turn_number)
        
        # 9. Foreshadowing Detection
        # Check if any active seeds were mentioned in the narrative
        mentioned_seeds = self.foreshadowing.detect_seed_in_narrative(
            narrative=narrative,
            current_turn=db_context.turn_number
        )
        
        # Check for overdue seeds
        overdue_seeds = self.foreshadowing.get_overdue_seeds(db_context.turn_number)
        
        # Phase 4: Director Checkup (HYBRID TRIGGER)
        # Runs when: turns_since_last >= 3 AND (epicness >= 2.0 OR arc_event OR turns >= 8)
        # =====================================================================
        
        # Accumulate epicness from this turn
        self._accumulated_epicness += intent.declared_epicness
        
        # Detect arc-relevant events this turn
        arc_events_this_turn = []
        if mentioned_seeds:
            arc_events_this_turn.append(f"foreshadowing_mentioned:{len(mentioned_seeds)}")
        if progression_result and getattr(progression_result, 'level_up', False):
            arc_events_this_turn.append("level_up")
        if use_sakuga:
            arc_events_this_turn.append("sakuga_moment")
        if combat_occurred and combat_result and combat_result.narrative_weight == "climactic":
            arc_events_this_turn.append("boss_defeat")
        # Major NPC shift detected during batch processing
        # (tracked separately if needed)
        
        self._arc_events_since_director.extend(arc_events_this_turn)
        
        # Calculate turns since last Director run
        turns_since_director = db_context.turn_number - self._last_director_turn
        
        # HYBRID TRIGGER CONDITIONS
        should_run_director = (
            db_context.turn_number > 0 and
            turns_since_director >= 3 and (  # Minimum floor
                self._accumulated_epicness >= 2.0 or  # ~3 epic turns worth
                len(self._arc_events_since_director) > 0 or  # Arc-relevant event occurred
                turns_since_director >= 8  # Maximum ceiling
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
                # Get OP mode guidance if active
                op_preset = db_context.op_preset
                op_mode_guidance = None
                if db_context.op_tension_source:
                    # Build combined guidance from all axes
                    tension_guidance = self.rules.get_op_axis_guidance("tension", db_context.op_tension_source)
                    expression_guidance = self.rules.get_op_axis_guidance("expression", db_context.op_power_expression)
                    focus_guidance = self.rules.get_op_axis_guidance("focus", db_context.op_narrative_focus)
                    parts = [g for g in [tension_guidance, expression_guidance, focus_guidance] if g]
                    op_mode_guidance = "\n\n".join(parts) if parts else None
                
                # Run Director analysis
                director_output = await self.director.run_session_review(
                    session=session,
                    bible=bible,
                    profile=self.profile,
                    world_state=world_state,
                    op_preset=op_preset,
                    op_tension_source=db_context.op_tension_source,
                    op_mode_guidance=op_mode_guidance
                )
                
                # Inject spotlight debt from our tracking
                spotlight_debt = self.state.compute_spotlight_debt()
                planning_data = director_output.model_dump()
                planning_data["spotlight_debt"] = spotlight_debt
                
                # Update Campaign Bible with Director's plans
                self.state.update_campaign_bible(
                    planning_data, 
                    db_context.turn_number
                )
                
                # Persist arc phase and tension to WorldState
                self.state.update_world_state(
                    arc_phase=director_output.arc_phase,
                    tension_level=director_output.tension_level
                )
                
                # Reset tracking after Director runs
                self._last_director_turn = db_context.turn_number
                self._accumulated_epicness = 0.0
                self._arc_events_since_director = []
                
                print(f"[Director] Checkpoint at turn {db_context.turn_number}: {director_output.arc_phase} (tension: {director_output.tension_level:.1f})")
        
        # Memory Compression (every 10 turns)
        if db_context.turn_number > 0 and db_context.turn_number % 10 == 0:
            compression_result = await self.memory.compress_cold_memories()
            if compression_result.get("compressed"):
                print(f"[Memory] Compressed {compression_result['memories_removed']} memories into {compression_result['summaries_created']} summaries")
        
        # =====================================================================
        # PROGRESSIVE OP MODE: Display suggestion if pending
        # =====================================================================
        if db_context.pending_op_suggestion:
            suggestion = db_context.pending_op_suggestion
            preset = suggestion.get('preset', suggestion.get('archetype', 'unknown'))
            
            # Different message if OP already enabled (required) vs suggested (optional)
            if db_context.op_protagonist_enabled and not db_context.op_tension_source:
                # REQUIRED: OP mode on but no composition
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
                # OPTIONAL: Suggested based on gameplay
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
        
        # DEBUG: Log final narrative before return
        print(f"[Orchestrator] FINAL narrative length: {len(narrative) if narrative else 0}")
        
        return TurnResult(
            narrative=narrative,
            intent=intent,
            outcome=outcome,
            latency_ms=latency
        )
    
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
            # Factions are indexed as memories
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

