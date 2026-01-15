"""
Session Save/Load for AIDM v3.

Campaign persistence via JSON export/import.
Per Phase 5 spec: save/load campaigns, session summaries, "Previously on..." generation.
"""

import json
from typing import Dict, Any, Optional, List
from pathlib import Path
from datetime import datetime
from pydantic import BaseModel


class SessionExport(BaseModel):
    """Exported session data."""
    session_id: int
    started_at: str
    ended_at: Optional[str]
    turn_count: int
    summary: Optional[str]
    turns: List[Dict[str, Any]]


class CampaignExport(BaseModel):
    """Full campaign export for save/load."""
    version: str = "1.0"
    exported_at: str
    
    # Campaign info
    campaign_id: int
    campaign_name: str
    profile_id: str
    
    # Character
    character: Dict[str, Any]
    
    # NPCs
    npcs: List[Dict[str, Any]]
    
    # World state
    world_state: Dict[str, Any]
    
    # Campaign bible (Director plans)
    campaign_bible: Dict[str, Any]
    
    # Foreshadowing seeds
    foreshadowing: Dict[str, Any]
    
    # Sessions
    sessions: List[SessionExport]


class SessionManager:
    """
    Manages session save/load operations.
    
    Features:
    - Export campaign to JSON
    - Import campaign from JSON
    - Generate session summaries
    - Generate "Previously on..." text
    """
    
    def __init__(self, state_manager, foreshadowing_ledger=None):
        """
        Initialize with a StateManager instance.
        
        Args:
            state_manager: The StateManager for DB access
            foreshadowing_ledger: Optional ForeshadowingLedger
        """
        self.state = state_manager
        self.foreshadowing = foreshadowing_ledger
    
    def export_campaign(self, save_path: Optional[Path] = None) -> CampaignExport:
        """
        Export the campaign to a CampaignExport object.
        
        Args:
            save_path: Optional path to save JSON file
            
        Returns:
            CampaignExport with all campaign data
        """
        from ..db.models import Campaign, Session, Turn, Character, NPC, WorldState, CampaignBible
        
        db = self.state._get_db()
        campaign_id = self.state.campaign_id
        
        # Get campaign
        campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
        if not campaign:
            raise ValueError(f"Campaign {campaign_id} not found")
        
        # Get character
        character = self.state.get_character()
        character_data = {}
        if character:
            character_data = {
                "name": character.name,
                "level": character.level,
                "xp_current": getattr(character, 'xp_current', 0),
                "hp_current": character.hp_current,
                "hp_max": character.hp_max,
                "mp_current": getattr(character, 'mp_current', 50),
                "mp_max": getattr(character, 'mp_max', 50),
                "sp_current": getattr(character, 'sp_current', 50),
                "sp_max": getattr(character, 'sp_max', 50),
                "power_tier": character.power_tier,
                "stats": character.stats or {},
                "abilities": character.abilities or [],
                "inventory": character.inventory or [],
                "archetype": character.archetype,
                "narrative_goals": character.narrative_goals or [],
                "story_flags": character.story_flags or {}
            }
        
        # Get NPCs
        npcs = db.query(NPC).filter(NPC.campaign_id == campaign_id).all()
        npcs_data = [
            {
                "name": npc.name,
                "role": npc.role,
                "power_tier": npc.power_tier,
                "disposition": npc.disposition,
                "personality": npc.personality,
                "goals": npc.goals or [],
                "secrets": npc.secrets or [],
                "scene_count": npc.scene_count,
                "last_appeared": npc.last_appeared
            }
            for npc in npcs
        ]
        
        # Get world state
        world = db.query(WorldState).filter(WorldState.campaign_id == campaign_id).first()
        world_data = {}
        if world:
            world_data = {
                "location": world.location,
                "time_of_day": world.time_of_day,
                "situation": world.situation,
                "arc_name": world.arc_name,
                "arc_phase": world.arc_phase,
                "tension_level": world.tension_level,
                "foreshadowing": world.foreshadowing or []
            }
        
        # Get campaign bible
        bible = self.state.get_campaign_bible()
        bible_data = {}
        if bible:
            bible_data = {
                "planning_data": bible.planning_data or {},
                "last_updated_turn": bible.last_updated_turn
            }
        
        # Get foreshadowing
        foreshadowing_data = {}
        if self.foreshadowing:
            foreshadowing_data = self.foreshadowing.to_dict()
        
        # Get sessions
        sessions = db.query(Session).filter(Session.campaign_id == campaign_id).all()
        sessions_data = []
        for session in sessions:
            turns = db.query(Turn).filter(Turn.session_id == session.id).all()
            turns_data = [
                {
                    "turn_number": turn.turn_number,
                    "player_input": turn.player_input,
                    "intent": turn.intent,
                    "outcome": turn.outcome,
                    "narrative": turn.narrative,
                    "state_changes": turn.state_changes,
                    "latency_ms": turn.latency_ms
                }
                for turn in turns
            ]
            
            sessions_data.append(SessionExport(
                session_id=session.id,
                started_at=session.started_at.isoformat() if session.started_at else "",
                ended_at=session.ended_at.isoformat() if session.ended_at else None,
                turn_count=session.turn_count,
                summary=session.summary,
                turns=turns_data
            ))
        
        # Build export
        export = CampaignExport(
            exported_at=datetime.utcnow().isoformat(),
            campaign_id=campaign_id,
            campaign_name=campaign.name,
            profile_id=campaign.profile_id,
            character=character_data,
            npcs=npcs_data,
            world_state=world_data,
            campaign_bible=bible_data,
            foreshadowing=foreshadowing_data,
            sessions=sessions_data
        )
        
        # Save to file if path provided
        if save_path:
            save_path = Path(save_path)
            save_path.parent.mkdir(parents=True, exist_ok=True)
            with open(save_path, 'w', encoding='utf-8') as f:
                json.dump(export.model_dump(), f, indent=2, ensure_ascii=False)
        
        return export
    
    def import_campaign(self, load_path: Path) -> int:
        """
        Import a campaign from JSON file.
        
        Args:
            load_path: Path to the JSON file
            
        Returns:
            Campaign ID of the imported campaign
        """
        from ..db.models import Campaign, Session, Turn, Character, NPC, WorldState, CampaignBible
        from .foreshadowing import ForeshadowingLedger
        
        with open(load_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        export = CampaignExport(**data)
        db = self.state._get_db()
        
        # Create campaign
        campaign = Campaign(
            name=export.campaign_name,
            profile_id=export.profile_id
        )
        db.add(campaign)
        db.commit()
        
        campaign_id = campaign.id
        
        # Create character
        if export.character:
            char_data = export.character
            character = Character(
                campaign_id=campaign_id,
                name=char_data.get("name", "Protagonist"),
                level=char_data.get("level", 1),
                hp_current=char_data.get("hp_current", 100),
                hp_max=char_data.get("hp_max", 100),
                power_tier=char_data.get("power_tier", "T10"),
                stats=char_data.get("stats", {}),
                abilities=char_data.get("abilities", []),
                inventory=char_data.get("inventory", []),
                archetype=char_data.get("archetype"),
                narrative_goals=char_data.get("narrative_goals", []),
                story_flags=char_data.get("story_flags", {})
            )
            # Set XP fields if they exist
            if hasattr(character, 'xp_current'):
                character.xp_current = char_data.get("xp_current", 0)
            if hasattr(character, 'mp_current'):
                character.mp_current = char_data.get("mp_current", 50)
                character.mp_max = char_data.get("mp_max", 50)
            if hasattr(character, 'sp_current'):
                character.sp_current = char_data.get("sp_current", 50)
                character.sp_max = char_data.get("sp_max", 50)
            db.add(character)
        
        # Create NPCs
        for npc_data in export.npcs:
            npc = NPC(
                campaign_id=campaign_id,
                name=npc_data.get("name", "Unknown"),
                role=npc_data.get("role"),
                power_tier=npc_data.get("power_tier", "T10"),
                disposition=npc_data.get("disposition", 0),
                personality=npc_data.get("personality"),
                goals=npc_data.get("goals", []),
                secrets=npc_data.get("secrets", []),
                scene_count=npc_data.get("scene_count", 0),
                last_appeared=npc_data.get("last_appeared")
            )
            db.add(npc)
        
        # Create world state
        if export.world_state:
            ws = export.world_state
            world = WorldState(
                campaign_id=campaign_id,
                location=ws.get("location", "Unknown"),
                time_of_day=ws.get("time_of_day", "Day"),
                situation=ws.get("situation", "Continuing the adventure..."),
                arc_name=ws.get("arc_name"),
                arc_phase=ws.get("arc_phase", "rising_action"),
                tension_level=ws.get("tension_level", 0.5),
                foreshadowing=ws.get("foreshadowing", [])
            )
            db.add(world)
        
        # Create campaign bible
        if export.campaign_bible:
            bible = CampaignBible(
                campaign_id=campaign_id,
                planning_data=export.campaign_bible.get("planning_data", {}),
                last_updated_turn=export.campaign_bible.get("last_updated_turn", 0)
            )
            db.add(bible)
        
        db.commit()
        
        # Restore foreshadowing
        if export.foreshadowing and self.foreshadowing:
            self.foreshadowing._seeds = {}
            for sid, seed_data in export.foreshadowing.get("seeds", {}).items():
                from .foreshadowing import ForeshadowingSeed
                self.foreshadowing._seeds[sid] = ForeshadowingSeed(**seed_data)
            self.foreshadowing._next_id = export.foreshadowing.get("next_id", 1)
        
        return campaign_id
    
    def generate_previously_on(self, num_turns: int = 10) -> str:
        """
        Generate a "Previously on..." summary for session start.
        
        Args:
            num_turns: Number of recent turns to summarize
            
        Returns:
            Narrative summary text
        """
        from ..db.models import Turn, Session
        
        db = self.state._get_db()
        
        # Get recent turns
        recent_turns = (
            db.query(Turn)
            .join(Session)
            .filter(Session.campaign_id == self.state.campaign_id)
            .order_by(Turn.id.desc())
            .limit(num_turns)
            .all()
        )
        
        if not recent_turns:
            return "A new adventure begins..."
        
        # Build summary
        lines = ["**Previously on your adventure...**\n"]
        
        # Reverse to chronological order
        for turn in reversed(recent_turns):
            if turn.narrative:
                # Truncate long narratives
                narrative_preview = turn.narrative[:200]
                if len(turn.narrative) > 200:
                    narrative_preview += "..."
                lines.append(f"- {narrative_preview}")
        
        # Add current state
        context = self.state.get_context()
        lines.append(f"\n**Current Location:** {context.location}")
        lines.append(f"**Situation:** {context.situation}")
        
        return "\n".join(lines)
    
    def end_session(self, summary: Optional[str] = None) -> None:
        """
        End the current session and optionally add a summary.
        
        Args:
            summary: Optional session summary
        """
        from ..db.models import Session
        
        db = self.state._get_db()
        session_id = self.state._session_id
        
        if session_id:
            session = db.query(Session).filter(Session.id == session_id).first()
            if session:
                session.ended_at = datetime.utcnow()
                if summary:
                    session.summary = summary
                db.commit()
    
    async def run_session_end_review(self, profile) -> Optional[Dict[str, Any]]:
        """
        Run Director review at session end for long-campaign planning.
        
        Args:
            profile: The NarrativeProfile for Director persona
            
        Returns:
            DirectorOutput as dict, or None if review couldn't run
        """
        from ..agents.director import DirectorAgent
        from ..db.models import Session
        
        db = self.state._get_db()
        session_id = self.state._session_id
        
        if not session_id:
            return None
        
        session = db.query(Session).filter(Session.id == session_id).first()
        bible = self.state.get_campaign_bible()
        world_state = self.state.get_world_state()
        
        if not session or not bible:
            return None
        
        # Run Director analysis
        director = DirectorAgent()
        director_output = await director.run_session_review(
            session=session,
            bible=bible,
            profile=profile,
            world_state=world_state
        )
        
        # Inject spotlight debt from tracking
        spotlight_debt = self.state.compute_spotlight_debt()
        planning_data = director_output.model_dump()
        planning_data["spotlight_debt"] = spotlight_debt
        
        # Update Campaign Bible
        turn_number = session.turn_count or 0
        self.state.update_campaign_bible(planning_data, turn_number)
        
        # Persist arc phase and tension to WorldState
        self.state.update_world_state(
            arc_phase=director_output.arc_phase,
            tension_level=director_output.tension_level
        )
        
        print(f"[Director] Session-end review: {director_output.arc_phase} (tension: {director_output.tension_level:.1f})")
        
        return planning_data
