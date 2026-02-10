"""
Shared gameplay tools for agentic AIDM agents.

Builds a ToolRegistry containing tools that wrap existing MemoryStore and
StateManager methods. Used by KeyAnimator, Director, and any other agent
that needs to research game state during its generation phase.

Usage:
    from src.agents.gameplay_tools import build_gameplay_tools
    tools = build_gameplay_tools(memory=memory, state=state, transcript=messages)
    response = await provider.complete_with_tools(messages, tools, ...)
"""

import json
from typing import Any, Dict, List, Optional

from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry


def build_gameplay_tools(
    memory: Any,         # MemoryStore
    state: Any,          # StateManager
    session_transcript: list = None,
) -> ToolRegistry:
    """Build the standard tool registry for gameplay agents.
    
    Args:
        memory: MemoryStore instance (ChromaDB)
        state: StateManager instance (SQLite)
        session_transcript: Recent messages for transcript search
        
    Returns:
        ToolRegistry populated with gameplay tools
    """
    registry = ToolRegistry()
    
    # -----------------------------------------------------------------
    # MEMORY TOOLS
    # -----------------------------------------------------------------
    
    registry.register(ToolDefinition(
        name="search_memory",
        description=(
            "Search long-term memory (ChromaDB) for relevant memories. "
            "Use specific, targeted queries like 'Belial holo-message' or "
            "'protagonist training with mentor'. Avoid broad queries."
        ),
        parameters=[
            ToolParam("query", "str", "The search query — be specific", required=True),
            ToolParam("limit", "int", "Max results to return (default 5)", required=False),
        ],
        handler=lambda query, limit=5: _search_memory(memory, query, limit)
    ))
    
    registry.register(ToolDefinition(
        name="get_critical_memories",
        description=(
            "Get ALL plot-critical and session-zero memories. "
            "These NEVER decay and contain canonical character facts, backstory, "
            "and player preferences established during Session Zero. "
            "ALWAYS call this to ground yourself in established facts."
        ),
        parameters=[],
        handler=lambda: _get_critical_memories(memory)
    ))
    
    registry.register(ToolDefinition(
        name="get_recent_episodes",
        description=(
            "Get the most recent episodic summaries (per-turn log). "
            "These give you a timeline of what just happened."
        ),
        parameters=[
            ToolParam("count", "int", "Number of episodes to retrieve (default 5)", required=False),
        ],
        handler=lambda count=5: _get_recent_episodes(memory, count)
    ))
    
    # -----------------------------------------------------------------
    # NPC TOOLS  
    # -----------------------------------------------------------------
    
    registry.register(ToolDefinition(
        name="get_npc_details",
        description=(
            "Get full details for an NPC by name. Returns: name, role, affinity, "
            "disposition, personality, emotional milestones, intelligence stage, "
            "relationship notes, scene count, goals, and secrets."
        ),
        parameters=[
            ToolParam("name", "str", "NPC name (fuzzy match supported)", required=True),
        ],
        handler=lambda name: _get_npc_details(state, name)
    ))
    
    registry.register(ToolDefinition(
        name="list_known_npcs",
        description=(
            "List ALL NPCs in the campaign with basic info: name, role, "
            "affinity, disposition label, scene count, and last appeared turn."
        ),
        parameters=[],
        handler=lambda: _list_known_npcs(state)
    ))
    
    # -----------------------------------------------------------------
    # TRANSCRIPT TOOLS
    # -----------------------------------------------------------------
    
    registry.register(ToolDefinition(
        name="search_transcript",
        description=(
            "Search the current session transcript for exact phrases or topics. "
            "Returns matching messages with speaker (PLAYER or DM) and content. "
            "Use this to find what the PLAYER actually said about something."
        ),
        parameters=[
            ToolParam("query", "str", "Search term to look for in the transcript", required=True),
        ],
        handler=lambda query: _search_transcript(session_transcript, query)
    ))
    
    # -----------------------------------------------------------------
    # WORLD STATE TOOLS
    # -----------------------------------------------------------------
    
    registry.register(ToolDefinition(
        name="get_world_state",
        description=(
            "Get the current world state: location, situation, arc phase, "
            "tension level, arc name, canonicality settings."
        ),
        parameters=[],
        handler=lambda: _get_world_state(state)
    ))
    
    registry.register(ToolDefinition(
        name="get_character_sheet",
        description=(
            "Get the player character's full stats, level, abilities, "
            "inventory, personality traits, goals, and OP mode status."
        ),
        parameters=[],
        handler=lambda: _get_character_sheet(state)
    ))
    
    return registry


# =========================================================================
# Tool Handler Implementations
# =========================================================================

def _search_memory(memory, query: str, limit: int = 5) -> List[Dict]:
    """Search ChromaDB for memories matching the query."""
    results = memory.search(query=query, limit=limit, boost_on_access=False)
    # Simplify for LLM consumption
    return [
        {
            "content": m["content"],
            "type": m["metadata"].get("type", "unknown"),
            "heat": round(m["heat"], 1),
            "score": round(m.get("score", 0), 3),
            "flags": m["metadata"].get("flags", ""),
            "turn": m["metadata"].get("turn", "?"),
        }
        for m in results
    ]


def _get_critical_memories(memory) -> List[Dict]:
    """Get all memories with plot_critical or session_zero flags."""
    try:
        all_results = memory.collection.get(
            include=["documents", "metadatas"]
        )
    except Exception:
        return [{"error": "Could not access memory store"}]
    
    if not all_results["ids"]:
        return []
    
    critical = []
    for i, mem_id in enumerate(all_results["ids"]):
        metadata = all_results["metadatas"][i]
        flags_str = metadata.get("flags", "")
        
        if "plot_critical" in flags_str or "session_zero" in flags_str:
            critical.append({
                "content": all_results["documents"][i],
                "type": metadata.get("type", "unknown"),
                "flags": flags_str,
                "turn": metadata.get("turn", "?"),
            })
    
    return critical


