"""
Custom Profile Library for AIDM v3.

Manages RAG storage for custom/original profiles.
Stores lore chunks in PostgreSQL (separate from canonical profiles).
"""

import logging
import shutil
import uuid
from pathlib import Path

import sqlalchemy as sa

from ..db.session import get_engine
from ._embeddings import embed, get_api_key, vec_to_pg

logger = logging.getLogger(__name__)


class CustomProfileLibrary:
    """
    Manages the RAG system for custom (original) profiles.

    Key differences from ProfileLibrary:
    - Profiles keyed by session_id (not anime name)
    - Supports full cleanup when session is reset
    - Uses custom_profile_lore_chunks table
    """

    def __init__(self, persist_dir: str | None = None):
        # persist_dir is ignored (legacy ChromaDB param kept for interface compat)
        self._engine = get_engine()

    def _conn(self):
        return self._engine.connect()

    def _embed(self, text: str) -> list[float] | None:
        return embed(text, api_key=get_api_key())

    # ── Ingestion ─────────────────────────────────────────────────────────────

    def add_custom_lore(
        self,
        session_id: str,
        content: str,
        source: str = "generated",
    ) -> int:
        """
        Ingest lore content for a custom profile.

        Args:
            session_id: The session this profile belongs to
            content: Raw text content to chunk and index
            source: Source type ("generated", "user_input")

        Returns:
            Number of chunks indexed
        """
        chunks = self._chunk_text(content)
        if not chunks:
            return 0

        with self._conn() as conn:
            for i, chunk_text in enumerate(chunks):
                chunk_id = f"{session_id}_{uuid.uuid4()}"
                vec = self._embed(chunk_text)
                vec_str = vec_to_pg(vec) if vec else None
                vec_sql = "CAST(:vec AS vector)" if vec_str else "NULL"
                conn.execute(sa.text(f"""
                    INSERT INTO custom_profile_lore_chunks
                        (session_id, chunk_id, category, tags, content, embedding_vec, created_at)
                    VALUES
                        (:sid, :cid, :cat, '[]'::jsonb, :content, {vec_sql}, now())
                    ON CONFLICT (session_id, chunk_id) DO NOTHING
                """), {
                    "sid": session_id,
                    "cid": chunk_id,
                    "cat": source,
                    "content": chunk_text,
                    "vec": vec_str,
                })
            conn.commit()

        logger.info(f"Indexed {len(chunks)} lore chunks for session {session_id[:8]}...")
        return len(chunks)

    # ── Search ────────────────────────────────────────────────────────────────

    def search_lore(
        self,
        session_id: str,
        query: str,
        limit: int = 5,
    ) -> list[str]:
        """Search for lore relevant to the query, filtered by session_id."""
        vec = self._embed(query)

        with self._conn() as conn:
            if vec:
                rows = conn.execute(sa.text("""
                    SELECT content
                    FROM custom_profile_lore_chunks
                    WHERE session_id = :sid AND embedding_vec IS NOT NULL
                    ORDER BY embedding_vec <=> CAST(:vec AS vector)
                    LIMIT :limit
                """), {"sid": session_id, "vec": vec_to_pg(vec), "limit": limit}).fetchall()
            else:
                rows = conn.execute(sa.text("""
                    SELECT content
                    FROM custom_profile_lore_chunks
                    WHERE session_id = :sid
                      AND (
                          to_tsvector('english', content) @@ plainto_tsquery('english', :query)
                          OR content ILIKE :ilike
                      )
                    LIMIT :limit
                """), {"sid": session_id, "query": query, "ilike": f"%{query[:50]}%",
                       "limit": limit}).fetchall()

        return [r[0] for r in rows]

    # ── Deletion ──────────────────────────────────────────────────────────────

    def delete_session_lore(self, session_id: str) -> int:
        """Delete all lore chunks for a session. Called when session is reset."""
        with self._conn() as conn:
            result = conn.execute(sa.text(
                "DELETE FROM custom_profile_lore_chunks WHERE session_id = :sid"
            ), {"sid": session_id})
            conn.commit()
            count = result.rowcount
        logger.info(f"Deleted {count} lore chunks for session {session_id[:8]}...")
        return count

    def has_session_profile(self, session_id: str, profiles_base: str = "./data/custom_profiles") -> bool:
        """Check if a session has a custom/hybrid profile stored."""
        session_dir = Path(profiles_base) / session_id
        return session_dir.exists() and any(session_dir.glob("*.yaml"))

    def clear_all(self):
        """Delete all custom profile data (lore + files). Called during full reset."""
        with self._conn() as conn:
            conn.execute(sa.text("DELETE FROM custom_profile_lore_chunks"))
            conn.commit()

        custom_dir = Path("./data/custom_profiles")
        if custom_dir.exists():
            shutil.rmtree(custom_dir)
            custom_dir.mkdir(parents=True)

        logger.info("Cleared all custom profiles")

    # ── Chunking ──────────────────────────────────────────────────────────────

    def _chunk_text(self, text: str, chunk_size: int = 1000) -> list[str]:
        """Simple paragraph-based chunking."""
        if not text:
            return []
        paragraphs = text.split("\n\n")
        chunks, current = [], ""
        for para in paragraphs:
            if len(current) + len(para) < chunk_size:
                current += "\n\n" + para
            else:
                if current:
                    chunks.append(current.strip())
                current = para
        if current:
            chunks.append(current.strip())
        return chunks


# ── Module-level helpers (disk I/O, unchanged) ────────────────────────────────

def save_custom_profile(
    session_id: str,
    world_data: dict,
    lore_content: str,
    profiles_base: str = "./data/custom_profiles",
) -> Path:
    """Save a custom profile to disk."""
    import yaml

    profile_dir = Path(profiles_base) / session_id
    profile_dir.mkdir(parents=True, exist_ok=True)

    world_path = profile_dir / "world.yaml"
    with open(world_path, "w", encoding="utf-8") as f:
        yaml.dump(world_data, f, default_flow_style=False, allow_unicode=True)

    lore_path = profile_dir / "world_lore.txt"
    with open(lore_path, "w", encoding="utf-8") as f:
        f.write(lore_content)

    logger.info(f"Saved custom profile to {profile_dir}")
    return profile_dir


def delete_custom_profile(
    session_id: str,
    profiles_base: str = "./data/custom_profiles",
) -> bool:
    """Delete a custom profile folder from disk."""
    profile_dir = Path(profiles_base) / session_id
    if profile_dir.exists():
        shutil.rmtree(profile_dir)
        logger.info(f"Deleted custom profile folder for session {session_id[:8]}...")
        return True
    return False


# Singleton instance
_custom_profile_library: CustomProfileLibrary | None = None


def get_custom_profile_library() -> CustomProfileLibrary:
    """Get the global custom profile library instance."""
    global _custom_profile_library
    if _custom_profile_library is None:
        _custom_profile_library = CustomProfileLibrary()
    return _custom_profile_library
