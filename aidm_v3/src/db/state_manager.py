"""State manager for CRUD operations on game state."""

from contextlib import contextmanager
from dataclasses import dataclass
from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session as SQLAlchemySession
from sqlalchemy.exc import OperationalError

from .models import Campaign, Session, Turn, Character, NPC, WorldState, CampaignBible, ForeshadowingSeedDB
from .session import get_session, create_session, init_db


@dataclass
class GameContext:
    """Current game context for agents."""
    campaign_id: int
    session_id: int
    turn_number: int
    
    # Character info
    character_name: str
    character_summary: str
    
    # World state
    location: str
    time_of_day: str
    situation: str
    arc_phase: str
    tension_level: float
    
    # Recent history
    recent_summary: str
    
    # Director guidance
    director_notes: str
    
    # Present NPCs
    present_npcs: List[str]
    
    # OP Protagonist Mode (3-Axis System)
    op_protagonist_enabled: bool = False
    op_tension_source: Optional[str] = None      # existential, relational, moral, burden, information, consequence, control
    op_power_expression: Optional[str] = None    # instantaneous, overwhelming, sealed, hidden, conditional, derivative, passive
    op_narrative_focus: Optional[str] = None     # internal, ensemble, reverse_ensemble, episodic, faction, mundane, competition, legacy
    op_preset: Optional[str] = None              # Optional preset name
    
    # Power Differential System (unifies profile composition + character OP mode)
    power_tier: str = "T10"                       # Character's current power tier
    world_tier: str = "T8"                        # World's baseline power tier (from profile)
    effective_composition: Optional[Dict[str, Any]] = None  # Calculated from differential
    
    # Progressive OP Mode tracking
    high_imbalance_count: int = 0  # Encounters where imbalance > 10
    op_suggestion_dismissed: bool = False  # Player dismissed suggestion
    pending_op_suggestion: Optional[Dict[str, Any]] = None  # Suggestion waiting for response
    
    # Power Scaling (Module 12)
    power_imbalance: float = 1.0  # PC power ÷ threat power (with context modifiers)
    narrative_scale: str = "strategic"  # tactical, strategic, ensemble, spectacle, conceptual
    
    # Party/Ensemble Detection (Module 12)
    has_party: bool = False  # True if NPCs with ally role exist
    party_tier_delta: float = 0.0  # PC tier - avg ally tier (high = ensemble appropriate)
    
    # Canonicality (from Session Zero - how story relates to source material)
    timeline_mode: Optional[str] = None       # canon_adjacent, alternate, inspired
    canon_cast_mode: Optional[str] = None     # full_cast, replaced_protagonist, npcs_only
    event_fidelity: Optional[str] = None      # observable, influenceable, background
    
    # Narrative Identity (deterministic, every turn - NOT from RAG)
    character_concept: Optional[str] = None
    character_age: Optional[int] = None
    character_backstory: Optional[str] = None
    character_appearance: Optional[str] = None   # Formatted string
    character_personality: Optional[str] = None  # Formatted string  
    character_values: Optional[str] = None       # Formatted string
    character_fears: Optional[str] = None        # Formatted string
    character_goals: Optional[str] = None        # Formatted string


