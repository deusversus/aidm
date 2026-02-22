"""SQLAlchemy database models for AIDM v3."""

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import declarative_base, relationship

from ..enums import ArcPhase, NPCIntelligenceStage

Base = declarative_base()


class Campaign(Base):
    """A campaign is a long-running game with a specific narrative profile."""

    __tablename__ = "campaigns"

    id = Column(Integer, primary_key=True)
    media_uuid = Column(String(36), nullable=False, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    profile_id = Column(String(100), nullable=False)  # e.g., "hunterxhunter"
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    sessions = relationship("Session", back_populates="campaign", cascade="all, delete-orphan")
    characters = relationship("Character", back_populates="campaign", cascade="all, delete-orphan")
    npcs = relationship("NPC", back_populates="campaign", cascade="all, delete-orphan")
    factions = relationship("Faction", back_populates="campaign", cascade="all, delete-orphan")
    overrides = relationship("Override", back_populates="campaign", cascade="all, delete-orphan")
    foreshadowing_seeds = relationship("ForeshadowingSeedDB", back_populates="campaign", cascade="all, delete-orphan")
    world_state = relationship("WorldState", back_populates="campaign", uselist=False, cascade="all, delete-orphan")
    campaign_bible = relationship("CampaignBible", back_populates="campaign", uselist=False, cascade="all, delete-orphan")
    consequences = relationship("Consequence", back_populates="campaign", cascade="all, delete-orphan")  # #17
    quests = relationship("Quest", back_populates="campaign", cascade="all, delete-orphan")
    locations = relationship("Location", back_populates="campaign", cascade="all, delete-orphan")
    media_assets = relationship("MediaAsset", back_populates="campaign", cascade="all, delete-orphan")


class Session(Base):
    """A play session within a campaign (typically 1-3 hours)."""

    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    started_at = Column(DateTime, default=datetime.utcnow)
    ended_at = Column(DateTime, nullable=True)
    turn_count = Column(Integer, default=0)
    summary = Column(Text, nullable=True)  # Generated at session end

    campaign = relationship("Campaign", back_populates="sessions")
    turns = relationship("Turn", back_populates="session", cascade="all, delete-orphan")


class Turn(Base):
    """A single turn in the game loop."""

    __tablename__ = "turns"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    turn_number = Column(Integer, nullable=False)

    # Player input
    player_input = Column(Text, nullable=False)

    # Agent decisions (JSON for flexibility)
    intent = Column(JSON, nullable=True)       # Intent classifier output
    outcome = Column(JSON, nullable=True)      # Outcome judge output

    # Final output
    narrative = Column(Text, nullable=True)    # Key animator output
    state_changes = Column(JSON, nullable=True)
    portrait_map = Column(JSON, nullable=True)  # {"NPC Name": "/api/game/media/..."}

    # Metadata
    created_at = Column(DateTime, default=datetime.utcnow)
    latency_ms = Column(Integer, nullable=True)
    cost_usd = Column(Float, nullable=True)

    session = relationship("Session", back_populates="turns")


class Character(Base):
    """Player character in a campaign."""

    __tablename__ = "characters"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    name = Column(String(255), nullable=False)

    # Core stats
    level = Column(Integer, default=1)
    xp_current = Column(Integer, default=0)  # Current XP
    xp_to_next_level = Column(Integer, default=100)  # XP needed for next level
    character_class = Column(String(100), nullable=True)  # e.g., "warrior", "mage"
    hp_current = Column(Integer, default=100)
    hp_max = Column(Integer, default=100)
    mp_current = Column(Integer, default=50)  # Mana/Magic Points
    mp_max = Column(Integer, default=50)
    sp_current = Column(Integer, default=50)  # Stamina/Skill Points
    sp_max = Column(Integer, default=50)
    stats = Column(JSON, default=dict)  # Dynamic stats (STR, INT, Chakra, etc.)

    # Power system (profile-specific)
    power_tier = Column(String(10), default="T10")  # VS Battles tier
    abilities = Column(JSON, default=list)
    inventory = Column(JSON, default=list)

    # Narrative state
    # OP Mode 3-Axis System (replaces single archetype)
    op_enabled = Column(Boolean, default=False)
    op_tension_source = Column(String(50), nullable=True)      # existential, relational, moral, burden, information, consequence, control
    op_power_expression = Column(String(50), nullable=True)    # instantaneous, overwhelming, sealed, hidden, conditional, derivative, passive
    op_narrative_focus = Column(String(50), nullable=True)     # internal, ensemble, reverse_ensemble, episodic, faction, mundane, competition, legacy
    op_preset = Column(String(50), nullable=True)              # Optional preset name (bored_god, hidden_ruler, etc.)
    narrative_goals = Column(JSON, default=list)    # e.g. ["Become Hokage"]
    calibration_score = Column(Float, default=1.0)  # 0.0 to 1.0 (How well it fits profile)
    story_flags = Column(JSON, default=dict)

    # Narrative Identity (from Session Zero - deterministic, not RAG)
    concept = Column(Text, nullable=True)              # High-level tagline
    age = Column(Integer, nullable=True)               # Character age
    backstory = Column(Text, nullable=True)            # Backstory summary
    appearance = Column(JSON, default=dict)            # {hair, eyes, outfit, etc.}
    visual_tags = Column(JSON, default=list)            # ["blue_hair", "scar_left_eye", "tall"]
    model_sheet_url = Column(String(500), nullable=True)  # Full-body reference (source of truth)
    portrait_url = Column(String(500), nullable=True)     # Derived head-and-shoulders
    personality_traits = Column(JSON, default=list)    # List of traits
    values = Column(JSON, default=list)                # Core values
    fears = Column(JSON, default=list)                 # Fears/Flaws
    quirks = Column(JSON, default=list)                # Quirks/habits
    short_term_goal = Column(Text, nullable=True)      # Current immediate objective
    long_term_goal = Column(Text, nullable=True)       # Ultimate aspiration

    # Faction system (Module 04)
    faction = Column(String(100), nullable=True)  # PC's primary faction
    faction_reputations = Column(JSON, default=dict)  # {"faction_name": reputation_score}

    campaign = relationship("Campaign", back_populates="characters")


class NPC(Base):
    """Non-player character in a campaign."""

    __tablename__ = "npcs"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    name = Column(String(255), nullable=False)

    # Basics
    role = Column(String(100), nullable=True)  # ally, enemy, neutral, rival
    power_tier = Column(String(10), default="T10")
    faction = Column(String(100), nullable=True)  # For disposition calculation

    # Relationship with PC (Module 04)
    affinity = Column(Integer, default=0)  # Personal relationship (-100 to +100)
    disposition = Column(Integer, default=0)  # Calculated: (affinity*0.6)+(faction*0.4)+modifier
    relationship_notes = Column(Text, nullable=True)

    # Knowledge System (Module 04)
    knowledge_topics = Column(JSON, default=dict)  # {"topic": "expert|moderate|basic"}
    knowledge_boundaries = Column(JSON, default=list)  # ["prohibited topic 1", ...]

    # Narrative
    personality = Column(Text, nullable=True)
    goals = Column(JSON, default=list)
    secrets = Column(JSON, default=list)

    # Ensemble/OP Integration (Module 04 + 12)
    ensemble_archetype = Column(String(50), nullable=True)  # struggler, heart, skeptic, dependent, equal, observer, rival
    growth_stage = Column(String(50), default="introduction")  # bonding, challenge, growth, mastery
    narrative_role = Column(String(50), nullable=True)  # witness, subordinate, grounding, protagonist

    # Cognitive Evolution (Module 04)
    intelligence_stage = Column(String(50), default=NPCIntelligenceStage.REACTIVE)  # contextual, anticipatory, autonomous

    # Emotional Milestones (Module 04) - Tracking relationship "firsts"
    # {"first_humor": {"session": 3, "context": "..."}, "first_sacrifice": null, ...}
    emotional_milestones = Column(JSON, default=dict)

    # Tracking
    scene_count = Column(Integer, default=0)  # For spotlight tracking
    last_appeared = Column(Integer, nullable=True)  # Turn number
    interaction_count = Column(Integer, default=0)  # For cognitive evolution

    campaign = relationship("Campaign", back_populates="npcs")

    # Visual Identity (generated by MediaGenerator)
    appearance = Column(JSON, default=dict)            # {hair, eyes, outfit, etc.}
    visual_tags = Column(JSON, default=list)            # ["blue_hair", "scar_left_eye", "tall"]
    model_sheet_url = Column(String(500), nullable=True)  # Full-body reference
    portrait_url = Column(String(500), nullable=True)     # Derived portrait


class WorldState(Base):
    """Current world state for a campaign."""

    __tablename__ = "world_state"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False, unique=True)

    # Current context
    location = Column(String(255), nullable=True)
    time_of_day = Column(String(50), nullable=True)
    situation = Column(Text, nullable=True)

    # Arc tracking (for Director, Phase 4)
    arc_name = Column(String(255), nullable=True)
    arc_phase = Column(String(50), default=ArcPhase.RISING_ACTION)
    tension_level = Column(Float, default=0.5)  # 0.0 to 1.0
    turns_in_phase = Column(Integer, default=0)  # #3: pacing gate counter

    # Canonicality (from Session Zero)
    timeline_mode = Column(String(50), nullable=True)      # canon_adjacent, alternate, inspired
    canon_cast_mode = Column(String(50), nullable=True)    # full_cast, replaced_protagonist, npcs_only
    event_fidelity = Column(String(50), nullable=True)     # observable, influenceable, background

    # Foreshadowing seeds planted (for Phase 4)
    foreshadowing = Column(JSON, default=list)

    # #5: Pinned messages (up to 5 exchanges that stay in working memory)
    pinned_messages = Column(JSON, default=list)

    campaign = relationship("Campaign", back_populates="world_state")


