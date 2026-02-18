"""Background processing mixin: post-narrative bookkeeping.

Split from orchestrator.py for maintainability.
Contains all fire-and-forget tasks that run after the narrative is returned.
"""

import asyncio
import logging
import time

from ..enums import NarrativeWeight

logger = logging.getLogger(__name__)


class BackgroundMixin:
    """Post-narrative background processing pipeline.

    Runs after ``process_turn`` returns the narrative to the user.
    Protected by ``_bg_lock`` so consecutive turns don't overlap.
    """

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
                # 1. ENTITY EXTRACTION + RELATIONSHIP ANALYSIS + PRODUCTION (PARALLEL)
                # All three only need the narrative text + context
                # =============================================================
                if narrative:
                    entity_task = asyncio.create_task(self._bg_extract_entities(
                        narrative, db_context.turn_number
                    ))
                    rel_task = asyncio.create_task(self._bg_relationship_analysis(
                        narrative, player_input, outcome, db_context.turn_number
                    ))
                    prod_task = asyncio.create_task(self._bg_production_check(
                        narrative=narrative,
                        player_input=player_input,
                        intent=intent,
                        outcome=outcome,
                        db_context=db_context,
                    ))
                    await asyncio.gather(entity_task, rel_task, prod_task, return_exceptions=True)

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
                                        logger.error(f"{error.severity.value}: {error.description}")
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
                        outcome.narrative_weight in [NarrativeWeight.SIGNIFICANT, NarrativeWeight.CLIMACTIC] or
                        (hasattr(outcome, 'quest_progress') and outcome.quest_progress)
                    )

                    if character and should_calculate_progression:
                        turn_result_data = {
                            "combat_occurred": combat_occurred,
                            "boss_fight": combat_result.narrative_weight == NarrativeWeight.CLIMACTIC if combat_result else False,
                            "sakuga_moment": combat_result.sakuga_moment if combat_result else use_sakuga,
                            "quest_completed": outcome.quest_progress if hasattr(outcome, 'quest_progress') else False,
                            "significant_roleplay": outcome.narrative_weight in [NarrativeWeight.SIGNIFICANT, NarrativeWeight.CLIMACTIC],
                        }
                        progression_result = await self.progression.calculate_progression(
                            character=character,
                            turn_result=turn_result_data,
                            profile=self.profile
                        )
                        if progression_result.xp_awarded > 0:
                            self.state.apply_progression(progression_result)
                    elif character and not should_calculate_progression:
                        logger.warning("Skipping progression: no XP-worthy events")

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
                                logger.info(f"Batch NPC analysis for {len(npc_lookup)} NPCs")
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
                                            logger.info(f"Disposition threshold crossed: {milestone['event']}")

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
                                        logger.info(f"{rel_result.npc_name}: delta={rel_result.affinity_delta}, milestone={rel_result.emotional_milestone}")

                            except Exception as e:
                                logger.error(f"Batch error: {e}")
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
                            logger.info(f"Auto-resolved seed '{seed_id}': {seed.description}")

                    # #12: Overdue seeds escalate world tension
                    if overdue_seeds:
                        tension_bump = len(overdue_seeds) * 0.05  # +0.05 per overdue seed
                        world = self.state.get_world_state()
                        current_tension = getattr(world, 'tension_level', 0.5) if world else 0.5
                        current_tension = current_tension or 0.5
                        new_tension = min(1.0, current_tension + tension_bump)
                        self.state.update_world_state(tension_level=new_tension)
                        logger.info(f"{len(overdue_seeds)} overdue seeds → tension {current_tension:.2f} → {new_tension:.2f}")

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
                    if combat_occurred and combat_result and combat_result.narrative_weight == NarrativeWeight.CLIMACTIC:
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

                        logger.info(f"HYBRID TRIGGER at turn {db_context.turn_number}: {trigger_reason}")

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

                            logger.info(f"Checkpoint at turn {db_context.turn_number}: {director_output.arc_phase} (tension: {director_output.tension_level:.1f})")

                # END deferred_commit block — single atomic SQL commit here
                # =============================================================
                # 8. MEMORY COMPRESSION (every 10 turns)
                # ChromaDB error recovery (#29): independent try/except
                # =============================================================
                try:
                    if db_context.turn_number > 0 and db_context.turn_number % 10 == 0:
                        compression_result = await self.memory.compress_cold_memories()
                        if compression_result.get("compressed"):
                            logger.info(f"Compressed {compression_result['memories_removed']} memories into {compression_result['summaries_created']} summaries")
                except Exception as e:
                    logger.error(f"Memory compression failed (will retry next cycle): {e}")

                # =============================================================
                # 9. EPISODIC MEMORY
                # ChromaDB error recovery (#29): independent try/except
                # =============================================================
                try:
                    turn_number = db_context.turn_number if hasattr(db_context, 'turn_number') else 0
                    location = db_context.location if hasattr(db_context, 'location') else "Unknown"
                    action_summary = player_input[:150].strip()
                    outcome_summary = narrative[:400].strip().replace('\n', ' ') if narrative else "No outcome"
                    self.memory.add_episode(
                        turn=turn_number,
                        location=location,
                        summary=f"{action_summary} — {outcome_summary}"
                    )
                    logger.info(f"Episodic memory written for turn {turn_number}")
                except Exception as e:
                    logger.error(f"Episodic write failed (idempotent, will retry): {e}")

                bg_elapsed = int((time.time() - bg_start) * 1000)
                logger.info(f"Post-narrative processing complete ({bg_elapsed}ms)")

            except Exception as e:
                logger.error(f"Post-narrative processing FAILED: {e}")
                import traceback
                traceback.print_exc()

    async def _bg_production_check(
        self,
        narrative: str,
        player_input: str,
        intent,
        outcome,
        db_context,
    ):
        """Background ProductionAgent — quest tracking + location discovery + media.
        
        Runs in parallel with entity extraction and relationship analysis.
        Non-fatal: failures are logged and never crash the pipeline.
        """
        try:
            from ..agents.production_agent import ProductionAgent
            from ..agents.production_tools import build_production_tools

            agent = ProductionAgent()

            # Load media settings for conditional tool registration
            media_enabled = False
            media_budget_enabled = False
            media_budget_remaining = None
            style_context = ""
            campaign_id = getattr(self.state, 'campaign_id', None)

            try:
                from src.settings import get_settings_store
                settings = get_settings_store().load()
                media_enabled = getattr(settings, 'media_enabled', False)
                media_budget_enabled = getattr(settings, 'media_budget_enabled', False)

                if media_enabled and media_budget_enabled:
                    budget_cap = getattr(settings, 'media_budget_per_session_usd', 2.0)
                    # Calculate remaining budget from current session spend
                    try:
                        from sqlalchemy import func

                        from ..db.models import MediaAsset
                        db = self.state._get_db()
                        session_spend = db.query(
                            func.coalesce(func.sum(MediaAsset.cost_usd), 0.0)
                        ).filter(
                            MediaAsset.campaign_id == campaign_id,
                        ).scalar()
                        media_budget_remaining = max(0, budget_cap - session_spend)
                    except Exception:
                        media_budget_remaining = budget_cap  # Fall back to full budget

                # Style context from campaign profile
                style_context = getattr(self.profile, 'art_style', '') or getattr(self.profile, 'name', '') or ''

                # Diagnostic logging for media pipeline
                if not media_enabled:
                    logger.info("[Production] media_enabled=False — media tools will not be registered")
                else:
                    google_key = getattr(getattr(settings, 'api_keys', None), 'google_api_key', '')
                    if not google_key:
                        logger.warning("[Production] media_enabled=True but no Google API key configured — generation will fail")
            except Exception:
                pass  # Settings load failure is non-fatal

            tools = build_production_tools(
                state=self.state,
                current_turn=db_context.turn_number,
                media_enabled=media_enabled,
                media_budget_enabled=media_budget_enabled,
                media_budget_remaining=media_budget_remaining,
                campaign_id=campaign_id,
                style_context=style_context,
            )
            agent.set_tools(tools)

            # Pre-format active quests for the agent's context
            active_quests = ""
            try:
                quests = self.state.get_quests(status="active")
                if quests:
                    lines = []
                    for q in quests:
                        obj_lines = []
                        for i, obj in enumerate(q.objectives or []):
                            status = "✓" if obj.get("completed") else "○"
                            obj_lines.append(f"  {status} [{i}] {obj.get('description', '???')}")
                        objectives_text = "\n".join(obj_lines) if obj_lines else "  (no sub-objectives)"
                        lines.append(f"Quest #{q.id} \"{q.title}\"\n{objectives_text}")
                    active_quests = "\n\n".join(lines)
            except Exception:
                active_quests = "(error loading quests)"

            # Summarize intent/outcome for the agent
            intent_summary = f"{intent.intent}: {intent.action}" if intent else "(unknown)"
            outcome_summary = (
                f"{outcome.consequence or 'No consequence'} "
                f"(weight: {outcome.narrative_weight})"
            ) if outcome else "(unknown)"

            # Pacing note if available
            pacing_note = ""
            if hasattr(db_context, 'pacing_directive') and db_context.pacing_directive:
                pd = db_context.pacing_directive
                pacing_note = getattr(pd, 'pacing_note', '') or ''

            await agent.react(
                narrative=narrative,
                player_input=player_input,
                intent_summary=intent_summary,
                outcome_summary=outcome_summary,
                active_quests=active_quests,
                pacing_note=pacing_note,
                situation=db_context.situation or "",
                current_location=db_context.location or "",
            )
            logger.info("Post-narrative check complete")
        except Exception as e:
            logger.error(f"Failed (non-fatal): {e}")

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
                    interaction_count = self.state.get_npc_interaction_count(npc.id)
                    evolution = self.state.evolve_npc_intelligence(npc.id, interaction_count)
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
                            logger.info(f"Stored narrative beat: {beat_text}")
        except Exception as e:
            logger.error(f"Intelligence check failed (non-fatal): {e}")

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
                # Apply new entities + enrich existing NPCs
                if entity.is_new or entity.entity_type == "npc":
                    await self._apply_world_building_entity(entity, turn_number)
            if dm_entities.entities:
                logger.info(f"Extracted {len(dm_entities.entities)} entities from narrative")
        except Exception as e:
            logger.error(f"Entity extraction failed: {e}")

    async def _extract_narrative_beats(self, narrative: str, turn_number: int):
        """Extract narrative beats from DM narrative and index to ChromaDB.
        
        Identifies emotionally significant moments, character revelations,
        and world-changing events. Also classifies each beat as plot-critical
        or not (PLAN #6: auto-detect plot-critical memories).
        """
        try:

            from pydantic import BaseModel, Field

            from ..llm import get_llm_manager

            class NarrativeBeat(BaseModel):
                description: str = Field(description="One-sentence summary of the beat")
                npcs: list[str] = Field(default_factory=list, description="NPC names involved")
                location: str = Field(default="", description="Where this happened")
                is_plot_critical: bool = Field(
                    default=False,
                    description="True if losing this memory would break narrative continuity"
                )

            class NarrativeBeatsOutput(BaseModel):
                beats: list[NarrativeBeat] = Field(
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
                    logger.error(f"Narrative beat write failed: {e}")

            critical_count = sum(1 for b in result.beats if b.is_plot_critical)
            logger.info(
                f"[Background] Extracted {len(result.beats)} narrative beats "
                f"({critical_count} plot-critical) from turn {turn_number}"
            )
        except Exception as e:
            logger.error(f"Narrative beat extraction failed (non-fatal): {e}")

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
                    logger.info(f"Relationship analysis: {len(rel_results)} NPCs updated")
        except Exception as e:
            logger.error(f"Relationship analysis failed (non-fatal): {e}")

    async def _apply_world_building_entity(self, entity, turn_number: int = 0):
        """Apply a world-building entity to game state.
        
        Creates NPCs, adds items to inventory, indexes locations/events to memory.
        
        Args:
            entity: WorldBuildingEntity from WorldBuilderAgent
            turn_number: Current turn number for memory indexing
        """

        if entity.entity_type == "npc":
            # Extract structured NPC data (prefer npc_details, fall back to details dict)
            npc_data = entity.npc_details
            details = entity.details or {}

            role = (npc_data.role if npc_data else details.get("role")) or "acquaintance"
            personality = (npc_data.personality if npc_data else details.get("personality")) or None
            goals = (npc_data.goals if npc_data else details.get("goals")) or None
            secrets = (npc_data.secrets if npc_data else details.get("secrets")) or None
            faction = (npc_data.faction if npc_data else details.get("faction")) or None
            visual_tags = (npc_data.visual_tags if npc_data else details.get("visual_tags")) or None
            knowledge_topics = (npc_data.knowledge_topics if npc_data else details.get("knowledge_topics")) or None
            power_tier = (npc_data.power_tier if npc_data else details.get("power_tier")) or None
            ensemble_archetype = (npc_data.ensemble_archetype if npc_data else details.get("ensemble_archetype")) or None

            # Create or enrich NPC via upsert
            try:
                self.state.upsert_npc(
                    name=entity.name,
                    role=role,
                    relationship_notes=entity.implied_backstory,
                    personality=personality,
                    goals=goals,
                    secrets=secrets,
                    faction=faction,
                    visual_tags=visual_tags,
                    knowledge_topics=knowledge_topics,
                    power_tier=power_tier,
                    ensemble_archetype=ensemble_archetype,
                )
            except Exception as e:
                logger.error(f"Failed to upsert NPC {entity.name}: {e}")

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
                logger.info(f"Added item: {entity.name}")
            except Exception as e:
                logger.error(f"Failed to add item {entity.name}: {e}")

            # Index to memory
            self.memory.add_memory(
                content=f"Item: {entity.name} - {entity.implied_backstory or 'No history.'}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "item"]
            )

        elif entity.entity_type == "location":
            # 1. Create/update Location in SQLite database
            try:
                self.state.upsert_location(
                    name=entity.name,
                    description=entity.details.get('description', entity.implied_backstory or ''),
                    location_type=entity.details.get('type', entity.details.get('location_type')),
                    atmosphere=entity.details.get('atmosphere'),
                )
                logger.info(f"Upserted location in DB: {entity.name}")
            except Exception as e:
                logger.error(f"Location DB upsert failed: {e}")

            # 2. Index to ChromaDB memory
            self.memory.add_memory(
                content=f"Location: {entity.name} - {entity.details.get('description', '')} {entity.implied_backstory or ''}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "location"]
            )
            logger.info(f"Indexed location: {entity.name}")

        elif entity.entity_type == "faction":
            # 1. Create faction in SQLite database
            try:
                self.state.create_faction(
                    name=entity.name,
                    description=entity.details.get('description', entity.implied_backstory or ''),
                    pc_controls=False
                )
                logger.info(f"Created faction in DB: {entity.name}")
            except Exception as e:
                logger.error(f"Faction DB creation failed: {e}")

            # 2. Index faction to ChromaDB memory
            self.memory.add_memory(
                content=f"Faction: {entity.name} - {entity.details.get('description', '')} {entity.implied_backstory or ''}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "faction"]
            )
            logger.info(f"Indexed faction: {entity.name}")

        elif entity.entity_type == "event":
            # Past events are indexed as backstory
            self.memory.add_memory(
                content=f"Past Event: {entity.name} - {entity.implied_backstory or entity.details.get('description', '')}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "backstory", "event"]
            )
            logger.info(f"Indexed event: {entity.name}")

        elif entity.entity_type == "relationship":
            # Relationships modify NPC or are indexed
            self.memory.add_memory(
                content=f"Relationship: {entity.name} - {entity.implied_backstory or entity.details.get('description', '')}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "relationship"]
            )
            logger.info(f"Indexed relationship: {entity.name}")

        elif entity.entity_type == "ability":
            # Abilities mentioned but not in list - flag for later
            self.memory.add_memory(
                content=f"Referenced Ability: {entity.name} - {entity.implied_backstory or 'Player referenced this ability.'}",
                memory_type="fact",
                turn_number=turn_number,
                flags=["world_building", "ability", "unverified"]
            )
            logger.info(f"Indexed ability reference: {entity.name}")
