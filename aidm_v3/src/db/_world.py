"""World mixin: factions, quests, locations, media, state transactions.

Split from state_manager.py for maintainability.
"""

import logging
from typing import Any, Optional

from .models import Location, MediaAsset, Quest

logger = logging.getLogger(__name__)


class WorldMixin:
    """Factions, quests, locations, media assets, state transactions."""

    # ==== Faction System ====

    FACTION_RELATIONSHIPS = ["allied", "friendly", "neutral", "unfriendly", "enemy", "at_war"]

    def get_faction(self, faction_name: str) -> Optional["Faction"]:
        """Get a faction by name."""
        from .models import Faction
        db = self._get_db()
        return (
            db.query(Faction)
            .filter(Faction.campaign_id == self.campaign_id)
            .filter(Faction.name.ilike(f"%{faction_name}%"))
            .first()
        )

    # Alias for consistent naming with get_npc_by_name
    def get_faction_by_name(self, name: str) -> Optional["Faction"]:
        """Get a faction by name (alias for get_faction)."""
        return self.get_faction(name)

    def get_all_factions(self) -> list["Faction"]:
        """Get all factions in the campaign."""
        from .models import Faction
        db = self._get_db()
        return db.query(Faction).filter(Faction.campaign_id == self.campaign_id).all()

    def create_faction(
        self,
        name: str,
        description: str = "",
        power_level: str = "regional",
        pc_controls: bool = False
    ) -> "Faction":
        """
        Create a new faction.
        
        Args:
            name: Faction name
            description: Faction description
            power_level: local, regional, national, continental, global
            pc_controls: True if PC is faction leader (Overlord/Rimuru mode)
        """
        from .models import Faction
        db = self._get_db()

        faction = Faction(
            campaign_id=self.campaign_id,
            name=name,
            description=description,
            power_level=power_level,
            pc_controls=pc_controls,
            relationships={},
            subordinates=[],
            faction_goals=[],
            secrets=[],
            current_events=[]
        )
        db.add(faction)
        db.commit()
        db.refresh(faction)

        logger.info(f"Created: {name} (PC controls: {pc_controls})")
        return faction

    def get_faction_relationship(self, faction1_name: str, faction2_name: str) -> str:
        """
        Get the relationship between two factions.
        
        Returns:
            One of: allied, friendly, neutral, unfriendly, enemy, at_war
        """
        faction1 = self.get_faction(faction1_name)
        if not faction1:
            return "neutral"

        relationships = faction1.relationships or {}
        return relationships.get(faction2_name, "neutral")

    def set_faction_relationship(self, faction1_name: str, faction2_name: str, relationship: str):
        """
        Set the relationship between two factions (bidirectional).
        
        Args:
            faction1_name: First faction name
            faction2_name: Second faction name
            relationship: allied, friendly, neutral, unfriendly, enemy, at_war
        """
        if relationship not in self.FACTION_RELATIONSHIPS:
            logger.warning(f"Invalid relationship: {relationship}")
            return

        db = self._get_db()

        faction1 = self.get_faction(faction1_name)
        faction2 = self.get_faction(faction2_name)

        if faction1:
            rels1 = faction1.relationships or {}
            rels1[faction2_name] = relationship
            faction1.relationships = rels1

        if faction2:
            rels2 = faction2.relationships or {}
            rels2[faction1_name] = relationship
            faction2.relationships = rels2

        db.commit()
        logger.info(f"{faction1_name} ↔ {faction2_name}: {relationship}")

    def update_faction_reputation(self, faction_name: str, change: int, reason: str = ""):
        """
        Update PC's reputation with a faction.
        
        Args:
            faction_name: Faction name
            change: Amount to change (-100 to +100 typically)
            reason: Reason for change
        """
        faction = self.get_faction(faction_name)
        if not faction:
            # Update character's faction_reputations dict instead
            character = self.get_character()
            if character:
                db = self._get_db()
                reps = character.faction_reputations or {}
                old_rep = reps.get(faction_name, 0)
                new_rep = max(-1000, min(1000, old_rep + change * 10))  # Scale up for storage
                reps[faction_name] = new_rep
                character.faction_reputations = reps
                db.commit()
                logger.info(f"PC reputation with {faction_name}: {old_rep} → {new_rep} ({reason})")
            return

        db = self._get_db()
        old_rep = faction.pc_reputation or 0
        new_rep = max(-1000, min(1000, old_rep + change * 10))
        faction.pc_reputation = new_rep
        db.commit()

        logger.info(f"PC reputation with {faction_name}: {old_rep} → {new_rep} ({reason})")

    def get_pc_controlled_factions(self) -> list["Faction"]:
        """
        Get all factions the PC controls (Overlord/Rimuru mode).
        
        Returns:
            List of factions where pc_controls=True
        """
        from .models import Faction
        db = self._get_db()
        return (
            db.query(Faction)
            .filter(Faction.campaign_id == self.campaign_id)
            .filter(Faction.pc_controls == True)
            .all()
        )

    def add_subordinate_to_faction(self, faction_name: str, npc_id: int, role: str = "member"):
        """
        Add an NPC as a subordinate to a PC-controlled faction.
        
        Args:
            faction_name: Faction name
            npc_id: NPC ID
            role: Role in faction (e.g., "floor guardian", "general", "advisor")
        """
        faction = self.get_faction(faction_name)
        if not faction or not faction.pc_controls:
            logger.info(f"{faction_name} not PC-controlled")
            return

        npc = self.get_npc(npc_id)
        if not npc:
            return

        db = self._get_db()
        subs = faction.subordinates or []
        subs.append({"npc_id": npc_id, "name": npc.name, "role": role})
        faction.subordinates = subs

        # Also update NPC's faction
        npc.faction = faction_name

        db.commit()
        logger.info(f"{npc.name} joined {faction_name} as {role}")

    def get_faction_context_for_op_mode(self, narrative_focus: str, preset: str | None = None) -> str | None:
        """
        Get faction management context for OP configurations that focus on factions.
        
        Args:
            narrative_focus: OP narrative focus axis (faction, ensemble, etc.)
            preset: Optional preset name (hidden_ruler, nation_builder, etc.)
            
        Returns:
            Faction management guidance for Key Animator, or None
        """
        if narrative_focus != "faction":
            return None

        controlled_factions = self.get_pc_controlled_factions()
        if not controlled_factions:
            return None

        lines = ["## Faction Management (OP Mode)"]

        for faction in controlled_factions:
            lines.append(f"\n### {faction.name}")
            lines.append(f"Power Level: {faction.power_level}")

            if faction.subordinates:
                sub_names = [s.get("name", "Unknown") for s in faction.subordinates[:5]]
                lines.append(f"Key Subordinates: {', '.join(sub_names)}")

            if faction.faction_goals:
                lines.append(f"Active Goals: {', '.join(faction.faction_goals[:3])}")

        # Add preset-specific guidance
        if preset == "hidden_ruler":
            lines.append("\n**Hidden Ruler Guidance**: Subordinates report, PC gives orders. "
                        "Maintain the 'genius mastermind' facade. Comedic gap between terror and improvisation.")
        elif preset == "nation_builder":
            lines.append("\n**Nation Builder Guidance**: Nation-building focus. Combat quick, management deep. "
                        "NPCs bring problems, PC delegates solutions. The nation thrives!")
        else:
            lines.append("\n**Faction Focus Guidance**: Organization management gets screen time. "
                        "Subordinates have their own personalities and problems. Combat is backdrop.")

        return "\n".join(lines)

    # ==== State Transaction Layer ====

    def begin_transaction(self, description: str = ""):
        """
        Begin a new state transaction.
        
        Usage:
            with state.begin_transaction("Cast Fire Bolt") as txn:
                txn.subtract("resources.mp.current", 50, reason="Spell cost")
                txn.subtract("target.hp.current", 35, reason="Fire damage")
        
        Returns:
            StateTransaction instance
        """
        from ..core.state_transaction import StateTransaction
        return StateTransaction(
            state_getter=self.get_value,
            state_setter=self.set_value,
            description=description
        )

    def get_value(self, path: str) -> Any:
        """
        Get a value from game state by dot-notation path.
        
        Supported paths:
        - resources.hp.current, resources.hp.max
        - resources.mp.current, resources.mp.max
        - resources.sp.current, resources.sp.max
        - character.name, character.level, character.xp
        - world.location, world.time_of_day, world.situation
        - world.tension_level, world.arc_phase
        
        Args:
            path: Dot-notation path like "resources.hp.current"
            
        Returns:
            Value at path, or None if not found
        """
        from .models import Character, WorldState
        db = self._get_db()
        parts = path.split(".")

        # Character resources
        if parts[0] == "resources":
            character = db.query(Character).filter(
                Character.campaign_id == self.campaign_id
            ).first()
            if not character:
                return None

            if len(parts) >= 2:
                resource = parts[1]  # hp, mp, sp
                field = parts[2] if len(parts) > 2 else "current"

                if resource == "hp":
                    return character.hp_current if field == "current" else character.hp_max
                elif resource == "mp":
                    return getattr(character, "mp_current", 0) if field == "current" else getattr(character, "mp_max", 100)
                elif resource == "sp":
                    return getattr(character, "sp_current", 0) if field == "current" else getattr(character, "sp_max", 50)

        # Character fields
        elif parts[0] == "character":
            character = db.query(Character).filter(
                Character.campaign_id == self.campaign_id
            ).first()
            if not character:
                return None

            field = parts[1] if len(parts) > 1 else None
            if field == "name":
                return character.name
            elif field == "level":
                return character.level
            elif field == "xp":
                return character.current_xp
            elif field == "power_tier":
                return character.power_tier

        # World state
        elif parts[0] == "world":
            world = db.query(WorldState).filter(
                WorldState.campaign_id == self.campaign_id
            ).first()
            if not world:
                return None

            field = parts[1] if len(parts) > 1 else None
            if field == "location":
                return world.location
            elif field == "time_of_day":
                return world.time_of_day
            elif field == "situation":
                return world.situation
            elif field == "tension_level":
                return world.tension_level
            elif field == "arc_phase":
                return world.arc_phase

        return None

    def set_value(self, path: str, value: Any):
        """
        Set a value in game state by dot-notation path.
        
        Args:
            path: Dot-notation path like "resources.hp.current"
            value: Value to set
        """
        from .models import Character, WorldState
        db = self._get_db()
        parts = path.split(".")

        # Character resources
        if parts[0] == "resources":
            character = db.query(Character).filter(
                Character.campaign_id == self.campaign_id
            ).first()
            if not character:
                return

            if len(parts) >= 2:
                resource = parts[1]  # hp, mp, sp
                field = parts[2] if len(parts) > 2 else "current"

                if resource == "hp":
                    if field == "current":
                        character.hp_current = int(value)
                    else:
                        character.hp_max = int(value)
                elif resource == "mp":
                    if field == "current":
                        character.mp_current = int(value)
                    else:
                        character.mp_max = int(value)
                elif resource == "sp":
                    if field == "current":
                        character.sp_current = int(value)
                    else:
                        character.sp_max = int(value)

            self._maybe_commit()

        # Character fields
        elif parts[0] == "character":
            character = db.query(Character).filter(
                Character.campaign_id == self.campaign_id
            ).first()
            if not character:
                return

            field = parts[1] if len(parts) > 1 else None
            if field == "name":
                character.name = value
            elif field == "level":
                character.level = int(value)
            elif field == "xp":
                character.current_xp = int(value)
            elif field == "power_tier":
                character.power_tier = value

            self._maybe_commit()

        # World state
        elif parts[0] == "world":
            world = db.query(WorldState).filter(
                WorldState.campaign_id == self.campaign_id
            ).first()
            if not world:
                return

            field = parts[1] if len(parts) > 1 else None
            if field == "location":
                world.location = value
            elif field == "time_of_day":
                world.time_of_day = value
            elif field == "situation":
                world.situation = value
            elif field == "tension_level":
                world.tension_level = float(value)
            elif field == "arc_phase":
                world.arc_phase = value

            self._maybe_commit()

    # -----------------------------------------------------------------
    # QUEST CRUD (Phase 2A)
    # -----------------------------------------------------------------

    def create_quest(
        self,
        title: str,
        description: str = None,
        quest_type: str = "main",
        source: str = "director",
        objectives: list = None,
        related_npcs: list = None,
        related_locations: list = None,
        created_turn: int = None,
    ) -> Quest:
        """Create a new quest.
        
        Called by Director Agent when establishing new storylines,
        or by Override Handler when player requests new objectives.
        """
        db = self._get_db()
        quest = Quest(
            campaign_id=self.campaign_id,
            title=title,
            description=description,
            quest_type=quest_type,
            source=source,
            objectives=objectives or [],
            related_npcs=related_npcs or [],
            related_locations=related_locations or [],
            created_turn=created_turn or self._turn_number,
        )
        db.add(quest)
        self._maybe_commit()
        return quest

    def get_quests(self, status: str = None) -> list:
        """Get all quests, optionally filtered by status."""
        db = self._get_db()
        q = db.query(Quest).filter(Quest.campaign_id == self.campaign_id)
        if status:
            q = q.filter(Quest.status == status)
        return q.order_by(Quest.created_at.desc()).all()

    def update_quest_status(self, quest_id: int, status: str) -> Quest | None:
        """Update quest status (active, completed, failed, abandoned).
        
        Called by Pacing Agent per-turn or Director on arc completion.
        """
        db = self._get_db()
        quest = db.query(Quest).filter(
            Quest.id == quest_id,
            Quest.campaign_id == self.campaign_id
        ).first()
        if quest:
            quest.status = status
            if status in ("completed", "failed"):
                quest.completed_turn = self._turn_number
            self._maybe_commit()
        return quest

    def update_quest_objective(
        self, quest_id: int, objective_index: int, completed: bool = True
    ) -> Quest | None:
        """Mark a specific objective within a quest as complete.
        
        Called by Pacing Agent when a sub-objective is achieved.
        """
        db = self._get_db()
        quest = db.query(Quest).filter(
            Quest.id == quest_id,
            Quest.campaign_id == self.campaign_id
        ).first()
        if quest and quest.objectives and 0 <= objective_index < len(quest.objectives):
            objectives = list(quest.objectives)  # Make mutable copy
            objectives[objective_index] = {
                **objectives[objective_index],
                "completed": completed,
                "turn_completed": self._turn_number if completed else None,
            }
            quest.objectives = objectives
            self._maybe_commit()
        return quest

    # -----------------------------------------------------------------
    # LOCATION CRUD (Phase 2B)
    # -----------------------------------------------------------------

    def upsert_location(
        self,
        name: str,
        description: str = None,
        location_type: str = None,
        visual_tags: list = None,
        atmosphere: str = None,
        lighting: str = None,
        scale: str = None,
        parent_location: str = None,
        connected_locations: list = None,
        known_npcs: list = None,
        current_state: str = None,
        aliases: list = None,
    ) -> Location:
        """Create or update a location.
        
        Upsert semantics: if a location with this name already exists
        in the campaign, update it. Otherwise create a new one.
        Called by WorldBuilder agent during environment extraction.
        """
        db = self._get_db()
        location = db.query(Location).filter(
            Location.campaign_id == self.campaign_id,
            Location.name == name
        ).first()

        if location:
            # Update existing — only override non-None fields
            if description is not None:
                location.description = description
            if location_type is not None:
                location.location_type = location_type
            if visual_tags is not None:
                location.visual_tags = visual_tags
            if atmosphere is not None:
                location.atmosphere = atmosphere
            if lighting is not None:
                location.lighting = lighting
            if scale is not None:
                location.scale = scale
            if parent_location is not None:
                location.parent_location = parent_location
            if connected_locations is not None:
                location.connected_locations = connected_locations
            if known_npcs is not None:
                location.known_npcs = known_npcs
            if current_state is not None:
                location.current_state = current_state
            if aliases is not None:
                location.aliases = aliases
            location.times_visited = (location.times_visited or 0) + 1
            location.last_visited_turn = self._turn_number
        else:
            # Create new
            location = Location(
                campaign_id=self.campaign_id,
                name=name,
                description=description,
                location_type=location_type,
                visual_tags=visual_tags or [],
                atmosphere=atmosphere,
                lighting=lighting,
                scale=scale,
                parent_location=parent_location,
                connected_locations=connected_locations or [],
                known_npcs=known_npcs or [],
                current_state=current_state or "intact",
                aliases=aliases or [],
                discovered_turn=self._turn_number,
                last_visited_turn=self._turn_number,
            )
            db.add(location)

        self._maybe_commit()
        return location

    def get_locations(self) -> list:
        """Get all discovered locations for the campaign."""
        db = self._get_db()
        return (
            db.query(Location)
            .filter(Location.campaign_id == self.campaign_id)
            .order_by(Location.last_visited_turn.desc())
            .all()
        )

    def get_location_by_name(self, name: str) -> Location | None:
        """Get a specific location by name."""
        db = self._get_db()
        return db.query(Location).filter(
            Location.campaign_id == self.campaign_id,
            Location.name == name
        ).first()

    def set_current_location(self, name: str) -> Location | None:
        """Mark a location as the current location (clears others).
        
        Called when the player moves to a new location.
        """
        db = self._get_db()
        # Clear current from all locations
        db.query(Location).filter(
            Location.campaign_id == self.campaign_id,
            Location.is_current == True
        ).update({"is_current": False})

        # Set new current
        location = db.query(Location).filter(
            Location.campaign_id == self.campaign_id,
            Location.name == name
        ).first()
        if location:
            location.is_current = True
            location.times_visited = (location.times_visited or 0) + 1
            location.last_visited_turn = self._turn_number
            self._maybe_commit()
        return location

    # ── Media Asset CRUD ──────────────────────────────────────────────

    def save_media_asset(
        self,
        asset_type: str,
        file_path: str,
        cutscene_type: str = None,
        turn_number: int = None,
        session_id: int = None,
        image_prompt: str = None,
        motion_prompt: str = None,
        duration_seconds: float = None,
        cost_usd: float = 0.0,
        status: str = "complete",
        thumbnail_path: str = None,
        error_message: str = None,
    ) -> MediaAsset:
        """Persist a new MediaAsset record.

        Args:
            asset_type: "image" or "video"
            file_path: Relative path under data/media/
            cutscene_type: CutsceneType value (optional)
            turn_number: Which turn generated this
            session_id: Active session ID
            image_prompt: Prompt used for image generation
            motion_prompt: Prompt used for video generation
            duration_seconds: Video duration
            cost_usd: Generation cost
            status: pending/generating/complete/failed
            thumbnail_path: For video thumbnail
            error_message: Error details if failed
        """
        from datetime import datetime
        db = self._get_db()
        asset = MediaAsset(
            campaign_id=self.campaign_id,
            session_id=session_id,
            turn_number=turn_number,
            asset_type=asset_type,
            cutscene_type=cutscene_type,
            file_path=file_path,
            thumbnail_path=thumbnail_path,
            image_prompt=image_prompt,
            motion_prompt=motion_prompt,
            duration_seconds=duration_seconds,
            cost_usd=cost_usd,
            status=status,
            error_message=error_message,
            completed_at=datetime.utcnow() if status == "complete" else None,
        )
        db.add(asset)
        self._maybe_commit()
        db.refresh(asset)
        return asset

    def get_media_for_turn(self, turn_number: int) -> list[MediaAsset]:
        """Get all media assets generated for a specific turn."""
        db = self._get_db()
        return db.query(MediaAsset).filter(
            MediaAsset.campaign_id == self.campaign_id,
            MediaAsset.turn_number == turn_number,
        ).order_by(MediaAsset.created_at).all()

    def get_media_gallery(self, limit: int = 50, offset: int = 0, asset_type: str = None) -> list[MediaAsset]:
        """Get paginated media assets for the campaign.

        Args:
            limit: Max results
            offset: Pagination offset
            asset_type: Optional filter ("image" or "video")
        """
        db = self._get_db()
        query = db.query(MediaAsset).filter(
            MediaAsset.campaign_id == self.campaign_id,
        )
        if asset_type:
            query = query.filter(MediaAsset.asset_type == asset_type)
        return query.order_by(MediaAsset.created_at.desc()).offset(offset).limit(limit).all()

    def get_session_media_cost(self, session_id: int = None) -> float:
        """Sum cost_usd for media in the current session (for budget enforcement).

        Args:
            session_id: Session to sum costs for. If None, sums all campaign media.
        """
        from sqlalchemy import func
        db = self._get_db()
        query = db.query(func.sum(MediaAsset.cost_usd)).filter(
            MediaAsset.campaign_id == self.campaign_id,
        )
        if session_id is not None:
            query = query.filter(MediaAsset.session_id == session_id)
        result = query.scalar()
        return result or 0.0