class Consequence(Base):
    """#17: Structured consequence tracking for a campaign.
    
    Replaces unstructured text appends to world_state.situation with
    queryable, categorized, expirable consequence records.
    """

    __tablename__ = "consequences"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    turn = Column(Integer, nullable=False)                    # When it occurred
    source_action = Column(String(500), nullable=True)        # What caused it
    description = Column(Text, nullable=False)                 # The consequence text
    category = Column(String(50), default="general")           # political/environmental/relational/economic/magical/general
    severity = Column(String(20), default="minor")             # minor/moderate/major/catastrophic
    active = Column(Boolean, default=True)                     # Still in effect?
    expires_turn = Column(Integer, nullable=True)              # Auto-expire after N turns (null = permanent)
    created_at = Column(DateTime, default=datetime.utcnow)

    campaign = relationship("Campaign", back_populates="consequences")


class CampaignBible(Base):
    """The Director's private planning document (Phase 4).
    
    Stores long-term arcs, foreshadowing plans, and spotlight tracking.
    This is separate from WorldState, which is the 'current' truth.
    """

    __tablename__ = "campaign_bible"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False, unique=True)

    # The "Series Bible" content
    planning_data = Column(JSON, default=dict)

    # Versioning (#2) — increments on each Director update
    bible_version = Column(Integer, default=0)

    # Tracking
    last_updated_turn = Column(Integer, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    campaign = relationship("Campaign", back_populates="campaign_bible")


class Faction(Base):
    """Faction in the game world.
    
    Used for:
    - NPC disposition modifiers
    - Inter-faction politics
    - OP Protagonist faction management (Overlord, Rimuru archetypes)
    """

    __tablename__ = "factions"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    name = Column(String(255), nullable=False)

    # Description
    description = Column(Text, nullable=True)
    alignment = Column(String(50), nullable=True)  # e.g., "lawful", "chaotic", "neutral"

    # Power and influence
    power_level = Column(String(50), default="regional")  # local, regional, national, continental, global
    influence_score = Column(Integer, default=50)  # 0-100, affects world events

    # Inter-faction relationships
    # {"faction_name": "allied" | "friendly" | "neutral" | "unfriendly" | "enemy" | "at_war"}
    relationships = Column(JSON, default=dict)

    # PC membership status
    pc_is_member = Column(Boolean, default=False)
    pc_rank = Column(String(100), nullable=True)  # e.g., "Initiate", "Commander", "Supreme Overlord"
    pc_reputation = Column(Integer, default=0)  # -1000 to +1000

    # OP Mode: Faction Management (Overlord/Rimuru archetype)
    # If PC controls this faction, enable management features
    pc_controls = Column(Boolean, default=False)  # True = PC is faction leader
    subordinates = Column(JSON, default=list)  # NPC IDs who serve PC in this faction
    faction_goals = Column(JSON, default=list)  # Active faction objectives

    # Narrative hooks
    secrets = Column(JSON, default=list)  # Faction secrets PC might discover
    current_events = Column(JSON, default=list)  # Active faction storylines

    campaign = relationship("Campaign", back_populates="factions")


class Override(Base):
    """
    Player override (hard constraint) for a campaign.
    
    Unlike META feedback (stored in memory, sanity-checked), Overrides are:
    - ALWAYS enforced (no decay, no sanity check)
    - Injected directly into agent context (not via RAG)
    - Scoped to campaign (deleted on session reset)
    
    Use for player "lines in the sand" that must be respected.
    """
    __tablename__ = "overrides"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)

    # Override content
    category = Column(String(50), nullable=False)  # NPC_PROTECTION, CONTENT_CONSTRAINT, NARRATIVE_DEMAND, TONE_REQUIREMENT
    description = Column(Text, nullable=False)  # Player's description of constraint
    target = Column(String(255), nullable=True)  # NPC name, topic, etc. (optional)

    # State
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationship
    campaign = relationship("Campaign", back_populates="overrides")


