"""Session Store - SQLite persistence for game sessions."""

import json
import sqlite3
from pathlib import Path
from typing import Optional, List
from datetime import datetime

from ..core.session import Session


import logging

logger = logging.getLogger(__name__)

class SessionStore:
    """Persists Session objects to SQLite database.
    
    Sessions are stored as JSON blobs in a `sessions` table,
    allowing them to survive server restarts.
    """
    
    def __init__(self, db_path: str = "./data/sessions.db"):
        """Initialize the session store.
        
        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
    
    def _init_db(self):
        """Create the sessions table if it doesn't exist."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    data TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_activity TEXT NOT NULL
                )
            """)
            conn.commit()
    
    def save(self, session: Session) -> None:
        """Save or update a session.
        
        Args:
            session: The Session object to persist
        """
        data = json.dumps(session.to_dict())
        
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO sessions 
                (session_id, data, created_at, last_activity)
                VALUES (?, ?, ?, ?)
            """, (
                session.session_id,
                data,
                session.created_at.isoformat(),
                session.last_activity.isoformat()
            ))
            conn.commit()
    
    def load(self, session_id: str) -> Optional[Session]:
        """Load a session by ID.
        
        Args:
            session_id: The session ID to load
            
        Returns:
            Session object if found, None otherwise
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "SELECT data FROM sessions WHERE session_id = ?",
                (session_id,)
            )
            row = cursor.fetchone()
            
            if row:
                data = json.loads(row[0])
                return Session.from_dict(data)
        
        return None
    
    def delete(self, session_id: str) -> bool:
        """Delete a session.
        
        Args:
            session_id: The session ID to delete
            
        Returns:
            True if deleted, False if not found
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "DELETE FROM sessions WHERE session_id = ?",
                (session_id,)
            )
            conn.commit()
            return cursor.rowcount > 0
    
    def clear_all(self) -> int:
        """Delete all sessions.
        
        Used during full reset.
        
        Returns:
            Number of sessions deleted
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("DELETE FROM sessions")
            conn.commit()
            count = cursor.rowcount
            if count > 0:
                logger.info(f"Cleared {count} session(s)")
            return count
    
    def list_sessions(self) -> List[dict]:
        """List all sessions with basic info.
        
        Returns:
            List of dicts with session_id, created_at, last_activity
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("""
                SELECT session_id, created_at, last_activity 
                FROM sessions 
                ORDER BY last_activity DESC
            """)
            return [
                {
                    "session_id": row[0],
                    "created_at": row[1],
                    "last_activity": row[2]
                }
                for row in cursor.fetchall()
            ]
    
    def get_latest_session_id(self) -> Optional[str]:
        """Get the most recently active session ID.
        
        Returns:
            Session ID if exists, None otherwise
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("""
                SELECT session_id FROM sessions 
                ORDER BY last_activity DESC 
                LIMIT 1
            """)
            row = cursor.fetchone()
            return row[0] if row else None


# Singleton instance
_session_store: Optional[SessionStore] = None


def get_session_store() -> SessionStore:
    """Get the global session store instance."""
    global _session_store
    if _session_store is None:
        _session_store = SessionStore()
    return _session_store
