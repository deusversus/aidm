"""
Profile Library for AIDM v3.

Manages the RAG system for narrative profiles (lore).
Stores lore chunks in PostgreSQL with pgvector embeddings.
Section-aware chunking preserves page_type metadata for filtered retrieval.
"""

import logging
import re
import uuid
from typing import Any

import sqlalchemy as sa

from ..db.session import get_engine
from ._embeddings import embed, get_api_key, vec_to_pg

logger = logging.getLogger(__name__)


class ProfileLibrary:
    """
    Manages the RAG system for narrative profiles (Lore).
    Ingests raw research text (Pass 1) or V2 markdown profiles.
    Used by Director and Key Animator to ground generation in series facts.

    Section-aware chunking preserves page_type metadata
    for filtered retrieval (e.g., only technique pages for ABILITY intents).
    """

    # Matches headers from the API pipeline:
    #   ## [TECHNIQUES] Rasengan
    _SECTION_HEADER_RE = re.compile(
        r'^##\s*\[([A-Z_]+)\]\s+(.+)$', re.MULTILINE
    )

    def __init__(self, persist_dir: str | None = None):
        # persist_dir is ignored (legacy ChromaDB param kept for interface compat)
        self._engine = get_engine()

    def _conn(self):
        return self._engine.connect()

    def _embed(self, text: str) -> list[float] | None:
        return embed(text, api_key=get_api_key())

    # ── Ingestion ─────────────────────────────────────────────────────────────

    def add_profile_lore(self, profile_id: str, content: str, source: str = "research"):
        """
        Ingest narrative content for a profile.

        Uses section-aware chunking when content contains page-type headers.
        Falls back to paragraph-based chunking for legacy content.
        """
        if self._SECTION_HEADER_RE.search(content):
            chunks = self._chunk_by_section(content)
        else:
            chunks = self._chunk_by_paragraph(content)

        if not chunks:
            return

        with self._conn() as conn:
            for i, chunk in enumerate(chunks):
                text = chunk["text"]
                chunk_id = f"{profile_id}_{uuid.uuid4()}"
                vec = self._embed(text)
                vec_str = vec_to_pg(vec) if vec else None
                vec_sql = "CAST(:vec AS vector)" if vec_str else "NULL"
                conn.execute(sa.text(f"""
                    INSERT INTO profile_lore_chunks
                        (profile_id, chunk_id, page_title, page_type, content,
                         word_count, embedding_vec, created_at)
                    VALUES
                        (:pid, :cid, :title, :ptype, :content,
                         :wc, {vec_sql}, now())
                    ON CONFLICT (profile_id, chunk_id) DO NOTHING
                """), {
                    "pid": profile_id,
                    "cid": chunk_id,
                    "title": chunk.get("page_title", ""),
                    "ptype": chunk.get("page_type", "general"),
                    "content": text,
                    "wc": len(text.split()),
                    "vec": vec_str,
                })
            conn.commit()

        type_counts: dict[str, int] = {}
        for c in chunks:
            pt = c.get("page_type", "general")
            type_counts[pt] = type_counts.get(pt, 0) + 1
        summary = ", ".join(f"{t}:{n}" for t, n in sorted(type_counts.items()))
        logger.info(f"Ingested {len(chunks)} lore chunks for {profile_id} ({summary})")

    # ── Search ────────────────────────────────────────────────────────────────

    def search_lore(
        self,
        profile_id: str,
        query: str,
        limit: int = 5,
        page_type: str | None = None,
    ) -> list[str]:
        """Search for lore relevant to the query within a single profile."""
        return self._search(profile_ids=[profile_id], query=query, limit=limit, page_type=page_type)

    def search_lore_multi(
        self,
        profile_ids: list[str],
        query: str,
        limit: int = 5,
        page_type: str | None = None,
    ) -> list[str]:
        """Search lore across multiple profiles, returning merged ranked results."""
        if not profile_ids:
            return []
        if len(profile_ids) == 1:
            return self.search_lore(profile_ids[0], query, limit, page_type)
        return self._search(profile_ids=profile_ids, query=query, limit=limit, page_type=page_type)

    def _search(
        self,
        profile_ids: list[str],
        query: str,
        limit: int,
        page_type: str | None,
    ) -> list[str]:
        ptype_filter = "AND page_type = :ptype" if page_type else ""
        # Build IN clause safely
        placeholders = ", ".join(f":pid{i}" for i in range(len(profile_ids)))
        pid_params = {f"pid{i}": v for i, v in enumerate(profile_ids)}

        vec = self._embed(query)
        params: dict[str, Any] = {**pid_params, "limit": limit, "ptype": page_type}

        with self._conn() as conn:
            if vec:
                params["vec"] = vec_to_pg(vec)
                rows = conn.execute(sa.text(f"""
                    SELECT content
                    FROM profile_lore_chunks
                    WHERE profile_id IN ({placeholders})
                      AND embedding_vec IS NOT NULL
                      {ptype_filter}
                    ORDER BY embedding_vec <=> CAST(:vec AS vector)
                    LIMIT :limit
                """), params).fetchall()
            else:
                rows = conn.execute(sa.text(f"""
                    SELECT content
                    FROM profile_lore_chunks
                    WHERE profile_id IN ({placeholders})
                      AND (
                          to_tsvector('english', content) @@ plainto_tsquery('english', :query)
                          OR content ILIKE :ilike
                      )
                      {ptype_filter}
                    ORDER BY word_count DESC
                    LIMIT :limit
                """), {**params, "query": query, "ilike": f"%{query[:50]}%"}).fetchall()

        return [r[0] for r in rows]

    # ── Chunking ──────────────────────────────────────────────────────────────

    def _chunk_by_section(self, content: str, max_chunk_size: int = 1500) -> list[dict[str, Any]]:
        """Section-aware chunking for API pipeline content."""
        chunks = []
        headers = list(self._SECTION_HEADER_RE.finditer(content))

        if not headers:
            return self._chunk_by_paragraph(content)

        pre_header = content[:headers[0].start()].strip()
        if pre_header and len(pre_header) >= 50:
            for sub in self._sub_chunk(pre_header, max_chunk_size):
                chunks.append({"text": sub, "page_type": "general", "page_title": ""})

        for i, m in enumerate(headers):
            page_type = m.group(1).lower()
            page_title = m.group(2).strip()
            section_start = m.end()
            section_end = headers[i + 1].start() if i + 1 < len(headers) else len(content)
            section_text = content[section_start:section_end].strip()

            if not section_text or len(section_text) < 30:
                continue

            for sub in self._sub_chunk(f"{page_title}\n{section_text}", max_chunk_size):
                chunks.append({"text": sub, "page_type": page_type, "page_title": page_title})

        return chunks

    def _sub_chunk(self, text: str, max_size: int = 1500) -> list[str]:
        if len(text) <= max_size:
            return [text]
        paragraphs = text.split("\n\n")
        sub_chunks, current = [], ""
        for para in paragraphs:
            if len(current) + len(para) + 2 <= max_size:
                current = f"{current}\n\n{para}" if current else para
            else:
                if current:
                    sub_chunks.append(current.strip())
                current = para
        if current:
            sub_chunks.append(current.strip())
        return sub_chunks

    def _chunk_by_paragraph(self, text: str, chunk_size: int = 1000) -> list[dict[str, Any]]:
        if not text:
            return []
        paragraphs = text.split("\n\n")
        chunks, current = [], ""
        for para in paragraphs:
            if len(current) + len(para) < chunk_size:
                current += "\n\n" + para
            else:
                if current:
                    chunks.append({"text": current.strip(), "page_type": "general", "page_title": ""})
                current = para
        if current:
            chunks.append({"text": current.strip(), "page_type": "general", "page_title": ""})
        return chunks


# Singleton instance
_profile_library: ProfileLibrary | None = None


def get_profile_library() -> ProfileLibrary:
    global _profile_library
    if _profile_library is None:
        _profile_library = ProfileLibrary()
    return _profile_library
