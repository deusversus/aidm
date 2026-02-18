"""Database session management and initialization."""

import logging
import os
from collections.abc import Generator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import Session as SQLAlchemySession
from sqlalchemy.orm import sessionmaker

from .models import Base

logger = logging.getLogger(__name__)

# Global engine and session factory
_engine = None
_SessionLocal = None


def get_database_url() -> str:
    """Get database URL from environment or use SQLite default."""
    return os.getenv("DATABASE_URL", "sqlite:///./aidm_v3.db")


def get_engine():
    """Get or create the database engine."""
    global _engine
    if _engine is None:
        database_url = get_database_url()

        # SQLite needs special handling for check_same_thread
        if database_url.startswith("sqlite"):
            _engine = create_engine(
                database_url,
                connect_args={"check_same_thread": False},
                echo=os.getenv("DEBUG", "false").lower() == "true"
            )
        else:
            _engine = create_engine(
                database_url,
                echo=os.getenv("DEBUG", "false").lower() == "true"
            )

    return _engine


def get_session_factory():
    """Get or create the session factory."""
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=get_engine()
        )
    return _SessionLocal


def init_db():
    """Initialize the database by creating all tables."""
    engine = get_engine()
    Base.metadata.create_all(bind=engine)

    # Inline migrations for existing databases
    with engine.connect() as conn:
        from sqlalchemy import text
        try:
            # #2: bible_version on campaign_bible
            result = conn.execute(text("PRAGMA table_info(campaign_bible)"))
            columns = [row[1] for row in result]
            if "bible_version" not in columns:
                conn.execute(text("ALTER TABLE campaign_bible ADD COLUMN bible_version INTEGER DEFAULT 0"))
                conn.commit()
                logger.info("Added bible_version column to campaign_bible")

            # #3: turns_in_phase on world_state
            result = conn.execute(text("PRAGMA table_info(world_state)"))
            columns = [row[1] for row in result]
            if "turns_in_phase" not in columns:
                conn.execute(text("ALTER TABLE world_state ADD COLUMN turns_in_phase INTEGER DEFAULT 0"))
                conn.commit()
                logger.info("Added turns_in_phase column to world_state")

            # #5: pinned_messages on world_state
            result = conn.execute(text("PRAGMA table_info(world_state)"))
            columns = [row[1] for row in result]
            if "pinned_messages" not in columns:
                conn.execute(text("ALTER TABLE world_state ADD COLUMN pinned_messages TEXT DEFAULT '[]'"))
                conn.commit()
                logger.info("Added pinned_messages column to world_state")
        except Exception as e:
            logger.warning(f"Column check skipped: {e}")

    logger.info(f"Database initialized: {get_database_url()}")


def drop_db():
    """Drop all tables (use with caution!)."""
    engine = get_engine()
    Base.metadata.drop_all(bind=engine)
    logger.info("Database tables dropped.")


@contextmanager
def get_session() -> Generator[SQLAlchemySession, None, None]:
    """Context manager for database sessions.
    
    Usage:
        with get_session() as session:
            session.query(...)
    """
    SessionLocal = get_session_factory()
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def create_session() -> SQLAlchemySession:
    """Create a new database session (caller must manage lifecycle)."""
    SessionLocal = get_session_factory()
    return SessionLocal()
