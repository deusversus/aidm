"""Session Store — SQLAlchemy persistence for Session Zero game sessions.

Replaces the former standalone SQLite database (data/sessions.db)
with the shared PostgreSQL database via SQLAlchemy.
"""

import json
import logging

from ..core.session import Session
from ..db.models import SessionZeroState
from ..db.session import create_session as create_db_session

logger = logging.getLogger(__name__)


class SessionStore:
    """Persists Session objects to the shared database.

    Sessions are stored as JSON blobs in the `session_zero_states` table,
    allowing them to survive server restarts.
    """

    def save(self, session: Session) -> None:
        """Save or update a session.

        Args:
            session: The Session object to persist
        """
        data = json.dumps(session.to_dict())
        db = create_db_session()
        try:
            existing = db.query(SessionZeroState).filter(
                SessionZeroState.session_id == session.session_id
            ).first()

            if existing:
                existing.data = data
                existing.last_activity = session.last_activity.isoformat()
            else:
                entry = SessionZeroState(
                    session_id=session.session_id,
                    data=data,
                    created_at=session.created_at.isoformat(),
                    last_activity=session.last_activity.isoformat(),
                )
                db.add(entry)

            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def load(self, session_id: str) -> Session | None:
        """Load a session by ID.

        Args:
            session_id: The session ID to load

        Returns:
            Session object if found, None otherwise
        """
        db = create_db_session()
        try:
            entry = db.query(SessionZeroState).filter(
                SessionZeroState.session_id == session_id
            ).first()

            if entry:
                data = json.loads(entry.data)
                return Session.from_dict(data)

            return None
        finally:
            db.close()

    def delete(self, session_id: str) -> bool:
        """Delete a session.

        Args:
            session_id: The session ID to delete

        Returns:
            True if deleted, False if not found
        """
        db = create_db_session()
        try:
            count = db.query(SessionZeroState).filter(
                SessionZeroState.session_id == session_id
            ).delete()
            db.commit()
            return count > 0
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def clear_all(self) -> int:
        """Delete all sessions.

        Used during full reset.

        Returns:
            Number of sessions deleted
        """
        db = create_db_session()
        try:
            count = db.query(SessionZeroState).delete()
            db.commit()
            if count > 0:
                logger.info(f"Cleared {count} session(s)")
            return count
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def list_sessions(self) -> list[dict]:
        """List all sessions with basic info.

        Returns:
            List of dicts with session_id, created_at, last_activity
        """
        db = create_db_session()
        try:
            entries = (
                db.query(SessionZeroState)
                .order_by(SessionZeroState.last_activity.desc())
                .all()
            )
            return [
                {
                    "session_id": e.session_id,
                    "created_at": e.created_at,
                    "last_activity": e.last_activity,
                }
                for e in entries
            ]
        finally:
            db.close()

    def get_latest_session_id(self) -> str | None:
        """Get the most recently active session ID.

        Returns:
            Session ID if exists, None otherwise
        """
        db = create_db_session()
        try:
            entry = (
                db.query(SessionZeroState)
                .order_by(SessionZeroState.last_activity.desc())
                .first()
            )
            return entry.session_id if entry else None
        finally:
            db.close()


# Singleton instance
_session_store: SessionStore | None = None


def get_session_store() -> SessionStore:
    """Get the global session store instance."""
    global _session_store
    if _session_store is None:
        _session_store = SessionStore()
    return _session_store
