"""
Background task helpers that generate/update context blocks when
narrative entities are created or mutated.

All functions are fire-and-forget coroutines — called via safe_create_task.
They perform their own DB queries so they're not coupled to the caller's
SQLAlchemy session.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


# ── Quest block tasks ─────────────────────────────────────────────────────────

async def create_quest_block(campaign_id: int, quest_id: int, current_turn: int) -> None:
    """Generate initial context block for a newly created quest."""
    try:
        from .block_generator import ContextBlockGenerator
        from .context_blocks import ContextBlockStore
        from ..db.session import get_engine
        import sqlalchemy as sa

        engine = get_engine()
        with engine.connect() as conn:
            row = conn.execute(sa.text("""
                SELECT id, title, description, status, quest_type,
                       objectives, related_npcs, related_locations, created_turn
                FROM quests
                WHERE id = :qid AND campaign_id = :cid
            """), {"qid": quest_id, "cid": campaign_id}).fetchone()
        if not row:
            return

        quest = dict(row._mapping)
        turns = _fetch_quest_turns(campaign_id, quest.get("created_turn") or current_turn, current_turn)

        gen = ContextBlockGenerator()
        result = await gen.generate_quest_block(quest=quest, relevant_turns=turns)
        if not result:
            return

        content, checklist = result
        checklist["last_generated_turn"] = current_turn
        store = ContextBlockStore(campaign_id)
        store.upsert(
            block_type="quest",
            entity_id=str(quest_id),
            entity_name=quest.get("title", f"Quest {quest_id}"),
            content=content,
            continuity_checklist=checklist,
            last_updated_turn=current_turn,
            first_turn=quest.get("created_turn") or current_turn,
        )
        logger.info(f"[block_triggers] Created quest block for quest_id={quest_id}")
    except Exception:
        logger.exception(f"[block_triggers] create_quest_block failed for quest_id={quest_id}")


async def update_quest_block(campaign_id: int, quest_id: int, current_turn: int) -> None:
    """Refresh context block after a quest update (status change or objective progress)."""
    try:
        from .block_generator import ContextBlockGenerator
        from .context_blocks import ContextBlockStore
        from ..db.session import get_engine
        import sqlalchemy as sa

        store = ContextBlockStore(campaign_id)
        existing = store.get("quest", str(quest_id))

        engine = get_engine()
        with engine.connect() as conn:
            row = conn.execute(sa.text("""
                SELECT id, title, description, status, quest_type,
                       objectives, related_npcs, related_locations, created_turn
                FROM quests
                WHERE id = :qid AND campaign_id = :cid
            """), {"qid": quest_id, "cid": campaign_id}).fetchone()
        if not row:
            return

        quest = dict(row._mapping)
        start_turn = (existing["last_updated_turn"] if existing else quest.get("created_turn")) or 1
        turns = _fetch_quest_turns(campaign_id, start_turn, current_turn)

        gen = ContextBlockGenerator()
        result = await gen.generate_quest_block(quest=quest, relevant_turns=turns, existing_block=existing)
        if not result:
            return

        content, checklist = result
        checklist["last_generated_turn"] = current_turn
        new_status = "closed" if quest.get("status") in ("completed", "failed", "abandoned") else "active"
        store.upsert(
            block_type="quest",
            entity_id=str(quest_id),
            entity_name=quest.get("title", f"Quest {quest_id}"),
            content=content,
            continuity_checklist=checklist,
            last_updated_turn=current_turn,
            first_turn=quest.get("created_turn") or current_turn,
            status=new_status,
        )
        if new_status == "closed":
            store.close_block("quest", str(quest_id))
        logger.info(f"[block_triggers] Updated quest block for quest_id={quest_id}")
    except Exception:
        logger.exception(f"[block_triggers] update_quest_block failed for quest_id={quest_id}")


# ── NPC block tasks ───────────────────────────────────────────────────────────

async def create_or_update_npc_block(campaign_id: int, npc_id: int, current_turn: int) -> None:
    """Generate or refresh context block for an NPC."""
    try:
        from .block_generator import ContextBlockGenerator
        from .context_blocks import ContextBlockStore
        from ..db.session import get_engine
        from ..context.memory import MemoryStore
        import sqlalchemy as sa

        engine = get_engine()
        with engine.connect() as conn:
            row = conn.execute(sa.text("""
                SELECT id, name, affinity_score, scene_count,
                       personality, secrets, milestones, npc_type
                FROM npcs
                WHERE id = :nid AND campaign_id = :cid
            """), {"nid": npc_id, "cid": campaign_id}).fetchone()
        if not row:
            return

        npc = dict(row._mapping)
        store = ContextBlockStore(campaign_id)
        existing = store.get("npc", str(npc_id))

        mem_store = MemoryStore(campaign_id)
        memories = mem_store.search(npc["name"], limit=15)
        turns = _fetch_npc_turns(campaign_id, npc["name"], current_turn, limit=10)

        gen = ContextBlockGenerator()
        result = await gen.generate_npc_block(
            npc=npc, memories=memories, relevant_turns=turns, existing_block=existing
        )
        if not result:
            return

        content, checklist = result
        checklist["last_generated_turn"] = current_turn
        store.upsert(
            block_type="npc",
            entity_id=str(npc_id),
            entity_name=npc["name"],
            content=content,
            continuity_checklist=checklist,
            last_updated_turn=current_turn,
            first_turn=existing["first_turn"] if existing else current_turn,
        )
        logger.info(f"[block_triggers] Upserted NPC block for npc_id={npc_id} ({npc['name']})")
    except Exception:
        logger.exception(f"[block_triggers] create_or_update_npc_block failed for npc_id={npc_id}")


# ── Arc block tasks ───────────────────────────────────────────────────────────

async def create_arc_block(campaign_id: int, arc_name: str, arc_start_turn: int, arc_end_turn: int) -> None:
    """Generate context block for a closing arc."""
    try:
        from .block_generator import ContextBlockGenerator
        from .context_blocks import ContextBlockStore
        from ..db._core import StateManager

        # Get arc turn narratives
        state = StateManager(campaign_id)
        turns = state.search_turn_narratives("", turn_range=(arc_start_turn, arc_end_turn), limit=50)

        store = ContextBlockStore(campaign_id)
        entity_id = arc_name.lower().replace(" ", "_")[:80]
        existing = store.get("arc", entity_id)

        gen = ContextBlockGenerator()
        result = await gen.generate_arc_block(
            arc_name=arc_name, turn_narratives=turns, existing_block=existing
        )
        if not result:
            return

        content, checklist = result
        checklist["last_generated_turn"] = arc_end_turn
        store.upsert(
            block_type="arc",
            entity_id=entity_id,
            entity_name=arc_name,
            content=content,
            continuity_checklist=checklist,
            last_updated_turn=arc_end_turn,
            first_turn=arc_start_turn,
            status="closed",
        )
        logger.info(f"[block_triggers] Created arc block for '{arc_name}'")
    except Exception:
        logger.exception(f"[block_triggers] create_arc_block failed for arc='{arc_name}'")


# ── Source material helpers ───────────────────────────────────────────────────

def _fetch_quest_turns(campaign_id: int, start_turn: int, end_turn: int, limit: int = 20) -> list[dict[str, Any]]:
    """Fetch turn narratives in the turn range for a quest."""
    try:
        from ..db.session import get_engine
        import sqlalchemy as sa
        engine = get_engine()
        with engine.connect() as conn:
            rows = conn.execute(sa.text("""
                SELECT turn_number, narrative
                FROM turns
                WHERE campaign_id = :cid
                  AND turn_number BETWEEN :start AND :end
                ORDER BY turn_number DESC
                LIMIT :lim
            """), {"cid": campaign_id, "start": start_turn, "end": end_turn, "lim": limit}).fetchall()
        return [dict(r._mapping) for r in rows]
    except Exception:
        logger.warning("[block_triggers] _fetch_quest_turns failed", exc_info=True)
        return []


def _fetch_npc_turns(campaign_id: int, npc_name: str, up_to_turn: int, limit: int = 10) -> list[dict[str, Any]]:
    """Fetch recent turn narratives mentioning an NPC."""
    try:
        from ..db.session import get_engine
        import sqlalchemy as sa
        engine = get_engine()
        with engine.connect() as conn:
            rows = conn.execute(sa.text("""
                SELECT turn_number, narrative
                FROM turns
                WHERE campaign_id = :cid
                  AND turn_number <= :up_to
                  AND narrative ILIKE :npc
                ORDER BY turn_number DESC
                LIMIT :lim
            """), {
                "cid": campaign_id, "up_to": up_to_turn,
                "npc": f"%{npc_name[:40]}%", "lim": limit
            }).fetchall()
        return [dict(r._mapping) for r in rows]
    except Exception:
        logger.warning("[block_triggers] _fetch_npc_turns failed", exc_info=True)
        return []
