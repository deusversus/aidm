"""Add current_location to NPCs for spatial tracking.

Revision ID: 010
Revises: 009
Create Date: 2026-03-22

Tracks the last known location of each NPC. Updated when NPCs are
summoned to or dismissed from the active scene cast, and when the
player moves to a new location (present NPCs travel with them).
"""

import sqlalchemy as sa
from alembic import op

revision = "010"
down_revision = "009"


def upgrade():
    op.add_column("npcs", sa.Column("current_location", sa.String(255), nullable=True))


def downgrade():
    op.drop_column("npcs", "current_location")
