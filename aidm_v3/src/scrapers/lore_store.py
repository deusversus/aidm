"""
SQL-backed Lore Store for AIDM v3.

Structured per-page storage for wiki lore data, enabling:
- Queryable per-page access
- Incremental updates (re-scrape one character)
- Deduplication detection
- Quality metrics and debugging

ChromaDB remains the vector search layer — this is the structured
source-of-truth that feeds it.

Uses the shared PostgreSQL database via SQLAlchemy (replaces former
standalone data/lore_store.db).
"""

import logging
import time
from typing import Any

from sqlalchemy import func

from ..db.models import WikiPage
from ..db.session import get_session

logger = logging.getLogger(__name__)


# ─── Store Implementation ────────────────────────────────────────────────────

class LoreStore:
    """SQLAlchemy-backed storage for structured wiki lore pages."""

    def store_pages(
        self,
        profile_id: str,
        pages: list[dict[str, Any]],
        source_wiki: str = "",
    ) -> int:
        """
        Bulk insert wiki pages for a profile.

        Uses upsert logic to handle re-scrapes cleanly.

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
            with get_session() as db:
                for page in pages:
                    content = page.get("content", "")
                    word_count = len(content.split())
                    page_title = page.get("title", "Unknown")

                    # Upsert: check if exists, update or insert
                    existing = (
                        db.query(WikiPage)
                        .filter(
                            WikiPage.profile_id == profile_id,
                            WikiPage.page_title == page_title,
                        )
                        .first()
                    )

                    if existing:
                        existing.page_type = page.get("page_type", "general")
                        existing.content = content
                        existing.word_count = word_count
                        existing.source_wiki = source_wiki
                        existing.scraped_at = now
                    else:
                        entry = WikiPage(
                            profile_id=profile_id,
                            page_title=page_title,
                            page_type=page.get("page_type", "general"),
                            content=content,
                            word_count=word_count,
                            source_wiki=source_wiki,
                            scraped_at=now,
                        )
                        db.add(entry)

                    stored += 1

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
            with get_session() as db:
                query = db.query(WikiPage).filter(WikiPage.profile_id == profile_id)

                if page_type:
                    query = query.filter(WikiPage.page_type == page_type)

                query = query.order_by(WikiPage.id)
                rows = query.all()

                return [
                    {
                        "id": row.id,
                        "profile_id": row.profile_id,
                        "page_title": row.page_title,
                        "page_type": row.page_type,
                        "content": row.content,
                        "word_count": row.word_count,
                        "source_wiki": row.source_wiki,
                        "scraped_at": row.scraped_at,
                    }
                    for row in rows
                ]
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
            with get_session() as db:
                count = (
                    db.query(func.count(WikiPage.id))
                    .filter(WikiPage.profile_id == profile_id)
                    .scalar()
                )
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
            with get_session() as db:
                count = (
                    db.query(WikiPage)
                    .filter(WikiPage.profile_id == profile_id)
                    .delete()
                )
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
            with get_session() as db:
                if profile_id:
                    total = (
                        db.query(func.count(WikiPage.id))
                        .filter(WikiPage.profile_id == profile_id)
                        .scalar()
                    )

                    total_words = (
                        db.query(func.coalesce(func.sum(WikiPage.word_count), 0))
                        .filter(WikiPage.profile_id == profile_id)
                        .scalar()
                    )

                    by_type = {}
                    type_rows = (
                        db.query(
                            WikiPage.page_type,
                            func.count(WikiPage.id),
                            func.sum(WikiPage.word_count),
                        )
                        .filter(WikiPage.profile_id == profile_id)
                        .group_by(WikiPage.page_type)
                        .all()
                    )
                    for row in type_rows:
                        by_type[row[0]] = {"pages": row[1], "words": row[2]}

                    scraped_at = (
                        db.query(func.min(WikiPage.scraped_at))
                        .filter(WikiPage.profile_id == profile_id)
                        .scalar()
                    )

                    return {
                        "profile_id": profile_id,
                        "total_pages": total,
                        "total_words": total_words,
                        "by_type": by_type,
                        "scraped_at": scraped_at,
                    }
                else:
                    # Global stats
                    total = db.query(func.count(WikiPage.id)).scalar()
                    profiles = (
                        db.query(WikiPage.profile_id)
                        .distinct()
                        .all()
                    )

                    return {
                        "total_pages": total,
                        "profiles": [r[0] for r in profiles],
                        "profile_count": len(profiles),
                    }
        except Exception as e:
            return {"error": str(e)}

    def clear_all(self):
        """Delete all stored pages."""
        try:
            with get_session() as db:
                db.query(WikiPage).delete()
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
