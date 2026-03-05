#!/usr/bin/env python3
"""
Migrate ChromaDB vector data to PostgreSQL pgvector tables.

Copies all documents from the four ChromaDB collections into the new
SQL tables created by migration 005. Embeddings are NOT transferred —
the pgai-vectorizer-worker will re-embed content asynchronously after
this script runs.

Usage:
    venv/bin/python3 dev/migrate_chroma_to_pg.py [--dry-run]

Idempotent: rows that already exist (by chunk_id / unique constraint) are
skipped, so the script is safe to re-run.
"""

import argparse
import json
import sys
from pathlib import Path

# ── Adjust sys.path so we can import from src/ ───────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from datetime import datetime

import chromadb
import sqlalchemy as sa
from sqlalchemy.orm import Session

from src.db._core import get_engine
from src.paths import CHROMA_DIR, CHROMA_CUSTOM_DIR


# ── Helpers ───────────────────────────────────────────────────────────────────

def _chroma_client(path: str):
    return chromadb.PersistentClient(path=path)


def _get_all(collection) -> list[dict]:
    """Fetch every document + metadata from a ChromaDB collection."""
    count = collection.count()
    if count == 0:
        return []
    result = collection.get(include=["documents", "metadatas"])
    rows = []
    for i, doc_id in enumerate(result["ids"]):
        rows.append({
            "id": doc_id,
            "document": result["documents"][i],
            "metadata": result["metadatas"][i] or {},
        })
    return rows