def _get_recent_episodes(memory, count: int = 5) -> List[Dict]:
    """Get the N most recent episodic memories."""
    try:
        all_results = memory.collection.get(
            include=["documents", "metadatas"]
        )
    except Exception:
        return [{"error": "Could not access memory store"}]
    
    if not all_results["ids"]:
        return []
    
    episodes = []
    for i, mem_id in enumerate(all_results["ids"]):
        metadata = all_results["metadatas"][i]
        if metadata.get("type") == "episode":
            turn = int(metadata.get("turn", 0))
            episodes.append({
                "content": all_results["documents"][i],
                "turn": turn,
                "location": metadata.get("location", "unknown"),
            })
    
    # Sort by turn number descending (most recent first)
    episodes.sort(key=lambda e: e["turn"], reverse=True)
    return episodes[:count]


def _get_npc_details(state, name: str) -> Dict:
    """Get full NPC card as a dict."""
    npc = state.get_npc_by_name(name)
    if not npc:
        return {"error": f"No NPC found matching '{name}'"}
    
    # Disposition label
    disp = npc.disposition or 0
    if disp >= 90: disp_label = "devoted"
    elif disp >= 60: disp_label = "trusted"
    elif disp >= 30: disp_label = "friendly"
    elif disp >= -20: disp_label = "neutral"
    elif disp >= -60: disp_label = "unfriendly"
    else: disp_label = "hostile"
    
    return {
        "name": npc.name,
        "role": npc.role or "unknown",
        "affinity": npc.affinity or 0,
        "disposition": disp,
        "disposition_label": disp_label,
        "personality": npc.personality or "Unknown",
        "intelligence_stage": npc.intelligence_stage or "reactive",
        "relationship_notes": npc.relationship_notes or "",
        "emotional_milestones": npc.emotional_milestones or {},
        "goals": npc.goals or [],
        "secrets": npc.secrets or [],
        "scene_count": npc.scene_count or 0,
        "last_appeared": npc.last_appeared,
        "interaction_count": npc.interaction_count or 0,
        "faction": npc.faction,
        "ensemble_archetype": npc.ensemble_archetype,
        "growth_stage": npc.growth_stage,
    }


def _list_known_npcs(state) -> List[Dict]:
    """List all NPCs with basic info."""
    npcs = state.get_all_npcs()
    if not npcs:
        return [{"info": "No NPCs in campaign yet"}]
    
    result = []
    for npc in npcs:
        disp = npc.disposition or 0
        if disp >= 60: disp_label = "positive"
        elif disp >= -20: disp_label = "neutral" 
        else: disp_label = "negative"
        
        result.append({
            "name": npc.name,
            "role": npc.role or "unknown",
            "affinity": npc.affinity or 0,
            "disposition_label": disp_label,
            "scene_count": npc.scene_count or 0,
            "last_appeared": npc.last_appeared,
            "intelligence": npc.intelligence_stage or "reactive",
        })
    
    return result


def _search_transcript(transcript: list, query: str) -> List[Dict]:
    """Simple keyword search on the session transcript."""
    if not transcript:
        return [{"info": "No transcript available for this session"}]
    
    query_lower = query.lower()
    matches = []
    for msg in transcript:
        content = msg.get("content", "")
        if query_lower in content.lower():
            role = "PLAYER" if msg.get("role") == "user" else "DM"
            matches.append({
                "speaker": role,
                "excerpt": content[:500],
            })
    
    if not matches:
        return [{"info": f"No transcript matches for '{query}'"}]
    
    return matches[:10]  # Cap at 10 results


def _get_world_state(state) -> Dict:
    """Get current world state as a dict."""
    ws = state.get_world_state()
    if not ws:
        return {"error": "No world state found"}
    
    return {
        "location": ws.location or "Unknown",
        "time_of_day": ws.time_of_day or "Unknown",
        "situation": ws.situation or "No current situation",
        "arc_name": ws.arc_name or "None",
        "arc_phase": ws.arc_phase or "rising_action",
        "tension_level": ws.tension_level or 0.5,
        "timeline_mode": ws.timeline_mode,
        "canon_cast_mode": ws.canon_cast_mode,
        "event_fidelity": ws.event_fidelity,
    }


def _get_character_sheet(state) -> Dict:
    """Get player character sheet as a dict."""
    char = state.get_character()
    if not char:
        return {"error": "No player character found"}
    
    return {
        "name": char.name,
        "level": char.level,
        "class": char.character_class,
        "hp": f"{char.hp_current}/{char.hp_max}",
        "mp": f"{char.mp_current}/{char.mp_max}" if char.mp_max else None,
        "sp": f"{char.sp_current}/{char.sp_max}" if char.sp_max else None,
        "power_tier": char.power_tier,
        "abilities": char.abilities or [],
        "inventory": char.inventory or [],
        "concept": char.concept,
        "backstory": char.backstory,
        "personality_traits": char.personality_traits or [],
        "values": char.values or [],
        "fears": char.fears or [],
        "goals": {
            "short_term": char.short_term_goal,
            "long_term": char.long_term_goal,
        },
        "op_mode": {
            "enabled": char.op_enabled,
            "tension_source": char.op_tension_source,
            "power_expression": char.op_power_expression,
            "narrative_focus": char.op_narrative_focus,
        } if char.op_enabled else None,
        "faction": char.faction,
        "stats": char.stats or {},
    }
