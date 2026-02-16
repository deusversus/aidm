"""
Production Agent tools — post-narrative quest tracking + location discovery.

These tools let the ProductionAgent react to a completed narrative by
updating quest objectives, managing quest status, and discovering/updating
locations.  In Phase 4 this registry will be extended with media-generation
tools (trigger_cutscene, generate_location_visual).

Design: standalone registry (no gameplay tools inheritance) because the
ProductionAgent doesn't need memory search / NPC cards — it only writes
back to the DB after reading the narrative.
"""

from typing import Any
from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry


def build_production_tools(
    state: Any,          # StateManager
    current_turn: int,
) -> ToolRegistry:
    """Build the tool registry for the ProductionAgent.

    Args:
        state: StateManager instance (bound to the active campaign).
        current_turn: Current turn number for tracking.

    Returns:
        ToolRegistry with quest + location tools.
    """
    registry = ToolRegistry()

    # -----------------------------------------------------------------
    # QUEST TRACKING TOOLS
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="get_active_quests",
        description=(
            "Retrieve all currently active quests for this campaign. "
            "Use this FIRST to see which quests exist before deciding "
            "whether objectives were completed or quests resolved."
        ),
        parameters=[],
        handler=lambda: _get_active_quests(state),
    ))

    registry.register(ToolDefinition(
        name="complete_quest_objective",
        description=(
            "Mark a specific sub-objective of a quest as completed. "
            "Call get_active_quests first to find the quest_id and "
            "objective_index. Only mark objectives that were CLEARLY "
            "accomplished in the narrative — do not speculate."
        ),
        parameters=[
            ToolParam("quest_id", "int", "ID of the quest", required=True),
            ToolParam("objective_index", "int",
                      "Zero-based index of the objective to complete",
                      required=True),
        ],
        handler=lambda **kw: _complete_quest_objective(state, **kw),
    ))

    registry.register(ToolDefinition(
        name="update_quest_status",
        description=(
            "Change the overall status of a quest. Valid statuses: "
            "'active', 'completed', 'failed', 'abandoned'. "
            "Only mark a quest 'completed' when ALL objectives are done "
            "or the quest's goal has been achieved in the narrative."
        ),
        parameters=[
            ToolParam("quest_id", "int", "ID of the quest", required=True),
            ToolParam("status", "str",
                      "New status: active|completed|failed|abandoned",
                      required=True),
        ],
        handler=lambda **kw: _update_quest_status(state, **kw),
    ))

    # -----------------------------------------------------------------
    # LOCATION DISCOVERY TOOLS
    # -----------------------------------------------------------------

    registry.register(ToolDefinition(
        name="upsert_location",
        description=(
            "Create a new location or update an existing one. Call this "
            "whenever the narrative introduces or revisits a named location. "
            "Provide rich visual metadata for future media generation."
        ),
        parameters=[
            ToolParam("name", "str",
                      "Location name (e.g. 'Greed Island', 'Phantom Troupe Hideout')",
                      required=True),
            ToolParam("description", "str",
                      "Vivid atmospheric prose description of how the location "
                      "feels / looks right now",
                      required=False),
            ToolParam("location_type", "str",
                      "Type: city, dungeon, wilderness, building, interior, region",
                      required=False),
            ToolParam("visual_tags", "str",
                      "Comma-separated visual keywords for media generation, "
                      "e.g. 'gothic_architecture,neon_signs,rain'",
                      required=False),
            ToolParam("atmosphere", "str",
                      "One-word/phrase atmosphere: oppressive, serene, chaotic, etc.",
                      required=False),
            ToolParam("lighting", "str",
                      "Lighting conditions: dim torchlight, moonlit, harsh neon, etc.",
                      required=False),
            ToolParam("scale", "str",
                      "Spatial scale: intimate, grand, vast",
                      required=False),
            ToolParam("parent_location", "str",
                      "Name of the containing location, if any",
                      required=False),
            ToolParam("connected_locations", "str",
                      "Comma-separated names of locations connected to this one",
                      required=False),
            ToolParam("current_state", "str",
                      "Current state of the location: intact, damaged, destroyed, etc.",
                      required=False),
        ],
        handler=lambda **kw: _upsert_location(state, **kw),
    ))

    registry.register(ToolDefinition(
        name="set_current_location",
        description=(
            "Mark a location as the player's current position. "
            "Call this when the narrative clearly indicates the player "
            "has moved to a new area."
        ),
        parameters=[
            ToolParam("name", "str",
                      "Name of the location (must already exist — call "
                      "upsert_location first if needed)",
                      required=True),
        ],
        handler=lambda **kw: _set_current_location(state, **kw),
    ))

    return registry


