"""003_card_catalog

Add dynamic cast management columns (Card Catalog NPC system).

Revision ID: 003
Revises: 002
Create Date: 2026-03-01 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '003'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('world_state', sa.Column('active_scene_cast', sa.JSON(), nullable=True))
    op.add_column('world_state', sa.Column('transient_entities', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('world_state', 'transient_entities')
    op.drop_column('world_state', 'active_scene_cast')
