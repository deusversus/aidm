"""
Production Agent tools — post-narrative quest tracking + location discovery + media generation.

These tools let the ProductionAgent react to a completed narrative by
updating quest objectives, managing quest status, discovering/updating
locations, and triggering media generation (when enabled).

Design: standalone registry (no gameplay tools inheritance) because the
ProductionAgent doesn't need memory search / NPC cards — it only writes
back to the DB after reading the narrative.
"""

from typing import Any, Optional
from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry


def build_production_tools(
    state: Any,          # StateManager
    current_turn: int,
    media_enabled: bool = False,
    media_budget_enabled: bool = False,
    media_budget_remaining: Optional[float] = None,
    campaign_id: Optional[int] = None,
    style_context: str = "",
) -> ToolRegistry:
    """Build the tool registry for the ProductionAgent.

    Args:
        state: StateManager instance (bound to the active campaign).
        current_turn: Current turn number for tracking.
        media_enabled: Whether AI media generation is active.
        media_budget_enabled: Whether to enforce budget caps.
        media_budget_remaining: Remaining budget in USD (None = uncapped).
        campaign_id: Campaign ID for media file organization.
        style_context: IP-specific art style guidance for prompts.

    Returns:
        ToolRegistry with quest + location + (optional) media tools.
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

    # -----------------------------------------------------------------
    # MEDIA GENERATION TOOLS (only when media_enabled)
    # -----------------------------------------------------------------

    if media_enabled:
        # Shared budget context for closures
        _budget_ctx = {
            "enabled": media_budget_enabled,
            "remaining": media_budget_remaining,
        }

        registry.register(ToolDefinition(
            name="trigger_cutscene",
            description=(
                "Trigger an AI-generated cutscene (still image + animated video). "
                "Call this for MAJOR cinematic moments only: action climaxes, "
                "power awakenings, emotional peaks, dramatic reveals, plot twists. "
                "NOT every turn — aim for ~20% of turns at most. "
                "Be SELECTIVE and provide vivid, detailed prompts."
            ),
            parameters=[
                ToolParam("cutscene_type", "str",
                          "Type: character_intro, location_reveal, action_climax, "
                          "emotional_peak, power_awakening, plot_twist, arc_transition",
                          required=True),
                ToolParam("image_prompt", "str",
                          "Detailed prompt for the still image. Describe the exact scene: "
                          "characters, poses, expressions, background, lighting, mood. "
                          "The more specific, the better the result.",
                          required=True),
                ToolParam("motion_prompt", "str",
                          "Prompt for animating the image into a short video. Describe "
                          "how elements should move: camera pans, character motion, "
                          "effects (wind, particles, energy). Keep it simple and focused.",
                          required=True),
            ],
            handler=lambda **kw: _trigger_cutscene(
                state, campaign_id, current_turn, style_context, _budget_ctx, **kw
            ),
        ))

        registry.register(ToolDefinition(
            name="generate_npc_portrait",
            description=(
                "Generate an AI portrait for an NPC that has appearance data "
                "but no portrait yet. Call this when a NEW NPC is introduced "
                "with a detailed description, or when an existing NPC gains "
                "visual importance. The portrait will appear in the chat on "
                "the NEXT turn (fire-and-forget)."
            ),
            parameters=[
                ToolParam("npc_name", "str",
                          "Exact name of the NPC as stored in the database",
                          required=True),
            ],
            handler=lambda **kw: _generate_npc_portrait(
                state, campaign_id, style_context, _budget_ctx, **kw
            ),
        ))

        registry.register(ToolDefinition(
            name="generate_location_visual",
            description=(
                "Generate an AI visual for a location. Call this when the player "
                "arrives at a vivid new location that has been upserted with rich "
                "visual metadata. The image will appear on the Locations page."
            ),
            parameters=[
                ToolParam("location_name", "str",
                          "Exact name of the location as stored in the database",
                          required=True),
            ],
            handler=lambda **kw: _generate_location_visual(
                state, campaign_id, style_context, _budget_ctx, **kw
            ),
        ))

    return registry


# =========================================================================
# Tool Handler Implementations — Quest Tracking
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


# =========================================================================
# Tool Handler Implementations — Location Discovery
# =========================================================================

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


# =========================================================================
# Tool Handler Implementations — Media Generation
# =========================================================================

def _check_budget(budget_ctx: dict, estimated_cost: float) -> Optional[str]:
    """Check if a media generation is within budget. Returns error string or None."""
    if budget_ctx["enabled"] and budget_ctx["remaining"] is not None:
        if estimated_cost > budget_ctx["remaining"]:
            return (
                f"Session media budget exhausted (${budget_ctx['remaining']:.2f} remaining, "
                f"estimated cost ${estimated_cost:.2f}). Skipping media generation."
            )
    return None


def _deduct_budget(budget_ctx: dict, cost: float):
    """Deduct cost from remaining budget (in-memory tracking for this turn batch)."""
    if budget_ctx["remaining"] is not None:
        budget_ctx["remaining"] = max(0, budget_ctx["remaining"] - cost)


def _trigger_cutscene(
    state,
    campaign_id: int,
    current_turn: int,
    style_context: str,
    budget_ctx: dict,
    cutscene_type: str,
    image_prompt: str,
    motion_prompt: str,
) -> str:
    """Trigger image -> video cutscene generation (fire-and-forget)."""
    import asyncio
    try:
        # Budget check (~$0.11 for image + video)
        budget_error = _check_budget(budget_ctx, 0.11)
        if budget_error:
            return budget_error

        # Enrich prompts with style context
        full_image_prompt = f"{image_prompt}\n\nArt style: {style_context}" if style_context else image_prompt

        async def _generate():
            try:
                from ..media.generator import MediaGenerator
                gen = MediaGenerator()
                result = await gen.generate_cutscene(
                    image_prompt=full_image_prompt,
                    motion_prompt=motion_prompt,
                    campaign_id=campaign_id,
                    cutscene_type=cutscene_type,
                    filename=f"turn{current_turn}_{cutscene_type}",
                )

                # Save to MediaAsset table
                if result.get("status") in ("complete", "partial"):
                    _save_media_asset(
                        campaign_id, current_turn,
                        asset_type="video" if result.get("video_path") else "image",
                        cutscene_type=cutscene_type,
                        file_path=str(result.get("video_path") or result.get("image_path", "")),
                        image_prompt=image_prompt,
                        motion_prompt=motion_prompt,
                        cost_usd=result.get("cost_usd", 0.0),
                        status=result["status"],
                    )
                    _deduct_budget(budget_ctx, result.get("cost_usd", 0.0))
                print(f"[MediaTools] Cutscene ({cutscene_type}): {result.get('status', 'unknown')}")
            except Exception as e:
                print(f"[MediaTools] Cutscene generation error: {e}")

        # Fire-and-forget: schedule as background task
        loop = asyncio.get_running_loop()
        loop.create_task(_generate())
        return f"Cutscene ({cutscene_type}) generation started. It will appear when ready (~30-60s)."

    except Exception as e:
        return f"Error triggering cutscene: {e}"


def _generate_npc_portrait(
    state,
    campaign_id: int,
    style_context: str,
    budget_ctx: dict,
    npc_name: str,
) -> str:
    """Generate portrait for an NPC that doesn't have one yet."""
    import asyncio
    try:
        # Budget check (~$0.06 for model sheet + portrait)
        budget_error = _check_budget(budget_ctx, 0.06)
        if budget_error:
            return budget_error

        # Look up NPC in DB
        from ..db.models import NPC
        db = state._get_db()
        npc = db.query(NPC).filter(
            NPC.campaign_id == campaign_id,
            NPC.name == npc_name,
        ).first()

        if not npc:
            return f"NPC \"{npc_name}\" not found in database."
        if npc.portrait_url:
            return f"NPC \"{npc_name}\" already has a portrait."

        appearance = npc.appearance or {}
        visual_tags = npc.visual_tags or []

        if not appearance and not visual_tags:
            return f"NPC \"{npc_name}\" has no appearance data — cannot generate portrait."

        async def _generate():
            try:
                from ..media.generator import MediaGenerator
                from ..db.session import create_session as create_db_session
                gen = MediaGenerator()
                result = await gen.generate_full_character_media(
                    visual_tags=visual_tags,
                    appearance=appearance,
                    style_context=style_context,
                    campaign_id=campaign_id,
                    entity_name=npc_name,
                )
                # Update NPC record with generated URLs using own DB session
                bg_db = create_db_session()
                try:
                    from ..db.models import NPC as NPCModel
                    bg_npc = bg_db.query(NPCModel).filter(
                        NPCModel.campaign_id == campaign_id,
                        NPCModel.name == npc_name,
                    ).first()
                    if bg_npc:
                        if result.get("portrait"):
                            portrait_url = gen.get_media_url(
                                campaign_id, "portraits",
                                result["portrait"].name
                            )
                            bg_npc.portrait_url = portrait_url
                        if result.get("model_sheet"):
                            model_url = gen.get_media_url(
                                campaign_id, "models",
                                result["model_sheet"].name
                            )
                            bg_npc.model_sheet_url = model_url
                        bg_db.commit()
                finally:
                    bg_db.close()
                _deduct_budget(budget_ctx, 0.06)
                _save_media_asset(
                    campaign_id, None,
                    asset_type="image",
                    cutscene_type="npc_portrait",
                    file_path=str(result.get("portrait") or result.get("model_sheet", "")),
                    image_prompt=f"NPC portrait: {npc_name}",
                    cost_usd=0.06,
                    status="complete",
                )
                print(f"[MediaTools] Portrait generated for NPC \"{npc_name}\"")
            except Exception as e:
                print(f"[MediaTools] NPC portrait generation error for \"{npc_name}\": {e}")

        loop = asyncio.get_running_loop()
        loop.create_task(_generate())
        return f"Portrait generation started for \"{npc_name}\". It will appear on the next turn."

    except Exception as e:
        return f"Error generating NPC portrait: {e}"


