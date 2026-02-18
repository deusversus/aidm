"""Turn pipeline mixin: the main process_turn method.

Split from orchestrator.py for maintainability.
Contains the full AIDM turn flow: intent → outcome → narrative.
"""

import asyncio
import time
from typing import Optional

from ..enums import NarrativeWeight, ArcPhase, IntentType
from ..utils.tasks import safe_create_task

import logging

logger = logging.getLogger(__name__)


class TurnPipelineMixin:
    """The main ``process_turn`` pipeline.

    Relies on instance attributes set by ``Orchestrator.__init__``.
    """

    async def process_turn(self, player_input: str, recent_messages: list = None, compaction_text: str = "") -> "TurnResult":
        """Process a single turn.
        
        Args:
            player_input: The player's action/input
            recent_messages: Last N messages from session for working memory (every turn)
            compaction_text: Flattened compaction buffer (narrative beats from messages
                that fell off the sliding window). Always present, cached.
            
        Returns:
            TurnResult with narrative and agent decisions
        """
        from .turn import TurnResult
        start = time.time()
        
        # Wait for previous turn's background processing to finish
        # (almost never blocks — users take ~5-10s between turns)
        if self._bg_lock.locked():
            logger.info(f"Waiting for previous turn's background processing...")
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
            
            logger.info(f"WORLD_BUILDING: {len(wb_result.entities)} entities, status={wb_result.validation_status}")
            
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
        from ..agents.pacing_agent import PacingDirective
        
        # Check for Tier 0 (trivial action) fast-path
        is_trivial = self.context_selector.is_trivial_action(intent)
        
        if is_trivial:
            # TIER 0 FAST-PATH: Skip OutcomeJudge, memory ranking, and pacing
            logger.warning(f"TIER 0 fast-path: trivial action, skipping Outcome/Memory/Pacing")
            
            # Synthetic auto-success outcome for trivial actions
            from ..agents.outcome_judge import OutcomeOutput
            outcome = OutcomeOutput(
                should_succeed=True,
                difficulty_class=5,
                modifiers={},
                calculated_roll=15,
                success_level="success",
                narrative_weight=NarrativeWeight.MINOR,
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
                logger.error(f"Memory ranking failed: {ranked_memories}, using unranked")
                ranked_memories = "No relevant past memories found."
            if isinstance(pacing_directive, Exception):
                logger.error(f"Pacing micro-check failed (non-fatal): {pacing_directive}")
                pacing_directive = None
            elif pacing_directive:
                logger.info(f"Beat: {pacing_directive.arc_beat}, Tone: {pacing_directive.tone}, Escalation: {pacing_directive.escalation_target:.0%}")
            
            # #18: Extract recap result (index 3, if present)
            recap_result = None
            if recap_task and len(phase2_results) > 3:
                recap_result = phase2_results[3]
                if isinstance(recap_result, Exception):
                    logger.error(f"Recap generation failed (non-fatal): {recap_result}")
                    recap_result = None
                elif recap_result:
                    logger.info(f"Recap generated: {len(recap_result.recap_text)} chars")
        
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
                                logger.error(f"Pre-validation failed: {err.message}")
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
                    logger.info(f"Pre-narrative resolution: {combat_result.damage_dealt} damage, hit={combat_result.hit}")
        
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
                logger.info(f"Power imbalance: {power_result.raw_imbalance:.1f} → {power_result.effective_imbalance:.1f}")
                logger.info(f"Context modifiers: {', '.join(power_result.context_modifiers)}")
            
            # =====================================================================
            # PROGRESSIVE OP MODE: Track high-imbalance encounters
            # If player consistently dominates (imbalance > 10), suggest OP Mode
            # =====================================================================
            if power_result.effective_imbalance > 10 and not db_context.op_protagonist_enabled:
                # Increment counter
                count = self.state.increment_high_imbalance_count()
                logger.info(f"High-imbalance encounter #{count}")
                
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
                        logger.info(f"Suggesting preset: {suggestion.get('preset', 'unknown')} (confidence: {suggestion.get('confidence', 0):.0%})")
            
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
                    logger.info(f"[OP Mode] Set static 3-axis guidance in Block 1 (cache-stable): "
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
                    logger.warning(f"Missing composition! Suggesting: {suggestion.get('preset', 'unknown')}")
            
            # Inject tension guidance for high power imbalance
            power_imbalance = db_context.power_imbalance
            if power_imbalance > 3:
                tension_guidance = self.rules.get_op_axis_guidance("tension", db_context.op_tension_source or "existential")
                if tension_guidance:
                    rag_context["tension_guidance"] = tension_guidance
                    logger.info(f"Injected tension guidance (imbalance: {power_imbalance:.1f})")
        
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
            logger.info(f"Injected {len(self.override_handler.get_active_overrides(self.campaign_id))} active overrides")
        
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
                    logger.info(f"DNA guidance for {len(dna_parts)} extreme scales → Block 1 (cache-stable)")

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
                    logger.info(f"Genre guidance → Block 1 (cache-stable): {', '.join(g for g in self.profile.detected_genres[:2])}")

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
                logger.info(f"Injected scale guidance: {db_context.narrative_scale}")
        
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
                logger.info(f"Injected compatibility guidance: T{tier_num} × {db_context.narrative_scale}")
        
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
            logger.info(f"Injected {len(active_consequences)} active consequences into context")
        
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
            logger.info(f"Injected combat result into KeyAnimator context")
        
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
            logger.error(f"Validation failed: {validation.correction}. Retrying...")
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
        if outcome.narrative_weight == NarrativeWeight.CLIMACTIC:
            use_sakuga = True
        elif intent.intent == "COMBAT" or outcome.calculated_roll >= 20: # Natural 20 or high
            use_sakuga = True
        # Special conditions auto-trigger sakuga
        elif any(cond in intent.special_conditions for cond in ("named_attack", "first_time_power")):
            use_sakuga = True
            logger.info(f"Auto-sakuga triggered by special condition: {intent.special_conditions}")
        
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
            logger.info(f"Mode transition: {prev_mode} → {new_mode} (threat: {current_threat or 'world baseline'})")
        logger.info(f"Power Differential: {effective_comp.get('differential', 0)} tiers, mode={new_mode}")
        
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
            logger.info(f"NPC context: {len(pre_narr_npcs)} NPCs present")
        
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
            logger.info(f"Injected {len(callbacks)} callback opportunities for KeyAnimator")
        
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
        logger.info(f"Narrative generated:")
        logger.info(f"- type: {type(narrative)}")
        logger.info(f"- length: {len(narrative) if narrative else 0}")
        logger.info(f"- empty: {not narrative or narrative.strip() == ''}")
        
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
            logger.info(f"Recap prepended ({len(recap_text)} chars)")
        
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
        logger.info(f"FINAL narrative length: {len(narrative) if narrative else 0} (latency: {latency}ms)")
        
        # =====================================================================
        # FIRE-AND-FORGET: All post-narrative processing runs in background
        # The user gets the narrative immediately while bookkeeping continues
        # =====================================================================
        safe_create_task(
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
            ),
            name="post_narrative_processing",
        )
        # =====================================================================
        # PORTRAIT RESOLUTION: Replace {{Name}} markers with bold + portrait map
        # Lightweight post-KA step — DB lookup only, no LLM
        # =====================================================================
        portrait_map = {}
        try:
            from src.media.resolver import resolve_portraits
            narrative, portrait_map = resolve_portraits(narrative, self.campaign_id)
        except Exception as e:
            logger.error(f"Portrait resolution failed (non-fatal): {e}")
        
        return TurnResult(
            narrative=narrative,
            intent=intent,
            outcome=outcome,
            latency_ms=latency,
            portrait_map=portrait_map or None,
            turn_number=db_context.turn_number,
            campaign_id=self.campaign_id,
        )
