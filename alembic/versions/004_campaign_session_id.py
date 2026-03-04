"""004_campaign_session_id

Link campaigns to session UUID as primary lookup key.
profile_id demoted to nullable metadata.

Revision ID: 004
Revises: 003
Create Date: 2026-03-04 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '004'
down_revision: Union[str, None] = '003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('campaigns',
        sa.Column('session_id', sa.String(length=64), nullable=True)
    )
    op.create_index('ix_campaigns_session_id', 'campaigns', ['session_id'], unique=True)
    op.alter_column('campaigns', 'profile_id',
        existing_type=sa.String(length=100),
        nullable=True
    )


def downgrade() -> None:
    op.alter_column('campaigns', 'profile_id',
        existing_type=sa.String(length=100),
        nullable=False
    )
    op.drop_index('ix_campaigns_session_id', table_name='campaigns')
    op.drop_column('campaigns', 'session_id')
