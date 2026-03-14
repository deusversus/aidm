"""Add Session Zero Compiler artifact tables.

Revision ID: 009
Revises: 008
Create Date: 2026-06-14

Adds two tables:
  - session_zero_runs  : one row per HandoffCompiler execution
  - session_zero_artifacts : versioned artifacts (OpeningStatePackage, entity graph, gap analysis)

Design constraints (from sz_upgrade_plan.md §11.5.9 Rule 5):
  All writes for a single handoff must be wrapped in a single DB transaction.
  Enforced by the SessionZeroArtifactRepository layer, not the schema itself.
"""
from datetime import datetime

import sqlalchemy as sa
from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # session_zero_artifacts must exist before session_zero_runs (FK reference)
    op.create_table(
        "session_zero_artifacts",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("session_id", sa.String(64), nullable=False),
        sa.Column("artifact_type", sa.String(50), nullable=False),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("content_json", sa.Text, nullable=False),
        sa.Column("source_run_id", sa.Integer, nullable=True),
        sa.Column("transcript_hash", sa.String(64), nullable=True),
        sa.Column("character_draft_hash", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("superseded_at", sa.DateTime, nullable=True),
    )
    op.create_index(
        "idx_sz_artifact_session_type",
        "session_zero_artifacts",
        ["session_id", "artifact_type"],
    )
    op.create_index(
        "idx_sz_artifact_session_status",
        "session_zero_artifacts",
        ["session_id", "status"],
    )
    op.create_unique_constraint(
        "uq_sz_artifact_session_type_version",
        "session_zero_artifacts",
        ["session_id", "artifact_type", "version"],
    )

    op.create_table(
        "session_zero_runs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("session_id", sa.String(64), nullable=False),
        sa.Column("run_type", sa.String(30), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="running"),
        sa.Column("started_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime, nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("entities_extracted", sa.Integer, server_default="0"),
        sa.Column("entities_resolved", sa.Integer, server_default="0"),
        sa.Column("contradictions_found", sa.Integer, server_default="0"),
        sa.Column("contradictions_resolved", sa.Integer, server_default="0"),
        sa.Column("unresolved_items", sa.Integer, server_default="0"),
        sa.Column("handoff_blocked", sa.Boolean, server_default="false"),
        sa.Column("checkpoints_json", sa.Text, nullable=True),
        sa.Column(
            "artifact_id",
            sa.Integer,
            sa.ForeignKey("session_zero_artifacts.id"),
            nullable=True,
        ),
    )
    op.create_index(
        "idx_sz_runs_session_status",
        "session_zero_runs",
        ["session_id", "status"],
    )

    # Add FK from session_zero_artifacts.source_run_id -> session_zero_runs.id
    # We use add_column here because the FK is a self-referential cycle:
    # artifacts references runs, runs references artifacts.
    # Both tables are already created above; now add the FK constraint separately.
    op.create_foreign_key(
        "fk_sz_artifact_source_run",
        "session_zero_artifacts",
        "session_zero_runs",
        ["source_run_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_sz_artifact_source_run", "session_zero_artifacts", type_="foreignkey")
    op.drop_table("session_zero_runs")
    op.drop_table("session_zero_artifacts")