class ForeshadowingSeedDB(Base):
    """Persisted foreshadowing seed (#10).
    
    Mirrors the Pydantic ForeshadowingSeed schema from core/foreshadowing.py.
    Seeds survive server restarts — unblocks the full foreshadowing system (#9, #12).
    """

    __tablename__ = "foreshadowing_seeds"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    seed_id = Column(String(100), nullable=False, unique=True)  # e.g. "seed_1_3"
    seed_type = Column(String(50), nullable=False)     # plot, character, mystery, threat, promise, chekhov, relationship
    status = Column(String(50), default="planted")     # planted, growing, callback, resolved, abandoned, overdue

    # Content
    description = Column(Text, nullable=False)
    planted_narrative = Column(Text, nullable=True)
    expected_payoff = Column(Text, nullable=True)

    # Tracking
    planted_turn = Column(Integer, nullable=False)
    planted_session = Column(Integer, nullable=False)
    mentions = Column(Integer, default=1)
    last_mentioned_turn = Column(Integer, nullable=True)

    # Timing
    min_turns_to_payoff = Column(Integer, default=5)
    max_turns_to_payoff = Column(Integer, default=50)
    urgency = Column(Float, default=0.5)

    # Resolution
    resolved_turn = Column(Integer, nullable=True)
    resolution_narrative = Column(Text, nullable=True)

    # Metadata (JSON arrays)
    tags = Column(JSON, default=list)
    related_npcs = Column(JSON, default=list)
    related_locations = Column(JSON, default=list)

    # Causal Chains (#11)
    depends_on = Column(JSON, default=list)       # Seed IDs that must resolve before this seed is callback-ready
    triggers = Column(JSON, default=list)          # Seed IDs to auto-plant when this seed resolves
    conflicts_with = Column(JSON, default=list)    # Seed IDs that get abandoned when this seed resolves

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    campaign = relationship("Campaign", back_populates="foreshadowing_seeds")


