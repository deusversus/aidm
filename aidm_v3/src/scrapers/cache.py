"""
API Response Cache for AIDM v3 Scraper Layer.

Cache with status-aware TTL. Uses the AniList series status
field to determine cache freshness:
- FINISHED series: 90-day TTL (completed content rarely changes)
- RELEASING series: 3-day TTL (ongoing series update frequently)
- HIATUS series: 14-day TTL
- NOT_YET_RELEASED: 1-day TTL

Caches both AniList metadata and Fandom wiki content separately.

Uses the shared PostgreSQL database via SQLAlchemy (replaces former
standalone data/scraper_cache.db).
"""

import json
import logging
import time
from datetime import timedelta
from typing import Any

from ..db.models import ApiCacheEntry
from ..db.session import create_session

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
    """SQLAlchemy-backed cache for API responses with status-aware TTL."""

    def _make_key(self, cache_type: str, identifier: str) -> str:
        """Generate a cache key."""
        return f"{cache_type}:{identifier.lower().strip()}"

    def get(self, cache_type: str, identifier: str) -> dict | None:
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

        db = create_session()
        try:
            entry = db.query(ApiCacheEntry).filter(
                ApiCacheEntry.cache_key == key
            ).first()

            if entry is None:
                return None

            if now > entry.expires_at:
                # Expired — delete and return miss
                db.delete(entry)
                db.commit()
                logger.debug(f"Cache expired: {key}")
                return None

            logger.debug(f"Cache hit: {key}")
            return json.loads(entry.data)

        except Exception as e:
            logger.warning(f"Cache read error: {e}")
            return None
        finally:
            db.close()

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

        db = create_session()
        try:
            data_json = json.dumps(data, ensure_ascii=False, default=str)

            existing = db.query(ApiCacheEntry).filter(
                ApiCacheEntry.cache_key == key
            ).first()

            if existing:
                existing.data = data_json
                existing.series_status = series_status
                existing.created_at = now
                existing.expires_at = expires_at
                existing.title = title
            else:
                entry = ApiCacheEntry(
                    cache_key=key,
                    cache_type=cache_type,
                    data=data_json,
                    series_status=series_status,
                    created_at=now,
                    expires_at=expires_at,
                    title=title,
                )
                db.add(entry)

            db.commit()

            logger.debug(
                f"Cache put: {key} (status={series_status}, "
                f"ttl={ttl.days}d, title='{title}')"
            )

        except Exception as e:
            db.rollback()
            logger.warning(f"Cache write error: {e}")
        finally:
            db.close()

    def invalidate(self, cache_type: str, identifier: str):
        """Remove a specific cache entry."""
        key = self._make_key(cache_type, identifier)
        db = create_session()
        try:
            db.query(ApiCacheEntry).filter(
                ApiCacheEntry.cache_key == key
            ).delete()
            db.commit()
        except Exception as e:
            db.rollback()
            logger.warning(f"Cache invalidate error: {e}")
        finally:
            db.close()

    def clear_expired(self) -> int:
        """Remove all expired entries. Returns count of deleted rows."""
        now = time.time()
        db = create_session()
        try:
            count = db.query(ApiCacheEntry).filter(
                ApiCacheEntry.expires_at < now
            ).delete()
            db.commit()
            if count > 0:
                logger.info(f"Cleared {count} expired cache entries")
            return count
        except Exception as e:
            db.rollback()
            logger.warning(f"Cache cleanup error: {e}")
            return 0
        finally:
            db.close()

    def clear_all(self):
        """Clear the entire cache."""
        db = create_session()
        try:
            db.query(ApiCacheEntry).delete()
            db.commit()
            logger.info("Cache cleared")
        except Exception as e:
            db.rollback()
            logger.warning(f"Cache clear error: {e}")
        finally:
            db.close()

    def stats(self) -> dict:
        """Get cache statistics."""
        now = time.time()
        db = create_session()
        try:
            from sqlalchemy import func

            total = db.query(func.count(ApiCacheEntry.cache_key)).scalar()
            valid = (
                db.query(func.count(ApiCacheEntry.cache_key))
                .filter(ApiCacheEntry.expires_at > now)
                .scalar()
            )
            expired = total - valid

            by_type = {}
            type_rows = (
                db.query(ApiCacheEntry.cache_type, func.count(ApiCacheEntry.cache_key))
                .filter(ApiCacheEntry.expires_at > now)
                .group_by(ApiCacheEntry.cache_type)
                .all()
            )
            for row in type_rows:
                by_type[row[0]] = row[1]

            return {
                "total": total,
                "valid": valid,
                "expired": expired,
                "by_type": by_type,
            }
        except Exception as e:
            return {"error": str(e)}
        finally:
            db.close()
