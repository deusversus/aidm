"""
SQL-backed Lore Store for AIDM v3.

Replaces flat .txt lore dumps with structured per-page SQLite storage.
Each wiki page is stored individually with metadata (page_type, title,
word count, source wiki, scrape timestamp), enabling:
- Queryable per-page access
- Incremental updates (re-scrape one character)
- Deduplication detection
- Quality metrics and debugging

ChromaDB remains the vector search layer — this is the structured
source-of-truth that feeds it.
"""

import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ─── Store Implementation ────────────────────────────────────────────────────

class LoreStore:
    """SQLite-backed storage for structured wiki lore pages."""

    def __init__(self, db_path: str | None = None):
        """
        Initialize the lore store.
        
        Args:
            db_path: Path to SQLite database. Defaults to data/lore_store.db
        """
        if db_path is None:
            db_path = str(Path(__file__).parent.parent.parent / "data" / "lore_store.db")

        self._db_path = db_path
        self._ensure_db()

    def _ensure_db(self):
        """Create the wiki_pages table if it doesn't exist."""
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)

        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS wiki_pages (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id  TEXT NOT NULL,
                    page_title  TEXT NOT NULL,
                    page_type   TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    word_count  INTEGER DEFAULT 0,
                    source_wiki TEXT DEFAULT '',
                    scraped_at  REAL NOT NULL,
                    
                    UNIQUE(profile_id, page_title)
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_wp_profile 
                ON wiki_pages(profile_id)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_wp_type 
                ON wiki_pages(profile_id, page_type)
            """)
            conn.commit()

    def store_pages(
        self,
        profile_id: str,
        pages: list[dict[str, Any]],
        source_wiki: str = "",
    ) -> int:
        """
        Bulk insert wiki pages for a profile.
        
        Uses INSERT OR REPLACE to handle re-scrapes cleanly.
        
        Args:
            profile_id: Profile identifier (e.g., "solo_leveling")
            pages: List of page dicts with keys: title, page_type, content
            source_wiki: Wiki URL for provenance tracking
            
        Returns:
            Number of pages stored
        """
        if not pages:
            return 0

        now = time.time()
        stored = 0

        try:
            with sqlite3.connect(self._db_path) as conn:
                for page in pages:
                    content = page.get("content", "")
                    word_count = len(content.split())

                    conn.execute("""
                        INSERT OR REPLACE INTO wiki_pages
                        (profile_id, page_title, page_type, content, word_count, source_wiki, scraped_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (
                        profile_id,
                        page.get("title", "Unknown"),
                        page.get("page_type", "general"),
                        content,
                        word_count,
                        source_wiki,
                        now,
                    ))
                    stored += 1

                conn.commit()

            logger.info(f"[LoreStore] Stored {stored} pages for '{profile_id}' from {source_wiki}")

        except Exception as e:
            logger.error(f"[LoreStore] Error storing pages for '{profile_id}': {e}")

        return stored

    def get_pages(
        self,
        profile_id: str,
        page_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Retrieve stored pages for a profile.
        
        Args:
            profile_id: Profile identifier
            page_type: Optional filter by page type (e.g., "characters")
            
        Returns:
            List of page dicts with all fields
        """
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.row_factory = sqlite3.Row

                if page_type:
                    rows = conn.execute(
                        "SELECT * FROM wiki_pages WHERE profile_id = ? AND page_type = ? ORDER BY id",
                        (profile_id, page_type)
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM wiki_pages WHERE profile_id = ? ORDER BY id",
                        (profile_id,)
                    ).fetchall()

                return [dict(row) for row in rows]

        except Exception as e:
            logger.error(f"[LoreStore] Error reading pages for '{profile_id}': {e}")
            return []

    def get_combined_content(self, profile_id: str) -> str:
        """
        Reconstruct the combined lore content from stored pages.
        
        Produces the same format as the old .txt dump:
        ## [TYPE] Title
        content...
        
        This is used for LLM synthesis and backward compatibility.
        
        Args:
            profile_id: Profile identifier
            
        Returns:
            Combined text string, or empty string if no pages found
        """
        pages = self.get_pages(profile_id)

        if not pages:
            return ""

        sections = []
        for page in pages:
            page_type = page.get("page_type", "general").upper()
            title = page.get("page_title", "")
            content = page.get("content", "")
            sections.append(f"\n## [{page_type}] {title}\n{content}")

        return "\n\n".join(sections)

    def has_profile(self, profile_id: str) -> bool:
        """Check if any pages exist for a profile."""
        try:
            with sqlite3.connect(self._db_path) as conn:
                count = conn.execute(
                    "SELECT COUNT(*) FROM wiki_pages WHERE profile_id = ?",
                    (profile_id,)
                ).fetchone()[0]
                return count > 0
        except Exception:
            return False

    def delete_profile(self, profile_id: str) -> int:
        """
        Delete all pages for a profile.
        
        Args:
            profile_id: Profile identifier
            
        Returns:
            Number of pages deleted
        """
        try:
            with sqlite3.connect(self._db_path) as conn:
                cursor = conn.execute(
                    "DELETE FROM wiki_pages WHERE profile_id = ?",
                    (profile_id,)
                )
                conn.commit()
                count = cursor.rowcount
                if count > 0:
                    logger.info(f"[LoreStore] Deleted {count} pages for '{profile_id}'")
                return count
        except Exception as e:
            logger.error(f"[LoreStore] Error deleting pages for '{profile_id}': {e}")
            return 0

    def get_stats(self, profile_id: str | None = None) -> dict[str, Any]:
        """
        Get storage statistics.
        
        Args:
            profile_id: Optional — stats for specific profile, or all if None
            
        Returns:
            Dict with page counts, word counts, types breakdown
        """
        try:
            with sqlite3.connect(self._db_path) as conn:
                if profile_id:
                    total = conn.execute(
                        "SELECT COUNT(*) FROM wiki_pages WHERE profile_id = ?",
                        (profile_id,)
                    ).fetchone()[0]

                    total_words = conn.execute(
                        "SELECT COALESCE(SUM(word_count), 0) FROM wiki_pages WHERE profile_id = ?",
                        (profile_id,)
                    ).fetchone()[0]

                    by_type = {}
                    for row in conn.execute(
                        "SELECT page_type, COUNT(*), SUM(word_count) FROM wiki_pages "
                        "WHERE profile_id = ? GROUP BY page_type",
                        (profile_id,)
                    ):
                        by_type[row[0]] = {"pages": row[1], "words": row[2]}

                    scraped_at = conn.execute(
                        "SELECT MIN(scraped_at) FROM wiki_pages WHERE profile_id = ?",
                        (profile_id,)
                    ).fetchone()[0]

                    return {
                        "profile_id": profile_id,
                        "total_pages": total,
                        "total_words": total_words,
                        "by_type": by_type,
                        "scraped_at": scraped_at,
                    }
                else:
                    # Global stats
                    total = conn.execute("SELECT COUNT(*) FROM wiki_pages").fetchone()[0]
                    profiles = conn.execute(
                        "SELECT DISTINCT profile_id FROM wiki_pages"
                    ).fetchall()

                    return {
                        "total_pages": total,
                        "profiles": [r[0] for r in profiles],
                        "profile_count": len(profiles),
                        "db_path": self._db_path,
                    }

        except Exception as e:
            return {"error": str(e)}

    def clear_all(self):
        """Delete all stored pages."""
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.execute("DELETE FROM wiki_pages")
                conn.commit()
            logger.info("[LoreStore] Cleared all pages")
        except Exception as e:
            logger.error(f"[LoreStore] Error clearing: {e}")


# ─── Singleton ───────────────────────────────────────────────────────────────

_lore_store: LoreStore | None = None


def get_lore_store() -> LoreStore:
    """Get the global LoreStore instance."""
    global _lore_store
    if _lore_store is None:
        _lore_store = LoreStore()
    return _lore_store
