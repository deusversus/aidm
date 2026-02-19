"""
Director-specific investigation tools for agentic arc planning.

These tools enable the Director to investigate NPC trajectories,
foreshadowing seeds, and story state before making arc decisions.
Extends the shared gameplay tools with Director-only capabilities.
"""

import logging
from typing import Any

from ..enums import NPCIntelligenceStage
from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry
from .gameplay_tools import build_gameplay_tools

logger = logging.getLogger(__name__)

def build_director_tools(
    memory: Any,         # MemoryStore
    state: Any,          # StateManager
    foreshadowing: Any,  # ForeshadowingLedger
    current_turn: int,
    session_number: int = 1,
    session_transcript: list = None,
    profile_library: Any = None,  # ProfileLibrary (for lore search)
    profile_ids: list[str] = None, # Active profile IDs (for lore search)
) -> ToolRegistry:
    """Build tools for Director investigation phase.
    
    Includes all shared gameplay tools PLUS Director-specific tools for
    foreshadowing, NPC trajectories, and spotlight analysis.
    
    Args:
        memory: MemoryStore instance
        state: StateManager instance
        foreshadowing: ForeshadowingLedger instance
        current_turn: Current turn number (for foreshadowing timing)
        session_number: Current session number (for seed planting)
        session_transcript: Recent messages
        profile_library: ProfileLibrary instance for lore search (optional)
        profile_ids: Active profile ID(s) for scoping lore search (optional, list)
        
    Returns:
        ToolRegistry with gameplay + director tools
    """
    # Start with the shared gameplay tools
    registry = build_gameplay_tools(
        memory=memory,
        state=state,
        session_transcript=session_transcript,
        profile_library=profile_library,
        profile_ids=profile_ids,
    )

    # -----------------------------------------------------------------
    # FORESHADOWING TOOLS
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="get_active_foreshadowing",
        description=(
            "Get all active (unresolved) foreshadowing seeds. "
            "Shows seeds that have been planted but not yet paid off. "
            "Includes callback-ready and overdue seeds."
        ),
        parameters=[],
        handler=lambda: _get_active_foreshadowing(foreshadowing, current_turn)
    ))

    registry.register(ToolDefinition(
        name="get_overdue_seeds",
        description=(
            "Get foreshadowing seeds that are PAST their maximum payoff window. "
            "These should be resolved, escalated, or explicitly abandoned."
        ),
        parameters=[],
        handler=lambda: _get_overdue_seeds(foreshadowing, current_turn)
    ))

    registry.register(ToolDefinition(
        name="plant_foreshadowing_seed",
        description=(
            "Plant a new foreshadowing seed for future payoff. Use this to set up "
            "mysteries, character reveals, threats, promises, or Chekhov's guns. "
            "Seeds will be tracked and surfaced to the KeyAnimator when ready for callback."
        ),
        parameters=[
            ToolParam("seed_type", "str", "Type: plot, character, mystery, threat, promise, chekhov, relationship", required=True),
            ToolParam("description", "str", "What this seed sets up (for tracking)", required=True),
            ToolParam("planted_narrative", "str", "How it was introduced in the story", required=True),
            ToolParam("expected_payoff", "str", "How this should pay off later", required=True),
            ToolParam("tags", "str", "Comma-separated keywords for narrative detection", required=False),
            ToolParam("related_npcs", "str", "Comma-separated NPC names involved", required=False),
            ToolParam("min_payoff_turns", "int", "Minimum turns before payoff (default 5)", required=False),
            ToolParam("max_payoff_turns", "int", "Maximum turns before overdue (default 50)", required=False),
        ],
        handler=lambda **kwargs: _plant_seed(foreshadowing, current_turn, session_number, **kwargs)
    ))

    # -----------------------------------------------------------------
    # NPC TRAJECTORY TOOLS
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="get_spotlight_analysis",
        description=(
            "Analyze NPC screen time balance. Shows which NPCs are over-exposed "
            "vs. underserved, their current relationship state, and growth stage."
        ),
        parameters=[],
        handler=lambda: _get_spotlight_analysis(state)
    ))

    registry.register(ToolDefinition(
        name="get_npc_trajectory",
        description=(
            "Get a specific NPC's full trajectory: relationship history, "
            "emotional milestones, growth stage, and intelligence evolution. "
            "Use this to plan an NPC's next story beat."
        ),
        parameters=[
            ToolParam("name", "str", "NPC name to analyze", required=True),
        ],
        handler=lambda name: _get_npc_trajectory(state, name)
    ))

    # -----------------------------------------------------------------
    # MEMORY TOOLS
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="mark_memory_critical",
        description=(
            "Mark a memory as plot-critical so it never decays. "
            "Use this for key revelations, betrayals, character-defining moments, "
            "or any narrative beat that should be permanently retrievable. "
            "Searches for the best-matching memory and flags it."
        ),
        parameters=[
            ToolParam("query", "str", "Search term to find the memory to flag (be specific)", required=True),
            ToolParam("reason", "str", "Why this memory is plot-critical (for audit trail)", required=True),
        ],
        handler=lambda **kwargs: _mark_memory_critical(memory, **kwargs)
    ))

    # -----------------------------------------------------------------
    # ARC HISTORY
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="get_campaign_bible",
        description=(
            "Get the Director's private planning document. Contains: "
            "previous arc decisions, planned foreshadowing, NPC notes, "
            "and the last Director checkpoint."
        ),
        parameters=[],
        handler=lambda: _get_campaign_bible(state)
    ))

    # -----------------------------------------------------------------
    # QUEST MANAGEMENT TOOLS (Phase 2A)
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="create_quest",
        description=(
            "Create a new quest/objective for the player. Use this when establishing "
            "new storylines, side quests, or campaign objectives. Quests are persisted "
            "in the database and tracked across sessions."
        ),
        parameters=[
            ToolParam("title", "str", "Quest title (concise, evocative)", required=True),
            ToolParam("description", "str", "Quest description (what the player needs to do)", required=True),
            ToolParam("quest_type", "str", "Type: main, side, personal, faction (default: main)", required=False),
            ToolParam("objectives", "str", "Pipe-separated list of sub-objectives, e.g. 'Find the key|Open the gate|Defeat the guardian'", required=False),
            ToolParam("related_npcs", "str", "Comma-separated NPC names involved", required=False),
            ToolParam("related_locations", "str", "Comma-separated location names", required=False),
        ],
        handler=lambda **kwargs: _create_quest(state, current_turn, **kwargs)
    ))

    registry.register(ToolDefinition(
        name="update_quest_status",
        description=(
            "Update a quest's status. Use 'completed' for successful quests, "
            "'failed' for failed ones, 'abandoned' for dropped storylines."
        ),
        parameters=[
            ToolParam("quest_id", "int", "Quest ID to update", required=True),
            ToolParam("status", "str", "New status: active, completed, failed, abandoned", required=True),
        ],
        handler=lambda **kwargs: _update_quest_status(state, **kwargs)
    ))

    registry.register(ToolDefinition(
        name="complete_quest_objective",
        description=(
            "Mark a specific objective within a quest as complete. "
            "Use the objective index (0-based) to target the right sub-objective."
        ),
        parameters=[
            ToolParam("quest_id", "int", "Quest ID containing the objective", required=True),
            ToolParam("objective_index", "int", "Index of objective to mark complete (0-based)", required=True),
        ],
        handler=lambda **kwargs: _complete_quest_objective(state, **kwargs)
    ))

    return registry


