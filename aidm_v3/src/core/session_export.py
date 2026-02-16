"""
Session Export/Import for AIDM v3.

Enables saving and loading complete session state to/from a portable file.
"""

import json
import zipfile
import io
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List

from ..db.session import create_session
from ..db.models import (
    Campaign, Character, WorldState, NPC, Faction, 
    CampaignBible, Session, Turn, MediaAsset, Quest, Location
)


EXPORT_VERSION = "1.1"


def export_session(campaign_id: int) -> bytes:
    """Export entire session to ZIP bytes.
    
    Args:
        campaign_id: The campaign to export
        
    Returns:
        ZIP file as bytes (ready for download)
    """
    db = create_session()
    
    try:
        # Get campaign
        campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
        if not campaign:
            raise ValueError(f"Campaign {campaign_id} not found")
        
        # Prepare export data
        export_data = {}
        
        # Manifest
        export_data["manifest"] = {
            "version": EXPORT_VERSION,
            "profile_id": campaign.profile_id,
            "campaign_name": campaign.name,
            "exported_at": datetime.now().isoformat(),
            "campaign_id": campaign_id
        }
        
        # Campaign
        export_data["campaign"] = {
            "name": campaign.name,
            "profile_id": campaign.profile_id,
            "created_at": campaign.created_at.isoformat() if campaign.created_at else None
        }
        
        # Character
        character = db.query(Character).filter(Character.campaign_id == campaign_id).first()
        if character:
            export_data["character"] = {
                "name": character.name,
                "level": character.level,
                "xp_current": character.xp_current,
                "xp_to_next_level": character.xp_to_next_level,
                "character_class": character.character_class,
                "hp_current": character.hp_current,
                "hp_max": character.hp_max,
                "mp_current": character.mp_current,
                "mp_max": character.mp_max,
                "sp_current": character.sp_current,
                "sp_max": character.sp_max,
                "power_tier": character.power_tier,
                # OP Mode 3-axis system
                "op_enabled": character.op_enabled,
                "op_tension_source": character.op_tension_source,
                "op_power_expression": character.op_power_expression,
                "op_narrative_focus": character.op_narrative_focus,
                "op_preset": character.op_preset,
                "abilities": character.abilities,
                "stats": character.stats,
                "inventory": character.inventory,
                "faction": character.faction,
                "faction_reputations": character.faction_reputations,
                "narrative_goals": character.narrative_goals,
                "calibration_score": character.calibration_score,
                "story_flags": character.story_flags
            }
        
        # WorldState
        world_state = db.query(WorldState).filter(WorldState.campaign_id == campaign_id).first()
        if world_state:
            export_data["world_state"] = {
                "location": world_state.location,
                "time_of_day": world_state.time_of_day,
                "situation": world_state.situation,
                "arc_phase": world_state.arc_phase,
                "tension_level": world_state.tension_level,
                "metadata": world_state.metadata
            }
        
        # NPCs
        npcs = db.query(NPC).filter(NPC.campaign_id == campaign_id).all()
        export_data["npcs"] = [
            {
                "name": npc.name,
                "role": npc.role,
                "faction": npc.faction,
                "affinity": npc.affinity,
                "power_tier": npc.power_tier,
                "scene_count": npc.scene_count,
                "last_appeared": npc.last_appeared,
                "personality": npc.personality,
                "goals": npc.goals,
                "secrets": npc.secrets,
                "memory_tags": npc.memory_tags
            }
            for npc in npcs
        ]
        
        # Factions
        factions = db.query(Faction).filter(Faction.campaign_id == campaign_id).all()
        export_data["factions"] = [
            {
                "name": faction.name,
                "description": faction.description,
                "power_level": faction.power_level,
                "pc_controls": faction.pc_controls,
                "relationships": faction.relationships,
                "subordinates": faction.subordinates,
                "faction_goals": faction.faction_goals,
                "secrets": faction.secrets,
                "current_events": faction.current_events
            }
            for faction in factions
        ]
        
        # CampaignBible
        bible = db.query(CampaignBible).filter(CampaignBible.campaign_id == campaign_id).first()
        if bible:
            export_data["campaign_bible"] = {
                "planning_data": bible.planning_data,
                "last_updated_turn": bible.last_updated_turn
            }
        
        # Sessions and Turns
        sessions = db.query(Session).filter(Session.campaign_id == campaign_id).all()
        export_data["sessions"] = []
        for session in sessions:
            turns = db.query(Turn).filter(Turn.session_id == session.id).all()
            export_data["sessions"].append({
                "turn_count": session.turn_count,
                "started_at": session.started_at.isoformat() if session.started_at else None,
                "ended_at": session.ended_at.isoformat() if session.ended_at else None,
                "turns": [
                    {
                        "turn_number": turn.turn_number,
                        "player_input": turn.player_input,
                        "intent": turn.intent,
                        "outcome": turn.outcome,
                        "narrative": turn.narrative,
                        "latency_ms": turn.latency_ms,
                        "cost_usd": turn.cost_usd
                    }
                    for turn in turns
                ]
            })
        
        # Campaign Memories from ChromaDB
        try:
            import chromadb
            client = chromadb.PersistentClient(path="./data/chroma")
            collection_name = f"campaign_{campaign_id}"
            
            try:
                collection = client.get_collection(collection_name)
                results = collection.get(include=["documents", "metadatas"])
                export_data["memories"] = {
                    "ids": results["ids"],
                    "documents": results["documents"],
                    "metadatas": results["metadatas"]
                }
            except Exception:
                export_data["memories"] = {"ids": [], "documents": [], "metadatas": []}
        except Exception as e:
            print(f"[Export] Warning: Could not export memories: {e}")
            export_data["memories"] = {"ids": [], "documents": [], "metadatas": []}
        
        # Settings
        from ..settings import get_settings_store
        store = get_settings_store()
        settings = store.load()
        export_data["settings"] = {
            "active_profile_id": settings.active_profile_id,
            "active_campaign_id": settings.active_campaign_id
        }
        
        # Session Zero state (for mid-session saves)
        try:
            from ..db.session_store import get_session_store
            session_store = get_session_store()
            all_sessions = session_store.list_sessions()
            session_zero_data = []
            
            for sess_info in all_sessions:
                sess = session_store.load(sess_info["session_id"])
                if sess:
                    session_zero_data.append(sess.to_dict())
            
            export_data["session_zero"] = session_zero_data
            if session_zero_data:
                print(f"[Export] Included {len(session_zero_data)} Session Zero state(s)")
        except Exception as e:
            print(f"[Export] Warning: Could not export Session Zero state: {e}")
            export_data["session_zero"] = []
        
        # Quests
        quests = db.query(Quest).filter(Quest.campaign_id == campaign_id).all()
        export_data["quests"] = [
            {
                "title": q.title,
                "description": q.description,
                "status": q.status,
                "quest_type": q.quest_type,
                "source": q.source,
                "objectives": q.objectives,
                "created_turn": q.created_turn,
                "completed_turn": q.completed_turn,
                "related_npcs": q.related_npcs,
                "related_locations": q.related_locations,
            }
            for q in quests
        ]

        # Locations
        locations = db.query(Location).filter(Location.campaign_id == campaign_id).all()
        export_data["locations"] = [
            {
                "name": loc.name,
                "aliases": loc.aliases,
                "location_type": loc.location_type,
                "description": loc.description,
                "visual_tags": loc.visual_tags,
                "atmosphere": loc.atmosphere,
                "lighting": loc.lighting,
                "scale": loc.scale,
                "parent_location": loc.parent_location,
                "connected_locations": loc.connected_locations,
                "current_state": loc.current_state,
                "state_history": loc.state_history,
                "discovered_turn": loc.discovered_turn,
                "times_visited": loc.times_visited,
                "last_visited_turn": loc.last_visited_turn,
                "is_current": loc.is_current,
                "notable_events": loc.notable_events,
                "known_npcs": loc.known_npcs,
            }
            for loc in locations
        ]

        # Media Assets
        media_assets = db.query(MediaAsset).filter(MediaAsset.campaign_id == campaign_id).all()
        export_data["media_assets"] = [
            {
                "asset_type": ma.asset_type,
                "cutscene_type": ma.cutscene_type,
                "file_path": ma.file_path,
                "thumbnail_path": ma.thumbnail_path,
                "image_prompt": ma.image_prompt,
                "motion_prompt": ma.motion_prompt,
                "duration_seconds": ma.duration_seconds,
                "cost_usd": ma.cost_usd,
                "status": ma.status,
                "turn_number": ma.turn_number,
                "created_at": ma.created_at.isoformat() if ma.created_at else None,
            }
            for ma in media_assets
        ]
        if media_assets:
            print(f"[Export] Included {len(media_assets)} media asset record(s)")

    finally:
        db.close()
    
    # Collect media files for inclusion
    media_files = {}
    media_dir = Path(f"./data/media/{campaign_id}")
    if media_dir.exists():
        for fpath in media_dir.rglob("*"):
            if fpath.is_file():
                rel = fpath.relative_to(media_dir)
                media_files[f"media/{rel.as_posix()}"] = fpath

    # Create ZIP file in memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        # Write JSON files
        for key, data in export_data.items():
            zf.writestr(f"{key}.json", json.dumps(data, indent=2, default=str))
        
        # Include media files
        for arcname, fpath in media_files.items():
            zf.write(fpath, arcname)
        if media_files:
            print(f"[Export] Included {len(media_files)} media file(s)")

        # Include custom profile folder if it exists (for hybrids)
        profile_id = campaign.profile_id
        if profile_id and profile_id.startswith("hybrid_"):
            # Check for session-based custom profile
            custom_dir = Path("./data/custom_profiles")
            for session_dir in custom_dir.glob("*"):
                if session_dir.is_dir():
                    for file in session_dir.glob("*"):
                        arcname = f"custom_profile/{session_dir.name}/{file.name}"
                        zf.write(file, arcname)
    
    zip_buffer.seek(0)
    return zip_buffer.getvalue()


