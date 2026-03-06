"""
Context Block Store for AIDM v3.

Living prose summaries of narrative elements (arcs, threads, quests, NPCs, factions)
stored in PostgreSQL with pgvector for semantic retrieval.

Block types: arc | thread | quest | npc | faction
"""

import json
import logging
from typing import Any

import sqlalchemy as sa

from ..db.session import get_engine
from ._embeddings import embed, get_api_key, vec_to_pg

logger = logging.getLogger(__name__)


def _json(obj: Any) -> str:
    return json.dumps(obj)


def _row_to_dict(row: Any) -> dict[str, Any]:
    return dict(row._mapping)


class ContextBlockStore:
    """
    CRUD and retrieval for context blocks.

    All writes increment `version` and update `updated_at`.
    Search uses pgvector cosine similarity with full-text fallback.
    """

    def __init__(self, campaign_id: int):
        self._campaign_id = int(campaign_id)
        self._engine = get_engine()

    def _conn(self):
        return self._engine.connect()

    def _embed(self, text: str) -> list[float] | None:
        return embed(text, api_key=get_api_key())

    # ── Read ──────────────────────────────────────────────────────────────────

    def get(self, block_type: str, entity_id: str) -> dict[str, Any] | None:
        """Fetch a single block by type + entity_id. Returns None if not found."""
        with self._conn() as conn:
            row = conn.execute(sa.text("""
                SELECT id, block_type, entity_id, entity_name, status,
                       first_turn, last_updated_turn, version,
                       content, continuity_checklist, metadata,
                       created_at, updated_at
                FROM context_blocks
                WHERE campaign_id = :cid
                  AND block_type  = :btype
                  AND entity_id   = :eid
            """), {"cid": self._campaign_id, "btype": block_type, "eid": entity_id}).fetchone()
        return _row_to_dict(row) if row else None

    def get_active_by_type(self, block_type: str) -> list[dict[str, Any]]:
        """Return all active blocks of a given type, newest-updated first."""
        with self._conn() as conn:
            rows = conn.execute(sa.text("""
                SELECT id, block_type, entity_id, entity_name, status,
                       first_turn, last_updated_turn, version,
                       content, continuity_checklist, metadata,
                       created_at, updated_at
                FROM context_blocks
                WHERE campaign_id = :cid
                  AND block_type  = :btype
                  AND status      = 'active'
                ORDER BY last_updated_turn DESC NULLS LAST
            """), {"cid": self._campaign_id, "btype": block_type}).fetchall()
        return [_row_to_dict(r) for r in rows]

    def get_for_session_start(self) -> dict[str, Any]:
        """
        Return blocks relevant at session open:
          - current_arc_block: most recently updated active arc block (or None)
          - active_quest_blocks: up to 3 active quest blocks, newest first
          - callback_thread_blocks: thread blocks with metadata seed_status=callback
        """
        with self._conn() as conn:
            arc_row = conn.execute(sa.text("""
                SELECT id, block_type, entity_id, entity_name, status,
                       first_turn, last_updated_turn, version,
                       content, continuity_checklist, metadata
                FROM context_blocks
                WHERE campaign_id = :cid
                  AND block_type  = 'arc'
                  AND status      = 'active'
                ORDER BY last_updated_turn DESC NULLS LAST
                LIMIT 1
            """), {"cid": self._campaign_id}).fetchone()

            quest_rows = conn.execute(sa.text("""
                SELECT id, block_type, entity_id, entity_name, status,
                       first_turn, last_updated_turn, version,
                       content, continuity_checklist, metadata
                FROM context_blocks
                WHERE campaign_id = :cid
                  AND block_type  = 'quest'
                  AND status      = 'active'
                ORDER BY last_updated_turn DESC NULLS LAST
                LIMIT 3
            """), {"cid": self._campaign_id}).fetchall()

            thread_rows = conn.execute(sa.text("""
                SELECT id, block_type, entity_id, entity_name, status,
                       first_turn, last_updated_turn, version,
                       content, continuity_checklist, metadata
                FROM context_blocks
                WHERE campaign_id = :cid
                  AND block_type  = 'thread'
                  AND status      = 'active'
                  AND metadata->>'seed_status' = 'callback'
                ORDER BY last_updated_turn DESC NULLS LAST
                LIMIT 5
            """), {"cid": self._campaign_id}).fetchall()

        return {
            "current_arc_block": _row_to_dict(arc_row) if arc_row else None,
            "active_quest_blocks": [_row_to_dict(r) for r in quest_rows],
            "callback_thread_blocks": [_row_to_dict(r) for r in thread_rows],
        }

    # ── Write ─────────────────────────────────────────────────────────────────

    def upsert(
        self,
        block_type: str,
        entity_id: str,
        entity_name: str,
        content: str,
        continuity_checklist: dict,
        last_updated_turn: int,
        first_turn: int | None = None,
        status: str = "active",
        metadata: dict | None = None,
    ) -> int:
        """
        Create or update a context block.

        On update, increments version and refreshes the embedding.
        Returns the row id.
        """
        vec = self._embed(content)
        vec_literal = vec_to_pg(vec) if vec else None
        vec_sql = "CAST(:vec AS vector)" if vec_literal else "NULL"
        meta = metadata or {}

        with self._conn() as conn:
            existing = conn.execute(sa.text("""
                SELECT id, version, first_turn FROM context_blocks
                WHERE campaign_id = :cid
                  AND block_type  = :btype
                  AND entity_id   = :eid
            """), {"cid": self._campaign_id, "btype": block_type, "eid": entity_id}).fetchone()

            base_params = {
                "cid": self._campaign_id,
                "btype": block_type,
                "eid": entity_id,
                "ename": entity_name,
                "content": content,
                "checklist": _json(continuity_checklist),
                "last_turn": last_updated_turn,
                "status": status,
                "meta": _json(meta),
                "vec": vec_literal,
            }

            if existing:
                base_params["version"] = existing.version + 1
                base_params["first_turn"] = existing.first_turn or first_turn
                conn.execute(sa.text(f"""
                    UPDATE context_blocks
                    SET entity_name          = :ename,
                        content              = :content,
                        continuity_checklist = CAST(:checklist AS jsonb),
                        last_updated_turn    = :last_turn,
                        first_turn           = :first_turn,
                        status               = :status,
                        version              = :version,
                        metadata             = CAST(:meta AS jsonb),
                        embedding_vec        = {vec_sql},
                        updated_at           = now()
                    WHERE campaign_id = :cid
                      AND block_type  = :btype
                      AND entity_id   = :eid
                """), base_params)
                row_id = existing.id
            else:
                base_params["first_turn"] = first_turn
                result = conn.execute(sa.text(f"""
                    INSERT INTO context_blocks
                        (campaign_id, block_type, entity_id, entity_name,
                         content, continuity_checklist, last_updated_turn,
                         first_turn, status, metadata, embedding_vec)
                    VALUES
                        (:cid, :btype, :eid, :ename,
                         :content, CAST(:checklist AS jsonb), :last_turn,
                         :first_turn, :status, CAST(:meta AS jsonb), {vec_sql})
                    RETURNING id
                """), base_params)
                row_id = result.fetchone()[0]

            conn.commit()

        return row_id

    def close_block(self, block_type: str, entity_id: str) -> None:
        """Mark a block as closed (entity's story arc is complete)."""
        with self._conn() as conn:
            conn.execute(sa.text("""
                UPDATE context_blocks
                SET status     = 'closed',
                    updated_at = now()
                WHERE campaign_id = :cid
                  AND block_type  = :btype
                  AND entity_id   = :eid
            """), {"cid": self._campaign_id, "btype": block_type, "eid": entity_id})
            conn.commit()

    # ── Search ────────────────────────────────────────────────────────────────

    def search(
        self,
        query: str,
        block_type: str | None = None,
        limit: int = 5,
        include_closed: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Semantic search across context blocks.

        Falls back to full-text search when embeddings are unavailable.
        """
        if limit <= 0:
            return []

        vec = self._embed(query)
        type_filter = "AND block_type = :btype" if block_type else ""
        status_filter = "" if include_closed else "AND status = 'active'"

        params: dict[str, Any] = {
            "cid": self._campaign_id,
            "btype": block_type,
            "lim": limit,
        }

        with self._conn() as conn:
            if vec:
                params["vec"] = vec_to_pg(vec)
                rows = conn.execute(sa.text(f"""
                    SELECT id, block_type, entity_id, entity_name, status,
                           first_turn, last_updated_turn, version,
                           content, continuity_checklist, metadata,
                           (embedding_vec <=> CAST(:vec AS vector)) AS distance
                    FROM context_blocks
                    WHERE campaign_id   = :cid
                      AND embedding_vec IS NOT NULL
                      {status_filter}
                      {type_filter}
                    ORDER BY embedding_vec <=> CAST(:vec AS vector)
                    LIMIT :lim
                """), params).fetchall()
            else:
                rows = conn.execute(sa.text(f"""
                    SELECT id, block_type, entity_id, entity_name, status,
                           first_turn, last_updated_turn, version,
                           content, continuity_checklist, metadata,
                           0.5 AS distance
                    FROM context_blocks
                    WHERE campaign_id = :cid
                      AND (
                          to_tsvector('english', content) @@ plainto_tsquery('english', :query)
                          OR content ILIKE :ilike
                      )
                      {status_filter}
                      {type_filter}
                    ORDER BY last_updated_turn DESC NULLS LAST
                    LIMIT :lim
                """), {**params, "query": query, "ilike": f"%{query[:60]}%"}).fetchall()

        return [_row_to_dict(r) for r in rows]

