"""Status, tracker, media, and gallery endpoints."""

import logging
import re

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from src.core.session import get_session_manager
from src.settings import get_settings_store

from .models import (
    AbilitiesResponse,
    AbilityInfo,
    CharacterStatusResponse,
    FactionInfo,
    FactionListResponse,
    GalleryResponse,
    InventoryItemInfo,
    InventoryResponse,
    JournalEntry,
    JournalResponse,
    LocationInfo,
    LocationsResponse,
    MediaAssetResponse,
    MediaCostResponse,
    NPCInfo,
    NPCListResponse,
    QuestDetailInfo,
    QuestObjectiveInfo,
    QuestTrackerResponse,
)
from .session_mgmt import get_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/session/{session_id}/status")
async def get_session_status(session_id: str):
    """Get the current status of a session."""
    manager = get_session_manager()
    session = manager.get_session(session_id)

    if session is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")

    return {
        "session_id": session_id,
        "phase": session.phase.value,
        "is_session_zero": session.is_session_zero(),
        "message_count": len(session.messages),
        "character_name": session.character_draft.name,
        "created_at": session.created_at.isoformat(),
        "last_activity": session.last_activity.isoformat()
    }


@router.get("/research/status")
async def get_research_status():
    """Check research capabilities.
    
    Returns info about the configured research agent and available profiles.
    """
    from src.agents.profile_generator import list_available_profiles

    store = get_settings_store()
    settings = store.load()

    # Get configured research model
    research_config = settings.agent_models.research
    if research_config:
        provider_name = research_config.provider
        model_name = research_config.model
    else:
        provider_name = "google"
        model_name = "gemini-3-pro-preview"

    # Check if provider has API key configured
    configured = store.get_configured_providers()
    provider_ready = configured.get(provider_name, False)

    return {
        "native_search_available": True,  # All providers now support native search
        "configured_provider": provider_name,
        "configured_model": model_name,
        "provider_ready": provider_ready,
        "available_profiles": list_available_profiles(),
        "capabilities": {
            "google": "Google Search grounding",
            "anthropic": "Web Search API (May 2025)",
            "openai": "Web Search Tool (Responses API)"
        },
        "note": f"Research uses native {provider_name} web search grounding - no external API keys needed"
    }


# === Status Tracker Endpoints ===

@router.get("/character-status", response_model=CharacterStatusResponse)
async def get_character_status():
    """Get character status for HP/MP/SP bars and stats display."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    char = orchestrator.state.get_character()

    if not char:
        raise HTTPException(status_code=404, detail="No character found")

    return CharacterStatusResponse(
        name=char.name or "Unknown",
        level=char.level or 1,
        xp_current=char.xp_current or 0,
        xp_to_next=char.xp_to_next_level or 100,
        hp_current=char.hp_current or 100,
        hp_max=char.hp_max or 100,
        mp_current=char.mp_current or 50,
        mp_max=char.mp_max or 50,
        sp_current=char.sp_current or 50,
        sp_max=char.sp_max or 50,
        stats=char.stats or {},
        power_tier=char.power_tier or "T10",
        abilities=char.abilities or [],
        character_class=char.character_class,
        portrait_url=char.portrait_url,
        model_sheet_url=char.model_sheet_url,
    )


@router.get("/npcs", response_model=NPCListResponse)
async def get_npcs():
    """Get list of known NPCs for relationship tracker."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    npcs = orchestrator.state.get_all_npcs()

    # Filter out the player character from NPC list
    char = orchestrator.state.get_character()
    pc_name = (char.name or "").lower().strip() if char else ""
    npcs = [
        n for n in npcs
        if (n.role or "").lower() != "protagonist"
        and (n.name or "").lower().strip() != pc_name
    ]

    # Deduplicate NPCs by name similarity (keep highest interaction_count)
    deduped = {}
    for npc in npcs:
        key = (npc.name or "").lower().strip()
        # Normalize common aliases: "Mom" matches "Deus's Mother", etc.
        normalized = key.replace("'s ", " ").replace("deus ", "")
        if normalized in ("mom", "mother", "deus mother"):
            normalized = "mother"
        existing = deduped.get(normalized)
        if existing is None or (npc.interaction_count or 0) > (existing.interaction_count or 0):
            deduped[normalized] = npc
    npcs = list(deduped.values())

    # Sort by last_appeared DESC (recent interactions first)
    npcs_sorted = sorted(npcs, key=lambda n: n.last_appeared or 0, reverse=True)

    return NPCListResponse(
        npcs=[
            NPCInfo(
                id=npc.id,
                name=npc.name,
                role=npc.role,
                affinity=npc.affinity or 0,
                disposition=npc.disposition or 0,
                faction=npc.faction,
                last_appeared=npc.last_appeared,
                portrait_url=npc.portrait_url,
            )
            for npc in npcs_sorted
        ]
    )