class Quest(Base):
    """A quest/objective tracked by the dual-agent management system.
    
    Director Agent: Creates quests, retires completed arcs, plans objectives.
    Pacing Agent: Marks objectives complete, updates status per-turn.
    Override Handler: Routes player /META quest requests to Director.
    """

    __tablename__ = "quests"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)

    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    status = Column(String(50), default="active")       # active, completed, failed, abandoned
    quest_type = Column(String(50), default="main")      # main, side, personal, faction
    source = Column(String(50), default="director")      # director, player, npc, world

    # Objectives: [{ description, completed, turn_completed }]
    objectives = Column(JSON, default=list)

    # Tracking
    created_turn = Column(Integer, nullable=True)
    completed_turn = Column(Integer, nullable=True)

    # Connections
    related_npcs = Column(JSON, default=list)
    related_locations = Column(JSON, default=list)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    campaign = relationship("Campaign", back_populates="quests")


class Location(Base):
    """A discovered location with rich visual and spatial data.
    
    Enriched for media generation: visual_tags, atmosphere, lighting, scale
    provide grounding for image/video prompts. Spatial relationships enable
    consistent camera movements and scene transitions.
    """

    __tablename__ = "locations"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)

    # Identity
    name = Column(String(255), nullable=False)
    aliases = Column(JSON, default=list)
    location_type = Column(String(50), nullable=True)     # city, dungeon, wilderness, building, interior, region

    # Visual grounding (media generation)
    description = Column(Text, nullable=True)              # Vivid atmospheric prose
    visual_tags = Column(JSON, default=list)               # ["gothic_architecture", "neon_signs", "rain"]
    atmosphere = Column(String(100), nullable=True)        # "oppressive", "serene", "chaotic"
    lighting = Column(String(100), nullable=True)          # "dim torchlight", "moonlit"
    scale = Column(String(50), nullable=True)              # "intimate", "grand", "vast"

    # Spatial relationships
    parent_location = Column(String(255), nullable=True)
    connected_locations = Column(JSON, default=list)       # [{ name, direction, distance, travel_descriptor }]

    # State tracking
    current_state = Column(String(100), default="intact")
    state_history = Column(JSON, default=list)             # [{ turn, from_state, to_state, cause }]

    # Discovery & visits
    discovered_turn = Column(Integer, nullable=True)
    times_visited = Column(Integer, default=1)
    last_visited_turn = Column(Integer, nullable=True)
    is_current = Column(Boolean, default=False)

    # Narrative
    notable_events = Column(JSON, default=list)
    known_npcs = Column(JSON, default=list)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    campaign = relationship("Campaign", back_populates="locations")


