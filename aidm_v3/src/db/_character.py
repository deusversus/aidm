"""Character mixin: consequences, world state, character CRUD, combat, progression, OP mode.

Split from state_manager.py for maintainability.
"""

import logging
from typing import Any

from ..enums import NarrativeWeight
from .models import NPC, CampaignBible, Character, Consequence, WorldState

logger = logging.getLogger(__name__)


class CharacterMixin:
    """Consequences, world state, character CRUD, combat, progression, OP mode."""

    # #17: Category classification keywords (no LLM needed)
    _CONSEQUENCE_CATEGORIES = {
        "political": {"ally", "faction", "treaty", "war", "rebellion", "authority", "kingdom", "ruler", "council", "government", "alliance", "throne", "diplomacy", "exile"},
        "environmental": {"destroyed", "collapsed", "weather", "terrain", "landscape", "fire", "flood", "earthquake", "ruin", "barrier", "sealed", "opened", "blocked"},
        "relational": {"trust", "betrayal", "friendship", "enemy", "respect", "reputation", "bond", "grudge", "loyalty", "hatred", "love", "rivalry"},
        "economic": {"gold", "trade", "market", "debt", "wealth", "shop", "merchant", "price", "cost", "treasure", "payment", "reward"},
        "magical": {"curse", "enchantment", "seal", "barrier", "artifact", "power", "spell", "ritual", "transformation", "awakening", "mana", "nen", "chakra"},
    }

    def _classify_consequence(self, description: str) -> str:
        """Classify consequence category via keyword matching."""
        desc_lower = description.lower()
        scores = {}
        for category, keywords in self._CONSEQUENCE_CATEGORIES.items():
            score = sum(1 for kw in keywords if kw in desc_lower)
            if score > 0:
                scores[category] = score
        return max(scores, key=scores.get) if scores else "general"

    def apply_consequence(
        self,
        consequence: str,
        turn_number: int = 0,
        source_action: str = None,
        narrative_weight: str = NarrativeWeight.MINOR,
        category: str = None
    ):
        """Apply a structured consequence to the campaign.
        
        #17: Stores as a queryable Consequence record with category/severity.
        Also appends to situation for backward compatibility.
        
        Args:
            consequence: Description of the consequence
            turn_number: Turn when it occurred
            source_action: What action caused it
            narrative_weight: From outcome (minor/significant/climactic)
            category: LLM-classified category (preferred). Falls back to keyword heuristic if null.
        """
        db = self._get_db()

        # Prefer LLM classification, fall back to keyword heuristic
        if not category:
            category = self._classify_consequence(consequence)

        # Map narrative weight to severity
        severity_map = {
            "minor": "minor",
            "significant": "moderate",
            "climactic": "major"
        }
        severity = severity_map.get(narrative_weight, NarrativeWeight.MINOR)

        # Minor consequences expire after 20 turns, moderate after 50, major are permanent
        expiry_map = {"minor": 20, "moderate": 50, "major": None, "catastrophic": None}
        expires_turn = None
        if expiry_map.get(severity) is not None:
            expires_turn = turn_number + expiry_map[severity]

        # Store structured consequence
        consequence_record = Consequence(
            campaign_id=self.campaign_id,
            turn=turn_number,
            source_action=source_action,
            description=consequence,
            category=category,
            severity=severity,
            active=True,
            expires_turn=expires_turn
        )
        db.add(consequence_record)

        # Backward compat: still append to situation
        world_state = (
            db.query(WorldState)
            .filter(WorldState.campaign_id == self.campaign_id)
            .first()
        )
        if world_state:
            world_state.situation = f"{world_state.situation}\n{consequence}"

        self._maybe_commit()
        logger.info(f"Stored: [{category}/{severity}] {consequence[:80]}..." if len(consequence) > 80 else f"[Consequence] Stored: [{category}/{severity}] {consequence}")

    def get_active_consequences(self, limit: int = 10) -> list:
        """#17: Query active, non-expired consequences for context injection.
        
        Returns:
            List of dicts with description, category, severity, turn
        """
        db = self._get_db()
        consequences = (
            db.query(Consequence)
            .filter(
                Consequence.campaign_id == self.campaign_id,
                Consequence.active == True
            )
            .order_by(Consequence.turn.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "description": c.description,
                "category": c.category,
                "severity": c.severity,
                "turn": c.turn,
                "source_action": c.source_action
            }
            for c in consequences
        ]

    def expire_consequences(self, current_turn: int) -> int:
        """#17: Mark expired consequences as inactive.
        
        Args:
            current_turn: Current turn number
            
        Returns:
            Number of consequences expired
        """
        db = self._get_db()
        expired = (
            db.query(Consequence)
            .filter(
                Consequence.campaign_id == self.campaign_id,
                Consequence.active == True,
                Consequence.expires_turn != None,
                Consequence.expires_turn <= current_turn
            )
            .all()
        )
        for c in expired:
            c.active = False
        if expired:
            self._maybe_commit()
            logger.info(f"Expired {len(expired)} consequences at turn {current_turn}")
        return len(expired)

    def update_world_state(
        self,
        location: str | None = None,
        time_of_day: str | None = None,
        situation: str | None = None,
        arc_phase: str | None = None,
        tension_level: float | None = None,
        timeline_mode: str | None = None,
        canon_cast_mode: str | None = None,
        event_fidelity: str | None = None,
        turns_in_phase: int | None = None
    ):
        """Update world state fields."""
        db = self._get_db()
        world_state = (
            db.query(WorldState)
            .filter(WorldState.campaign_id == self.campaign_id)
            .first()
        )

        if world_state:
            if location is not None:
                world_state.location = location
            if time_of_day is not None:
                world_state.time_of_day = time_of_day
            if situation is not None:
                world_state.situation = situation
            if arc_phase is not None:
                # #3: Reset turns_in_phase on phase transition
                if world_state.arc_phase != arc_phase:
                    world_state.turns_in_phase = 0
                    logger.info(f"Phase transition: {world_state.arc_phase} → {arc_phase}, turns_in_phase reset")
                world_state.arc_phase = arc_phase
            if tension_level is not None:
                world_state.tension_level = tension_level
            if turns_in_phase is not None:
                world_state.turns_in_phase = turns_in_phase
            # Canonicality
            if timeline_mode is not None:
                world_state.timeline_mode = timeline_mode
            if canon_cast_mode is not None:
                world_state.canon_cast_mode = canon_cast_mode
            if event_fidelity is not None:
                world_state.event_fidelity = event_fidelity
            self._maybe_commit()

    def get_character(self) -> Character | None:
        """Get the player character."""
        db = self._get_db()
        return (
            db.query(Character)
            .filter(Character.campaign_id == self.campaign_id)
            .first()
        )

    def update_character(
        self,
        name: str | None = None,
        hp_current: int | None = None,
        hp_max: int | None = None,
        level: int | None = None,
        power_tier: str | None = None,
        abilities: list[str] | None = None,
        # Identity fields
        concept: str | None = None,
        age: int | None = None,
        backstory: str | None = None,
        appearance: dict | None = None,
        visual_tags: list | None = None,
        personality_traits: list[str] | None = None,
        values: list[str] | None = None,
        fears: list[str] | None = None,
        quirks: list[str] | None = None,
        short_term_goal: str | None = None,
        long_term_goal: str | None = None,
        inventory: list | None = None,
    ):
        """Update character fields."""
        db = self._get_db()
        character = self.get_character()

        if character:
            if name is not None:
                character.name = name
            if hp_current is not None:
                character.hp_current = hp_current
            if hp_max is not None:
                character.hp_max = hp_max
            if level is not None:
                character.level = level
            if power_tier is not None:
                character.power_tier = power_tier
            if abilities is not None:
                character.abilities = abilities
            # Identity fields
            if concept is not None:
                character.concept = concept
            if age is not None:
                character.age = age
            if backstory is not None:
                character.backstory = backstory
            if appearance is not None:
                character.appearance = appearance
            if visual_tags is not None:
                character.visual_tags = visual_tags
            if personality_traits is not None:
                character.personality_traits = personality_traits
            if values is not None:
                character.values = values
            if fears is not None:
                character.fears = fears
            if quirks is not None:
                character.quirks = quirks
            if short_term_goal is not None:
                character.short_term_goal = short_term_goal
            if long_term_goal is not None:
                character.long_term_goal = long_term_goal
            if inventory is not None:
                character.inventory = inventory
            db.commit()

    def get_campaign_bible(self) -> CampaignBible | None:
        """Get the campaign bible (Director's plans)."""
        db = self._get_db()
        return (
            db.query(CampaignBible)
            .filter(CampaignBible.campaign_id == self.campaign_id)
            .first()
        )

    def add_inventory_item(self, item_name: str, details: dict[str, Any] = None) -> None:
        """Add an item to character inventory from world-building.
        
        Args:
            item_name: Name of the item
            details: Optional item details (type, description, properties)
        """
        db = self._get_db()
        character = self.get_character()

        if character:
            # Get current inventory
            inventory = character.inventory or []

            # Create item entry
            item_entry = {
                "name": item_name,
                "type": (details or {}).get("type", "miscellaneous"),
                "description": (details or {}).get("description", ""),
                "quantity": (details or {}).get("quantity", 1),
                "properties": (details or {}).get("properties", {}),
                "source": "world_building"  # Flag as player-asserted
            }

            # Check if item already exists
            for existing in inventory:
                if existing.get("name", "").lower() == item_name.lower():
                    # Update quantity if it exists
                    existing["quantity"] = existing.get("quantity", 1) + 1
                    character.inventory = inventory
                    db.commit()
                    return

            # Add new item
            inventory.append(item_entry)
            character.inventory = inventory
            db.commit()

    def update_campaign_bible(self, planning_data: dict[str, Any], turn_number: int):
        """Update the campaign bible with arc history (#2).
        
        Instead of overwriting, merges new data and appends to arc_history.
        """
        db = self._get_db()
        bible = (
            db.query(CampaignBible)
            .filter(CampaignBible.campaign_id == self.campaign_id)
            .first()
        )

        if bible:
            existing = bible.planning_data or {}

            # Build arc_history entry from this Director pass
            arc_entry = {
                "turn": turn_number,
                "version": (bible.bible_version or 0) + 1,
                "arc_phase": planning_data.get("arc_phase"),
                "tension_level": planning_data.get("tension_level"),
                "current_arc": planning_data.get("current_arc"),
                "director_notes": planning_data.get("director_notes", ""),
            }

            # Append to arc_history (cap at 10 entries)
            arc_history = existing.get("arc_history", [])
            arc_history.append(arc_entry)
            if len(arc_history) > 10:
                arc_history = arc_history[-10:]

            # Ensure active_threads is always present (#5 — multi-arc thread tracking)
            # Director can populate threads during review pass; we ensure the key exists.
            active_threads = existing.get("active_threads", [])
            if "active_threads" in planning_data:
                # Director provided updated threads — use them
                active_threads = planning_data["active_threads"]

            # Merge: new data overwrites current fields, but preserves arc_history + active_threads
            merged = {**existing, **planning_data}
            merged["arc_history"] = arc_history
            merged["active_threads"] = active_threads

            bible.planning_data = merged
            bible.bible_version = (bible.bible_version or 0) + 1
            bible.last_updated_turn = turn_number
            self._maybe_commit()

            logger.info(f"v{bible.bible_version}: {arc_entry.get('arc_phase')} @ turn {turn_number} ({len(arc_history)} history entries)")

    def get_target(self, target_name: str) -> NPC | None:
        """Get an NPC by name for combat targeting."""
        db = self._get_db()
        return (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{target_name}%"))
            .first()
        )

    def apply_combat_result(self, combat_result: Any, target: Any):
        """Apply combat results to state (damage, status effects, etc.)."""
        db = self._get_db()

        # Apply damage to target (NPC or Character)
        if hasattr(target, 'hp_current') and combat_result.damage_dealt > 0:
            target.hp_current = max(0, target.hp_current - combat_result.damage_dealt)

        # Deduct resources from attacker
        character = self.get_character()
        if character and combat_result.resources_consumed:
            if hasattr(combat_result.resources_consumed, 'mp') and combat_result.resources_consumed.mp > 0:
                if hasattr(character, 'mp_current'):
                    character.mp_current = max(0, character.mp_current - combat_result.resources_consumed.mp)
            if hasattr(combat_result.resources_consumed, 'sp') and combat_result.resources_consumed.sp > 0:
                if hasattr(character, 'sp_current'):
                    character.sp_current = max(0, character.sp_current - combat_result.resources_consumed.sp)

        self._maybe_commit()

    def apply_progression(self, progression_result: Any):
        """Apply progression results (XP, level-up, abilities)."""
        db = self._get_db()
        character = self.get_character()

        if not character:
            return

        # Apply XP
        if hasattr(character, 'xp_current'):
            character.xp_current = (character.xp_current or 0) + progression_result.xp_awarded

        # Apply level-up
        if progression_result.level_up:
            character.level = progression_result.new_level

            # Update XP threshold for next level
            if hasattr(character, 'xp_to_next_level'):
                # Simple formula: each level needs 100 more XP
                character.xp_to_next_level = progression_result.new_level * 100

            # Apply stat increases
            if progression_result.stats_increased:
                stats = character.stats or {}
                for stat, increase in progression_result.stats_increased.items():
                    stats[stat] = stats.get(stat, 10) + increase
                character.stats = stats

            # Apply new abilities
            if progression_result.abilities_unlocked:
                abilities = character.abilities or []
                abilities.extend(progression_result.abilities_unlocked)
                character.abilities = abilities

            # Apply tier change
            if progression_result.tier_changed and progression_result.new_tier:
                character.power_tier = progression_result.new_tier

        self._maybe_commit()

    def update_op_mode(
        self,
        enabled: bool,
        tension_source: str | None = None,
        power_expression: str | None = None,
        narrative_focus: str | None = None,
        preset: str | None = None
    ):
        """Update OP Protagonist mode settings for the character (3-axis system)."""
        db = self._get_db()
        character = self.get_character()

        if not character:
            return

        # Store on the character model
        character.op_enabled = enabled
        character.op_tension_source = tension_source if enabled else None
        character.op_power_expression = power_expression if enabled else None
        character.op_narrative_focus = narrative_focus if enabled else None
        character.op_preset = preset if enabled else None
        db.commit()

    def update_op_suggestion_dismissed(self, dismissed: bool):
        """Mark that the player has dismissed the OP mode suggestion."""
        # Store in world state metadata for persistence
        db = self._get_db()
        world_state = db.query(WorldState).filter(
            WorldState.campaign_id == self.campaign_id
        ).first()

        if world_state:
            metadata = world_state.metadata or {}
            metadata["op_suggestion_dismissed"] = dismissed
            world_state.metadata = metadata
            db.commit()

    def increment_high_imbalance_count(self) -> int:
        """Increment and return the high imbalance encounter count."""
        db = self._get_db()
        world_state = db.query(WorldState).filter(
            WorldState.campaign_id == self.campaign_id
        ).first()

        if world_state:
            metadata = world_state.metadata or {}
            count = metadata.get("high_imbalance_count", 0) + 1
            metadata["high_imbalance_count"] = count
            world_state.metadata = metadata
            db.commit()
            return count
        return 0

    def get_high_imbalance_count(self) -> int:
        """Get current high imbalance encounter count."""
        db = self._get_db()
        world_state = db.query(WorldState).filter(
            WorldState.campaign_id == self.campaign_id
        ).first()

        if world_state:
            metadata = world_state.metadata or {}
            return metadata.get("high_imbalance_count", 0)
        return 0

    def get_world_state(self) -> WorldState | None:
        """Get the WorldState object for Director context."""
        db = self._get_db()
        return (
            db.query(WorldState)
            .filter(WorldState.campaign_id == self.campaign_id)
            .first()
        )
