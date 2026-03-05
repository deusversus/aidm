"""
Memory Store for AIDM v3.

Manages long-term memory using PostgreSQL + pgvector with heat-based decay.
Memories start "hot" and cool over time, but can be refreshed when referenced.
Per Module 02 spec.

Embeddings are generated synchronously on insert via OpenAI text-embedding-3-small
and stored in the `campaign_memories.embedding_vec` column.
Falls back to full-text search when no API key is available.
"""

import logging
import time
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel, Field

from ..db.session import get_engine
from ._embeddings import embed, get_api_key, vec_to_pg

logger = logging.getLogger(__name__)

# Decay rates per memory type (per-turn multiplier)
DECAY_CURVES = {
    "none": 1.0,       # Plot-critical: never decay
    "very_slow": 0.97, # Relationships: 3% decay per turn
    "slow": 0.95,      # Important details: 5% decay per turn
    "normal": 0.90,    # Events: 10% decay per turn
    "fast": 0.80,      # Transient details: 20% decay per turn
    "very_fast": 0.70, # Episodes: 30% decay per turn (fades in ~6 turns)
}

# Default decay rates by memory category
CATEGORY_DECAY = {
    "core": "none",
    "character_state": "fast",
    "relationship": "very_slow",
    "quest": "normal",
    "world_state": "normal",
    "consequence": "slow",
    "event": "normal",
    "fact": "slow",
    "npc_state": "normal",
    "location": "slow",
    "episode": "very_fast",
    "narrative_beat": "slow",
    "session_zero": "none",
    "session_zero_voice": "none",
}


class Memory(BaseModel):
    """A single memory unit."""
    id: str
    type: str
    content: str
    embedding: list[float] | None = None
    heat: float = 100.0
    turn_number: int
    decay_rate: str = "normal"
    timestamp: float = Field(default_factory=time.time)
    metadata: dict[str, Any] = Field(default_factory=dict)
    flags: list[str] = Field(default_factory=list)