# =========================================================================
# Director Tool Handlers
# =========================================================================

def _get_active_foreshadowing(foreshadowing, current_turn: int) -> dict:
    """Get active foreshadowing with status analysis."""
    active = foreshadowing.get_active_seeds()
    callback_ready = foreshadowing.get_callback_opportunities(current_turn)
    overdue = foreshadowing.get_overdue_seeds(current_turn)

    if not active:
        return {"info": "No active foreshadowing seeds", "total": 0}

    seeds = []
    for seed in active:
        status = "active"
        if any(s.id == seed.id for s in overdue):
            status = "OVERDUE"
        elif any(s.id == seed.id for s in callback_ready):
            status = "CALLBACK_READY"

        seeds.append({
            "id": seed.id,
            "type": seed.seed_type.value if hasattr(seed.seed_type, 'value') else str(seed.seed_type),
            "description": seed.description,
            "planted_turn": seed.planted_turn,
            "expected_payoff": seed.expected_payoff,
            "status": status,
            "mentions": seed.mention_count if hasattr(seed, 'mention_count') else 0,
            "related_npcs": seed.related_npcs or [],
        })

    return {
        "total": len(seeds),
        "callback_ready": len(callback_ready),
        "overdue": len(overdue),
        "seeds": seeds,
    }


def _get_overdue_seeds(foreshadowing, current_turn: int) -> list[dict]:
    """Get specifically overdue seeds for urgent resolution."""
    overdue = foreshadowing.get_overdue_seeds(current_turn)
    if not overdue:
        return [{"info": "No overdue seeds — all foreshadowing is on schedule"}]

    return [
        {
            "id": s.id,
            "description": s.description,
            "planted_turn": s.planted_turn,
            "turns_overdue": current_turn - (s.planted_turn + (s.max_payoff_turns if hasattr(s, 'max_payoff_turns') else 50)),
            "expected_payoff": s.expected_payoff,
            "related_npcs": s.related_npcs or [],
        }
        for s in overdue
    ]


