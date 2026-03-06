"""006_context_blocks

Add context_blocks table — living prose summaries of narrative elements
(arcs, threads, quests, NPCs, factions) for LLM consumption.

Each block contains:
  - content: prose narrative (continuity supervisor voice)
  - continuity_checklist: JSON list of named entities with exact attributes
  - embedding_vec: for semantic search across blocks

Revision ID: 006
Revises: 005
Create Date: 2026-03-06 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '006'
down_revision: Union[str, None] = '005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()

    op.create_table(
        "context_blocks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "campaign_id",
            sa.Integer,
            sa.ForeignKey("campaigns.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # What this block describes
        sa.Column("block_type", sa.String(20), nullable=False),   # arc|thread|quest|npc|faction
        sa.Column("entity_id", sa.String(100), nullable=True),    # slug/id of the entity
        sa.Column("entity_name", sa.String(255), nullable=False), # human-readable label

        # Lifecycle
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),  # active|closed
        sa.Column("first_turn", sa.Integer, nullable=True),
        sa.Column("last_updated_turn", sa.Integer, nullable=True),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),

        # Content
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("continuity_checklist", sa.JSON, server_default='{"entities":[]}'),
        sa.Column("metadata", sa.JSON, server_default="{}"),

        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),

        sa.UniqueConstraint("campaign_id", "block_type", "entity_id", name="uq_context_blocks_entity"),
    )

    # Vector column — same pattern as other embedding tables
    conn.execute(sa.text(
        "ALTER TABLE context_blocks ADD COLUMN IF NOT EXISTS embedding_vec vector(1536)"
    ))

    # Indexes
    conn.execute(sa.text(
        "CREATE INDEX ix_context_blocks_campaign ON context_blocks (campaign_id)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_context_blocks_type ON context_blocks (campaign_id, block_type)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_context_blocks_entity ON context_blocks (campaign_id, block_type, entity_id)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_context_blocks_status ON context_blocks (campaign_id, status)"
    ))
    conn.execute(sa.text(
        "CREATE INDEX ix_context_blocks_vec ON context_blocks "
        "USING hnsw (embedding_vec vector_cosine_ops)"
    ))


def downgrade() -> None:
    op.drop_table("context_blocks")
