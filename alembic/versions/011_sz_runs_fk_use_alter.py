"""Rename session_zero_runs.artifact_id FK so it matches the ORM.

Revision ID: 011
Revises: 010
Create Date: 2026-04-16

The model now declares this FK with ``use_alter=True`` and an explicit name
(``fk_sz_runs_artifact_id``) so that ``Base.metadata.drop_all()`` can
topologically sort the pair of circularly-dependent tables
(session_zero_runs.artifact_id → session_zero_artifacts.id and
session_zero_artifacts.source_run_id → session_zero_runs.id).

Previously the FK was created from a column-level ``sa.ForeignKey`` without
a name, leaving Postgres to auto-assign ``session_zero_runs_artifact_id_fkey``.
This migration renames it so schema introspection matches the ORM.
"""

from alembic import op

revision = "011"
down_revision = "010"


def upgrade():
    op.drop_constraint(
        "session_zero_runs_artifact_id_fkey",
        "session_zero_runs",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_sz_runs_artifact_id",
        "session_zero_runs",
        "session_zero_artifacts",
        ["artifact_id"],
        ["id"],
    )


def downgrade():
    op.drop_constraint(
        "fk_sz_runs_artifact_id",
        "session_zero_runs",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "session_zero_runs_artifact_id_fkey",
        "session_zero_runs",
        "session_zero_artifacts",
        ["artifact_id"],
        ["id"],
    )
