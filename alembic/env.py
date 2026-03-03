"""Alembic environment configuration for AIDM v3.

Reads DATABASE_URL from environment (via .env or Docker Compose),
imports the SQLAlchemy Base metadata from src.db.models, and runs
migrations either online (normal) or offline (SQL generation).
"""

import os
import sys
from logging.config import fileConfig

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import create_engine

# Ensure the project root is on sys.path so we can import src.*
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load .env for DATABASE_URL
load_dotenv()

# Alembic Config object
config = context.config

# Set up loggers from alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Import all models so Alembic can see them for autogenerate
from src.db.models import Base  # noqa: E402

target_metadata = Base.metadata


def get_url() -> str:
    """Get database URL from environment, falling back to alembic.ini."""
    return os.getenv("DATABASE_URL", config.get_main_option("sqlalchemy.url"))


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode — generates SQL without connecting."""
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,  # SQLite compat (batch ALTER TABLE)
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode — connects to DB and applies."""
    url = get_url()

    # Build engine kwargs based on dialect
    engine_kwargs = {}
    if url and url.startswith("postgresql"):
        engine_kwargs.update({
            "pool_size": 5,
            "pool_pre_ping": True,
        })

    connectable = create_engine(url, **engine_kwargs)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite compat (batch ALTER TABLE)
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