# =========================================================================
# Tool Handler Implementations
# =========================================================================

def _get_active_quests(state) -> str:
    """Return active quests as formatted text for the agent."""
    try:
        quests = state.get_quests(status="active")
        if not quests:
            return "No active quests."

        lines = []
        for q in quests:
            obj_lines = []
            for i, obj in enumerate(q.objectives or []):
                status = "✓" if obj.get("completed") else "○"
                obj_lines.append(f"    {status} [{i}] {obj.get('description', '???')}")
            objectives_text = "\n".join(obj_lines) if obj_lines else "    (no sub-objectives)"
            lines.append(
                f"Quest #{q.id} [{q.quest_type}] \"{q.title}\" (status: {q.status})\n"
                f"  Description: {q.description or '(none)'}\n"
                f"  Objectives:\n{objectives_text}"
            )
        return "\n\n".join(lines)
    except Exception as e:
        return f"Error fetching quests: {e}"


def _complete_quest_objective(state, quest_id: int, objective_index: int) -> str:
    """Mark one objective as done."""
    try:
        quest_id = int(quest_id)
        objective_index = int(objective_index)
        quest = state.update_quest_objective(quest_id, objective_index, completed=True)
        if quest:
            obj = quest.objectives[objective_index] if objective_index < len(quest.objectives) else {}
            return (
                f"Completed objective [{objective_index}] "
                f"\"{obj.get('description', '???')}\" on quest \"{quest.title}\"."
            )
        return f"Quest #{quest_id} not found or objective index {objective_index} out of range."
    except Exception as e:
        return f"Error completing objective: {e}"


def _update_quest_status(state, quest_id: int, status: str) -> str:
    """Change overall quest status."""
    try:
        quest_id = int(quest_id)
        valid = {"active", "completed", "failed", "abandoned"}
        if status not in valid:
            return f"Invalid status '{status}'. Must be one of: {', '.join(sorted(valid))}"
        quest = state.update_quest_status(quest_id, status)
        if quest:
            return f"Quest \"{quest.title}\" status updated to '{status}'."
        return f"Quest #{quest_id} not found."
    except Exception as e:
        return f"Error updating quest status: {e}"


def _upsert_location(
    state,
    name: str,
    description: str = None,
    location_type: str = None,
    visual_tags: str = None,
    atmosphere: str = None,
    lighting: str = None,
    scale: str = None,
    parent_location: str = None,
    connected_locations: str = None,
    current_state: str = None,
) -> str:
    """Create or update a location with rich metadata."""
    try:
        tag_list = (
            [t.strip() for t in visual_tags.split(",") if t.strip()]
            if visual_tags else None
        )
        connected = (
            [c.strip() for c in connected_locations.split(",") if c.strip()]
            if connected_locations else None
        )

        # Convert connected names to the expected list-of-dicts format
        connected_dicts = None
        if connected:
            connected_dicts = [{"name": n} for n in connected]

        location = state.upsert_location(
            name=name,
            description=description,
            location_type=location_type,
            visual_tags=tag_list,
            atmosphere=atmosphere,
            lighting=lighting,
            scale=scale,
            parent_location=parent_location,
            connected_locations=connected_dicts,
            current_state=current_state,
        )
        return f"Location \"{location.name}\" upserted (type: {location.location_type or 'untyped'})."
    except Exception as e:
        return f"Error upserting location: {e}"


def _set_current_location(state, name: str) -> str:
    """Mark location as the player's current position."""
    try:
        location = state.set_current_location(name)
        if location:
            return f"Current location set to \"{location.name}\"."
        return f"Location \"{name}\" not found — call upsert_location first."
    except Exception as e:
        return f"Error setting current location: {e}"