class MemoryStore:
    """
    Manages long-term memory using PostgreSQL + pgvector.

    Features:
    - Semantic search via OpenAI embeddings + pgvector cosine similarity
    - Full-text search fallback when embedding unavailable
    - Heat decay over turns (memories fade)
    - Heat boost on access (referenced memories stay relevant)
    - Category-based decay rates
    """

    def __init__(self, campaign_id: str, persist_dir: str | None = None):
        # persist_dir is ignored (legacy ChromaDB param kept for interface compat)
        try:
            self._campaign_id = int(campaign_id)
        except (ValueError, TypeError):
            raise ValueError(f"campaign_id must be convertible to int, got: {campaign_id!r}")

        self._engine = get_engine()
        self._last_decay_turn = 0

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _conn(self):
        return self._engine.connect()

    def _embed(self, text: str) -> list[float] | None:
        return embed(text, api_key=get_api_key())

    # ── Public API ────────────────────────────────────────────────────────────

    def add_memory(
        self,
        content: str,
        memory_type: str,
        turn_number: int,
        metadata: dict[str, Any] | None = None,
        decay_rate: str | None = None,
        flags: list[str] | None = None,
    ) -> str:
        """
        Add a new memory to the store.

        Args:
            content: The memory content
            memory_type: Category (core, relationship, quest, etc.)
            turn_number: When this memory was created
            metadata: Additional metadata (stored in extra_meta)
            decay_rate: Override decay rate (none, slow, normal, fast)
            flags: Special flags (plot_critical, character_milestone)

        Returns:
            Memory ID as string (the row's integer PK)
        """
        if flags is None:
            flags = []
        if metadata is None:
            metadata = {}

        if decay_rate is None:
            decay_rate = CATEGORY_DECAY.get(memory_type, "normal")
        if "plot_critical" in flags:
            decay_rate = "none"

        # Deduplication: check first 200 chars
        content_fp = content.strip()[:200]
        with self._conn() as conn:
            dup = conn.execute(sa.text(
                "SELECT id FROM campaign_memories "
                "WHERE campaign_id = :cid AND LEFT(content, 200) = :fp LIMIT 1"
            ), {"cid": self._campaign_id, "fp": content_fp}).fetchone()
            if dup:
                logger.warning(f"Dedup: skipping duplicate content (matches id={dup[0]})")
                return str(dup[0])

            # Generate embedding
            vec = self._embed(content)
            vec_literal = vec_to_pg(vec) if vec else None
            vec_sql = "CAST(:vec AS vector)" if vec_literal else "NULL"

            result = conn.execute(sa.text(f"""
                INSERT INTO campaign_memories
                    (campaign_id, content, memory_type, heat, decay_rate,
                     turn_number, flags, extra_meta, embedding_vec, created_at)
                VALUES
                    (:cid, :content, :mtype, 100.0, :decay,
                     :turn, :flags::jsonb, :meta::jsonb,
                     {vec_sql}, now())
                RETURNING id
            """), {
                "cid": self._campaign_id,
                "content": content,
                "mtype": memory_type,
                "decay": decay_rate,
                "turn": turn_number,
                "flags": _json(flags),
                "meta": _json(metadata),
                "vec": vec_literal,
            })
            row_id = result.scalar()
            conn.commit()

        return str(row_id)

    def add_episode(
        self,
        turn: int,
        location: str,
        summary: str,
        flags: list | None = None,
    ) -> str:
        """Write episodic memory for a turn (condensed summary)."""
        content = f"[Turn {turn}] {location}: {summary}"
        return self.add_memory(
            content=content,
            memory_type="episode",
            turn_number=turn,
            decay_rate="very_fast",
            flags=flags or ["recent_event"],
        )

    def search(
        self,
        query: str,
        limit: int = 5,
        min_heat: float = 0.0,
        boost_on_access: bool = True,
        memory_type: str | None = None,
        keyword: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Search for relevant memories with heat filtering.

        Uses vector cosine similarity when embeddings are available,
        falls back to PostgreSQL full-text search otherwise.
        """
        if limit <= 0:
            return []

        vec = self._embed(query)
        type_filter = "AND memory_type = :mtype" if memory_type else ""
        kw_filter = "AND content ILIKE :kw" if keyword else ""

        params: dict[str, Any] = {
            "cid": self._campaign_id,
            "min_heat": min_heat,
            "fetch": limit * 2,
            "mtype": memory_type,
            "kw": f"%{keyword}%" if keyword else None,
        }

        with self._conn() as conn:
            if vec:
                params["vec"] = vec_to_pg(vec)
                rows = conn.execute(sa.text(f"""
                    SELECT id, content, memory_type, heat, decay_rate,
                           turn_number, flags, extra_meta,
                           (embedding_vec <=> CAST(:vec AS vector)) AS distance
                    FROM campaign_memories
                    WHERE campaign_id = :cid
                      AND heat >= :min_heat
                      AND embedding_vec IS NOT NULL
                      {type_filter}
                      {kw_filter}
                    ORDER BY embedding_vec <=> CAST(:vec AS vector)
                    LIMIT :fetch
                """), params).fetchall()
            else:
                # FTS fallback
                rows = conn.execute(sa.text(f"""
                    SELECT id, content, memory_type, heat, decay_rate,
                           turn_number, flags, extra_meta,
                           0.5 AS distance
                    FROM campaign_memories
                    WHERE campaign_id = :cid
                      AND heat >= :min_heat
                      AND (
                          to_tsvector('english', content) @@ plainto_tsquery('english', :query)
                          OR content ILIKE :ilike
                      )
                      {type_filter}
                      {kw_filter}
                    ORDER BY heat DESC
                    LIMIT :fetch
                """), {**params, "query": query, "ilike": f"%{query[:50]}%"}).fetchall()

        memories = []
        ids_to_boost = []

        for row in rows:
            mem_id, content, mtype, heat, decay_rate_val, turn_num, flags_raw, meta_raw, distance = row
            flags_list = flags_raw if isinstance(flags_raw, list) else (flags_raw or [])
            flags_str = ",".join(flags_list)

            base_score = 1.0 - float(distance)

            boost = 0.0
            if "session_zero" in flags_str or "plot_critical" in flags_str:
                boost += 0.3
            if mtype == "episode":
                boost += 0.15

            boosted_score = min(1.0, base_score + boost)

            memories.append({
                "id": str(mem_id),
                "content": content,
                "metadata": {
                    "type": mtype,
                    "heat": heat,
                    "decay_rate": decay_rate_val,
                    "turn": turn_num,
                    "flags": flags_str,
                    **(meta_raw or {}),
                },
                "heat": heat,
                "distance": float(distance),
                "score": boosted_score,
                "base_score": base_score,
                "boost": boost,
            })

            if boost_on_access:
                ids_to_boost.append((mem_id, mtype))

            if len(memories) >= limit:
                break

        if ids_to_boost:
            self._boost_heat_batch(ids_to_boost)

        memories.sort(key=lambda m: m["score"], reverse=True)
        return memories

    def search_hybrid(
        self,
        query: str,
        keyword: str,
        limit: int = 5,
        min_heat: float = 0.0,
        boost_on_access: bool = True,
        memory_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """Hybrid search: merges keyword-filtered and pure semantic results."""
        keyword_results = self.search(
            query=query,
            limit=limit,
            min_heat=min_heat,
            boost_on_access=boost_on_access,
            memory_type=memory_type,
            keyword=keyword,
        )
        semantic_results = self.search(
            query=query,
            limit=limit,
            min_heat=min_heat,
            boost_on_access=False,
            memory_type=memory_type,
        )

        seen_ids = set()
        merged = []

        for mem in keyword_results:
            mem = dict(mem)
            mem["score"] = min(1.0, mem["score"] + 0.25)
            mem["boost"] = mem.get("boost", 0.0) + 0.25
            seen_ids.add(mem["id"])
            merged.append(mem)

        for mem in semantic_results:
            if mem["id"] not in seen_ids:
                merged.append(mem)
                seen_ids.add(mem["id"])

        merged.sort(key=lambda m: m["score"], reverse=True)
        return merged[:limit]

    def _boost_heat_batch(self, id_type_pairs: list[tuple[int, str]]):
        """Boost heat for multiple memories after retrieval."""
        if not id_type_pairs:
            return
        with self._conn() as conn:
            for mem_id, mtype in id_type_pairs:
                boost_amount = 30.0 if mtype == "relationship" else 20.0
                conn.execute(sa.text("""
                    UPDATE campaign_memories
                    SET heat = LEAST(100.0, heat + :boost)
                    WHERE id = :id
                """), {"boost": boost_amount, "id": mem_id})
            conn.commit()

    def decay_heat(self, current_turn: int):
        """
        Apply decay to all memory heat based on turns elapsed.
        Called at the end of each turn.
        """
        if current_turn <= self._last_decay_turn:
            return

        turns_elapsed = current_turn - self._last_decay_turn
        self._last_decay_turn = current_turn

        with self._conn() as conn:
            for decay_name, multiplier in DECAY_CURVES.items():
                if multiplier >= 1.0:
                    continue
                effective_mult = multiplier ** turns_elapsed
                # Apply decay, floor at 1.0; milestone relationship memories floor at 40
                conn.execute(sa.text("""
                    UPDATE campaign_memories
                    SET heat = CASE
                        WHEN decay_rate = :rate
                             AND memory_type = 'relationship'
                             AND (flags::text LIKE '%milestone%' OR flags::text LIKE '%plot_critical%')
                        THEN GREATEST(40.0, GREATEST(1.0, heat * :mult))
                        WHEN decay_rate = :rate
                        THEN GREATEST(1.0, heat * :mult)
                        ELSE heat
                    END
                    WHERE campaign_id = :cid
                      AND decay_rate = :rate
                      AND ABS(heat * :mult - heat) > 0.1
                """), {"cid": self._campaign_id, "rate": decay_name, "mult": effective_mult})
            conn.commit()

    def get_hot_memories(self, min_heat: float = 50.0, limit: int = 10) -> list[dict[str, Any]]:
        """Get the hottest memories (most relevant/recent)."""
        with self._conn() as conn:
            rows = conn.execute(sa.text("""
                SELECT id, content, memory_type, heat, flags, extra_meta
                FROM campaign_memories
                WHERE campaign_id = :cid AND heat >= :min_heat
                ORDER BY heat DESC
                LIMIT :limit
            """), {"cid": self._campaign_id, "min_heat": min_heat, "limit": limit}).fetchall()

        return [
            {
                "id": str(r[0]),
                "content": r[1],
                "metadata": {"type": r[2], "heat": r[3], "flags": r[4], **(r[5] or {})},
                "heat": r[3],
            }
            for r in rows
        ]

    def mark_plot_critical(self, memory_id: str):
        """Mark a memory as plot-critical (no decay)."""
        with self._conn() as conn:
            conn.execute(sa.text("""
                UPDATE campaign_memories
                SET decay_rate = 'none',
                    flags = CASE
                        WHEN flags::text NOT LIKE '%plot_critical%'
                        THEN (flags::jsonb || '["plot_critical"]'::jsonb)
                        ELSE flags
                    END
                WHERE id = :id AND campaign_id = :cid
            """), {"id": int(memory_id), "cid": self._campaign_id})
            conn.commit()

    def count(self) -> int:
        """Get total memory count."""
        with self._conn() as conn:
            return conn.execute(sa.text(
                "SELECT COUNT(*) FROM campaign_memories WHERE campaign_id = :cid"
            ), {"cid": self._campaign_id}).scalar() or 0

    async def compress_cold_memories(
        self,
        heat_threshold: float = 30.0,
        min_memories_to_compress: int = 5,
        max_per_category: int = 10,
    ) -> dict[str, Any]:
        """Compress old, cold memories into summarized versions."""
        cold = self._get_cold_memories(heat_threshold)

        if len(cold) < min_memories_to_compress:
            return {
                "compressed": False,
                "reason": f"Only {len(cold)} cold memories, need {min_memories_to_compress}",
                "cold_count": len(cold),
            }

        by_category: dict[str, list[dict]] = {}
        for mem in cold:
            cat = mem["metadata"].get("type", "event")
            by_category.setdefault(cat, []).append(mem)

        # Skip plot-critical categories
        for cat in [c for c, mems in by_category.items()
                    if all(m["metadata"].get("decay_rate") == "none" for m in mems)]:
            del by_category[cat]

        if not by_category:
            return {
                "compressed": False,
                "reason": "All cold memories are plot-critical",
                "cold_count": len(cold),
            }

        compressed_count = 0
        summaries_created = 0

        for category, memories in by_category.items():
            if len(memories) < 2:
                continue
            batch = memories[:max_per_category]
            summary = await self._summarize_memories(category, batch)

            if summary:
                self.add_memory(
                    content=f"[COMPRESSED MEMORIES - {category.upper()}]\n{summary}",
                    memory_type=category,
                    turn_number=batch[0]["metadata"].get("turn_number", 0),
                    metadata={
                        "is_compressed": True,
                        "source_count": len(batch),
                        "source_ids": ",".join(m["id"] for m in batch),
                    },
                    decay_rate="slow",
                    flags=["compressed"],
                )
                summaries_created += 1

                ids_to_delete = [int(m["id"]) for m in batch]
                with self._conn() as conn:
                    conn.execute(sa.text(
                        "DELETE FROM campaign_memories WHERE id = ANY(:ids)"
                    ), {"ids": ids_to_delete})
                    conn.commit()
                compressed_count += len(ids_to_delete)

        return {
            "compressed": True,
            "memories_removed": compressed_count,
            "summaries_created": summaries_created,
            "categories_processed": list(by_category.keys()),
        }

    def _get_cold_memories(self, heat_threshold: float) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(sa.text("""
                SELECT id, content, memory_type, heat, decay_rate, flags, extra_meta
                FROM campaign_memories
                WHERE campaign_id = :cid AND heat < :threshold
            """), {"cid": self._campaign_id, "threshold": heat_threshold}).fetchall()

        return [
            {
                "id": str(r[0]),
                "content": r[1],
                "metadata": {"type": r[2], "heat": r[3], "decay_rate": r[4],
                             "flags": r[5], **(r[6] or {})},
                "heat": r[3],
            }
            for r in rows
        ]

    async def _summarize_memories(self, category: str, memories: list[dict]) -> str | None:
        from ..llm import get_llm_manager
        memory_texts = [f"{i+1}. {m['content']}" for i, m in enumerate(memories)]
        prompt = (
            f"Summarize these {len(memories)} old memories from the \"{category}\" category "
            f"into a single concise paragraph. Preserve key facts, names, and important details. "
            f"Remove redundancy. Keep the summary under 200 words.\n\n"
            f"MEMORIES:\n" + "\n".join(memory_texts) + "\n\nSUMMARY:"
        )
        try:
            manager = get_llm_manager()
            provider, model = manager.get_provider_for_agent("context_selector")
            response = await provider.complete(
                messages=[{"role": "user", "content": prompt}],
                system="You are a memory compression assistant. Create concise summaries that preserve essential information.",
                model=model,
            )
            return response.content.strip()
        except Exception as e:
            logger.error(f"Compression error for {category}: {e}")
            return None

    def close(self):
        """Cleanup if needed."""
        pass


# ── Utility ───────────────────────────────────────────────────────────────────

def _json(obj) -> str:
    import json
    return json.dumps(obj)
