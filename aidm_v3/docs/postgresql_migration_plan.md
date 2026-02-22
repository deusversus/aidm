# PostgreSQL Migration + Alembic Setup

Consolidate 4 SQLite databases into one PostgreSQL instance via Docker Compose. Set up Alembic for schema management. Clean slate all data.

## Current State

| Store | Backend | Module | Tables |
|-------|---------|--------|--------|
| Main DB | SQLAlchemy + SQLite | `src/db/session.py` | 12 tables (Campaign, Character, Session, Turn, NPC, etc.) |
| Session Zero | Raw `sqlite3` | `src/db/session_store.py` | 1 table (`sessions`) |
| Lore Store | Raw `sqlite3` | `src/scrapers/lore_store.py` | 1 table (`wiki_pages`) |
| Scraper Cache | Raw `sqlite3` | `src/scrapers/cache.py` | 1 table (`api_cache`) |

ChromaDB stays file-based — no change needed.

---

## Proposed Changes

### Phase 1: Infrastructure

#### [NEW] [docker-compose.yml](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/docker-compose.yml)
- PostgreSQL 17 service with named volume
- AIDM app service depending on `db`
- Environment variables for `DATABASE_URL`
- Health check on Postgres before app starts

#### [MODIFY] [Dockerfile](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/Dockerfile)
- Remove `mkdir -p data` for SQLite
- Add Alembic config files to image

#### [MODIFY] [requirements.txt](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/requirements.txt)
- Uncomment `psycopg2-binary`

#### [MODIFY] [.env.example](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/.env.example)
- Add `DATABASE_URL=postgresql://aidm:aidm@localhost:5432/aidm`

---

### Phase 2: Alembic Setup

#### [NEW] [alembic.ini](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/alembic.ini)
- Points at `DATABASE_URL` env var

#### [NEW] [alembic/env.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/alembic/env.py)
- Import `Base.metadata` from `src.db.models`
- Use `get_database_url()` from `src.db.session`
- `render_as_batch=True` for SQLite backward compat

#### [NEW] [alembic/versions/001_baseline.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/alembic/versions/001_baseline.py)
- Auto-generated from all models (existing 12 tables + 3 new consolidated tables)

#### [MODIFY] [session.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/src/db/session.py)
- **Delete** entire PRAGMA migration block (lines 65–120)
- `init_db()` → runs `alembic upgrade head` instead
- Keep `get_engine()` with its SQLite/Postgres branching (already works)
- Add pool configuration for Postgres (`pool_size`, `pool_pre_ping`)

---

### Phase 3: Consolidate Standalone Stores into SQLAlchemy Models

#### [MODIFY] [models.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/src/db/models.py)
Add 3 new SQLAlchemy models:

```python
class SessionZeroState(Base):
    """Session Zero state (replaces sessions.db)."""
    __tablename__ = "session_zero_states"
    session_id = Column(String(64), primary_key=True)
    data = Column(Text, nullable=False)  # JSON blob
    created_at = Column(DateTime, default=datetime.utcnow)
    last_activity = Column(DateTime, default=datetime.utcnow)

class WikiPage(Base):
    """Structured wiki lore (replaces lore_store.db)."""
    __tablename__ = "wiki_pages"
    id = Column(Integer, primary_key=True)
    profile_id = Column(String(100), index=True)
    title = Column(String(500))
    content = Column(Text)
    page_type = Column(String(50))
    word_count = Column(Integer, default=0)
    source_wiki = Column(String(200))
    scraped_at = Column(DateTime, default=datetime.utcnow)

class ApiCacheEntry(Base):
    """Scraper response cache (replaces scraper_cache.db)."""
    __tablename__ = "api_cache"
    cache_key = Column(String(256), primary_key=True)
    cache_type = Column(String(20), index=True)
    title = Column(String(500))
    data = Column(Text)  # JSON blob
    series_status = Column(String(20))
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, index=True)
```

#### [MODIFY] [session_store.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/src/db/session_store.py)
- Replace raw `sqlite3` with SQLAlchemy queries against `SessionZeroState`
- Use `create_session()` from `src.db.session`

#### [MODIFY] [lore_store.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/src/scrapers/lore_store.py)
- Replace raw `sqlite3` with SQLAlchemy queries against `WikiPage`

#### [MODIFY] [cache.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/src/scrapers/cache.py)
- Replace raw `sqlite3` with SQLAlchemy queries against `ApiCacheEntry`

---

### Phase 4: Remove SQLite Artifacts

#### [MODIFY] [_core.py](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/src/db/_core.py)
- `full_reset()` → also clear `session_zero_states`, `wiki_pages`, `api_cache`

#### [MODIFY] [.gitignore](file:///c:/Users/admin/Downloads/animerpg/aidm_v3/.gitignore)
- Remove `*.db` patterns (no more SQLite files)
- Add `pgdata/` for Docker volume

---

### Phase 5: Clean Slate

- Delete existing `*.db` files (`aidm_v3.db`, `data/sessions.db`, `data/lore_store.db`, `data/scraper_cache.db`)
- Delete `data/chroma/` directory
- Delete `data/media/` campaign folders
- Delete existing narrative profile YAMLs from `src/profiles/catalog/`

---

## Verification Plan

### Automated
- `docker compose up` — Postgres starts, AIDM connects, Alembic runs migrations
- `py_compile` all modified files
- `python -c "from src.db.session import init_db; init_db()"` with `DATABASE_URL` pointing at Postgres
- Verify all 15 tables exist in Postgres

### Manual
- Run Session Zero flow → verify campaign, characters, sessions stored in Postgres
- Verify `SessionStore`, `LoreStore`, `ScraperCache` all read/write to Postgres
- `docker compose down -v && docker compose up` → verify clean start with Alembic migrations