def _parse_float(val, default=100.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _parse_int(val, default=None):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


# ── Migration functions ───────────────────────────────────────────────────────

def migrate_memories(conn: sa.Connection, chroma_path: str, dry_run: bool):
    """Migrate campaign_{id} collections → campaign_memories."""
    client = _chroma_client(chroma_path)
    collections = client.list_collections()
    campaign_colls = [c for c in collections if c.name.startswith("campaign_")]

    total = 0
    for coll_meta in campaign_colls:
        campaign_id_str = coll_meta.name[len("campaign_"):]
        try:
            campaign_id = int(campaign_id_str)
        except ValueError:
            print(f"  [skip] Non-numeric campaign collection: {coll_meta.name}")
            continue

        coll = client.get_collection(coll_meta.name)
        rows = _get_all(coll)
        print(f"  campaign_{campaign_id}: {len(rows)} memories")

        for row in rows:
            meta = row["metadata"]
            record = {
                "campaign_id": campaign_id,
                "content": row["document"],
                "memory_type": meta.get("type", "episodic"),
                "heat": _parse_float(meta.get("heat", 100.0)),
                "turn_number": _parse_int(meta.get("turn")),
                "tags": json.dumps(meta.get("flags", "").split(",") if meta.get("flags") else []),
                "created_at": datetime.utcnow(),
            }
            if not dry_run:
                try:
                    conn.execute(sa.text("""
                        INSERT INTO campaign_memories
                            (campaign_id, content, memory_type, heat, turn_number, tags, created_at)
                        VALUES
                            (:campaign_id, :content, :memory_type, :heat, :turn_number, :tags::jsonb, :created_at)
                        ON CONFLICT DO NOTHING
                    """), record)
                except Exception as e:
                    print(f"    [error] {e}")
            total += 1

    print(f"  → {total} memory rows {'(dry-run)' if dry_run else 'inserted'}")


def migrate_profile_lore(conn: sa.Connection, chroma_path: str, dry_run: bool):
    """Migrate narrative_profiles_lore collection → profile_lore_chunks."""
    client = _chroma_client(chroma_path)
    try:
        coll = client.get_collection("narrative_profiles_lore")
    except Exception:
        print("  [skip] narrative_profiles_lore collection not found")
        return

    rows = _get_all(coll)
    print(f"  narrative_profiles_lore: {len(rows)} chunks")

    for row in rows:
        meta = row["metadata"]
        record = {
            "profile_id": meta.get("profile_id", "unknown"),
            "chunk_id": row["id"],
            "page_title": meta.get("page_title", ""),
            "page_type": meta.get("page_type", "general"),
            "content": row["document"],
            "word_count": len(row["document"].split()),
            "created_at": datetime.utcnow(),
        }
        if not dry_run:
            try:
                conn.execute(sa.text("""
                    INSERT INTO profile_lore_chunks
                        (profile_id, chunk_id, page_title, page_type, content, word_count, created_at)
                    VALUES
                        (:profile_id, :chunk_id, :page_title, :page_type, :content, :word_count, :created_at)
                    ON CONFLICT (profile_id, chunk_id) DO NOTHING
                """), record)
            except Exception as e:
                print(f"    [error] {e}")

    print(f"  → {len(rows)} profile lore rows {'(dry-run)' if dry_run else 'inserted'}")


def migrate_custom_profile_lore(conn: sa.Connection, chroma_path: str, dry_run: bool):
    """Migrate custom_profiles_lore collection → custom_profile_lore_chunks."""
    client = _chroma_client(chroma_path)
    try:
        coll = client.get_collection("custom_profiles_lore")
    except Exception:
        print("  [skip] custom_profiles_lore collection not found")
        return

    rows = _get_all(coll)
    print(f"  custom_profiles_lore: {len(rows)} chunks")

    for row in rows:
        meta = row["metadata"]
        session_id = meta.get("session_id", "unknown")
        record = {
            "session_id": session_id,
            "chunk_id": row["id"],
            "category": meta.get("source", "generated"),
            "tags": json.dumps([]),
            "content": row["document"],
            "created_at": datetime.utcnow(),
        }
        if not dry_run:
            try:
                conn.execute(sa.text("""
                    INSERT INTO custom_profile_lore_chunks
                        (session_id, chunk_id, category, tags, content, created_at)
                    VALUES
                        (:session_id, :chunk_id, :category, :tags::jsonb, :content, :created_at)
                    ON CONFLICT (session_id, chunk_id) DO NOTHING
                """), record)
            except Exception as e:
                print(f"    [error] {e}")

    print(f"  → {len(rows)} custom lore rows {'(dry-run)' if dry_run else 'inserted'}")


def migrate_rule_library(conn: sa.Connection, chroma_path: str, dry_run: bool):
    """Migrate rule_library_v2 collection → rule_library_chunks."""
    client = _chroma_client(chroma_path)
    try:
        coll = client.get_collection("rule_library_v2")
    except Exception:
        print("  [skip] rule_library_v2 collection not found")
        return

    rows = _get_all(coll)
    print(f"  rule_library_v2: {len(rows)} chunks")

    for row in rows:
        meta = row["metadata"]
        record = {
            "chunk_id": row["id"],
            "category": meta.get("category", "unknown"),
            "source_module": meta.get("source_module", "unknown"),
            "tags": json.dumps(meta.get("tags", "").split(",") if meta.get("tags") else []),
            "retrieve_conditions": json.dumps(
                meta.get("conditions", "").split(",") if meta.get("conditions") else []
            ),
            "content": row["document"],
            "created_at": datetime.utcnow(),
        }
        if not dry_run:
            try:
                conn.execute(sa.text("""
                    INSERT INTO rule_library_chunks
                        (chunk_id, category, source_module, tags, retrieve_conditions, content, created_at)
                    VALUES
                        (:chunk_id, :category, :source_module, :tags::jsonb, :retrieve_conditions::jsonb, :content, :created_at)
                    ON CONFLICT (chunk_id) DO NOTHING
                """), record)
            except Exception as e:
                print(f"    [error] {e}")

    print(f"  → {len(rows)} rule library rows {'(dry-run)' if dry_run else 'inserted'}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Migrate ChromaDB → pgvector")
    parser.add_argument("--dry-run", action="store_true", help="Read ChromaDB but don't write to Postgres")
    args = parser.parse_args()

    dry_run = args.dry_run
    if dry_run:
        print("[DRY RUN] No writes will be made to PostgreSQL.\n")

    engine = get_engine()

    with engine.connect() as conn:
        print("=== Migrating campaign memories ===")
        migrate_memories(conn, str(CHROMA_DIR), dry_run)

        print("\n=== Migrating profile lore ===")
        migrate_profile_lore(conn, str(CHROMA_DIR), dry_run)

        print("\n=== Migrating custom profile lore ===")
        migrate_custom_profile_lore(conn, str(CHROMA_CUSTOM_DIR), dry_run)

        print("\n=== Migrating rule library ===")
        migrate_rule_library(conn, str(CHROMA_DIR), dry_run)

        if not dry_run:
            conn.commit()
            print("\n✓ Migration complete. pgai-worker will embed content in the background.")
        else:
            print("\n(dry-run complete — nothing written)")


if __name__ == "__main__":
    main()
