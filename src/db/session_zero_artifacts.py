"""Session Zero Compiler artifact repository.

CRUD helpers for SessionZeroArtifact and SessionZeroRun with:
  - Versioned artifact write (supersedes the previous active artifact of the
    same type so every session always has at most one 'active' per type)
  - Idempotent get-or-create for runs
  - Transactional batch-write helpers
  - Hash-based change detection to skip redundant re-compiles

Locking rule (from sz_upgrade_plan.md §11.5.9 Rule 5):
    All artifact writes for a single handoff must be done inside the same
    SQLAlchemy Session and committed together.  Callers should use the
    save_artifacts_transactional() helper which enforces this.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session as SQLAlchemySession

from .models import SessionZeroArtifact, SessionZeroRun
from .session import get_session

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# Run helpers
# ─────────────────────────────────────────────

def create_run(
    db: SQLAlchemySession,
    session_id: str,
    run_type: str,
) -> SessionZeroRun:
    """Create and flush a new run record.  Does NOT commit; caller owns the transaction."""
    run = SessionZeroRun(
        session_id=session_id,
        run_type=run_type,
        status="running",
        started_at=datetime.utcnow(),
    )
    db.add(run)
    db.flush()  # populate run.id without committing
    logger.debug("[SZ Artifact] Created run id=%s type=%s session=%s", run.id, run_type, session_id)
    return run


def complete_run(
    db: SQLAlchemySession,
    run: SessionZeroRun,
    *,
    artifact_id: int | None = None,
    entities_extracted: int = 0,
    entities_resolved: int = 0,
    contradictions_found: int = 0,
    contradictions_resolved: int = 0,
    unresolved_items: int = 0,
    handoff_blocked: bool = False,
    checkpoints: list[dict] | None = None,
) -> None:
    """Mark a run as completed and update counters.  Does NOT commit."""
    run.status = "completed"
    run.completed_at = datetime.utcnow()
    run.artifact_id = artifact_id
    run.entities_extracted = entities_extracted
    run.entities_resolved = entities_resolved
    run.contradictions_found = contradictions_found
    run.contradictions_resolved = contradictions_resolved
    run.unresolved_items = unresolved_items
    run.handoff_blocked = handoff_blocked
    if checkpoints is not None:
        run.checkpoints_json = json.dumps(checkpoints)
    db.flush()


def fail_run(
    db: SQLAlchemySession,
    run: SessionZeroRun,
    error: str,
) -> None:
    """Mark a run as failed.  Does NOT commit."""
    run.status = "failed"
    run.completed_at = datetime.utcnow()
    run.error_message = error[:4000]  # guard against absurdly long tracebacks
    db.flush()


def get_latest_run(
    db: SQLAlchemySession,
    session_id: str,
    run_type: str | None = None,
    status: str | None = None,
) -> SessionZeroRun | None:
    """Return the most recent run for a session, optionally filtered by type/status."""
    q = db.query(SessionZeroRun).filter(SessionZeroRun.session_id == session_id)
    if run_type:
        q = q.filter(SessionZeroRun.run_type == run_type)
    if status:
        q = q.filter(SessionZeroRun.status == status)
    return q.order_by(SessionZeroRun.id.desc()).first()


# ─────────────────────────────────────────────
# Artifact helpers
# ─────────────────────────────────────────────

def _compute_content_hash(content_json: str) -> str:
    return hashlib.sha256(content_json.encode()).hexdigest()[:32]


def get_active_artifact(
    db: SQLAlchemySession,
    session_id: str,
    artifact_type: str,
) -> SessionZeroArtifact | None:
    """Return the current 'active' artifact for (session, type), or None."""
    return (
        db.query(SessionZeroArtifact)
        .filter(
            SessionZeroArtifact.session_id == session_id,
            SessionZeroArtifact.artifact_type == artifact_type,
            SessionZeroArtifact.status == "active",
        )
        .order_by(SessionZeroArtifact.version.desc())
        .first()
    )


def list_artifacts(
    db: SQLAlchemySession,
    session_id: str,
    artifact_type: str | None = None,
    status: str | None = None,
) -> list[SessionZeroArtifact]:
    """List artifacts for a session, optionally filtered."""
    q = db.query(SessionZeroArtifact).filter(
        SessionZeroArtifact.session_id == session_id
    )
    if artifact_type:
        q = q.filter(SessionZeroArtifact.artifact_type == artifact_type)
    if status:
        q = q.filter(SessionZeroArtifact.status == status)
    return q.order_by(SessionZeroArtifact.version.desc()).all()


def save_artifact(
    db: SQLAlchemySession,
    session_id: str,
    artifact_type: str,
    content: Any,  # Pydantic model or plain dict/JSON-serializable
    *,
    source_run_id: int | None = None,
    transcript_hash: str | None = None,
    character_draft_hash: str | None = None,
    force_new_version: bool = False,
) -> SessionZeroArtifact:
    """Save a new artifact version, superseding the previous active one.

    Rules:
    - If there is no current active artifact, writes version=1
    - If the content hash matches the active artifact exactly, returns the
      existing artifact unchanged (content-deduplication)
    - Otherwise, marks the old active artifact as 'superseded' and writes a
      new 'active' artifact with version = old_version + 1
    - Does NOT commit; caller owns the transaction

    Args:
        db:                    Active SQLAlchemy session
        session_id:            Session UUID string
        artifact_type:         One of 'opening_state_package', 'entity_graph', 'gap_analysis'
        content:               Pydantic model (will call .model_dump_json()) or dict
        source_run_id:         Run that produced this artifact
        transcript_hash:       Optional SHA-256 of the transcript used to build this
        character_draft_hash:  Optional SHA-256 of the character_draft JSON
        force_new_version:     Skip content-hash deduplication and always write a new version

    Returns:
        The new (or unchanged) SessionZeroArtifact
    """
    # Serialize content
    if hasattr(content, "model_dump_json"):
        content_json = content.model_dump_json()
    elif isinstance(content, dict):
        content_json = json.dumps(content)
    else:
        content_json = str(content)

    # Find current active artifact
    existing = get_active_artifact(db, session_id, artifact_type)

    if existing is not None and not force_new_version:
        existing_hash = _compute_content_hash(existing.content_json)
        new_hash = _compute_content_hash(content_json)
        if existing_hash == new_hash:
            logger.debug(
                "[SZ Artifact] Content-hash match for session=%s type=%s version=%s — skipping write",
                session_id, artifact_type, existing.version,
            )
            return existing

    # Calculate new version
    new_version = 1 if existing is None else existing.version + 1

    # Supersede the old active artifact
    if existing is not None:
        existing.status = "superseded"
        existing.superseded_at = datetime.utcnow()
        db.flush()

    # Write the new artifact
    artifact = SessionZeroArtifact(
        session_id=session_id,
        artifact_type=artifact_type,
        version=new_version,
        status="active",
        content_json=content_json,
        source_run_id=source_run_id,
        transcript_hash=transcript_hash,
        character_draft_hash=character_draft_hash,
        created_at=datetime.utcnow(),
    )
    db.add(artifact)
    db.flush()  # populate artifact.id without committing

    logger.info(
        "[SZ Artifact] Saved session=%s type=%s version=%s id=%s",
        session_id, artifact_type, new_version, artifact.id,
    )
    return artifact


def save_artifacts_transactional(
    session_id: str,
    artifacts: dict[str, Any],
    *,
    run_type: str,
    transcript_hash: str | None = None,
    character_draft_hash: str | None = None,
    run_metadata: dict | None = None,
) -> tuple[SessionZeroRun, dict[str, SessionZeroArtifact]]:
    """Write multiple artifacts and their run record in a single DB transaction.

    This is the preferred high-level API for the HandoffCompiler.

    Args:
        session_id:            Session UUID string
        artifacts:             Dict of artifact_type -> Pydantic model or dict
        run_type:              'turn_orchestration' | 'handoff_compile' | 'recovery_compile'
        transcript_hash:       Optional content hash of transcript
        character_draft_hash:  Optional content hash of character_draft
        run_metadata:          Optional dict with compiler counters to record on the run

    Returns:
        Tuple of (completed_run, {artifact_type: saved_artifact})
    """
    run_metadata = run_metadata or {}

    with get_session() as db:
        # Create run record
        run = create_run(db, session_id, run_type)

        # Write all artifacts in the same transaction
        saved: dict[str, SessionZeroArtifact] = {}
        for artifact_type, content in artifacts.items():
            saved[artifact_type] = save_artifact(
                db,
                session_id,
                artifact_type,
                content,
                source_run_id=run.id,
                transcript_hash=transcript_hash,
                character_draft_hash=character_draft_hash,
            )

        # Link primary artifact to run (prefer opening_state_package if present)
        primary = (
            saved.get("opening_state_package")
            or saved.get("entity_graph")
            or next(iter(saved.values()), None)
        )

        complete_run(
            db,
            run,
            artifact_id=primary.id if primary else None,
            entities_extracted=run_metadata.get("entities_extracted", 0),
            entities_resolved=run_metadata.get("entities_resolved", 0),
            contradictions_found=run_metadata.get("contradictions_found", 0),
            contradictions_resolved=run_metadata.get("contradictions_resolved", 0),
            unresolved_items=run_metadata.get("unresolved_items", 0),
            handoff_blocked=run_metadata.get("handoff_blocked", False),
            checkpoints=run_metadata.get("checkpoints"),
        )

        # Refresh all objects before commit so they remain usable post-detach
        db.refresh(run)
        for art in saved.values():
            db.refresh(art)

        # Expunge to keep the objects accessible after the session closes
        db.expunge(run)
        for art in saved.values():
            db.expunge(art)

        # Transaction commits on exit from `with get_session()`
        return run, saved


def load_artifact_content(artifact: SessionZeroArtifact, model_class: type | None = None) -> Any:
    """Deserialize a stored artifact's JSON content.

    Args:
        artifact:    The SessionZeroArtifact row
        model_class: Optional Pydantic model class to parse into.  If None,
                     returns a raw dict.

    Returns:
        Parsed Pydantic model or dict
    """
    data = json.loads(artifact.content_json)
    if model_class is not None:
        return model_class.model_validate(data)
    return data


def compute_transcript_hash(messages: list[dict]) -> str:
    """Compute a stable SHA-256 hash of the transcript messages list."""
    serialized = json.dumps(messages, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(serialized.encode()).hexdigest()


def compute_draft_hash(draft_dict: dict) -> str:
    """Compute a stable SHA-256 hash of the character draft dict."""
    serialized = json.dumps(draft_dict, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(serialized.encode()).hexdigest()
