"""Core mixin: infrastructure, sessions, context, turns, foreshadowing.

Split from state_manager.py for maintainability.
"""

import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session as SQLAlchemySession

from ..enums import ArcPhase
from .models import (
    NPC,
    Campaign,
    CampaignBible,
    Character,
    Consequence,
    ForeshadowingSeedDB,
    Location,
    MediaAsset,
    Quest,
    Session,
    Turn,
    WorldState,
)
from .session import create_session, init_db

logger = logging.getLogger(__name__)

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
    present_npcs: list[str]

    # #3: Pacing gate counter (default field must come after non-default fields)
    turns_in_phase: int = 0

    # #5: Pinned messages (exchanges that stay in working memory regardless of window)
    pinned_messages: list[dict] = field(default_factory=list)

    # OP Protagonist Mode (3-Axis System)
    op_protagonist_enabled: bool = False
    op_tension_source: str | None = None      # existential, relational, moral, burden, information, consequence, control
    op_power_expression: str | None = None    # instantaneous, overwhelming, sealed, hidden, conditional, derivative, passive
    op_narrative_focus: str | None = None     # internal, ensemble, reverse_ensemble, episodic, faction, mundane, competition, legacy
    op_preset: str | None = None              # Optional preset name

    # Power Differential System (unifies profile composition + character OP mode)
    power_tier: str = "T10"                       # Character's current power tier
    world_tier: str = "T8"                        # World's baseline power tier (from profile)
    effective_composition: dict[str, Any] | None = None  # Calculated from differential

    # Progressive OP Mode tracking
    high_imbalance_count: int = 0  # Encounters where imbalance > 10
    op_suggestion_dismissed: bool = False  # Player dismissed suggestion
    pending_op_suggestion: dict[str, Any] | None = None  # Suggestion waiting for response

    # Power Scaling (Module 12)
    power_imbalance: float = 1.0  # PC power ÷ threat power (with context modifiers)
    narrative_scale: str = "strategic"  # tactical, strategic, ensemble, spectacle, conceptual

    # Party/Ensemble Detection (Module 12)
    has_party: bool = False  # True if NPCs with ally role exist
    party_tier_delta: float = 0.0  # PC tier - avg ally tier (high = ensemble appropriate)

    # Canonicality (from Session Zero - how story relates to source material)
    timeline_mode: str | None = None       # canon_adjacent, alternate, inspired
    canon_cast_mode: str | None = None     # full_cast, replaced_protagonist, npcs_only
    event_fidelity: str | None = None      # observable, influenceable, background

    # Narrative Identity (deterministic, every turn - NOT from RAG)
    character_concept: str | None = None
    character_age: int | None = None
    character_backstory: str | None = None
    character_appearance: str | None = None   # Formatted string
    character_personality: str | None = None  # Formatted string
    character_values: str | None = None       # Formatted string
    character_fears: str | None = None        # Formatted string
    character_goals: str | None = None        # Formatted string