def _generate_location_visual(
    state,
    campaign_id: int,
    style_context: str,
    budget_ctx: dict,
    location_name: str,
) -> str:
    """Generate visual for a location."""
    import asyncio
    try:
        # Budget check (~$0.03 for one image)
        budget_error = _check_budget(budget_ctx, 0.03)
        if budget_error:
            return budget_error

        # Look up location
        from ..db.models import Location
        db = state._get_db()
        loc = db.query(Location).filter(
            Location.campaign_id == campaign_id,
            Location.name == location_name,
        ).first()

        if not loc:
            return f"Location \"{location_name}\" not found — call upsert_location first."

        async def _generate():
            try:
                from ..media.generator import MediaGenerator
                gen = MediaGenerator()
                path = await gen.generate_location_visual(
                    location_name=location_name,
                    location_type=loc.location_type or "unknown",
                    description=loc.description or location_name,
                    atmosphere=loc.atmosphere or "mysterious",
                    style_context=style_context,
                    campaign_id=campaign_id,
                )
                if path:
                    _deduct_budget(budget_ctx, 0.03)
                    _save_media_asset(
                        campaign_id, None,
                        asset_type="image",
                        cutscene_type="location_reveal",
                        file_path=str(path),
                        image_prompt=f"Location: {location_name}",
                        cost_usd=0.03,
                        status="complete",
                    )
                    print(f"[MediaTools] Location visual generated for \"{location_name}\"")
            except Exception as e:
                print(f"[MediaTools] Location visual error for \"{location_name}\": {e}")

        loop = asyncio.get_running_loop()
        loop.create_task(_generate())
        return f"Location visual generation started for \"{location_name}\"."

    except Exception as e:
        return f"Error generating location visual: {e}"


def _save_media_asset(
    campaign_id: int,
    turn_number: Optional[int],
    asset_type: str,
    cutscene_type: str,
    file_path: str,
    image_prompt: str = None,
    motion_prompt: str = None,
    cost_usd: float = 0.0,
    status: str = "complete",
):
    """Persist a MediaAsset record to the database.

    Uses its own DB session to avoid sharing with the orchestrator's session,
    since this may be called from fire-and-forget background tasks.
    """
    try:
        from ..db.models import MediaAsset
        from ..db.session import create_session as create_db_session
        db = create_db_session()
        try:
            asset = MediaAsset(
                campaign_id=campaign_id,
                turn_number=turn_number,
                asset_type=asset_type,
                cutscene_type=cutscene_type,
                file_path=file_path,
                image_prompt=image_prompt,
                motion_prompt=motion_prompt,
                cost_usd=cost_usd,
                status=status,
            )
            db.add(asset)
            db.commit()
        finally:
            db.close()
    except Exception as e:
        print(f"[MediaTools] Failed to save media asset: {e}")
