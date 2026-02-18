"""
API Response Cache for AIDM v3 Scraper Layer.

SQLite-backed cache with status-aware TTL. Uses the AniList series status
field to determine cache freshness:
- FINISHED series: 90-day TTL (completed content rarely changes)
- RELEASING series: 3-day TTL (ongoing series update frequently)
- HIATUS series: 14-day TTL
- NOT_YET_RELEASED: 1-day TTL

Caches both AniList metadata and Fandom wiki content separately.
"""

import json
import logging
import sqlite3
import time
from datetime import timedelta
from pathlib import Path
from typing import Optional, Any

logger = logging.getLogger(__name__)


# ─── TTL Configuration ───────────────────────────────────────────────────────

# Series status → TTL for Fandom wiki content
FANDOM_TTL_BY_STATUS = {
    "FINISHED": timedelta(days=90),
    "RELEASING": timedelta(days=3),
    "NOT_YET_RELEASED": timedelta(days=1),
    "CANCELLED": timedelta(days=180),
    "HIATUS": timedelta(days=14),
}

# Default TTL if status unknown
DEFAULT_FANDOM_TTL = timedelta(days=7)

# AniList metadata TTL (shorter, scores/popularity change)
ANILIST_TTL = timedelta(days=7)

# Wiki existence check TTL (don't re-check constantly)
WIKI_CHECK_TTL = timedelta(days=30)


# ─── Cache Types ─────────────────────────────────────────────────────────────

CACHE_TYPE_ANILIST = "anilist"
CACHE_TYPE_FANDOM = "fandom"
CACHE_TYPE_WIKI_CHECK = "wiki_check"


# ─── Cache Implementation ────────────────────────────────────────────────────

class ScraperCache:
    """SQLite-backed cache for API responses with status-aware TTL."""
    
    def __init__(self, db_path: Optional[str] = None):
        """
        Initialize the cache.
        
        Args:
            db_path: Path to SQLite database. Defaults to data/scraper_cache.db
        """
        if db_path is None:
            db_path = str(Path(__file__).parent.parent.parent / "data" / "scraper_cache.db")
        
        self._db_path = db_path
        self._ensure_db()
    
    def _ensure_db(self):
        """Create the cache table if it doesn't exist."""
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS cache (
                    cache_key TEXT PRIMARY KEY,
                    cache_type TEXT NOT NULL,
                    data TEXT NOT NULL,
                    series_status TEXT DEFAULT 'FINISHED',
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    title TEXT DEFAULT ''
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_cache_type 
                ON cache(cache_type)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_cache_expires 
                ON cache(expires_at)
            """)
            conn.commit()
    
    def _make_key(self, cache_type: str, identifier: str) -> str:
        """Generate a cache key."""
        return f"{cache_type}:{identifier.lower().strip()}"
    
    def get(self, cache_type: str, identifier: str) -> Optional[dict]:
        """
        Retrieve a cached response if it exists and hasn't expired.
        
        Args:
            cache_type: "anilist", "fandom", or "wiki_check"
            identifier: Search key (usually the anime title or wiki URL)
            
        Returns:
            Cached data dict or None if miss/expired
        """
        key = self._make_key(cache_type, identifier)
        now = time.time()
        
        try:
            with sqlite3.connect(self._db_path) as conn:
                row = conn.execute(
                    "SELECT data, expires_at FROM cache WHERE cache_key = ?",
                    (key,)
                ).fetchone()
                
                if row is None:
                    return None
                
                data_json, expires_at = row
                
                if now > expires_at:
                    # Expired — delete and return miss
                    conn.execute("DELETE FROM cache WHERE cache_key = ?", (key,))
                    conn.commit()
                    logger.debug(f"Cache expired: {key}")
                    return None
                
                logger.debug(f"Cache hit: {key}")
                return json.loads(data_json)
                
        except Exception as e:
            logger.warning(f"Cache read error: {e}")
            return None
    
    def put(
        self,
        cache_type: str,
        identifier: str,
        data: Any,
        series_status: str = "FINISHED",
        title: str = "",
    ):
        """
        Store a response in the cache.
        
        TTL is automatically determined by cache_type and series_status.
        
        Args:
            cache_type: "anilist", "fandom", or "wiki_check"
            identifier: Search key
            data: Data to cache (must be JSON-serializable)
            series_status: AniList status for TTL calculation
            title: Human-readable title (for debugging)
        """
        key = self._make_key(cache_type, identifier)
        now = time.time()
        
        # Determine TTL
        if cache_type == CACHE_TYPE_ANILIST:
            ttl = ANILIST_TTL
        elif cache_type == CACHE_TYPE_WIKI_CHECK:
            ttl = WIKI_CHECK_TTL
        else:
            ttl = FANDOM_TTL_BY_STATUS.get(series_status, DEFAULT_FANDOM_TTL)
        
        expires_at = now + ttl.total_seconds()
        
        try:
            data_json = json.dumps(data, ensure_ascii=False, default=str)
            
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO cache 
                    (cache_key, cache_type, data, series_status, created_at, expires_at, title)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (key, cache_type, data_json, series_status, now, expires_at, title))
                conn.commit()
            
            logger.debug(
                f"Cache put: {key} (status={series_status}, "
                f"ttl={ttl.days}d, title='{title}')"
            )
            
        except Exception as e:
            logger.warning(f"Cache write error: {e}")
    
    def invalidate(self, cache_type: str, identifier: str):
        """Remove a specific cache entry."""
        key = self._make_key(cache_type, identifier)
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("DELETE FROM cache WHERE cache_key = ?", (key,))
                conn.commit()
        except Exception as e:
            logger.warning(f"Cache invalidate error: {e}")
    
    def clear_expired(self) -> int:
        """Remove all expired entries. Returns count of deleted rows."""
        now = time.time()
        try:
            with sqlite3.connect(self._db_path) as conn:
                cursor = conn.execute(
                    "DELETE FROM cache WHERE expires_at < ?", (now,)
                )
                conn.commit()
                count = cursor.rowcount
                if count > 0:
                    logger.info(f"Cleared {count} expired cache entries")
                return count
        except Exception as e:
            logger.warning(f"Cache cleanup error: {e}")
            return 0
    
    def clear_all(self):
        """Clear the entire cache."""
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("DELETE FROM cache")
                conn.commit()
            logger.info("Cache cleared")
        except Exception as e:
            logger.warning(f"Cache clear error: {e}")
    
    def stats(self) -> dict:
        """Get cache statistics."""
        now = time.time()
        try:
            with sqlite3.connect(self._db_path) as conn:
                total = conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
                valid = conn.execute(
                    "SELECT COUNT(*) FROM cache WHERE expires_at > ?", (now,)
                ).fetchone()[0]
                expired = total - valid
                
                by_type = {}
                for row in conn.execute(
                    "SELECT cache_type, COUNT(*) FROM cache WHERE expires_at > ? GROUP BY cache_type",
                    (now,)
                ):
                    by_type[row[0]] = row[1]
                
                return {
                    "total": total,
                    "valid": valid,
                    "expired": expired,
                    "by_type": by_type,
                    "db_path": self._db_path,
                }
        except Exception as e:
            return {"error": str(e)}