class MediaAsset(Base):
    """Tracks all generated media assets (images, videos, cutscenes).
    
    Used for:
    - Budget enforcement (sum cost_usd per session)
    - Gallery display (all media for a campaign)
    - Turn-level media association (which turn triggered this media)
    - Async status tracking (Veo generation polling)
    """

    __tablename__ = "media_assets"

    id = Column(Integer, primary_key=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=True)
    turn_number = Column(Integer, nullable=True)

    # Classification
    asset_type = Column(String(20), nullable=False)          # "image" or "video"
    cutscene_type = Column(String(50), nullable=True)        # CutsceneType value

    # File references
    file_path = Column(String(500), nullable=False)          # Relative to data/media/
    thumbnail_path = Column(String(500), nullable=True)      # For video thumbnails

    # Generation details
    image_prompt = Column(Text, nullable=True)
    motion_prompt = Column(Text, nullable=True)              # For video
    duration_seconds = Column(Float, nullable=True)          # Video duration

    # Cost tracking
    cost_usd = Column(Float, default=0.0)

    # Async status
    status = Column(String(20), default="pending")           # pending/generating/complete/failed
    error_message = Column(Text, nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    campaign = relationship("Campaign", back_populates="media_assets")


# ═══════════════════════════════════════════════════════════════════════════════
# Consolidated stores (formerly separate SQLite databases)
# ═══════════════════════════════════════════════════════════════════════════════


class SessionZeroState(Base):
    """Session Zero conversation state (replaces data/sessions.db).

    Stores the full Session Zero conversation as a JSON blob,
    allowing sessions to survive server restarts.
    """

    __tablename__ = "session_zero_states"

    session_id = Column(String(64), primary_key=True)
    data = Column(Text, nullable=False)  # JSON blob of Session.to_dict()
    created_at = Column(String(50), nullable=False)  # ISO format
    last_activity = Column(String(50), nullable=False)  # ISO format


class WikiPage(Base):
    """Structured wiki lore page (replaces data/lore_store.db).

    Each wiki page is stored individually with metadata, enabling
    queryable per-page access, incremental updates, and quality metrics.
    ChromaDB remains the vector search layer — this is the structured
    source-of-truth that feeds it.
    """

    __tablename__ = "wiki_pages"

    id = Column(Integer, primary_key=True)
    profile_id = Column(String(100), nullable=False, index=True)
    page_title = Column(String(500), nullable=False)
    page_type = Column(String(50), nullable=False)
    content = Column(Text, nullable=False)
    word_count = Column(Integer, default=0)
    source_wiki = Column(String(200), default="")
    scraped_at = Column(Float, nullable=False)  # Unix timestamp

    __table_args__ = (
        sa.UniqueConstraint("profile_id", "page_title", name="uq_wiki_profile_title"),
        sa.Index("idx_wiki_profile_type", "profile_id", "page_type"),
    )


class ApiCacheEntry(Base):
    """API response cache with TTL (replaces data/scraper_cache.db).

    Status-aware TTL based on AniList series status:
    - FINISHED: 90-day TTL
    - RELEASING: 3-day TTL
    - HIATUS: 14-day TTL
    """

    __tablename__ = "api_cache"

    cache_key = Column(String(256), primary_key=True)
    cache_type = Column(String(20), nullable=False, index=True)
    data = Column(Text, nullable=False)  # JSON blob
    series_status = Column(String(20), default="FINISHED")
    created_at = Column(Float, nullable=False)  # Unix timestamp
    expires_at = Column(Float, nullable=False, index=True)  # Unix timestamp
    title = Column(String(500), default="")


class SessionProfileComposition(Base):
    """Session profile composition (replaces session_profiles table in data/sessions.db).

    Stores composition metadata: what base profiles are linked,
    with what roles/weights, and any session-layer overrides.
    """

    __tablename__ = "session_profiles"

    session_id = Column(String(64), primary_key=True)
    composition_type = Column(String(30), nullable=False)
    data = Column(Text, nullable=False)  # JSON blob of SessionProfile.to_dict()
    created_at = Column(String(50), nullable=False)  # ISO format

