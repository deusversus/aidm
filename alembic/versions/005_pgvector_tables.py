"""005_pgvector_tables

Replace ChromaDB with pgvector for all vector stores:
  - campaign_memories  (was MemoryStore)
  - profile_lore_chunks  (was ProfileLibrary)
  - custom_profile_lore_chunks  (was CustomProfileLibrary)
  - rule_library_chunks  (was RuleLibrary)

Embeddings are generated synchronously from Python using OpenAI
text-embedding-3-small (1536-dim) and stored in a pgvector column.
This gives immediate consistency — no async cold-start window.

Revision ID: 005
Revises: 004
Create Date: 2026-03-04 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '005'
down_revision: Union[str, None] = '004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()

    # ── Extensions ────────────────────────────────────────────────────────────
    conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))

    # ── campaign_memories ─────────────────────────────────────────────────────
    # One row per memory fragment for a campaign.
    # heat: 0-100, decays each turn, boosted on retrieval.
    op.create_table(
        "campaign_memories",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("campaign_id", sa.Integer, sa.ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("memory_type", sa.String(50), nullable=False, server_default="episodic"),
        sa.Column("heat", sa.Float, nullable=False, server_default="100.0"),
        sa.Column("decay_rate", sa.String(20), nullable=False, server_default="normal"),
        sa.Column("turn_number", sa.Integer, nullable=True),
        sa.Column("flags", sa.JSON, server_default="[]"),
        sa.Column("extra_meta", sa.JSON, server_default="{}"),
        sa.Column("embedding", sa.Text, nullable=True),  # stored as pgvector via raw SQL
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    # Add the vector column via raw SQL (SQLAlchemy doesn't know the vector type natively)
    conn.execute(sa.text(
        "ALTER TABLE campaign_memories ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_campaign_memories_heat ON campaign_memories (campaign_id, heat DESC)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_campaign_memories_vec ON campaign_memories "
        "USING hnsw (embedding_vec vector_cosine_ops)"
    ))

    # ── profile_lore_chunks ───────────────────────────────────────────────────
    # Wiki lore for canonical narrative profiles (scraped from Fandom, etc.)
    op.create_table(
        "profile_lore_chunks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("profile_id", sa.String(100), nullable=False, index=True),
        sa.Column("chunk_id", sa.String(255), nullable=False),
        sa.Column("page_title", sa.String(500), nullable=True),
        sa.Column("page_type", sa.String(50), nullable=True),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("word_count", sa.Integer, server_default="0"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    conn.execute(sa.text(
        "ALTER TABLE profile_lore_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)"
    ))
    conn.execute(sa.text(
        "CREATE UNIQUE INDEX ix_profile_lore_chunks_uid ON profile_lore_chunks (profile_id, chunk_id)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_profile_lore_chunks_vec ON profile_lore_chunks "
        "USING hnsw (embedding_vec vector_cosine_ops)"
    ))

    # ── custom_profile_lore_chunks ────────────────────────────────────────────
    # Session-scoped custom profile content (player-defined world additions).
    op.create_table(
        "custom_profile_lore_chunks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("session_id", sa.String(64), nullable=False, index=True),
        sa.Column("chunk_id", sa.String(255), nullable=False),
        sa.Column("category", sa.String(50), nullable=True),
        sa.Column("tags", sa.JSON, server_default="[]"),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    conn.execute(sa.text(
        "ALTER TABLE custom_profile_lore_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)"
    ))
    conn.execute(sa.text(
        "CREATE UNIQUE INDEX ix_custom_lore_chunks_uid ON custom_profile_lore_chunks (session_id, chunk_id)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_custom_lore_chunks_vec ON custom_profile_lore_chunks "
        "USING hnsw (embedding_vec vector_cosine_ops)"
    ))

    # ── rule_library_chunks ───────────────────────────────────────────────────
    # Static narrative guidance chunks (Module 12/13 YAML content).
    op.create_table(
        "rule_library_chunks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("chunk_id", sa.String(255), nullable=False, unique=True),
        sa.Column("category", sa.String(50), nullable=True),
        sa.Column("source_module", sa.String(50), nullable=True),
        sa.Column("tags", sa.JSON, server_default="[]"),
        sa.Column("retrieve_conditions", sa.JSON, server_default="[]"),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    conn.execute(sa.text(
        "ALTER TABLE rule_library_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_rule_library_chunks_vec ON rule_library_chunks "
        "USING hnsw (embedding_vec vector_cosine_ops)"
    ))


def downgrade() -> None:
    op.drop_table("rule_library_chunks")
    op.drop_table("custom_profile_lore_chunks")
    op.drop_table("profile_lore_chunks")
    op.drop_table("campaign_memories")
