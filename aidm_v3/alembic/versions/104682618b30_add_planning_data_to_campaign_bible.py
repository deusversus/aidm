"""add planning_data to campaign_bible

Revision ID: 104682618b30
Revises: 002
Create Date: 2026-02-23 12:22:51.407836
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '104682618b30'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Only add the missing column — don't touch other tables
    with op.batch_alter_table('campaign_bible', schema=None) as batch_op:
        batch_op.add_column(sa.Column('planning_data', sa.JSON(), nullable=True))

    # Also add canonicality columns to world_state if missing
    with op.batch_alter_table('world_state', schema=None) as batch_op:
        batch_op.add_column(sa.Column('timeline_mode', sa.String(length=50), nullable=True))
        batch_op.add_column(sa.Column('canon_cast_mode', sa.String(length=50), nullable=True))
        batch_op.add_column(sa.Column('event_fidelity', sa.String(length=50), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('world_state', schema=None) as batch_op:
        batch_op.drop_column('event_fidelity')
        batch_op.drop_column('canon_cast_mode')
        batch_op.drop_column('timeline_mode')

    with op.batch_alter_table('campaign_bible', schema=None) as batch_op:
        batch_op.drop_column('planning_data')
