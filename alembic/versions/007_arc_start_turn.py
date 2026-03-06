"""Add arc_start_turn to world_state

Revision ID: 007_arc_start_turn
Revises: 006_context_blocks
Create Date: 2026-03-06
"""
from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "world_state",
        sa.Column("arc_start_turn", sa.Integer(), nullable=True, server_default="1"),
    )


def downgrade():
    op.drop_column("world_state", "arc_start_turn")
