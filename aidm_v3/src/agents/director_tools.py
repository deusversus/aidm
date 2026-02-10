"""
Director-specific investigation tools for agentic arc planning.

These tools enable the Director to investigate NPC trajectories,
foreshadowing seeds, and story state before making arc decisions.
Extends the shared gameplay tools with Director-only capabilities.
"""

from typing import Any, Dict, List, Optional

from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry
from .gameplay_tools import build_gameplay_tools


def build_director_tools(
    memory: Any,         # MemoryStore
    state: Any,          # StateManager
    foreshadowing: Any,  # ForeshadowingLedger
    current_turn: int,
    session_transcript: list = None,
) -> ToolRegistry:
    """Build tools for Director investigation phase.
    
    Includes all shared gameplay tools PLUS Director-specific tools for
    foreshadowing, NPC trajectories, and spotlight analysis.
    
    Args:
        memory: MemoryStore instance
        state: StateManager instance
        foreshadowing: ForeshadowingLedger instance
        current_turn: Current turn number (for foreshadowing timing)
        session_transcript: Recent messages
        
    Returns:
        ToolRegistry with gameplay + director tools
    """
    # Start with the shared gameplay tools
    registry = build_gameplay_tools(
        memory=memory,
        state=state,
        session_transcript=session_transcript,
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
    
    return registry


# =========================================================================
# Director Tool Handlers
# =========================================================================

def _get_active_foreshadowing(foreshadowing, current_turn: int) -> Dict:
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


def _get_overdue_seeds(foreshadowing, current_turn: int) -> List[Dict]:
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


def _get_spotlight_analysis(state) -> Dict:
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
            "intelligence": npc.intelligence_stage or "reactive",
        })
    
    # Sort by spotlight debt (most underserved first)
    npc_summaries.sort(key=lambda n: n["spotlight_debt"], reverse=True)
    
    return {
        "total_npcs": len(npc_summaries),
        "underserved": [n["name"] for n in npc_summaries if n["spotlight_debt"] > 2],
        "overexposed": [n["name"] for n in npc_summaries if n["spotlight_debt"] < -2],
        "npcs": npc_summaries,
    }


def _get_npc_trajectory(state, name: str) -> Dict:
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
        "intelligence_stage": npc.intelligence_stage or "reactive",
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


def _get_campaign_bible(state) -> Dict:
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
