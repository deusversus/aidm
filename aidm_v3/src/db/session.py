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
    """Get database URL from environment or use PostgreSQL default."""
    return os.getenv("DATABASE_URL", "postgresql://aidm:aidm@localhost:5432/aidm")


def get_engine():
    """Get or create the database engine."""
    global _engine
    if _engine is None:
        database_url = get_database_url()

        if database_url.startswith("sqlite"):
            # SQLite needs special handling for check_same_thread
            _engine = create_engine(
                database_url,
                connect_args={"check_same_thread": False},
                echo=os.getenv("DEBUG", "false").lower() == "true",
            )
        else:
            # PostgreSQL with connection pooling
            _engine = create_engine(
                database_url,
                pool_size=5,
                max_overflow=10,
                pool_pre_ping=True,
                echo=os.getenv("DEBUG", "false").lower() == "true",
            )

    return _engine


def get_session_factory():
    """Get or create the session factory."""
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=get_engine(),
        )
    return _SessionLocal


def init_db():
    """Initialize the database — run Alembic migrations to head.

    This replaces the old create_all() + manual PRAGMA migrations.
    Alembic handles both initial schema creation and incremental changes.
    """
    try:
        from alembic import command
        from alembic.config import Config

        alembic_cfg = Config("alembic.ini")
        # Override the URL with our environment-aware one
        alembic_cfg.set_main_option("sqlalchemy.url", get_database_url())
        command.upgrade(alembic_cfg, "head")
        logger.info(f"Database initialized via Alembic: {get_database_url()}")
    except Exception as e:
        # Fallback to create_all for dev/testing if Alembic isn't set up yet
        logger.warning(f"Alembic migration failed ({e}), falling back to create_all()")
        engine = get_engine()
        Base.metadata.create_all(bind=engine)
        logger.info(f"Database initialized via create_all: {get_database_url()}")


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
