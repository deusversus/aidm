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

from typing import Any

from ..enums import ArcPhase, NPCIntelligenceStage
from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry


def build_gameplay_tools(
    memory: Any,         # MemoryStore
    state: Any,          # StateManager
    session_transcript: list = None,
    profile_library: Any = None,  # ProfileLibrary (for lore search)
    profile_ids: list[str] = None, # Active profile IDs (for lore search, N+1 composition)
) -> ToolRegistry:
    """Build the standard tool registry for gameplay agents.
    
    Args:
        memory: MemoryStore instance (ChromaDB)
        state: StateManager instance (SQLite)
        session_transcript: Recent messages for transcript search
        profile_library: ProfileLibrary instance for lore search (optional)
        profile_ids: Active profile ID(s) for scoping lore search (optional, list)
        
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
            "'protagonist training with mentor'. Avoid broad queries. "
            "Use the 'keyword' parameter for exact name lookups (e.g. an NPC name) "
            "alongside the semantic query for best results."
        ),
        parameters=[
            ToolParam("query", "str", "The search query — be specific", required=True),
            ToolParam("limit", "int", "Max results to return (default 5)", required=False),
            ToolParam("memory_type", "str",
                "Optional: filter to specific type (core, relationship, quest, episode, "
                "session_zero, fact, combat, dialogue). Default: all types",
                required=False),
            ToolParam("keyword", "str",
                "Optional: exact keyword to match in memory content (e.g. an NPC name). "
                "Use this for precise name lookups alongside the semantic query.",
                required=False),
        ],
        handler=lambda query, limit=5, memory_type=None, keyword=None: _search_memory(
            memory, query, limit, memory_type, keyword
        )
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

    registry.register(ToolDefinition(
        name="update_npc",
        description=(
            "Update an NPC's profile with newly learned information. "
            "Only non-empty fields are applied; existing data is never overwritten. "
            "Use after learning new personality traits, goals, secrets, faction ties, "
            "or visual details about an NPC from the narrative."
        ),
        parameters=[
            ToolParam("name", "str", "NPC name (fuzzy match)", required=True),
            ToolParam("personality", "str", "Personality description (1-2 sentences)", required=False),
            ToolParam("goals", "list", "Known goals/motivations", required=False),
            ToolParam("secrets", "list", "Secrets hinted at in narrative", required=False),
            ToolParam("faction", "str", "Faction/org affiliation", required=False),
            ToolParam("visual_tags", "list", "Visual descriptors for portraits", required=False),
            ToolParam("knowledge_topics", "dict", 'Topics NPC knows: {"topic": "expert|moderate|basic"}', required=False),
        ],
        handler=lambda **kwargs: _update_npc(state, **kwargs)
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

    # -----------------------------------------------------------------
    # LORE TOOLS (IP canon knowledge)
    # -----------------------------------------------------------------

    if profile_library and profile_ids:
        registry.register(ToolDefinition(
            name="search_lore",
            description=(
                "Search the canonical anime/manga lore library for IP-accurate facts. "
                "Returns passages from the series research: characters, techniques, "
                "locations, plot events, world-building details. Use this to ground "
                "your narration in authentic series knowledge."
            ),
            parameters=[
                ToolParam("query", "str", "Semantic search query for anime lore", required=True),
                ToolParam("page_type", "str",
                    "Optional: filter by lore category (characters, techniques, locations, "
                    "world_building, plot, general). Default: all types",
                    required=False),
                ToolParam("limit", "int", "Max results (default 3)", required=False),
            ],
            handler=lambda query, page_type=None, limit=3: _search_lore(
                profile_library, profile_ids, query, page_type, limit
            )
        ))

    # -----------------------------------------------------------------
    # FACTION TOOLS
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="get_faction_details",
        description=(
            "Get full details for a faction by name. Returns: description, alignment, "
            "power level, influence score, inter-faction relationships, PC membership "
            "status and rank, faction goals, secrets, and current events."
        ),
        parameters=[
            ToolParam("name", "str", "Faction name", required=True),
        ],
        handler=lambda name: _get_faction_details(state, name)
    ))

    registry.register(ToolDefinition(
        name="list_factions",
        description=(
            "List ALL factions in the campaign with summary info: name, alignment, "
            "power level, influence score, and PC membership status."
        ),
        parameters=[],
        handler=lambda: _list_factions(state)
    ))

    # -----------------------------------------------------------------
    # DEEP RECALL TOOLS (#30)
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="recall_scene",
        description=(
            "Search past turn narratives for specific scenes, events, or "
            "character moments. Use this to find what happened in earlier turns — "
            "exact dialogue, descriptions, and outcomes. More detailed than "
            "episodic memory summaries. Good for 'what did X say?' or "
            "'what happened when we fought Y?'"
        ),
        parameters=[
            ToolParam("query", "str", "Keyword to search for in past narratives", required=True),
            ToolParam("npc", "str",
                "Optional: filter results to scenes mentioning this NPC name",
                required=False),
            ToolParam("turn_range", "str",
                "Optional: limit to a turn range as 'start-end' (e.g. '1-10')",
                required=False),
        ],
        handler=lambda query, npc=None, turn_range=None: _recall_scene(
            state, query, npc, turn_range
        )
    ))

    return registry


# =========================================================================
# Tool Handler Implementations
# =========================================================================

def _search_memory(
    memory, query: str, limit: int = 5,
    memory_type: str = None, keyword: str = None,
) -> list[dict]:
    """Search ChromaDB for memories matching the query."""
    # Use hybrid search if keyword is provided for best results
    if keyword:
        results = memory.search_hybrid(
            query=query, keyword=keyword, limit=limit,
            boost_on_access=False, memory_type=memory_type,
        )
    else:
        results = memory.search(
            query=query, limit=limit, boost_on_access=False,
            memory_type=memory_type,
        )
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


def _get_critical_memories(memory) -> list[dict]:
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


def _get_recent_episodes(memory, count: int = 5) -> list[dict]:
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


def _get_npc_details(state, name: str) -> dict:
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
        "intelligence_stage": npc.intelligence_stage or NPCIntelligenceStage.REACTIVE,
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


def _list_known_npcs(state) -> list[dict]:
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
            "intelligence": npc.intelligence_stage or NPCIntelligenceStage.REACTIVE,
        })

    return result


def _update_npc(state, name: str, **kwargs) -> dict:
    """Update an NPC with new information via upsert."""
    try:
        npc = state.upsert_npc(name=name, **kwargs)
        return {
            "status": "updated",
            "name": npc.name,
            "fields_provided": [k for k, v in kwargs.items() if v],
        }
    except Exception as e:
        return {"error": f"Failed to update NPC '{name}': {e}"}


def _search_transcript(transcript: list, query: str) -> list[dict]:
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


def _get_world_state(state) -> dict:
    """Get current world state as a dict."""
    ws = state.get_world_state()
    if not ws:
        return {"error": "No world state found"}

    return {
        "location": ws.location or "Unknown",
        "time_of_day": ws.time_of_day or "Unknown",
        "situation": ws.situation or "No current situation",
        "arc_name": ws.arc_name or "None",
        "arc_phase": ws.arc_phase or ArcPhase.RISING_ACTION,
        "tension_level": ws.tension_level or 0.5,
        "timeline_mode": ws.timeline_mode,
        "canon_cast_mode": ws.canon_cast_mode,
        "event_fidelity": ws.event_fidelity,
    }


def _get_character_sheet(state) -> dict:
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


def _search_lore(
    profile_library, profile_ids: list[str], query: str,
    page_type: str = None, limit: int = 3,
) -> list[dict]:
    """Search the canonical lore library for IP-accurate content.

    Supports multi-profile search (N+1 composition). Results from all
    linked profiles are merged and ranked by relevance.
    """
    try:
        results = profile_library.search_lore_multi(
            profile_ids=profile_ids,
            query=query,
            limit=limit,
            page_type=page_type,
        )
        if not results:
            return [{"info": f"No lore found for query: '{query}'"}]
        # Results are raw text strings from ProfileLibrary
        return [{"lore_passage": passage} for passage in results]
    except Exception as e:
        return [{"error": f"Lore search failed: {e}"}]


def _get_faction_details(state, name: str) -> dict:
    """Get full faction card as a dict."""
    faction = state.get_faction_by_name(name)
    if not faction:
        return {"error": f"No faction found matching '{name}'"}

    return {
        "name": faction.name,
        "description": faction.description or "Unknown",
        "alignment": faction.alignment or "neutral",
        "power_level": faction.power_level or "regional",
        "influence_score": faction.influence_score or 50,
        "relationships": faction.relationships or {},
        "pc_is_member": faction.pc_is_member,
        "pc_rank": faction.pc_rank,
        "pc_reputation": faction.pc_reputation or 0,
        "pc_controls": faction.pc_controls,
        "subordinates": faction.subordinates or [],
        "faction_goals": faction.faction_goals or [],
        "secrets": faction.secrets or [],
        "current_events": faction.current_events or [],
    }


def _list_factions(state) -> list[dict]:
    """List all factions with summary info."""
    factions = state.get_all_factions()
    if not factions:
        return [{"info": "No factions in campaign yet"}]

    return [
        {
            "name": f.name,
            "alignment": f.alignment or "neutral",
            "power_level": f.power_level or "regional",
            "influence_score": f.influence_score or 50,
            "pc_is_member": f.pc_is_member,
            "pc_rank": f.pc_rank,
        }
        for f in factions
    ]


def _recall_scene(state, query: str, npc: str = None, turn_range: str = None):
    """Search past turn narratives for specific scenes."""
    tr = None
    if turn_range:
        parts = turn_range.split("-")
        if len(parts) == 2:
            try:
                tr = (int(parts[0]), int(parts[1]))
            except ValueError:
                pass

    results = state.search_turn_narratives(query, npc=npc, turn_range=tr)
    if not results:
        return "No matching scenes found."

    lines = []
    for r in results:
        player_ctx = f" (Player: {r['player_input']})" if r.get("player_input") else ""
        lines.append(f"**Turn {r['turn']}**{player_ctx}\n{r['narrative_excerpt']}")
    return "\n---\n".join(lines)
