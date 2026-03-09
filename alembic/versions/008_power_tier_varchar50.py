"""Widen power_tier column from VARCHAR(10) to VARCHAR(50)

Revision ID: 008
Revises: 007
Create Date: 2026-03-09
"""
from alembic import op
import sqlalchemy as sa

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "characters",
        "power_tier",
        existing_type=sa.String(10),
        type_=sa.String(50),
        existing_nullable=True,
    )
    op.alter_column(
        "npcs",
        "power_tier",
        existing_type=sa.String(10),
        type_=sa.String(50),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "npcs",
        "power_tier",
        existing_type=sa.String(50),
        type_=sa.String(10),
        existing_nullable=True,
    )
    op.alter_column(
        "characters",
        "power_tier",
        existing_type=sa.String(50),
        type_=sa.String(10),
        existing_nullable=True,
    )