@router.get("/factions", response_model=FactionListResponse)
async def get_factions():
    """Get list of factions for reputation tracker."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    factions = orchestrator.state.get_all_factions()

    def get_relationship(rep):
        if rep >= 500: return "allied"
        if rep >= 100: return "friendly"
        if rep >= -100: return "neutral"
        if rep >= -500: return "unfriendly"
        return "hostile"

    return FactionListResponse(
        factions=[
            FactionInfo(
                id=f.id,
                name=f.name,
                pc_reputation=f.pc_reputation or 0,
                pc_rank=f.pc_rank,
                pc_is_member=f.pc_is_member or False,
                relationship_to_pc=get_relationship(f.pc_reputation or 0)
            )
            for f in factions
        ]
    )


@router.get("/quests", response_model=QuestTrackerResponse)
async def get_quests():
    """Get quests from Quest table, with legacy fallback.
    
    Primary source: Quest model (DB-backed, dual-agent managed).
    Fallback: Character goals + campaign bible (legacy ad-hoc approach).
    """
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    current_arc = None

    # Try DB-backed quests first
    db_quests = orchestrator.state.get_quests()

    if db_quests:
        quests = []
        active_count = 0
        completed_count = 0

        for q in db_quests:
            objectives = []
            for obj in (q.objectives or []):
                if isinstance(obj, dict):
                    objectives.append(QuestObjectiveInfo(
                        description=obj.get("description", ""),
                        completed=obj.get("completed", False),
                        turn_completed=obj.get("turn_completed"),
                    ))

            quests.append(QuestDetailInfo(
                id=q.id,
                title=q.title,
                description=q.description,
                status=q.status or "active",
                quest_type=q.quest_type or "main",
                source=q.source or "director",
                objectives=objectives,
                created_turn=q.created_turn,
                completed_turn=q.completed_turn,
                related_npcs=q.related_npcs or [],
                related_locations=q.related_locations or [],
            ))

            if q.status == "active":
                active_count += 1
            elif q.status in ("completed", "failed"):
                completed_count += 1

        # Get current arc from world state or bible
        bible = orchestrator.state.get_campaign_bible()
        if bible and bible.planning_data:
            current_arc = bible.planning_data.get("current_arc", {}).get("name")
        if not current_arc:
            world_state = orchestrator.state.get_world_state()
            if world_state:
                current_arc = world_state.arc_name

        return QuestTrackerResponse(
            quests=quests,
            current_arc=current_arc,
            total_active=active_count,
            total_completed=completed_count,
        )

    # Legacy fallback: character goals + campaign bible
    quests = []

    char = orchestrator.state.get_character()
    if char:
        if char.short_term_goal:
            quests.append(QuestDetailInfo(
                id=0,
                title="Current Objective",
                description=char.short_term_goal,
                quest_type="personal",
                source="player",
            ))
        if char.long_term_goal:
            quests.append(QuestDetailInfo(
                id=0,
                title="Ultimate Goal",
                description=char.long_term_goal,
                quest_type="personal",
                source="player",
            ))
        for goal in (char.narrative_goals or []):
            if isinstance(goal, dict):
                quests.append(QuestDetailInfo(
                    id=0,
                    title=goal.get("name", "Quest"),
                    description=goal.get("description", ""),
                    status=goal.get("status", "active"),
                    quest_type="main",
                    source="director",
                ))

    bible = orchestrator.state.get_campaign_bible()
    if bible and bible.planning_data:
        data = bible.planning_data
        current_arc = (
            data.get("current_arc", {}).get("name")
            if isinstance(data.get("current_arc"), dict)
            else data.get("current_arc")
        ) or current_arc

        for goal in data.get("active_goals", []):
            quests.append(QuestDetailInfo(
                id=0,
                title=goal.get("name", "Unknown Objective"),
                description=goal.get("description", ""),
                status=goal.get("status", "active"),
                quest_type="main",
                source="director",
            ))
        for obj in data.get("arc_objectives", []):
            quests.append(QuestDetailInfo(
                id=0,
                title=obj.get("name", "Arc Objective"),
                description=obj.get("description", ""),
                status=obj.get("status", "active"),
                quest_type="main",
                source="director",
            ))

    if not current_arc:
        world_state = orchestrator.state.get_world_state()
        if world_state:
            current_arc = world_state.arc_name

    active = sum(1 for q in quests if q.status == "active")
    completed = sum(1 for q in quests if q.status in ("completed", "failed"))

    return QuestTrackerResponse(
        quests=quests,
        current_arc=current_arc,
        total_active=active,
        total_completed=completed,
    )


# === Phase 1: Inventory, Abilities, Journal Endpoints ===

@router.get("/inventory", response_model=InventoryResponse)
async def get_inventory():
    """Get character inventory items."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    char = orchestrator.state.get_character()
    if not char:
        raise HTTPException(status_code=404, detail="No character found")

    raw_inventory = char.inventory or []
    items = []
    for item in raw_inventory:
        if isinstance(item, dict):
            items.append(InventoryItemInfo(
                name=item.get("name", "Unknown"),
                type=item.get("type", "miscellaneous"),
                description=item.get("description", ""),
                quantity=item.get("quantity", 1),
                properties=item.get("properties", {}),
                source=item.get("source"),
            ))
        elif isinstance(item, str):
            items.append(InventoryItemInfo(name=item))

    return InventoryResponse(items=items, total_items=len(items))