def import_session(zip_bytes: bytes) -> int:
    """Import session from ZIP bytes.
    
    This performs a FULL RESET first, then imports the session data.
    
    Args:
        zip_bytes: ZIP file contents
        
    Returns:
        New campaign_id after import
    """
    from ..db.state_manager import StateManager
    from ..context.custom_profile_library import get_custom_profile_library
    from ..settings import get_settings_store, reset_settings_store
    
    # Parse ZIP
    zip_buffer = io.BytesIO(zip_bytes)
    export_data = {}
    custom_profile_files = {}
    media_file_entries = {}
    
    with zipfile.ZipFile(zip_buffer, 'r') as zf:
        for name in zf.namelist():
            if name.endswith('.json'):
                key = name.replace('.json', '')
                export_data[key] = json.loads(zf.read(name))
            elif name.startswith('custom_profile/'):
                custom_profile_files[name] = zf.read(name)
            elif name.startswith('media/'):
                media_file_entries[name] = zf.read(name)
    
    # Validate manifest
    manifest = export_data.get("manifest", {})
    if not manifest:
        raise ValueError("Invalid export file: missing manifest")
    
    profile_id = manifest.get("profile_id")
    if not profile_id:
        raise ValueError("Invalid export file: missing profile_id")
    
    # Check profile exists (unless it's a hybrid/custom or test)
    if not profile_id.startswith(("hybrid_", "custom_", "test")):
        try:
            from ..context.profile_library import get_profile_library
            lib = get_profile_library()
            if profile_id not in lib.list_profiles():
                print(f"[Import] Warning: Profile '{profile_id}' not found locally. You may want to regenerate it via Session Zero.")
        except Exception as e:
            print(f"[Import] Warning: Could not check profile: {e}")
    
    # Full reset first
    StateManager.full_reset()
    custom_lib = get_custom_profile_library()
    custom_lib.clear_all()
    
    # Import to database
    db = create_session()
    
    try:
        # Campaign
        campaign_data = export_data.get("campaign", {})
        campaign = Campaign(
            name=campaign_data.get("name", "Imported Campaign"),
            profile_id=profile_id
        )
        db.add(campaign)
        db.commit()
        db.refresh(campaign)
        new_campaign_id = campaign.id
        
        # Character
        char_data = export_data.get("character")
        if char_data:
            character = Character(
                campaign_id=new_campaign_id,
                name=char_data.get("name", "Imported Character"),
                level=char_data.get("level", 1),
                xp_current=char_data.get("xp_current"),
                xp_to_next_level=char_data.get("xp_to_next_level"),
                character_class=char_data.get("character_class"),
                hp_current=char_data.get("hp_current", 100),
                hp_max=char_data.get("hp_max", 100),
                mp_current=char_data.get("mp_current"),
                mp_max=char_data.get("mp_max"),
                sp_current=char_data.get("sp_current"),
                sp_max=char_data.get("sp_max"),
                power_tier=char_data.get("power_tier", "T10"),
                # OP Mode 3-axis system (with migration fallback for old saves)
                op_enabled=char_data.get("op_enabled", bool(char_data.get("archetype"))),
                op_tension_source=char_data.get("op_tension_source"),
                op_power_expression=char_data.get("op_power_expression"),
                op_narrative_focus=char_data.get("op_narrative_focus"),
                op_preset=char_data.get("op_preset") or char_data.get("archetype"),  # Migration: old archetype becomes preset
                abilities=char_data.get("abilities"),
                stats=char_data.get("stats"),
                inventory=char_data.get("inventory"),
                faction=char_data.get("faction"),
                faction_reputations=char_data.get("faction_reputations"),
                narrative_goals=char_data.get("narrative_goals"),
                calibration_score=char_data.get("calibration_score"),
                story_flags=char_data.get("story_flags")
            )
            db.add(character)
        
        # WorldState
        world_data = export_data.get("world_state")
        if world_data:
            world_state = WorldState(
                campaign_id=new_campaign_id,
                location=world_data.get("location", "Unknown"),
                time_of_day=world_data.get("time_of_day", "Day"),
                situation=world_data.get("situation", "The adventure continues..."),
                arc_phase=world_data.get("arc_phase", "rising_action"),
                tension_level=world_data.get("tension_level", 0.5),
                metadata=world_data.get("metadata")
            )
            db.add(world_state)
        
        # NPCs
        for npc_data in export_data.get("npcs", []):
            npc = NPC(
                campaign_id=new_campaign_id,
                name=npc_data.get("name"),
                role=npc_data.get("role"),
                faction=npc_data.get("faction"),
                affinity=npc_data.get("affinity", 0),
                power_tier=npc_data.get("power_tier"),
                scene_count=npc_data.get("scene_count", 0),
                last_appeared=npc_data.get("last_appeared"),
                personality=npc_data.get("personality"),
                goals=npc_data.get("goals"),
                secrets=npc_data.get("secrets"),
                memory_tags=npc_data.get("memory_tags")
            )
            db.add(npc)
        
        # Factions
        for faction_data in export_data.get("factions", []):
            faction = Faction(
                campaign_id=new_campaign_id,
                name=faction_data.get("name"),
                description=faction_data.get("description"),
                power_level=faction_data.get("power_level"),
                pc_controls=faction_data.get("pc_controls", False),
                relationships=faction_data.get("relationships"),
                subordinates=faction_data.get("subordinates"),
                faction_goals=faction_data.get("faction_goals"),
                secrets=faction_data.get("secrets"),
                current_events=faction_data.get("current_events")
            )
            db.add(faction)
        
        # Quests
        for q_data in export_data.get("quests", []):
            quest = Quest(
                campaign_id=new_campaign_id,
                title=q_data.get("title"),
                description=q_data.get("description"),
                status=q_data.get("status", "active"),
                quest_type=q_data.get("quest_type", "main"),
                source=q_data.get("source", "director"),
                objectives=q_data.get("objectives"),
                created_turn=q_data.get("created_turn"),
                completed_turn=q_data.get("completed_turn"),
                related_npcs=q_data.get("related_npcs"),
                related_locations=q_data.get("related_locations"),
            )
            db.add(quest)

        # Locations
        for loc_data in export_data.get("locations", []):
            location = Location(
                campaign_id=new_campaign_id,
                name=loc_data.get("name"),
                aliases=loc_data.get("aliases"),
                location_type=loc_data.get("location_type"),
                description=loc_data.get("description"),
                visual_tags=loc_data.get("visual_tags"),
                atmosphere=loc_data.get("atmosphere"),
                lighting=loc_data.get("lighting"),
                scale=loc_data.get("scale"),
                parent_location=loc_data.get("parent_location"),
                connected_locations=loc_data.get("connected_locations"),
                current_state=loc_data.get("current_state", "intact"),
                state_history=loc_data.get("state_history"),
                discovered_turn=loc_data.get("discovered_turn"),
                times_visited=loc_data.get("times_visited", 1),
                last_visited_turn=loc_data.get("last_visited_turn"),
                is_current=loc_data.get("is_current", False),
                notable_events=loc_data.get("notable_events"),
                known_npcs=loc_data.get("known_npcs"),
            )
            db.add(location)
        
        # CampaignBible
        bible_data = export_data.get("campaign_bible")
        if bible_data:
            bible = CampaignBible(
                campaign_id=new_campaign_id,
                planning_data=bible_data.get("planning_data"),
                last_updated_turn=bible_data.get("last_updated_turn")
            )
            db.add(bible)
        
        # Sessions and Turns
        for session_data in export_data.get("sessions", []):
            session = Session(
                campaign_id=new_campaign_id,
                turn_count=session_data.get("turn_count", 0)
            )
            db.add(session)
            db.commit()
            db.refresh(session)
            
            for turn_data in session_data.get("turns", []):
                turn = Turn(
                    session_id=session.id,
                    turn_number=turn_data.get("turn_number"),
                    player_input=turn_data.get("player_input"),
                    intent=turn_data.get("intent"),
                    outcome=turn_data.get("outcome"),
                    narrative=turn_data.get("narrative"),
                    latency_ms=turn_data.get("latency_ms"),
                    cost_usd=turn_data.get("cost_usd")
                )
                db.add(turn)
        
        db.commit()
        
        # Media Assets
        for ma_data in export_data.get("media_assets", []):
            # Remap file paths from old campaign_id to new
            old_path = ma_data.get("file_path", "")
            new_path = old_path  # Paths in media/ dir are relative, remapped below
            ma = MediaAsset(
                campaign_id=new_campaign_id,
                turn_number=ma_data.get("turn_number"),
                asset_type=ma_data.get("asset_type", "image"),
                cutscene_type=ma_data.get("cutscene_type"),
                file_path=new_path,
                thumbnail_path=ma_data.get("thumbnail_path"),
                image_prompt=ma_data.get("image_prompt"),
                motion_prompt=ma_data.get("motion_prompt"),
                duration_seconds=ma_data.get("duration_seconds"),
                cost_usd=ma_data.get("cost_usd", 0.0),
                status=ma_data.get("status", "complete"),
            )
            db.add(ma)
        
        db.commit()
        
    finally:
        db.close()
    
    # Import memories to ChromaDB
    memories_data = export_data.get("memories", {})
    if memories_data.get("ids"):
        try:
            import chromadb
            client = chromadb.PersistentClient(path="./data/chroma")
            collection = client.get_or_create_collection(
                name=f"campaign_{new_campaign_id}",
                metadata={"hnsw:space": "cosine"}
            )
            collection.add(
                ids=memories_data["ids"],
                documents=memories_data["documents"],
                metadatas=memories_data["metadatas"]
            )
            print(f"[Import] Restored {len(memories_data['ids'])} memories")
        except Exception as e:
            print(f"[Import] Warning: Could not restore memories: {e}")
    
    # Restore custom profile files
    if custom_profile_files:
        for arcname, content in custom_profile_files.items():
            # arcname = "custom_profile/session_id/file.yaml"
            target_path = Path("./data") / arcname.replace("custom_profile/", "custom_profiles/")
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_bytes(content)
        print(f"[Import] Restored custom profile files")
    
    # Restore media files
    if media_file_entries:
        media_dir = Path(f"./data/media/{new_campaign_id}")
        for arcname, content in media_file_entries.items():
            # arcname = "media/cutscenes/file.png" → data/media/{new_id}/cutscenes/file.png
            rel_path = arcname[len("media/"):]  # strip "media/" prefix
            target_path = media_dir / rel_path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_bytes(content)
        print(f"[Import] Restored {len(media_file_entries)} media file(s)")
    
    # Update settings
    settings_data = export_data.get("settings", {})
    store = get_settings_store()
    settings = store.load()
    settings.active_profile_id = profile_id
    settings.active_campaign_id = profile_id  # Use profile_id, orchestrator will resolve
    store.save(settings)
    reset_settings_store()
    
    # Restore Session Zero state (for mid-session resume)
    session_zero_data = export_data.get("session_zero", [])
    if session_zero_data:
        try:
            from ..db.session_store import get_session_store
            from .session import Session
            session_store = get_session_store()
            
            # Clear existing sessions first
            existing = session_store.list_sessions()
            for sess_info in existing:
                session_store.delete(sess_info["session_id"])
            
            # Restore sessions
            for sess_dict in session_zero_data:
                sess = Session.from_dict(sess_dict)
                session_store.save(sess)
            
            print(f"[Import] Restored {len(session_zero_data)} Session Zero state(s)")
        except Exception as e:
            print(f"[Import] Warning: Could not restore Session Zero state: {e}")
    
    print(f"[Import] Session imported successfully as campaign {new_campaign_id}")
    return new_campaign_id