def _plant_seed(foreshadowing, current_turn: int, session_number: int, **kwargs) -> dict:
    """Plant a new foreshadowing seed via Director tool call."""
    from ..core.foreshadowing import SeedType

    # Parse seed_type string to enum
    seed_type_str = kwargs.get("seed_type", "plot").lower().strip()
    try:
        seed_type = SeedType(seed_type_str)
    except ValueError:
        return {"error": f"Invalid seed_type '{seed_type_str}'. Valid: plot, character, mystery, threat, promise, chekhov, relationship"}

    # Parse comma-separated lists
    tags = [t.strip() for t in kwargs.get("tags", "").split(",") if t.strip()] if kwargs.get("tags") else []
    related_npcs = [n.strip() for n in kwargs.get("related_npcs", "").split(",") if n.strip()] if kwargs.get("related_npcs") else []

    # Parse payoff windows
    min_payoff = int(kwargs.get("min_payoff_turns", 5))
    max_payoff = int(kwargs.get("max_payoff_turns", 50))

    seed_id = foreshadowing.plant_seed(
        seed_type=seed_type,
        description=kwargs["description"],
        planted_narrative=kwargs["planted_narrative"],
        expected_payoff=kwargs["expected_payoff"],
        turn_number=current_turn,
        session_number=session_number,
        tags=tags,
        related_npcs=related_npcs,
        min_payoff=min_payoff,
        max_payoff=max_payoff,
    )

    logger.info(f"Seed planted: {seed_id} ({seed_type_str}) — {kwargs['description'][:60]}")

    return {
        "planted": True,
        "seed_id": seed_id,
        "type": seed_type_str,
        "description": kwargs["description"],
        "min_payoff_turns": min_payoff,
        "max_payoff_turns": max_payoff,
    }

def _mark_memory_critical(memory, **kwargs) -> dict:
    """Mark a memory as plot-critical via search + flag."""
    query = kwargs.get("query", "")
    reason = kwargs.get("reason", "")

    if not query:
        return {"error": "query parameter is required"}

    try:
        # Search for the best matching memory
        results = memory.search(query, top_k=1)
        if not results:
            return {"error": f"No memories found matching '{query}'", "flagged": False}

        best = results[0]
        memory_id = best.get("id", "")
        content_preview = best.get("content", "")[:200]

        # Flag as plot-critical
        memory.mark_plot_critical(memory_id)

        logger.info(f"Marked memory as plot-critical: {content_preview[:80]}... (reason: {reason})")
        return {
            "flagged": True,
            "memory_id": memory_id,
            "content_preview": content_preview,
            "reason": reason,
        }
    except Exception as e:
        return {"error": f"Failed to mark memory: {str(e)}", "flagged": False}


def _get_spotlight_analysis(state) -> dict:
    """Combined spotlight debt and NPC relationship overview."""
    npcs = state.get_all_npcs()
    if not npcs:
        return {"info": "No NPCs in campaign", "total": 0}

    spotlight_debt = state.compute_spotlight_debt()

    npc_summaries = []
    for npc in npcs:
        disp = npc.disposition or 0
        if disp >= 60: disp_label = "positive"
        elif disp >= -20: disp_label = "neutral"
        else: disp_label = "negative"

        debt = spotlight_debt.get(npc.name, 0)

        npc_summaries.append({
            "name": npc.name,
            "role": npc.role or "unknown",
            "disposition": disp_label,
            "affinity": npc.affinity or 0,
            "scene_count": npc.scene_count or 0,
            "spotlight_debt": debt,
            "needs_attention": debt > 2,
            "growth_stage": npc.growth_stage or "introduction",
            "intelligence": npc.intelligence_stage or NPCIntelligenceStage.REACTIVE,
        })

    # Sort by spotlight debt (most underserved first)
    npc_summaries.sort(key=lambda n: n["spotlight_debt"], reverse=True)

    return {
        "total_npcs": len(npc_summaries),
        "underserved": [n["name"] for n in npc_summaries if n["spotlight_debt"] > 2],
        "overexposed": [n["name"] for n in npc_summaries if n["spotlight_debt"] < -2],
        "npcs": npc_summaries,
    }


def _get_npc_trajectory(state, name: str) -> dict:
    """Full NPC trajectory for arc planning."""
    npc = state.get_npc_by_name(name)
    if not npc:
        return {"error": f"No NPC found matching '{name}'"}

    return {
        "name": npc.name,
        "role": npc.role or "unknown",
        "faction": npc.faction,
        "affinity": npc.affinity or 0,
        "disposition": npc.disposition or 0,
        "personality": npc.personality,
        "goals": npc.goals or [],
        "secrets": npc.secrets or [],
        "emotional_milestones": npc.emotional_milestones or {},
        "ensemble_archetype": npc.ensemble_archetype,
        "growth_stage": npc.growth_stage or "introduction",
        "narrative_role": npc.narrative_role,
        "intelligence_stage": npc.intelligence_stage or NPCIntelligenceStage.REACTIVE,
        "interaction_count": npc.interaction_count or 0,
        "scene_count": npc.scene_count or 0,
        "last_appeared": npc.last_appeared,
        # Trajectory hints
        "next_growth_stage": _next_growth(npc.growth_stage),
        "next_intelligence": _next_intelligence(npc.intelligence_stage, npc.interaction_count or 0),
    }