@router.get("/abilities", response_model=AbilitiesResponse)
async def get_abilities():
    """Get character abilities and skills."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    char = orchestrator.state.get_character()
    if not char:
        raise HTTPException(status_code=404, detail="No character found")

    raw_abilities = char.abilities or []
    abilities = []
    seen_names = set()
    for ability in raw_abilities:
        if isinstance(ability, dict):
            name = ability.get("name", "Unknown")
            if name.lower() in seen_names:
                continue
            seen_names.add(name.lower())
            abilities.append(AbilityInfo(
                name=name,
                description=ability.get("description", ""),
                type=ability.get("type", "passive"),
                level_acquired=ability.get("level_acquired"),
            ))
        elif isinstance(ability, str):
            if ability.lower() in seen_names:
                continue
            seen_names.add(ability.lower())
            abilities.append(AbilityInfo(name=ability, type="passive"))

    return AbilitiesResponse(abilities=abilities, total_abilities=len(abilities))


@router.get("/journal", response_model=JournalResponse)
async def get_journal(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    expand_turn: int | None = Query(None, description="Expand full narrative for a specific turn"),
):
    """Get journal entries from compactor narrative beats.
    
    Timeline mode (default): Returns compactor episode beats from ChromaDB,
    ordered chronologically. These are ~100-200 word narrative summaries.
    
    Full text mode (expand_turn=N): Returns the full Turn.narrative for a 
    specific turn number, alongside the regular timeline.
    """
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    entries = []
    expanded_turn_content = None

    # Timeline mode: Get episode beats from memory store
    try:
        # Search for all episode memories (compactor-generated summaries)
        episode_results = orchestrator.memory.search(
            query="narrative events story moments",
            limit=200,  # Get all available
            min_heat=0.0,
            boost_on_access=False,
            memory_type="episode",
        )

        # Also get narrative_beat type memories
        beat_results = orchestrator.memory.search(
            query="narrative events story moments",
            limit=200,
            min_heat=0.0,
            boost_on_access=False,
            memory_type="narrative_beat",
        )

        # Combine and deduplicate
        seen_ids = set()
        all_beats = []
        for result in episode_results + beat_results:
            if result["id"] not in seen_ids:
                seen_ids.add(result["id"])
                turn_num = int(result["metadata"].get("turn", 0))
                raw_heat = result.get("heat", 0) or 0
                # Normalize heat to 0.0-1.0 range
                heat = min(float(raw_heat), 1.0) if raw_heat <= 1.0 else min(float(raw_heat) / 100.0, 1.0)

                # Clean up content — strip raw location/player/outcome prefixes
                content = result["content"]
                # Remove "[Turn N] Location: Player: ... Outcome: ---" wrapper
                content = re.sub(r'^\[Turn \d+\]\s*[^:]+:\s*Player:.*?Outcome:\s*---\s*', '', content, flags=re.DOTALL).strip()
                # Remove leading markdown headers from compactor output
                content = re.sub(r'^#{1,4}\s*', '', content).strip()

                # Skip tiny stubs (character names, one-word entries)
                if len(content) < 20:
                    continue

                all_beats.append(JournalEntry(
                    turn=turn_num,
                    content=content,
                    entry_type="beat",
                    heat=heat,
                ))

        # Fallback: if no ChromaDB memories yet, build journal from Turn narratives
        if not all_beats:
            from src.db.models import Turn
            db = orchestrator.state._get_db()
            session_id = orchestrator.state.get_or_create_session()
            turns = (
                db.query(Turn)
                .filter(Turn.session_id == session_id, Turn.narrative.isnot(None))
                .order_by(Turn.turn_number.asc())
                .all()
            )
            for t in turns:
                summary = t.narrative[:500].strip().replace('\n', ' ') if t.narrative else ""
                if summary:
                    all_beats.append(JournalEntry(
                        turn=t.turn_number,
                        content=summary,
                        entry_type="beat",
                    ))

        # Sort chronologically by turn
        all_beats.sort(key=lambda e: e.turn or 0)

        # Paginate
        total = len(all_beats)
        start = (page - 1) * per_page
        end = start + per_page
        entries = all_beats[start:end]

    except Exception as e:
        logger.error(f"Error fetching episode memories: {e}")
        total = 0

    # Full text expansion: Get the full narrative for a specific turn
    if expand_turn is not None:
        try:
            turn_narrative = orchestrator.state.get_turn_narrative(expand_turn)
            if turn_narrative:
                expanded_turn_content = expand_turn
                entries.append(JournalEntry(
                    turn=expand_turn,
                    content=turn_narrative,
                    entry_type="full_text",
                ))
        except Exception as e:
            logger.error(f"Error expanding turn {expand_turn}: {e}")

    return JournalResponse(
        entries=entries,
        total_entries=total,
        page=page,
        per_page=per_page,
        expanded_turn=expanded_turn_content,
    )


# === Phase 2: Locations Endpoint ===

@router.get("/locations", response_model=LocationsResponse)
async def get_locations():
    """Get all discovered locations."""
    try:
        orchestrator = get_orchestrator()
    except HTTPException:
        raise HTTPException(status_code=404, detail="No active campaign")

    db_locations = orchestrator.state.get_locations()
    current_location_name = None

    locations = []
    for loc in db_locations:
        locations.append(LocationInfo(
            id=loc.id,
            name=loc.name,
            location_type=loc.location_type,
            description=loc.description,
            atmosphere=loc.atmosphere,
            current_state=loc.current_state or "intact",
            is_current=loc.is_current or False,
            times_visited=loc.times_visited or 0,
            discovered_turn=loc.discovered_turn,
            last_visited_turn=loc.last_visited_turn,
            visual_tags=loc.visual_tags or [],
            known_npcs=loc.known_npcs or [],
            connected_locations=loc.connected_locations or [],
            notable_events=loc.notable_events or [],
        ))
        if loc.is_current:
            current_location_name = loc.name

    # Fallback: use world state location if no DB locations marked as current
    if not current_location_name:
        world_state = orchestrator.state.get_world_state()
        if world_state:
            current_location_name = world_state.location

    return LocationsResponse(
        locations=locations,
        current_location=current_location_name,
        total_locations=len(locations),
    )


# === Phase 4: Media Serving Endpoint ===

@router.get("/media/{file_path:path}")
async def serve_media(file_path: str):
    """Serve generated media files (model sheets, portraits, cutscenes).
    
    Files are stored under data/media/ with the structure:
        {campaign_id}/models/{name}_model.png
        {campaign_id}/portraits/{name}_portrait.png
        {campaign_id}/cutscenes/{name}.mp4
    """
    from src.media.generator import MEDIA_BASE_DIR

    # Resolve and validate path (prevent directory traversal)
    full_path = (MEDIA_BASE_DIR / file_path).resolve()
    if not str(full_path).startswith(str(MEDIA_BASE_DIR.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")

    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="Media not found")

    # Determine MIME type
    suffix = full_path.suffix.lower()
    mime_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
    }
    media_type = mime_types.get(suffix, "application/octet-stream")

    return FileResponse(full_path, media_type=media_type)


# === Phase 5: Media Gallery & Cost Endpoints ===

@router.get("/gallery/{campaign_id}")
async def get_media_gallery(
    campaign_id: int,
    asset_type: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    """Get all generated media for a campaign.
    
    Query params:
        asset_type: filter by 'image' or 'video'
        limit: max results (default 50)
        offset: pagination offset
    """
    try:
        from sqlalchemy import func

        from src.db.models import MediaAsset
        from src.db.state_manager import StateManager

        sm = StateManager(campaign_id)
        db = sm._get_db()

        query = db.query(MediaAsset).filter(
            MediaAsset.campaign_id == campaign_id,
            MediaAsset.status.in_(["complete", "partial"]),
        )

        if asset_type:
            query = query.filter(MediaAsset.asset_type == asset_type)

        total = query.count()
        total_cost = db.query(
            func.coalesce(func.sum(MediaAsset.cost_usd), 0.0)
        ).filter(MediaAsset.campaign_id == campaign_id).scalar()

        assets = query.order_by(
            MediaAsset.created_at.desc()
        ).offset(offset).limit(limit).all()

        return GalleryResponse(
            assets=[
                MediaAssetResponse(
                    id=a.id,
                    asset_type=a.asset_type,
                    cutscene_type=a.cutscene_type,
                    file_url=f"/api/game/media/{a.file_path}" if a.file_path else "",
                    thumbnail_url=f"/api/game/media/{a.thumbnail_path}" if a.thumbnail_path else None,
                    turn_number=a.turn_number,
                    cost_usd=a.cost_usd or 0.0,
                    status=a.status,
                    created_at=a.created_at.isoformat() if a.created_at else None,
                )
                for a in assets
            ],
            total=total,
            total_cost_usd=total_cost,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/turn/{campaign_id}/{turn_number}/media")
async def get_turn_media(campaign_id: int, turn_number: int):
    """Get all media assets generated for a specific turn.
    
    The frontend polls this to check if cutscenes have finished generating.
    """
    try:
        from src.db.models import MediaAsset
        from src.db.state_manager import StateManager

        sm = StateManager(campaign_id)
        db = sm._get_db()

        assets = db.query(MediaAsset).filter(
            MediaAsset.campaign_id == campaign_id,
            MediaAsset.turn_number == turn_number,
        ).order_by(MediaAsset.created_at.asc()).all()

        return {
            "turn_number": turn_number,
            "assets": [
                MediaAssetResponse(
                    id=a.id,
                    asset_type=a.asset_type,
                    cutscene_type=a.cutscene_type,
                    file_url=f"/api/game/media/{a.file_path}" if a.file_path else "",
                    thumbnail_url=f"/api/game/media/{a.thumbnail_path}" if a.thumbnail_path else None,
                    turn_number=a.turn_number,
                    cost_usd=a.cost_usd or 0.0,
                    status=a.status,
                    created_at=a.created_at.isoformat() if a.created_at else None,
                )
                for a in assets
            ],
            "total": len(assets),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/cost/{campaign_id}")
async def get_media_cost(campaign_id: int):
    """Get media generation cost summary for a campaign."""
    try:
        from sqlalchemy import func

        from src.db.models import MediaAsset
        from src.db.state_manager import StateManager
        from src.settings.store import get_settings_store

        sm = StateManager(campaign_id)
        db = sm._get_db()

        total_cost = db.query(
            func.coalesce(func.sum(MediaAsset.cost_usd), 0.0)
        ).filter(MediaAsset.campaign_id == campaign_id).scalar()

        asset_count = db.query(MediaAsset).filter(
            MediaAsset.campaign_id == campaign_id
        ).count()

        # Load budget settings
        settings = get_settings_store().load()
        budget_enabled = getattr(settings, 'media_budget_enabled', False)
        budget_cap = getattr(settings, 'media_budget_per_session_usd', 2.0) if budget_enabled else None

        return MediaCostResponse(
            campaign_total_usd=total_cost,
            budget_cap_usd=budget_cap,
            budget_enabled=budget_enabled,
            budget_remaining_usd=max(0, budget_cap - total_cost) if budget_cap is not None else None,
            asset_count=asset_count,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