class CoreMixin:
    """Infrastructure, session management, context, turns, foreshadowing."""

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
            from .models import NPC, CampaignBible, Faction, Turn
            from .models import SessionZeroState, WikiPage, ApiCacheEntry, SessionProfileComposition

            try:
                db.query(MediaAsset).delete()
                db.query(Quest).delete()
                db.query(Location).delete()
                db.query(Consequence).delete()
                db.query(ForeshadowingSeedDB).delete()
                db.query(Turn).delete()
                db.query(Session).delete()
                db.query(NPC).delete()
                db.query(Faction).delete()
                db.query(CampaignBible).delete()
                db.query(WorldState).delete()
                db.query(Character).delete()
                db.query(Campaign).delete()
                # Consolidated stores
                db.query(SessionZeroState).delete()
                db.query(WikiPage).delete()
                db.query(ApiCacheEntry).delete()
                db.query(SessionProfileComposition).delete()
                db.commit()
                logger.info("Full reset: cleared all campaign data from DB")
            except OperationalError as e:
                logger.error(f"Warning: Table delete failed (likely missing schema): {e}")
                db.rollback()
        finally:
            db.close()

        # Ensure DB is initialized (recreate tables if missing)
        try:
            init_db()
        except Exception as e:
            logger.error(f"Warning: init_db failed during reset: {e}")

        # Clear campaign memory collections from ChromaDB
        try:
            import chromadb
            client = chromadb.PersistentClient(path="./data/chroma")
            for col in client.list_collections():
                if col.name.startswith("campaign_"):
                    client.delete_collection(col.name)
                    logger.info(f"Deleted memory collection: {col.name}")
        except Exception as e:
            logger.warning(f"Warning: Could not clear ChromaDB collections: {e}")

        # Clear campaign media folders (preserve templates/ and references/)
        try:
            import shutil
            from pathlib import Path
            media_base = Path("./data/media")
            if media_base.exists():
                preserved = {"templates", "references"}
                for child in media_base.iterdir():
                    if child.is_dir() and child.name not in preserved:
                        shutil.rmtree(child)
                        logger.info(f"Deleted media folder: {child}")
        except Exception as e:
            logger.warning(f"Warning: Could not clear media folders: {e}")

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
                logger.info(f"Created new campaign: id={campaign.id}, profile_id={profile_id}")

                # Create supporting entities for the new campaign
                # WorldState
                world_state = WorldState(
                    campaign_id=campaign.id,
                    location="Unknown",
                    time_of_day="Day",
                    situation="The adventure begins...",
                    arc_phase=ArcPhase.RISING_ACTION,
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
                logger.info(f"Created supporting entities for campaign {campaign.id}")

            return campaign.id
        finally:
            db.close()

    def __init__(self, campaign_id: int):
        self.campaign_id = campaign_id
        self._db: SQLAlchemySession | None = None
        self._session_id: int | None = None
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
            logger.info("Deferred commit: all changes committed atomically")
        except Exception:
            db.rollback()
            logger.error("Deferred commit: ROLLBACK due to exception")
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
                arc_phase=ArcPhase.RISING_ACTION,
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

    def get_current_session_model(self) -> Session | None:
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
            arc_phase=world_state.arc_phase if world_state else ArcPhase.RISING_ACTION,
            tension_level=world_state.tension_level if world_state else 0.5,
            turns_in_phase=getattr(world_state, 'turns_in_phase', 0) or 0 if world_state else 0,
            pinned_messages=getattr(world_state, 'pinned_messages', []) or [] if world_state else [],
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

    def _detect_present_npcs(self, recent_summary: str, world_state: WorldState | None) -> list[str]:
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
        intent: dict[str, Any],
        outcome: dict[str, Any],
        narrative: str,
        latency_ms: int,
        cost_usd: float | None = None,
        portrait_map: dict[str, str] | None = None,
        prompt_fingerprint: str | None = None,
        prompt_name: str | None = None,
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
            cost_usd=cost_usd,
            portrait_map=portrait_map,
            prompt_fingerprint=prompt_fingerprint,
            prompt_name=prompt_name,
        )
        db.add(turn)

        # Update session turn count
        session = db.query(Session).filter(Session.id == session_id).first()
        if session:
            session.turn_count = self._turn_number

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

    def get_turn_narrative(self, turn_number: int) -> str | None:
        """Get the full narrative text for a specific turn.
        
        Used by the Journal API for full-text expansion mode.
        
        Args:
            turn_number: The turn number to retrieve
            
        Returns:
            Full narrative text, or None if turn not found
        """
        db = self._get_db()
        session_id = self.get_or_create_session()

        turn = (
            db.query(Turn)
            .filter(
                Turn.session_id == session_id,
                Turn.turn_number == turn_number,
                Turn.narrative.isnot(None)
            )
            .first()
        )

        return turn.narrative if turn else None

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
                # Causal chains (#11) — were missing, causing silent data loss on restart
                "depends_on": row.depends_on or [],
                "triggers": row.triggers or [],
                "conflicts_with": row.conflicts_with or [],
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
