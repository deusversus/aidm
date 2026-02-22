"""baseline: create all tables

Revision ID: 001
Revises: 
Create Date: 2026-02-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ─── Core gameplay tables ────────────────────────────────────────

    op.create_table(
        "campaigns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("profile_id", sa.String(100), nullable=True),
        sa.Column("status", sa.String(50), default="active"),
        sa.Column("media_uuid", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.Column("turn_count", sa.Integer(), default=0),
        sa.Column("summary", sa.Text(), nullable=True),
    )

    op.create_table(
        "turns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("turn_number", sa.Integer(), nullable=False),
        sa.Column("player_input", sa.Text(), nullable=True),
        sa.Column("narrative", sa.Text(), nullable=True),
        sa.Column("game_state_snapshot", sa.JSON(), nullable=True),
        sa.Column("intent_classification", sa.JSON(), nullable=True),
        sa.Column("outcome_data", sa.JSON(), nullable=True),
        sa.Column("suggestions", sa.JSON(), nullable=True),
        sa.Column("portrait_map", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Float(), nullable=True),
    )

    op.create_table(
        "characters",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("character_class", sa.String(100), nullable=True),
        sa.Column("level", sa.Integer(), default=1),
        sa.Column("experience", sa.Integer(), default=0),
        sa.Column("hp", sa.Integer(), default=100),
        sa.Column("max_hp", sa.Integer(), default=100),
        sa.Column("mp", sa.Integer(), default=50),
        sa.Column("max_mp", sa.Integer(), default=50),
        sa.Column("sp", sa.Integer(), default=100),
        sa.Column("max_sp", sa.Integer(), default=100),
        sa.Column("strength", sa.Integer(), default=10),
        sa.Column("defense", sa.Integer(), default=10),
        sa.Column("magic", sa.Integer(), default=10),
        sa.Column("speed", sa.Integer(), default=10),
        sa.Column("luck", sa.Integer(), default=10),
        sa.Column("abilities", sa.JSON(), nullable=True),
        sa.Column("inventory", sa.JSON(), nullable=True),
        sa.Column("equipment", sa.JSON(), nullable=True),
        sa.Column("backstory", sa.Text(), nullable=True),
        sa.Column("personality", sa.Text(), nullable=True),
        sa.Column("appearance", sa.JSON(), nullable=True),
        sa.Column("visual_tags", sa.JSON(), nullable=True),
        sa.Column("model_sheet_url", sa.String(500), nullable=True),
        sa.Column("portrait_url", sa.String(500), nullable=True),
        sa.Column("power_tier", sa.String(10), nullable=True),
        sa.Column("tier_justification", sa.Text(), nullable=True),
        sa.Column("status_effects", sa.JSON(), nullable=True),
        sa.Column("relationships", sa.JSON(), nullable=True),
        sa.Column("currency", sa.Integer(), default=0),
        sa.Column("long_term_goal", sa.Text(), nullable=True),
        sa.Column("faction", sa.String(100), nullable=True),
        sa.Column("faction_reputations", sa.JSON(), nullable=True),
    )

    op.create_table(
        "npcs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("role", sa.String(100), nullable=True),
        sa.Column("disposition", sa.String(50), nullable=True),
        sa.Column("affinity", sa.Integer(), default=0),
        sa.Column("intelligence_stage", sa.String(50), nullable=True),
        sa.Column("backstory", sa.Text(), nullable=True),
        sa.Column("personality", sa.Text(), nullable=True),
        sa.Column("abilities", sa.JSON(), nullable=True),
        sa.Column("inventory", sa.JSON(), nullable=True),
        sa.Column("relationships", sa.JSON(), nullable=True),
        sa.Column("secrets", sa.JSON(), nullable=True),
        sa.Column("goals", sa.JSON(), nullable=True),
        sa.Column("last_seen_location", sa.String(255), nullable=True),
        sa.Column("last_interaction_turn", sa.Integer(), nullable=True),
        sa.Column("faction", sa.String(100), nullable=True),
        sa.Column("power_tier", sa.String(10), nullable=True),
        sa.Column("is_canonical", sa.Boolean(), default=False),
        sa.Column("hp", sa.Integer(), nullable=True),
        sa.Column("max_hp", sa.Integer(), nullable=True),
        sa.Column("appearance", sa.JSON(), nullable=True),
        sa.Column("visual_tags", sa.JSON(), nullable=True),
        sa.Column("model_sheet_url", sa.String(500), nullable=True),
        sa.Column("portrait_url", sa.String(500), nullable=True),
    )

    op.create_table(
        "world_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False, unique=True),
        sa.Column("current_location", sa.String(255), nullable=True),
        sa.Column("time_of_day", sa.String(50), nullable=True),
        sa.Column("situation", sa.Text(), nullable=True),
        sa.Column("arc_name", sa.String(255), nullable=True),
        sa.Column("arc_phase", sa.String(50), nullable=True),
        sa.Column("turns_in_phase", sa.Integer(), default=0),
        sa.Column("event_fidelity", sa.String(50), nullable=True),
        sa.Column("foreshadowing", sa.JSON(), nullable=True),
        sa.Column("pinned_messages", sa.JSON(), nullable=True),
    )

    op.create_table(
        "consequences",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("category", sa.String(50), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("severity", sa.String(20), nullable=True),
        sa.Column("source_turn", sa.Integer(), nullable=True),
        sa.Column("active", sa.Boolean(), default=True),
        sa.Column("expires_turn", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "campaign_bible",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False, unique=True),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("bible_version", sa.Integer(), default=0),
        sa.Column("last_updated_turn", sa.Integer(), default=0),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "factions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("alignment", sa.String(50), nullable=True),
        sa.Column("power_level", sa.String(50), nullable=True),
        sa.Column("territory", sa.String(255), nullable=True),
        sa.Column("leader_npc_id", sa.Integer(), nullable=True),
        sa.Column("member_npc_ids", sa.JSON(), nullable=True),
        sa.Column("player_reputation", sa.Integer(), default=0),
        sa.Column("relationships", sa.JSON(), nullable=True),
        sa.Column("resources", sa.JSON(), nullable=True),
        sa.Column("subordinates", sa.JSON(), nullable=True),
        sa.Column("faction_goals", sa.JSON(), nullable=True),
        sa.Column("secrets", sa.JSON(), nullable=True),
        sa.Column("current_events", sa.JSON(), nullable=True),
    )

    op.create_table(
        "overrides",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("override_type", sa.String(50), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("target", sa.String(255), nullable=True),
        sa.Column("active", sa.Boolean(), default=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "foreshadowing_seeds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("seed_id", sa.String(100), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("seed_type", sa.String(50), nullable=True),
        sa.Column("priority", sa.String(20), nullable=True),
        sa.Column("status", sa.String(20), default="planted"),
        sa.Column("planted_turn", sa.Integer(), nullable=True),
        sa.Column("target_turn_min", sa.Integer(), nullable=True),
        sa.Column("target_turn_max", sa.Integer(), nullable=True),
        sa.Column("revealed_turn", sa.Integer(), nullable=True),
        sa.Column("related_npcs", sa.JSON(), nullable=True),
        sa.Column("related_locations", sa.JSON(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "quests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("quest_id", sa.String(100), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("quest_type", sa.String(50), nullable=True),
        sa.Column("status", sa.String(20), default="active"),
        sa.Column("priority", sa.String(20), nullable=True),
        sa.Column("objectives", sa.JSON(), nullable=True),
        sa.Column("rewards", sa.JSON(), nullable=True),
        sa.Column("related_npcs", sa.JSON(), nullable=True),
        sa.Column("related_locations", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "locations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("location_type", sa.String(100), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("visual_tags", sa.JSON(), nullable=True),
        sa.Column("atmosphere", sa.String(100), nullable=True),
        sa.Column("lighting", sa.String(100), nullable=True),
        sa.Column("scale", sa.String(100), nullable=True),
        sa.Column("parent_location", sa.String(255), nullable=True),
        sa.Column("connected_locations", sa.JSON(), nullable=True),
        sa.Column("danger_level", sa.String(50), nullable=True),
        sa.Column("discovered_turn", sa.Integer(), nullable=True),
        sa.Column("last_visited_turn", sa.Integer(), nullable=True),
        sa.Column("image_url", sa.String(500), nullable=True),
        sa.Column("known_npcs", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "media_assets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("turn_number", sa.Integer(), nullable=True),
        sa.Column("asset_type", sa.String(20), nullable=False),
        sa.Column("cutscene_type", sa.String(50), nullable=True),
        sa.Column("file_path", sa.String(500), nullable=False),
        sa.Column("thumbnail_path", sa.String(500), nullable=True),
        sa.Column("image_prompt", sa.Text(), nullable=True),
        sa.Column("motion_prompt", sa.Text(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("cost_usd", sa.Float(), default=0.0),
        sa.Column("status", sa.String(20), default="pending"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )

    # ─── Consolidated stores (formerly separate SQLite databases) ─────

    op.create_table(
        "session_zero_states",
        sa.Column("session_id", sa.String(64), primary_key=True),
        sa.Column("data", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(50), nullable=False),
        sa.Column("last_activity", sa.String(50), nullable=False),
    )

    op.create_table(
        "wiki_pages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("profile_id", sa.String(100), nullable=False),
        sa.Column("page_title", sa.String(500), nullable=False),
        sa.Column("page_type", sa.String(50), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("word_count", sa.Integer(), default=0),
        sa.Column("source_wiki", sa.String(200), server_default=""),
        sa.Column("scraped_at", sa.Float(), nullable=False),
    )
    op.create_index("ix_wiki_pages_profile_id", "wiki_pages", ["profile_id"])
    op.create_unique_constraint("uq_wiki_profile_title", "wiki_pages", ["profile_id", "page_title"])
    op.create_index("idx_wiki_profile_type", "wiki_pages", ["profile_id", "page_type"])

    op.create_table(
        "api_cache",
        sa.Column("cache_key", sa.String(256), primary_key=True),
        sa.Column("cache_type", sa.String(20), nullable=False),
        sa.Column("data", sa.Text(), nullable=False),
        sa.Column("series_status", sa.String(20), server_default="FINISHED"),
        sa.Column("created_at", sa.Float(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False),
        sa.Column("title", sa.String(500), server_default=""),
    )
    op.create_index("ix_api_cache_cache_type", "api_cache", ["cache_type"])
    op.create_index("ix_api_cache_expires_at", "api_cache", ["expires_at"])

    op.create_table(
        "session_profiles",
        sa.Column("session_id", sa.String(64), primary_key=True),
        sa.Column("composition_type", sa.String(30), nullable=False),
        sa.Column("data", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(50), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("session_profiles")
    op.drop_table("api_cache")
    op.drop_table("wiki_pages")
    op.drop_table("session_zero_states")
    op.drop_table("media_assets")
    op.drop_table("locations")
    op.drop_table("quests")
    op.drop_table("foreshadowing_seeds")
    op.drop_table("overrides")
    op.drop_table("factions")
    op.drop_table("campaign_bible")
    op.drop_table("consequences")
    op.drop_table("world_state")
    op.drop_table("npcs")
    op.drop_table("characters")
    op.drop_table("turns")
    op.drop_table("sessions")
    op.drop_table("campaigns")
