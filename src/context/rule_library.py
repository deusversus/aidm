"""
Rule Library for AIDM v3.

Manages the RAG system for narrative guidance chunks extracted from
Module 12 (Narrative Scaling) and Module 13 (Narrative Calibration).

Chunks are stored as YAML files in aidm_v3/rule_library/ and indexed
in PostgreSQL with pgvector embeddings on first run.
"""

import logging
from pathlib import Path
from typing import Any

import sqlalchemy as sa
import yaml
from pydantic import BaseModel

from ..db.session import get_engine
from ._embeddings import embed, get_api_key, vec_to_pg

logger = logging.getLogger(__name__)


class RuleChunk(BaseModel):
    """A single retrievable rule/guidance chunk."""
    id: str
    category: str  # scale, archetype, ceremony, dna, genre, example
    source_module: str  # module_12 or module_13
    tags: list[str]
    retrieve_conditions: list[str] = []
    content: str


class RuleLibrary:
    """
    Manages the RAG system for narrative guidance chunks.

    Loads YAML chunks from rule_library/ directory and indexes them
    in PostgreSQL (rule_library_chunks table) on first run.
    """

    def __init__(
        self,
        persist_dir: str | None = None,   # ignored, legacy ChromaDB param
        library_dir: str | None = None,
    ):
        from ..paths import RULE_LIBRARY_DIR
        self._engine = get_engine()
        self.library_dir = Path(library_dir) if library_dir else RULE_LIBRARY_DIR

        # Initialize if table is empty
        if self._count_db() == 0:
            self.initialize()

    def _conn(self):
        return self._engine.connect()

    def _embed(self, text: str) -> list[float] | None:
        return embed(text, api_key=get_api_key())

    def _count_db(self) -> int:
        try:
            with self._conn() as conn:
                return conn.execute(sa.text("SELECT COUNT(*) FROM rule_library_chunks")).scalar() or 0
        except Exception:
            return 0

    # ── Initialization ────────────────────────────────────────────────────────

    def initialize(self):
        """Load all YAML chunks from library directory and index them."""
        if not self.library_dir.exists():
            logger.warning(f"Rule library directory not found at {self.library_dir}")
            return

        logger.info(f"Initializing Rule Library from {self.library_dir}...")
        chunks_loaded = 0

        for yaml_file in self.library_dir.glob("**/*.yaml"):
            try:
                chunks_loaded += self._load_yaml_file(yaml_file)
            except Exception as e:
                logger.error(f"Error loading {yaml_file}: {e}")

        logger.info(f"Loaded {chunks_loaded} chunks into Rule Library.")

    def _load_yaml_file(self, file_path: Path) -> int:
        """Load chunks from a YAML file, return count loaded."""
        with open(file_path, encoding="utf-8") as f:
            content = f.read()

        count = 0
        for doc in yaml.safe_load_all(content):
            if doc is None:
                continue
            if isinstance(doc, list):
                for item in doc:
                    if self._index_chunk_dict(item):
                        count += 1
            elif isinstance(doc, dict):
                if self._index_chunk_dict(doc):
                    count += 1
        return count

    def _index_chunk_dict(self, data: dict) -> bool:
        """Parse and index a single chunk dict. Returns True if indexed."""
        if not data or "id" not in data or "content" not in data:
            return False

        chunk = RuleChunk(
            id=data["id"],
            category=data.get("category", "unknown"),
            source_module=data.get("source_module", "unknown"),
            tags=data.get("tags", []),
            retrieve_conditions=data.get("retrieve_conditions", []),
            content=data["content"],
        )
        self._index_chunk(chunk)
        return True

    def _index_chunk(self, chunk: RuleChunk):
        """Upsert a chunk into the database."""
        import json
        vec = self._embed(chunk.content)
        vec_str = vec_to_pg(vec) if vec else None
        vec_sql = "CAST(:vec AS vector)" if vec_str else "NULL"
        with self._conn() as conn:
            conn.execute(sa.text(f"""
                INSERT INTO rule_library_chunks
                    (chunk_id, category, source_module, tags, retrieve_conditions,
                     content, embedding_vec, created_at)
                VALUES
                    (:cid, :cat, :src, CAST(:tags AS jsonb), CAST(:conds AS jsonb),
                     :content, {vec_sql}, now())
                ON CONFLICT (chunk_id) DO UPDATE
                    SET category = EXCLUDED.category,
                        source_module = EXCLUDED.source_module,
                        tags = EXCLUDED.tags,
                        retrieve_conditions = EXCLUDED.retrieve_conditions,
                        content = EXCLUDED.content,
                        embedding_vec = EXCLUDED.embedding_vec
            """), {
                "cid": chunk.id,
                "cat": chunk.category,
                "src": chunk.source_module,
                "tags": json.dumps(chunk.tags),
                "conds": json.dumps(chunk.retrieve_conditions),
                "content": chunk.content,
                "vec": vec_to_pg(vec) if vec else None,
            })
            conn.commit()

    # ── Retrieval ─────────────────────────────────────────────────────────────

    def retrieve(
        self,
        query: str,
        limit: int = 5,
        category: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Retrieve relevant chunks based on semantic search.

        Args:
            query: Search query
            limit: Maximum results to return
            category: Filter by category
            tags: Filter by tags (must have at least one)

        Returns:
            List of dicts with chunk content and metadata
        """
        cat_filter = "AND category = :cat" if category else ""
        vec = self._embed(query)
        params: dict[str, Any] = {"limit": limit * 2, "cat": category}

        with self._conn() as conn:
            if vec:
                params["vec"] = vec_to_pg(vec)
                rows = conn.execute(sa.text(f"""
                    SELECT chunk_id, category, tags, content,
                           (embedding_vec <=> CAST(:vec AS vector)) AS distance
                    FROM rule_library_chunks
                    WHERE embedding_vec IS NOT NULL
                      {cat_filter}
                    ORDER BY embedding_vec <=> CAST(:vec AS vector)
                    LIMIT :limit
                """), params).fetchall()
            else:
                rows = conn.execute(sa.text(f"""
                    SELECT chunk_id, category, tags, content, 0.5 AS distance
                    FROM rule_library_chunks
                    WHERE (
                        to_tsvector('english', content) @@ plainto_tsquery('english', :query)
                        OR content ILIKE :ilike
                    )
                    {cat_filter}
                    ORDER BY LENGTH(content) DESC
                    LIMIT :limit
                """), {**params, "query": query, "ilike": f"%{query[:50]}%"}).fetchall()

        chunks = []
        for row in rows:
            chunk_id, cat, tags_raw, content, distance = row
            chunk_tags = tags_raw if isinstance(tags_raw, list) else []

            # Optional tag post-filter
            if tags and not any(t in chunk_tags for t in tags):
                continue

            chunks.append({
                "id": chunk_id,
                "content": content,
                "category": cat,
                "tags": chunk_tags,
                "score": 1.0 - float(distance),
            })
            if len(chunks) >= limit:
                break

        return chunks

    def get_relevant_rules(self, query: str, limit: int = 5) -> str:
        """Retrieve relevant rules as a formatted string context."""
        chunks = self.retrieve(query, limit=limit)
        parts = []
        for chunk in chunks:
            category = chunk.get("category", "unknown")
            parts.append(f"--- {category.upper()} Guidance ---\n{chunk['content']}")
        return "\n\n".join(parts)

    def get_by_category(self, category: str, limit: int = 10) -> list[dict[str, Any]]:
        return self.retrieve(query=f"{category} guidance", limit=limit, category=category)

    def get_scale_guidance(self, scale_name: str) -> str | None:
        chunks = self.retrieve(query=f"{scale_name} narrative scale", limit=1, category="scale")
        return chunks[0]["content"] if chunks else None

    def get_archetype_guidance(self, archetype: str) -> str | None:
        chunks = self.retrieve(query=f"{archetype} archetype techniques", limit=1, category="archetype")
        return chunks[0]["content"] if chunks else None

    def get_op_axis_guidance(self, axis: str, value: str) -> str | None:
        if not value:
            return None
        category_map = {
            "tension": "op_tension",
            "expression": "op_expression",
            "focus": "op_focus",
        }
        category = category_map.get(axis)
        if not category:
            return None
        chunks = self.retrieve(
            query=f"{value} {axis} OP protagonist mode",
            limit=1,
            category=category,
        )
        return chunks[0]["content"] if chunks else None

    def get_by_id(self, doc_id: str) -> str | None:
        """Get a document by its exact chunk_id."""
        with self._conn() as conn:
            row = conn.execute(sa.text(
                "SELECT content FROM rule_library_chunks WHERE chunk_id = :cid"
            ), {"cid": doc_id}).fetchone()
        return row[0] if row else None

    def get_ceremony_text(self, old_tier: int, new_tier: int) -> str | None:
        return self.get_by_id(f"ceremony_t{old_tier}_t{new_tier}")

    def get_compatibility_guidance(self, tier: int, scale: str) -> str | None:
        tier_label = "low tier" if tier <= 3 else ("mid tier" if tier <= 7 else "high tier")
        chunks = self.retrieve(
            query=f"{tier_label} tier {tier} {scale} scale compatibility guidance",
            limit=1,
            category="compatibility",
        )
        return chunks[0]["content"] if chunks else None

    def get_power_tier_guidance(self, tier: int) -> str | None:
        chunks = self.retrieve(
            query=f"power tier T{tier} narrative guidance scale compatibility",
            limit=1,
            category="power_tier",
        )
        return chunks[0]["content"] if chunks else None

    def get_genre_guidance(self, genre: str, topic: str = "") -> str | None:
        query = f"{genre} genre"
        if topic:
            query += f" {topic}"
        chunks = self.retrieve(query=query, limit=1, category="genre")
        return chunks[0]["content"] if chunks else None

    def get_dna_guidance(self, scale_name: str, value: int) -> str | None:
        level = "low" if value <= 3 else ("high" if value >= 7 else "mid")
        chunks = self.retrieve(
            query=f"{scale_name} {level} DNA narration style",
            limit=1,
            category="dna",
        )
        return chunks[0]["content"] if chunks else None

    def get_tension_guidance(self, archetype: str, power_imbalance: float) -> str | None:
        if power_imbalance <= 3:
            return None

        archetype_tensions = {
            "saitama": "existential",
            "mob": "existential",
            "overlord": "social",
            "saiki_k": "social",
            "wang_ling": "social",
            "disguised_god": "social",
            "vampire_d": "existential",
            "rimuru": "ensemble",
            "mashle": "structural",
        }
        tension_type = archetype_tensions.get((archetype or "").lower(), "structural")
        chunks = self.retrieve(
            query=f"{tension_type} tension OP protagonist",
            limit=1,
            category="tension",
        )
        return chunks[0]["content"] if chunks else None

    def count(self) -> int:
        return self._count_db()

    def close(self):
        pass


# Convenience function
def get_rule_library(persist_dir: str = None) -> RuleLibrary:
    return RuleLibrary(persist_dir=persist_dir)