class StateManager:
    """Manages game state and provides context for agents."""
    
    @staticmethod
    def full_reset():
        """Clear all session-specific data from database.
        
        Deletes all campaigns, characters, world states, sessions, turns,
        NPCs, factions, and campaign bibles. Also clears campaign memory
        collections from ChromaDB.
        
        PRESERVES: Canonical profile lore and rules library.
        """
        db = create_session()
        try:
            # Delete in order (respecting foreign key constraints)
            from .models import Turn, NPC, Faction, CampaignBible
            
            try:
                db.query(Turn).delete()
                db.query(Session).delete()
                db.query(NPC).delete()
                db.query(Faction).delete()
                db.query(CampaignBible).delete()
                db.query(WorldState).delete()
                db.query(Character).delete()
                db.query(Campaign).delete()
                db.commit()
                print("[StateManager] Full reset: cleared all campaign data from DB")
            except OperationalError as e:
                print(f"[StateManager] Warning: Table delete failed (likely missing schema): {e}")
                db.rollback()
        finally:
            db.close()
            
        # Ensure DB is initialized (recreate tables if missing)
        try:
            init_db()
        except Exception as e:
            print(f"[StateManager] Warning: init_db failed during reset: {e}")
        
        # Clear campaign memory collections from ChromaDB
        try:
            import chromadb
            client = chromadb.PersistentClient(path="./data/chroma")
            for col in client.list_collections():
                if col.name.startswith("campaign_"):
                    client.delete_collection(col.name)
                    print(f"[StateManager] Deleted memory collection: {col.name}")
        except Exception as e:
            print(f"[StateManager] Warning: Could not clear ChromaDB collections: {e}")
    
    @staticmethod
    def get_or_create_campaign_by_profile(profile_id: str, profile_name: str = None) -> int:
        """Look up or create a campaign by profile_id, returning integer campaign_id.
        
        This bridges the gap between profile_id strings (used by Session Zero and settings)
        and integer campaign_id (used by the database schema).
        
        When creating a new campaign, also creates required supporting entities:
        - WorldState (default location/situation)
        - Character (placeholder, updated by Session Zero handoff)
        - CampaignBible (Director planning data)
        
        Args:
            profile_id: The narrative profile ID (e.g., "demon_slayer", "hybrid_abc123")
            profile_name: Optional display name for the campaign
            
        Returns:
            Integer campaign_id from the database
        """
        db = create_session()
        try:
            campaign = db.query(Campaign).filter(Campaign.profile_id == profile_id).first()
            if not campaign:
                # Create new campaign for this profile
                display_name = profile_name or f"{profile_id.replace('_', ' ').title()} Campaign"
                campaign = Campaign(
                    name=display_name,
                    profile_id=profile_id
                )
                db.add(campaign)
                db.commit()
                db.refresh(campaign)
                print(f"[StateManager] Created new campaign: id={campaign.id}, profile_id={profile_id}")
                
                # Create supporting entities for the new campaign
                # WorldState
                world_state = WorldState(
                    campaign_id=campaign.id,
                    location="Unknown",
                    time_of_day="Day",
                    situation="The adventure begins...",
                    arc_phase="rising_action",
                    tension_level=0.3
                )
                db.add(world_state)
                
                # Character (placeholder - will be updated by Session Zero handoff)
                character = Character(
                    campaign_id=campaign.id,
                    name="Protagonist",
                    level=1,
                    hp_current=100,
                    hp_max=100,
                    power_tier="T10"
                )
                db.add(character)
                
                # CampaignBible (Director planning)
                bible = CampaignBible(
                    campaign_id=campaign.id,
                    planning_data={"notes": "Initial setup. Establish the world and characters."}
                )
                db.add(bible)
                
                db.commit()
                print(f"[StateManager] Created supporting entities for campaign {campaign.id}")
                
            return campaign.id
        finally:
            db.close()
    
    def __init__(self, campaign_id: int):
        self.campaign_id = campaign_id
        self._db: Optional[SQLAlchemySession] = None
        self._session_id: Optional[int] = None
        self._turn_number: int = 0
        self._commit_deferred: bool = False
    
    def _get_db(self) -> SQLAlchemySession:
        """Get or create database session."""
        if self._db is None:
            self._db = create_session()
        return self._db
    
    def close(self):
        """Close the database session."""
        if self._db:
            self._db.close()
            self._db = None
    
    def _maybe_commit(self):
        """Commit only if not inside a deferred_commit() block."""
        if not self._commit_deferred:
            db = self._get_db()
            db.commit()
    
    @contextmanager
    def deferred_commit(self):
        """
        Context manager that batches all db.commit() calls into a single
        atomic commit at the end of the block.
        
        Usage:
            with state.deferred_commit():
                state.apply_combat_result(result, target)
                state.apply_progression(progression)
                # ... all mutations are held in-memory
            # Single commit here, or full rollback on exception
        """
        if self._commit_deferred:
            # Already inside a deferred block — no-op (reentrant safe)
            yield
            return
        
        self._commit_deferred = True
        db = self._get_db()
        try:
            yield
            # All mutations succeeded — single atomic commit
            db.commit()
            print("[StateManager] Deferred commit: all changes committed atomically")
        except Exception:
            db.rollback()
            print("[StateManager] Deferred commit: ROLLBACK due to exception")
            raise
        finally:
            self._commit_deferred = False
    
    def ensure_campaign_exists(self, name: str = "Default Campaign", profile_id: str = None):
        """Ensure campaign exists, create if not."""
        db = self._get_db()
        campaign = db.query(Campaign).filter(Campaign.id == self.campaign_id).first()
        
        if not campaign:
            campaign = Campaign(
                id=self.campaign_id,
                name=name,
                profile_id=profile_id
            )
            db.add(campaign)
            db.commit()
            
            # Create default world state
            world_state = WorldState(
                campaign_id=self.campaign_id,
                location="Unknown",
                time_of_day="Day",
                situation="The adventure begins...",
                arc_phase="rising_action",
                tension_level=0.3
            )
            db.add(world_state)
            
            # Create default character
            character = Character(
                campaign_id=self.campaign_id,
                name="Protagonist",
                level=1,
                hp_current=100,
                hp_max=100,
                power_tier="T10"
            )
            db.add(character)
            
            # Create default Campaign Bible (Phase 4)
            bible = CampaignBible(
                campaign_id=self.campaign_id,
                planning_data={"notes": "Initial setup. Establish the world and characters."}
            )
            db.add(bible)
            
            db.commit()
        
        return campaign
    
    def start_session(self) -> int:
        """Start a new game session."""
        db = self._get_db()
        
        # Create new session
        session = Session(campaign_id=self.campaign_id)
        db.add(session)
        db.commit()
        
        self._session_id = session.id
        self._turn_number = 0
        
        return session.id
    
    def get_or_create_session(self) -> int:
        """Get current session or create new one."""
        if self._session_id:
            return self._session_id
        
        db = self._get_db()
        
        # Try to get latest session
        session = (
            db.query(Session)
            .filter(Session.campaign_id == self.campaign_id)
            .filter(Session.ended_at.is_(None))
            .order_by(Session.started_at.desc())
            .first()
        )
        
        if session:
            self._session_id = session.id
            self._turn_number = session.turn_count
            return session.id
        
        return self.start_session()
    
    def get_current_session_model(self) -> Optional[Session]:
        """Get the current session object."""
        if not self._session_id:
            return None
        db = self._get_db()
        return db.query(Session).filter(Session.id == self._session_id).first()

    
    def get_context(self) -> GameContext:
        """Get current game context for agents."""
        db = self._get_db()
        session_id = self.get_or_create_session()
        
        # Get world state
        world_state = (
            db.query(WorldState)
            .filter(WorldState.campaign_id == self.campaign_id)
            .first()
        )
        
        # Get campaign bible (Director notes)
        bible = (
            db.query(CampaignBible)
            .filter(CampaignBible.campaign_id == self.campaign_id)
            .first()
        )
        director_notes = ""
        if bible and bible.planning_data:
            director_notes = bible.planning_data.get("director_notes", "")
            if not director_notes:
                 # Fallback to generic notes
                 director_notes = bible.planning_data.get("notes", "")
            
            # Append voice patterns if available (for KeyAnimator voice consistency)
            voice_patterns = bible.planning_data.get("voice_patterns", "")
            if voice_patterns:
                director_notes += f"\n\n### Voice Consistency\n{voice_patterns}"
        
        # Get character
        character = (
            db.query(Character)
            .filter(Character.campaign_id == self.campaign_id)
            .first()
        )
        
        # Get recent turns for summary
        recent_turns = (
            db.query(Turn)
            .filter(Turn.session_id == session_id)
            .order_by(Turn.turn_number.desc())
            .limit(3)
            .all()
        )
        
        recent_summary = ""
        if recent_turns:
            summaries = []
            for turn in reversed(recent_turns):
                if turn.narrative:
                    # Truncate to first 200 chars
                    snippet = turn.narrative[:200] + "..." if len(turn.narrative) > 200 else turn.narrative
                    summaries.append(f"Turn {turn.turn_number}: {snippet}")
            recent_summary = "\n".join(summaries)
        
        # Build character summary
        char_summary = "No character created"
        
        # Helper to format lists
        def _format_list(items: list) -> str:
            return ", ".join(items) if items else "Unknown"
        
        if character:
            concept_str = f"\nConcept: {character.concept}" if character.concept else ""
            traits_str = ""
            if character.personality_traits:
                traits_str = f"\nTraits: {_format_list(character.personality_traits)}"
            
            char_summary = (
                f"{character.name} (Level {character.level}, {character.power_tier}){concept_str}{traits_str}\n"
                f"HP: {character.hp_current}/{character.hp_max}"
            )
            if character.abilities:
                char_summary += f"\nAbilities: {', '.join(character.abilities)}"
        
        # Calculate party detection for Ensemble mode
        ally_npcs = [
            npc for npc in db.query(NPC).filter(NPC.campaign_id == self.campaign_id).all()
            if npc.role in ("ally", "companion", "party_member")
        ]
        has_party = len(ally_npcs) > 0
        party_tier_delta = 0.0
        if has_party and character and character.power_tier:
            # Parse PC tier (e.g., "T6" -> 6)
            try:
                pc_tier_num = int(character.power_tier.replace("T", ""))
                ally_tiers = []
                for npc in ally_npcs:
                    if npc.power_tier:
                        try:
                            ally_tiers.append(int(npc.power_tier.replace("T", "")))
                        except (ValueError, AttributeError):
                            pass
                if ally_tiers:
                    avg_ally_tier = sum(ally_tiers) / len(ally_tiers)
                    party_tier_delta = pc_tier_num - avg_ally_tier
            except (ValueError, AttributeError):
                pass
        
        return GameContext(
            campaign_id=self.campaign_id,
            session_id=session_id,
            turn_number=self._turn_number,
            character_name=character.name if character else "Unknown",
            character_summary=char_summary,
            location=world_state.location if world_state else "Unknown",
            time_of_day=world_state.time_of_day if world_state else "Day",
            situation=world_state.situation if world_state else "The adventure begins...",
            arc_phase=world_state.arc_phase if world_state else "rising_action",
            tension_level=world_state.tension_level if world_state else 0.5,
            recent_summary=recent_summary,
            present_npcs=self._detect_present_npcs(recent_summary, world_state),
            director_notes=director_notes,
            op_protagonist_enabled=bool(character.op_enabled if character else False),
            op_tension_source=character.op_tension_source if character else None,
            op_power_expression=character.op_power_expression if character else None,
            op_narrative_focus=character.op_narrative_focus if character else None,
            op_preset=character.op_preset if character else None,
            # Power Differential System
            power_tier=character.power_tier if character else "T10",
            world_tier="T8",  # TODO: Load from profile when available in context
            narrative_scale=getattr(world_state, 'narrative_scale', None) or "strategic",
            has_party=has_party,
            party_tier_delta=party_tier_delta,
            # Canonicality
            timeline_mode=world_state.timeline_mode if world_state else None,
            canon_cast_mode=world_state.canon_cast_mode if world_state else None,
            event_fidelity=world_state.event_fidelity if world_state else None,
            # Narrative Identity
            character_concept=character.concept if character else None,
            character_age=character.age if character else None,
            character_backstory=character.backstory if character else None,
            character_appearance=", ".join(f"{k}: {v}" for k, v in (character.appearance or {}).items()) if character else None,
            character_personality=_format_list(character.personality_traits) if character else None,
            character_values=_format_list(character.values) if character else None,
            character_fears=_format_list(character.fears) if character else None,
            character_goals=f"Short: {character.short_term_goal or 'None'}, Long: {character.long_term_goal or 'None'}" if character else None,
        )
    
    def _detect_present_npcs(self, recent_summary: str, world_state: Optional[WorldState]) -> List[str]:
        """
        Detect NPCs present in recent narrative and situation.
        Uses detect_npcs_in_text to find known NPC names.
        """
        text_to_check = recent_summary or ""
        if world_state and world_state.situation:
            text_to_check += " " + world_state.situation
        
        if not text_to_check.strip():
            return []
        
        return self.detect_npcs_in_text(text_to_check)
    
    def record_turn(
        self,
        player_input: str,
        intent: Dict[str, Any],
        outcome: Dict[str, Any],
        narrative: str,
        latency_ms: int,
        cost_usd: Optional[float] = None
    ) -> Turn:
        """Record a completed turn."""
        db = self._get_db()
        session_id = self.get_or_create_session()
        
        self._turn_number += 1
        
        turn = Turn(
            session_id=session_id,
            turn_number=self._turn_number,
            player_input=player_input,
            intent=intent,
            outcome=outcome,
            narrative=narrative,
            latency_ms=latency_ms,
            cost_usd=cost_usd
        )
        db.add(turn)
        
        # Update session turn count
        session = db.query(Session).filter(Session.id == session_id).first()
        if session:
            session.turn_count = self._turn_number
        
        self._maybe_commit()
        return turn
    
    def search_turn_narratives(
        self,
        query: str,
        npc: str = None,
        location: str = None,
        turn_range: tuple = None,
        limit: int = 3
    ) -> list:
        """Search Turn.narrative by keyword with optional filters.
        
        Deep recall tool — searches past turn narratives for specific scenes,
        events, or character moments. More detailed than episodic memory summaries.
        
        Args:
            query: Keyword to search for in narratives
            npc: Optional NPC name to filter by
            location: Optional location name to filter by
            turn_range: Optional (start, end) tuple for turn number range
            limit: Max results to return
            
        Returns:
            List of dicts with turn, narrative_excerpt, player_input
        """
        db = self._get_db()
        session_id = self.get_or_create_session()
        
        q = db.query(Turn).filter(
            Turn.session_id == session_id,
            Turn.narrative.isnot(None)
        )
        
        if turn_range and len(turn_range) == 2:
            q = q.filter(Turn.turn_number.between(turn_range[0], turn_range[1]))
        
        # Keyword search on narrative text
        q = q.filter(Turn.narrative.contains(query))
        
        if npc:
            q = q.filter(Turn.narrative.contains(npc))
        
        results = q.order_by(Turn.turn_number.desc()).limit(limit).all()
        
        return [
            {
                "turn": t.turn_number,
                "narrative_excerpt": t.narrative[:300],
                "player_input": t.player_input[:100] if t.player_input else "",
            }
            for t in results
        ]
    
    # -----------------------------------------------------------------
    # FORESHADOWING PERSISTENCE (#10)
    # -----------------------------------------------------------------
    
    def save_foreshadowing_seed(self, seed_data: dict) -> None:
        """Upsert a foreshadowing seed to DB.
        
        Args:
            seed_data: Dict with keys matching ForeshadowingSeedDB columns.
                       Must include 'seed_id' as the logical key.
        """
        db = self._get_db()
        seed_id = seed_data["seed_id"]
        
        existing = db.query(ForeshadowingSeedDB).filter(
            ForeshadowingSeedDB.seed_id == seed_id
        ).first()
        
        if existing:
            # Update existing
            for key, value in seed_data.items():
                if key != "seed_id" and hasattr(existing, key):
                    setattr(existing, key, value)
        else:
            # Insert new
            row = ForeshadowingSeedDB(
                campaign_id=self.campaign_id,
                **seed_data
            )
            db.add(row)
        
        self._maybe_commit()
    
    def load_foreshadowing_seeds(self) -> list:
        """Load all foreshadowing seeds for this campaign.
        
        Returns:
            List of dicts, each representing a ForeshadowingSeedDB row.
        """
        db = self._get_db()
        rows = db.query(ForeshadowingSeedDB).filter(
            ForeshadowingSeedDB.campaign_id == self.campaign_id
        ).all()
        
        seeds = []
        for row in rows:
            seeds.append({
                "seed_id": row.seed_id,
                "seed_type": row.seed_type,
                "status": row.status,
                "description": row.description,
                "planted_narrative": row.planted_narrative or "",
                "expected_payoff": row.expected_payoff or "",
                "planted_turn": row.planted_turn,
                "planted_session": row.planted_session,
                "mentions": row.mentions,
                "last_mentioned_turn": row.last_mentioned_turn,
                "min_turns_to_payoff": row.min_turns_to_payoff,
                "max_turns_to_payoff": row.max_turns_to_payoff,
                "urgency": row.urgency,
                "resolved_turn": row.resolved_turn,
                "resolution_narrative": row.resolution_narrative,
                "tags": row.tags or [],
                "related_npcs": row.related_npcs or [],
                "related_locations": row.related_locations or [],
            })
        return seeds
    
    def update_foreshadowing_seed(self, seed_id: str, **fields) -> None:
        """Partial update of a foreshadowing seed.
        
        Args:
            seed_id: The logical seed ID (e.g. 'seed_1_3')
            **fields: Column names and new values to update
        """
        db = self._get_db()
        row = db.query(ForeshadowingSeedDB).filter(
            ForeshadowingSeedDB.seed_id == seed_id
        ).first()
        
        if row:
            for key, value in fields.items():
                if hasattr(row, key):
                    setattr(row, key, value)
            self._maybe_commit()
    
    def get_max_seed_sequence(self) -> int:
        """Get the next available seed sequence number for this campaign.
        
        Parses seed_id format 'seed_{campaign_id}_{N}' to determine max N,
        so _next_id survives server restarts without ID collision.
        
        Returns:
            Next sequence number (1 if no seeds exist)
        """
        db = self._get_db()
        rows = db.query(ForeshadowingSeedDB.seed_id).filter(
            ForeshadowingSeedDB.campaign_id == self.campaign_id
        ).all()
        
        if not rows:
            return 1
        
        max_seq = 0
        for (sid,) in rows:
            try:
                # seed_id format: "seed_{campaign_id}_{N}"
                parts = sid.split("_")
                if len(parts) >= 3:
                    max_seq = max(max_seq, int(parts[-1]))
            except (ValueError, IndexError):
                continue
        
        return max_seq + 1
    
    def apply_consequence(self, consequence: str):
        """Apply a narrative consequence to the world state.
        
        For Phase 1 MVP, this is a simple text update.
        Later phases will parse structured consequences.
        """
        db = self._get_db()
        world_state = (
            db.query(WorldState)
            .filter(WorldState.campaign_id == self.campaign_id)
            .first()
        )
        
        if world_state:
            # Append consequence to situation
            world_state.situation = f"{world_state.situation}\n{consequence}"
            self._maybe_commit()
    
    def update_world_state(
        self,
        location: Optional[str] = None,
        time_of_day: Optional[str] = None,
        situation: Optional[str] = None,
        arc_phase: Optional[str] = None,
        tension_level: Optional[float] = None,
        timeline_mode: Optional[str] = None,
        canon_cast_mode: Optional[str] = None,
        event_fidelity: Optional[str] = None
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
                world_state.arc_phase = arc_phase
            if tension_level is not None:
                world_state.tension_level = tension_level
            # Canonicality
            if timeline_mode is not None:
                world_state.timeline_mode = timeline_mode
            if canon_cast_mode is not None:
                world_state.canon_cast_mode = canon_cast_mode
            if event_fidelity is not None:
                world_state.event_fidelity = event_fidelity
            self._maybe_commit()
    
    def get_character(self) -> Optional[Character]:
        """Get the player character."""
        db = self._get_db()
        return (
            db.query(Character)
            .filter(Character.campaign_id == self.campaign_id)
            .first()
        )
    
    def update_character(
        self,
        name: Optional[str] = None,
        hp_current: Optional[int] = None,
        hp_max: Optional[int] = None,
        level: Optional[int] = None,
        power_tier: Optional[str] = None,
        abilities: Optional[List[str]] = None,
        # Identity fields
        concept: Optional[str] = None,
        age: Optional[int] = None,
        backstory: Optional[str] = None,
        appearance: Optional[Dict] = None,
        personality_traits: Optional[List[str]] = None,
        values: Optional[List[str]] = None,
        fears: Optional[List[str]] = None,
        quirks: Optional[List[str]] = None,
        short_term_goal: Optional[str] = None,
        long_term_goal: Optional[str] = None,
        inventory: Optional[List] = None,
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

    def get_campaign_bible(self) -> Optional[CampaignBible]:
        """Get the campaign bible (Director's plans)."""
        db = self._get_db()
        return (
            db.query(CampaignBible)
            .filter(CampaignBible.campaign_id == self.campaign_id)
            .first()
        )
    
    def create_npc(
        self,
        name: str,
        role: str = "acquaintance",
        relationship_notes: Optional[str] = None,
        **kwargs
    ) -> NPC:
        """Create an NPC from world-building assertion.
        
        Args:
            name: NPC name
            role: Role/relationship to player (ally, rival, mentor, etc.)
            relationship_notes: Backstory/notes about the relationship
            **kwargs: Additional NPC fields
            
        Returns:
            Created NPC instance
        """
        db = self._get_db()
        
        # Check if NPC already exists
        existing = (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{name}%"))
            .first()
        )
        if existing:
            # Update existing NPC
            if relationship_notes:
                existing.relationship_notes = relationship_notes
            if role:
                existing.role = role
            db.commit()
            return existing
        
        # Create new NPC
        npc = NPC(
            campaign_id=self.campaign_id,
            name=name,
            role=role,
            relationship_notes=relationship_notes or "",
            affinity=kwargs.get("affinity", 0),
            disposition=kwargs.get("disposition", 0),
            power_tier=kwargs.get("power_tier", "T10"),
            personality=kwargs.get("personality", ""),
            goals=kwargs.get("goals", []),
            ensemble_archetype=kwargs.get("ensemble_archetype"),
            growth_stage="introduction",
            intelligence_stage="reactive",
            scene_count=0,
            interaction_count=0,
        )
        db.add(npc)
        db.commit()
        return npc
    
    def add_inventory_item(self, item_name: str, details: Dict[str, Any] = None) -> None:
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
    
    def update_campaign_bible(self, planning_data: Dict[str, Any], turn_number: int):
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
            
            # Merge: new data overwrites current fields, but preserves arc_history
            merged = {**existing, **planning_data}
            merged["arc_history"] = arc_history
            
            bible.planning_data = merged
            bible.bible_version = (bible.bible_version or 0) + 1
            bible.last_updated_turn = turn_number
            self._maybe_commit()
            
            print(f"[Bible] v{bible.bible_version}: {arc_entry.get('arc_phase')} @ turn {turn_number} ({len(arc_history)} history entries)")

    def get_target(self, target_name: str) -> Optional[NPC]:
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
        tension_source: Optional[str] = None,
        power_expression: Optional[str] = None,
        narrative_focus: Optional[str] = None,
        preset: Optional[str] = None
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
    
    # ==== Spotlight Tracking (Phase 4: Director Layer) ====
    
    def compute_spotlight_debt(self) -> Dict[str, int]:
        """
        Compute which NPCs need more screen time.
        
        Returns:
            Dict mapping NPC names to spotlight debt 
            (positive = needs more scenes, negative = over-exposed)
        """
        db = self._get_db()
        npcs = db.query(NPC).filter(NPC.campaign_id == self.campaign_id).all()
        
        if not npcs:
            return {}
        
        avg_scene_count = sum(n.scene_count for n in npcs) / len(npcs)
        return {n.name: int(avg_scene_count - n.scene_count) for n in npcs}
    
    def increment_npc_scene_count(self, npc_name: str, turn_number: int):
        """
        Track that an NPC appeared in a scene.
        
        Args:
            npc_name: Name of the NPC
            turn_number: Current turn number for last_appeared tracking
        """
        db = self._get_db()
        npc = (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{npc_name}%"))
            .first()
        )
        
        if npc:
            npc.scene_count = (npc.scene_count or 0) + 1
            npc.last_appeared = turn_number
            self._maybe_commit()
    
    def get_world_state(self) -> Optional[WorldState]:
        """Get the WorldState object for Director context."""
        db = self._get_db()
        return (
            db.query(WorldState)
            .filter(WorldState.campaign_id == self.campaign_id)
            .first()
        )
    
    # ==== NPC Intelligence (Module 04) ====
    
    DISPOSITION_THRESHOLDS = {
        "hostile": (-100, -61),
        "unfriendly": (-60, -21),
        "neutral": (-20, 29),
        "friendly": (30, 59),
        "trusted": (60, 89),
        "devoted": (90, 100)
    }
    
    def get_npc(self, npc_id: int) -> Optional[NPC]:
        """Get an NPC by ID."""
        db = self._get_db()
        return db.query(NPC).filter(NPC.id == npc_id).first()
    
    def get_npc_by_name(self, name: str) -> Optional[NPC]:
        """Get an NPC by name (fuzzy match)."""
        db = self._get_db()
        return (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{name}%"))
            .first()
        )
    
    def get_all_npcs(self) -> List[NPC]:
        """Get all NPCs in the campaign."""
        db = self._get_db()
        return db.query(NPC).filter(NPC.campaign_id == self.campaign_id).all()
    
    def update_npc_relationship(
        self,
        npc_name: str,
        affinity_delta: int,
        turn_number: int,
        emotional_milestone: Optional[str] = None,
        milestone_context: Optional[str] = None
    ) -> Optional[NPC]:
        """Apply a relationship update to an NPC.
        
        Updates affinity, tracks emotional milestones, increments counters,
        recalculates disposition, and evolves intelligence stage.
        
        Args:
            npc_name: Name of the NPC
            affinity_delta: Change in affinity (-10 to +10)
            turn_number: Current turn number
            emotional_milestone: Optional milestone key (e.g., 'first_humor')
            milestone_context: Reasoning for milestone
            
        Returns:
            Updated NPC or None if not found
        """
        npc = self.get_npc_by_name(npc_name)
        if not npc:
            return None
        
        db = self._get_db()
        
        # Update affinity (clamp to -100/+100)
        npc.affinity = max(-100, min(100, (npc.affinity or 0) + affinity_delta))
        npc.interaction_count = (npc.interaction_count or 0) + 1
        npc.last_appeared = turn_number
        
        # Track emotional milestone (only firsts count)
        if emotional_milestone:
            milestones = npc.emotional_milestones or {}
            if emotional_milestone not in milestones:
                milestones[emotional_milestone] = {
                    "turn": turn_number,
                    "context": milestone_context or ""
                }
                npc.emotional_milestones = milestones
                print(f"[NPC] {npc.name}: Emotional milestone '{emotional_milestone}' at turn {turn_number}")
        
        # Recalculate disposition
        npc.disposition = self.get_npc_disposition(npc.id)
        
        # Evolve intelligence stage based on interaction count
        self.evolve_npc_intelligence(npc)
        
        self._maybe_commit()
        
        if affinity_delta != 0:
            print(f"[NPC] {npc.name}: affinity {affinity_delta:+d} → {npc.affinity} (disposition: {npc.disposition})")
        
        return npc
    
    def evolve_npc_intelligence(self, npc: NPC) -> str:
        """Advance NPC intelligence stage based on interaction count.
        
        Stages:
            reactive (0-4): NPC responds to direct prompts only
            contextual (5-9): NPC references past interactions
            anticipatory (10-19): NPC anticipates PC behavior
            autonomous (20+): NPC acts independently
            
        Returns:
            Current intelligence stage after evaluation
        """
        count = npc.interaction_count or 0
        old_stage = npc.intelligence_stage or "reactive"
        
        if count >= 20:
            new_stage = "autonomous"
        elif count >= 10:
            new_stage = "anticipatory"
        elif count >= 5:
            new_stage = "contextual"
        else:
            new_stage = "reactive"
        
        if new_stage != old_stage:
            npc.intelligence_stage = new_stage
            print(f"[NPC] {npc.name}: Intelligence evolved: {old_stage} → {new_stage} ({count} interactions)")
        
        return new_stage
    
    def get_present_npc_cards(self, npc_names: List[str]) -> str:
        """Build formatted NPC context cards for narrative agents.
        
        Provides relationship-aware context so KeyAnimator can write
        disposition-appropriate dialogue (hostile NPCs sound hostile, etc.).
        
        Args:
            npc_names: List of NPC names present in the scene
            
        Returns:
            Formatted string of NPC cards, or empty string
        """
        cards = []
        for name in npc_names:
            npc = self.get_npc_by_name(name)
            if not npc:
                continue
            
            # Determine disposition label
            disp = npc.disposition or 0
            if disp >= 90:
                disp_label = "devoted"
            elif disp >= 60:
                disp_label = "trusted"
            elif disp >= 30:
                disp_label = "friendly"
            elif disp >= -20:
                disp_label = "neutral"
            elif disp >= -60:
                disp_label = "unfriendly"
            else:
                disp_label = "hostile"
            
            # Build milestone summary
            milestones = npc.emotional_milestones or {}
            milestone_str = ", ".join(milestones.keys()) if milestones else "none yet"
            
            # Intelligence stage hint
            intel = npc.intelligence_stage or "reactive"
            
            card = (
                f"**{npc.name}** ({npc.role or 'unknown'}, {disp_label})\n"
                f"  Affinity: {npc.affinity or 0}/100 | Scenes: {npc.scene_count or 0} | Intelligence: {intel}\n"
                f"  Personality: {npc.personality or 'Unknown'}\n"
                f"  Milestones: {milestone_str}"
            )
            cards.append(card)
        
        return "\n\n".join(cards)
    
    def get_npc_disposition(self, npc_id: int) -> int:
        """
        Calculate NPC disposition using Module 04 formula:
        Disposition = (Affinity × 0.6) + (FactionRep × 0.4) + Modifier
        
        Returns:
            Disposition score (-100 to +100)
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return 0
        
        character = self.get_character()
        if not character:
            return npc.affinity or 0
        
        # Base affinity (personal relationship)
        affinity = npc.affinity or 0
        
        # Faction reputation
        faction_rep = 0
        if npc.faction and character.faction_reputations:
            raw_rep = character.faction_reputations.get(npc.faction, 0)
            faction_rep = raw_rep / 10  # Normalize -1000/+1000 → -100/+100
        
        # Faction relationship modifier
        modifier = self._get_faction_modifier(npc.faction, character.faction)
        
        # Calculate
        disposition = int((affinity * 0.6) + (faction_rep * 0.4) + modifier)
        return max(-100, min(100, disposition))  # Clamp
    
    def _get_faction_modifier(self, npc_faction: Optional[str], pc_faction: Optional[str]) -> int:
        """
        Get faction relationship modifier based on inter-faction politics.
        Allied factions: +20, Enemy factions: -35, At war: -50
        """
        if not npc_faction or not pc_faction:
            return 0
        
        if npc_faction == pc_faction:
            return 20  # Same faction = allied bonus
        
        # Look up faction relationship
        relationship = self.get_faction_relationship(npc_faction, pc_faction)
        
        modifiers = {
            "allied": 20,
            "friendly": 10,
            "neutral": 0,
            "unfriendly": -15,
            "enemy": -35,
            "at_war": -50
        }
        
        return modifiers.get(relationship, 0)
    
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
    
    def get_all_factions(self) -> List["Faction"]:
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
        
        print(f"[Faction] Created: {name} (PC controls: {pc_controls})")
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
            print(f"[Faction] Invalid relationship: {relationship}")
            return
        
        from .models import Faction
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
        print(f"[Faction] {faction1_name} ↔ {faction2_name}: {relationship}")
    
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
                print(f"[Faction] PC reputation with {faction_name}: {old_rep} → {new_rep} ({reason})")
            return
        
        db = self._get_db()
        old_rep = faction.pc_reputation or 0
        new_rep = max(-1000, min(1000, old_rep + change * 10))
        faction.pc_reputation = new_rep
        db.commit()
        
        print(f"[Faction] PC reputation with {faction_name}: {old_rep} → {new_rep} ({reason})")
    
    def get_pc_controlled_factions(self) -> List["Faction"]:
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
            print(f"[Faction] {faction_name} not PC-controlled")
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
        print(f"[Faction] {npc.name} joined {faction_name} as {role}")
    
    def get_faction_context_for_op_mode(self, narrative_focus: str, preset: Optional[str] = None) -> Optional[str]:
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
    
    def get_disposition_label(self, disposition: int) -> str:
        """Get the threshold label for a disposition score."""
        for label, (low, high) in self.DISPOSITION_THRESHOLDS.items():
            if low <= disposition <= high:
                return label
        return "neutral"
    
    def check_npc_knowledge(self, npc_id: int, topic: str) -> Dict[str, Any]:
        """
        Check if NPC knows about a topic and at what depth.
        
        Args:
            npc_id: NPC ID
            topic: Topic to check
            
        Returns:
            {"knows": bool, "depth": str|None, "can_share": bool, "reason": str}
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return {"knows": False, "depth": None, "can_share": False, "reason": "npc_not_found"}
        
        # Check prohibited
        boundaries = npc.knowledge_boundaries or []
        if topic.lower() in [t.lower() for t in boundaries]:
            return {"knows": False, "depth": None, "can_share": False, "reason": "prohibited"}
        
        # Check known topics
        topics = npc.knowledge_topics or {}
        depth = topics.get(topic.lower())
        if not depth:
            return {"knows": False, "depth": None, "can_share": False, "reason": "unknown"}
        
        # Check if willing to share (affinity based)
        disposition = self.get_npc_disposition(npc_id)
        can_share = disposition >= 30 or depth == "basic"  # Friendly+, or common knowledge
        
        return {"knows": True, "depth": depth, "can_share": can_share, "reason": "known"}
    
    def get_npc_behavior_context(self, npc_id: int, situation: str = "", 
                                  narrative_scale: str = "strategic") -> str:
        """
        Generate NPC behavior guidance combining:
        - Personality (40%)
        - Situation (30%)
        - Affinity (20%)
        - Goals (10%)
        
        PLUS OP mode adjustments based on narrative scale.
        
        Args:
            npc_id: NPC ID
            situation: Current situation description
            narrative_scale: Active narrative scale (tactical, ensemble, spectacle, etc.)
            
        Returns:
            Formatted behavior guidance string for Key Animator
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return ""
        
        disposition = self.get_npc_disposition(npc_id)
        label = self.get_disposition_label(disposition)
        
        lines = [
            f"## NPC: {npc.name}",
            f"**Disposition**: {disposition} ({label.upper()})",
            f"**Role**: {npc.role or 'neutral'} | **Power**: {npc.power_tier}",
        ]
        
        if npc.personality:
            lines.append(f"**Personality**: {npc.personality}")
        
        if npc.goals:
            lines.append(f"**Goals**: {', '.join(npc.goals) if isinstance(npc.goals, list) else npc.goals}")
        
        # OP Mode behavior adjustment
        if npc.ensemble_archetype:
            lines.append(f"\n**Ensemble Archetype**: {npc.ensemble_archetype.upper()}")
            op_behavior = self._get_npc_op_behavior(
                npc.ensemble_archetype, 
                narrative_scale, 
                disposition
            )
            lines.append(f"**OP Mode Guidance**: {op_behavior}")
        
        return "\n".join(lines)
    
    def _get_npc_op_behavior(self, archetype: str, scale: str, disposition: int) -> str:
        """
        How should this NPC behave given archetype + active narrative scale?
        """
        behaviors = {
            # Ensemble archetypes in different scales
            ("struggler", "ensemble"): "Tries to keep up with PC, measures against PC's strength, drives own growth",
            ("struggler", "spectacle"): "Watches in awe, then trains harder after",
            ("heart", "ensemble"): "Emotional anchor, reminds PC of what matters beyond power",
            ("heart", "conceptual"): "Asks about feelings, not power. Grounds PC in normalcy.",
            ("skeptic", "ensemble"): "Questions PC's methods, provides narrative tension",
            ("skeptic", "faction"): "Challenges decisions in council, keeps PC accountable",
            ("dependent", "ensemble"): "Needs protection, creates stakes through vulnerability",
            ("equal", "faction"): "Has power PC lacks (social, political), can't be solved with strength",
            ("observer", "spectacle"): "Documents PC's legend, provides narration, creates mythos",
            ("observer", "mythology"): "Spreads tales, each episode adds to PC's legendarium",
            ("rival", "ensemble"): "Refuses to accept gap, pushes own parallel growth",
            ("witness", "spectacle"): "Reacts with appropriate awe/terror to power displays",
            ("subordinate", "faction"): "Reports, requests orders, respects hierarchy",
            ("subordinate", "reverse_ensemble"): "Views PC as obstacle to their own story",
            ("grounding", "conceptual"): "Creates social stakes power can't solve (romance, friendship)",
        }
        
        key = (archetype.lower(), scale.lower())
        if key in behaviors:
            return behaviors[key]
        
        # Default by scale
        scale_defaults = {
            "ensemble": "Support PC's allies, let them have moments",
            "spectacle": "React dramatically to PC's power",
            "conceptual": "Focus on emotional/social, not combat",
            "faction": "Interact within organizational hierarchy",
            "reverse_ensemble": "This NPC has their own protagonist journey",
            "mythology": "Part of episodic legend, may not recur",
            "tactical": "Act strategically, stakes are real",
            "strategic": "Balance combat tactics with character moments",
        }
        return scale_defaults.get(scale.lower(), "Behave naturally based on personality")
    
    def assign_ensemble_archetype(self, npc_id: int) -> Optional[str]:
        """
        Analyze NPC and assign appropriate ensemble archetype.
        Called by Director during session review for recurring NPCs.
        
        Returns:
            Assigned archetype or None
        """
        npc = self.get_npc(npc_id)
        if not npc or not npc.personality:
            return None
        
        personality = npc.personality.lower()
        disposition = self.get_npc_disposition(npc_id)
        
        # Archetype selection logic
        if "protective" in personality or "compassionate" in personality or "caring" in personality:
            archetype = "heart"
        elif "competitive" in personality or "ambitious" in personality or "driven" in personality:
            archetype = "struggler"
        elif "skeptical" in personality or "questioning" in personality or "analytical" in personality:
            archetype = "skeptic"
        elif npc.power_tier in ["T10", "T11"] and disposition >= 60:
            archetype = "dependent"
        elif npc.role == "rival":
            archetype = "rival"
        elif "observant" in personality or "chronicler" in personality:
            archetype = "observer"
        else:
            archetype = "witness"  # Default
        
        # Update NPC
        db = self._get_db()
        npc.ensemble_archetype = archetype
        db.commit()
        
        return archetype
    
    def update_npc_affinity(self, npc_id: int, change: int, reason: str = ""):
        """
        Update NPC affinity and recalculate disposition.
        
        Args:
            npc_id: NPC ID
            change: Amount to change affinity (-50 to +50 typically)
            reason: Reason for change (for logging)
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return None
        
        db = self._get_db()
        old_affinity = npc.affinity or 0
        new_affinity = max(-100, min(100, old_affinity + change))
        npc.affinity = new_affinity
        
        # Calculate old and new disposition
        old_disposition = npc.disposition or 0
        new_disposition = self.get_npc_disposition(npc_id)
        npc.disposition = new_disposition
        
        # Check for threshold crossing
        milestone = self._check_disposition_milestone(old_disposition, new_disposition, npc.name)
        
        self._maybe_commit()
        print(f"[NPC] {npc.name} affinity: {old_affinity} → {new_affinity} ({reason})")
        
        return milestone  # Returns event dict or None
    
    def _check_disposition_milestone(self, old_disp: int, new_disp: int, npc_name: str) -> Optional[Dict[str, Any]]:
        """
        Check if disposition crossed a threshold and return milestone event.
        
        Thresholds (Module 04):
        - HOSTILE (-100 to -61): Active obstruction
        - UNFRIENDLY (-60 to -21): Dismissive
        - NEUTRAL (-20 to 29): Indifferent
        - FRIENDLY (30 to 59): Helpful
        - TRUSTED (60 to 89): Confides secrets
        - DEVOTED (90 to 100): Takes personal risks
        """
        old_label = self.get_disposition_label(old_disp)
        new_label = self.get_disposition_label(new_disp)
        
        if old_label == new_label:
            return None  # No threshold crossed
        
        # Milestone events for threshold crossings
        milestone_events = {
            # Positive transitions
            ("neutral", "friendly"): {
                "type": "threshold_up",
                "event": "trust_gained",
                "description": f"{npc_name}'s wall is coming down. They're starting to warm up to you.",
                "dialogue_hint": "More open, willing to share opinions and gossip"
            },
            ("friendly", "trusted"): {
                "type": "threshold_up", 
                "event": "trust_deepened",
                "description": f"{npc_name} truly trusts you now. They'll confide secrets and offer significant aid.",
                "dialogue_hint": "Shares personal information, offers keys/access, defends you to others"
            },
            ("trusted", "devoted"): {
                "type": "threshold_up",
                "event": "devotion_earned",
                "description": f"{npc_name} is completely devoted. They would take personal risks for you.",
                "dialogue_hint": "Fierce loyalty, protective, may sacrifice for you"
            },
            # Negative transitions
            ("neutral", "unfriendly"): {
                "type": "threshold_down",
                "event": "trust_lost",
                "description": f"{npc_name} is cooling toward you. They've become dismissive.",
                "dialogue_hint": "Short answers, reluctant to engage, provides no useful info"
            },
            ("unfriendly", "hostile"): {
                "type": "threshold_down",
                "event": "hostility_triggered",
                "description": f"{npc_name} is now actively hostile. They may obstruct or attack.",
                "dialogue_hint": "Aggressive, threatening, may attack on sight"
            },
            ("friendly", "neutral"): {
                "type": "threshold_down",
                "event": "warmth_faded",
                "description": f"{npc_name} has become distant. Something changed.",
                "dialogue_hint": "Transactional only, no personal warmth"
            },
        }
        
        key = (old_label, new_label)
        if key in milestone_events:
            event = milestone_events[key].copy()
            event["npc_name"] = npc_name
            event["old_threshold"] = old_label
            event["new_threshold"] = new_label
            print(f"[NPC Milestone] {npc_name}: {old_label} → {new_label}")
            return event
        
        return None
    
    def detect_npcs_in_text(self, text: str) -> List[str]:
        """
        Detect known NPC names mentioned in narrative text.
        Used to populate present_npcs for context.
        
        Args:
            text: Narrative or situation text
            
        Returns:
            List of NPC names found
        """
        db = self._get_db()
        npcs = db.query(NPC).filter(NPC.campaign_id == self.campaign_id).all()
        
        found = []
        text_lower = text.lower()
        for npc in npcs:
            if npc.name.lower() in text_lower:
                found.append(npc.name)
        
        return found
    
    def evolve_npc_intelligence(self, npc_id: int, interaction_count: int, trust_milestone: bool = False):
        """
        Progress NPC cognitive evolution based on interactions.
        
        Stages (Module 04):
        - REACTIVE (default): Responds to direct stimuli
        - CONTEXTUAL (5+ interactions): Remembers patterns
        - ANTICIPATORY (trust + shared challenge): Proactively prepares
        - AUTONOMOUS (major quest + high affinity): Acts independently
        
        Args:
            npc_id: NPC ID
            interaction_count: Number of meaningful interactions
            trust_milestone: Whether trust threshold was just crossed
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return
        
        current_stage = npc.intelligence_stage or "reactive"
        new_stage = current_stage
        disposition = self.get_npc_disposition(npc_id)
        
        # Progression logic
        if current_stage == "reactive" and interaction_count >= 5:
            new_stage = "contextual"
        elif current_stage == "contextual" and trust_milestone and disposition >= 60:
            new_stage = "anticipatory"
        elif current_stage == "anticipatory" and disposition >= 80:
            # Requires major quest completion together (tracked elsewhere)
            new_stage = "autonomous"
        
        if new_stage != current_stage:
            db = self._get_db()
            npc.intelligence_stage = new_stage
            self._maybe_commit()
            print(f"[NPC Evolution] {npc.name}: {current_stage} → {new_stage}")
    
    # Valid emotional milestone types (Module 04 P5-16)
    EMOTIONAL_MILESTONE_TYPES = [
        "first_humor",      # Laughed together
        "first_concern",    # Showed genuine worry for PC
        "first_disagreement",  # Had a real argument
        "first_initiative", # Acted independently to help
        "first_sacrifice",  # Took a hit for PC
        "first_vulnerability",  # Shared deep fear/secret
        "first_trust_test", # PC could have betrayed but didn't
    ]
    
    def record_emotional_milestone(
        self, 
        npc_id: int, 
        milestone_type: str, 
        context: str,
        session_id: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Record an emotional milestone for an NPC relationship.
        Only records if this is the FIRST time (milestones are "firsts").
        
        Args:
            npc_id: NPC ID
            milestone_type: One of EMOTIONAL_MILESTONE_TYPES
            context: Description of what happened
            session_id: Session when it occurred
            
        Returns:
            Milestone event if new, None if already recorded
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return None
        
        if milestone_type not in self.EMOTIONAL_MILESTONE_TYPES:
            print(f"[NPC] Invalid milestone type: {milestone_type}")
            return None
        
        # Get existing milestones
        milestones = npc.emotional_milestones or {}
        
        # Check if already recorded
        if milestone_type in milestones and milestones[milestone_type]:
            return None  # Already happened, not a first
        
        # Record the milestone
        db = self._get_db()
        milestones[milestone_type] = {
            "session": session_id,
            "context": context,
            "turn": self._turn_number
        }
        npc.emotional_milestones = milestones
        self._maybe_commit()
        
        print(f"[NPC Milestone] {npc.name}: {milestone_type} - {context[:50]}...")
        
        # Return event for potential narrative use
        return {
            "type": "emotional_milestone",
            "milestone": milestone_type,
            "npc_name": npc.name,
            "context": context,
            "narrative_hint": self._get_milestone_narrative_hint(milestone_type)
        }
    
    def _get_milestone_narrative_hint(self, milestone_type: str) -> str:
        """Get narrative guidance for a milestone type."""
        hints = {
            "first_humor": "This shared laughter deepens the bond. Reference this moment in future banter.",
            "first_concern": "NPC now worries about PC's wellbeing. May ask 'Are you okay?' proactively.",
            "first_disagreement": "Relationship survived conflict. NPC respects PC's conviction even if disagrees.",
            "first_initiative": "NPC now acts independently to help. May prepare supplies, scout ahead.",
            "first_sacrifice": "Profound bond. NPC becomes protective, may mention 'I'd do it again.'",
            "first_vulnerability": "Deep trust. NPC confides fears/secrets. Betraying this = catastrophic.",
            "first_trust_test": "PC proved trustworthy. NPC's skepticism fades, offers true loyalty.",
        }
        return hints.get(milestone_type, "This moment matters to the relationship.")
    
    def get_emotional_milestones(self, npc_id: int) -> Dict[str, Any]:
        """
        Get all emotional milestones for an NPC, including which haven't happened yet.
        
        Returns:
            Dict with all milestone types, recorded ones have data, others are None
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return {}
        
        milestones = npc.emotional_milestones or {}
        
        # Return all types, marking unfulfilled as None
        result = {}
        for m_type in self.EMOTIONAL_MILESTONE_TYPES:
            result[m_type] = milestones.get(m_type)
        
        return result
    
    def increment_npc_interaction(self, npc_id: int) -> int:
        """
        Increment interaction count for cognitive evolution tracking.
        
        Returns:
            New interaction count
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return 0
        
        db = self._get_db()
        npc.interaction_count = (npc.interaction_count or 0) + 1
        self._maybe_commit()
        
        return npc.interaction_count
    
    def get_npc_interaction_count(self, npc_id: int) -> int:
        """Get the current interaction count for an NPC.
        
        Returns:
            Interaction count, or 0 if NPC not found
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return 0
        return npc.interaction_count or 0
    
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

