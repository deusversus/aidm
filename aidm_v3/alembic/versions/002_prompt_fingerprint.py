"""Add prompt fingerprint columns to turns table.

Revision ID: 002
Revises: 001
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("turns", sa.Column("prompt_fingerprint", sa.String(64), nullable=True))
    op.add_column("turns", sa.Column("prompt_name", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("turns", "prompt_name")
    op.drop_column("turns", "prompt_fingerprint")