def _next_growth(current: str) -> str:
    """Predict next growth stage."""
    progression = ["introduction", "bonding", "challenge", "growth", "mastery"]
    try:
        idx = progression.index(current or "introduction")
        if idx < len(progression) - 1:
            return progression[idx + 1]
        return "mastery (complete)"
    except ValueError:
        return "unknown"


def _next_intelligence(current: str, interactions: int) -> str:
    """Predict next intelligence stage."""
    stages = {
        "reactive": ("contextual", 5),
        "contextual": ("anticipatory", 10),
        "anticipatory": ("autonomous", 20),
        "autonomous": ("autonomous (max)", 999),
    }
    current = current or "reactive"
    if current in stages:
        next_stage, threshold = stages[current]
        remaining = max(0, threshold - interactions)
        return f"{next_stage} (in ~{remaining} interactions)"
    return "unknown"


def _get_campaign_bible(state) -> dict:
    """Get the campaign bible contents."""
    bible = state.get_campaign_bible()
    if not bible:
        return {"info": "No campaign bible yet — this is the first Director pass"}

    planning = bible.planning_data or {}
    return {
        "last_updated_turn": bible.last_updated_turn,
        "current_arc": planning.get("current_arc", "Unknown"),
        "arc_phase": planning.get("arc_phase", "unknown"),
        "tension_level": planning.get("tension_level", 0.5),
        "foreshadowing_seeds": planning.get("foreshadowing_seeds", []),
        "npc_notes": planning.get("npc_development_notes", ""),
        "pacing_notes": planning.get("pacing_adjustment", ""),
        "spotlight_debt": planning.get("spotlight_debt", {}),
    }


# =========================================================================
# Quest Tool Handlers (Phase 2A)
# =========================================================================

def _create_quest(state, current_turn: int, **kwargs) -> dict:
    """Create a new quest via Director tool call."""
    title = kwargs.get("title", "")
    if not title:
        return {"error": "title is required"}

    # Parse pipe-separated objectives
    objectives = []
    if kwargs.get("objectives"):
        for desc in kwargs["objectives"].split("|"):
            desc = desc.strip()
            if desc:
                objectives.append({"description": desc, "completed": False})

    # Parse comma-separated lists
    related_npcs = [n.strip() for n in kwargs.get("related_npcs", "").split(",") if n.strip()] if kwargs.get("related_npcs") else []
    related_locations = [l.strip() for l in kwargs.get("related_locations", "").split(",") if l.strip()] if kwargs.get("related_locations") else []

    quest = state.create_quest(
        title=title,
        description=kwargs.get("description", ""),
        quest_type=kwargs.get("quest_type", "main"),
        source="director",
        objectives=objectives,
        related_npcs=related_npcs,
        related_locations=related_locations,
        created_turn=current_turn,
    )

    logger.info(f"Quest created: {quest.title} (ID {quest.id}, type={quest.quest_type})")
    return {
        "created": True,
        "quest_id": quest.id,
        "title": quest.title,
        "objectives_count": len(objectives),
    }


def _update_quest_status(state, **kwargs) -> dict:
    """Update quest status via Director tool call."""
    quest_id = int(kwargs.get("quest_id", 0))
    status = kwargs.get("status", "")

    if not quest_id or not status:
        return {"error": "quest_id and status are required"}
    if status not in ("active", "completed", "failed", "abandoned"):
        return {"error": f"Invalid status '{status}'. Valid: active, completed, failed, abandoned"}

    quest = state.update_quest_status(quest_id, status)
    if not quest:
        return {"error": f"Quest {quest_id} not found"}

    logger.info(f"Quest {quest_id} status → {status}: {quest.title}")
    return {"updated": True, "quest_id": quest_id, "status": status, "title": quest.title}


def _complete_quest_objective(state, **kwargs) -> dict:
    """Mark a quest objective as complete."""
    quest_id = int(kwargs.get("quest_id", 0))
    objective_index = int(kwargs.get("objective_index", 0))

    if not quest_id:
        return {"error": "quest_id is required"}

    quest = state.update_quest_objective(quest_id, objective_index)
    if not quest:
        return {"error": f"Quest {quest_id} not found or objective index out of range"}

    logger.info(f"Quest {quest_id} objective {objective_index} completed")
    return {"completed": True, "quest_id": quest_id, "objective_index": objective_index}
