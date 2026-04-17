"""Add per-turn idempotency markers to characters.

Revision ID: 012
Revises: 011
Create Date: 2026-04-17

Adds ``last_combat_applied_turn`` and ``last_progression_applied_turn``
to the ``characters`` table. These fields let the crash-recovery replay
path (see ``src/core/turn_replay.py``) tell whether a turn's non-idempotent
bookkeeping — HP/MP deltas from combat, XP/level-up from progression —
was already applied before the crash, so it doesn't double-apply them.

Both columns are nullable; existing rows default to NULL, which replay
treats as "not yet applied for any turn".
"""

import sqlalchemy as sa
from alembic import op

revision = "012"
down_revision = "011"


def upgrade():
    op.add_column(
        "characters",
        sa.Column("last_combat_applied_turn", sa.Integer, nullable=True),
    )
    op.add_column(
        "characters",
        sa.Column("last_progression_applied_turn", sa.Integer, nullable=True),
    )


def downgrade():
    op.drop_column("characters", "last_progression_applied_turn")
    op.drop_column("characters", "last_combat_applied_turn")
