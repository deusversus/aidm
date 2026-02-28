"""002_stat_presentation

Revision ID: 002
Revises: 001
Create Date: 2026-02-28 11:25:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '002'
down_revision: Union[str, None] = '001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('characters', sa.Column('stat_presentation', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('characters', 'stat_presentation')
