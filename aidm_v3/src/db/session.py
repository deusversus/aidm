"""Database session management and initialization."""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session as SQLAlchemySession
from contextlib import contextmanager
from typing import Generator

from .models import Base

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
    print(f"Database initialized: {get_database_url()}")


def drop_db():
    """Drop all tables (use with caution!)."""
    engine = get_engine()
    Base.metadata.drop_all(bind=engine)
    print("Database tables dropped.")


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
