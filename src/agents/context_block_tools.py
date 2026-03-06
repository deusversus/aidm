"""
Context block tools for Director and Key Animator agents.

Registered into the gameplay tool registry by build_gameplay_tools()
when a campaign_id is available.

Tools:
  get_context_block   — fetch a specific block by type + entity_id
  search_context_blocks — semantic search across blocks
"""

import logging

from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry

logger = logging.getLogger(__name__)


def register_context_block_tools(registry: ToolRegistry, campaign_id: int) -> None:
    """Register context block retrieval tools into an existing tool registry."""

    registry.register(ToolDefinition(
        name="get_context_block",
        description=(
            "Retrieve a context block — the full narrative history of a story element "
            "(NPC, quest, arc, faction, or foreshadowing thread). "
            "Returns prose summary and continuity checklist. "
            "Use this as your first stop when you need to understand an entity's story arc, "
            "relationship history, or what has happened to a quest. "
            "Falls back to search_memory or search_turn_history for specific details not in the block."
        ),
        parameters=[
            ToolParam(
                "block_type",
                "str",
                "Type of block: 'npc', 'quest', 'arc', 'faction', or 'thread'",
                required=True,
            ),
            ToolParam(
                "entity_id",
                "str",
                "Entity identifier: NPC ID (integer as string), quest ID, arc slug, faction name slug, or seed_id",
                required=True,
            ),
        ],
        handler=lambda block_type, entity_id: _get_context_block(campaign_id, block_type, entity_id),
    ))

    registry.register(ToolDefinition(
        name="search_context_blocks",
        description=(
            "Semantic search across context blocks. "
            "Use when you know the topic but not the exact entity_id, "
            "or when you want to find all blocks related to a theme (e.g. 'betrayal', 'faction politics'). "
            "Returns a ranked list of matching blocks with their prose content."
        ),
        parameters=[
            ToolParam(
                "query",
                "str",
                "Natural language search query — describe what narrative information you're looking for",
                required=True,
            ),
            ToolParam(
                "block_type",
                "str",
                "Optional: filter to 'npc', 'quest', 'arc', 'faction', or 'thread'. Omit to search all types.",
                required=False,
            ),
            ToolParam(
                "limit",
                "int",
                "Maximum results to return (default 5, max 10)",
                required=False,
            ),
        ],
        handler=lambda query, block_type=None, limit=5: _search_context_blocks(
            campaign_id, query, block_type, limit
        ),
    ))


def _get_context_block(campaign_id: int, block_type: str, entity_id: str) -> dict:
    try:
        from ..context.context_blocks import ContextBlockStore
        block = ContextBlockStore(campaign_id).get(block_type, entity_id)
        if not block:
            return {
                "found": False,
                "message": f"No context block found for {block_type}:{entity_id}. "
                           "The block may not have been generated yet (requires 3+ scenes for NPCs, "
                           "or creation event for quests/arcs).",
            }
        return {
            "found": True,
            "block_type": block["block_type"],
            "entity_name": block["entity_name"],
            "status": block["status"],
            "last_updated_turn": block["last_updated_turn"],
            "version": block["version"],
            "content": block["content"],
            "continuity_checklist": block["continuity_checklist"],
        }
    except Exception as e:
        logger.exception("get_context_block failed")
        return {"error": str(e)}


def _search_context_blocks(
    campaign_id: int, query: str, block_type: str | None, limit: int
) -> dict:
    try:
        from ..context.context_blocks import ContextBlockStore
        limit = min(max(1, int(limit or 5)), 10)
        results = ContextBlockStore(campaign_id).search(query, block_type=block_type, limit=limit)
        if not results:
            return {"found": False, "message": "No matching context blocks found."}
        return {
            "found": True,
            "count": len(results),
            "blocks": [
                {
                    "block_type": r["block_type"],
                    "entity_id": r["entity_id"],
                    "entity_name": r["entity_name"],
                    "status": r["status"],
                    "last_updated_turn": r["last_updated_turn"],
                    "content": r["content"],
                }
                for r in results
            ],
        }
    except Exception as e:
        logger.exception("search_context_blocks failed")
        return {"error": str(e)}
