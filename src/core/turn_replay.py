"""Safe replay of idempotent post-narrative bookkeeping steps.

When ``Orchestrator._check_incomplete_turns`` detects that the last gameplay
turn's background processing crashed before completion, we expose a narrow
replay path that re-runs the steps whose side effects are safe to re-apply
for the same ``(campaign_id, turn_number)`` pair:

  - ``entity_graph_snapshot``: writes a versioned ``gameplay_entity_graph``
    artifact. ``save_artifact`` is content-hash-deduplicated, so a repeat
    call is a no-op when the world hasn't changed.
  - ``memory_heat_decay``: decays per-memory heat by a fixed rate keyed on
    turn number; re-running for the same turn simply lands at the same
    terminal value (decay to zero is absorbed).
  - ``episodic_memory``: ``MemoryStore.add_memory`` dedup-skips any write
    whose first 200 chars match an existing row, and the episode content
    is deterministic for a given (turn, location, summary) tuple.

The following steps are **NOT** replayed from this module because replay
would need inputs that aren't persisted in the checkpoint (e.g. the full
``combat_result`` object or the ``outcome`` pydantic model). The underlying
DB mutations are nevertheless safe against double-apply within a running
process thanks to per-turn markers on the character:

  - ``combat_bookkeeping``: guarded by ``character.last_combat_applied_turn``.
  - ``consequence_and_progression``: guarded by
    ``character.last_progression_applied_turn``.

And these remain skipped because their inputs (full narrative text, LLM
outputs) aren't persisted and re-running would call the LLM again with
potentially different results:

  - ``entity_extraction`` / ``relationship_analysis`` / ``production_check``
  - ``memory_compression``
  - ``state_snapshot`` (gated on director/level-up triggers, not meaningful
    outside the turn that triggered it)

Callers receive a dict describing which steps ran and which were skipped,
so an operator or the player-facing banner can decide whether a human retry
of the remaining steps is warranted.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

logger = logging.getLogger(__name__)


# Steps we can safely re-run on an already-partially-applied turn.
# Each of these either writes a dedup-keyed artifact or a dedup-keyed
# memory row, or stamps a terminal-value field (heat decay).
_IDEMPOTENT_STEPS: tuple[str, ...] = (
    "entity_graph_snapshot",
    "memory_heat_decay",
    "episodic_memory",
)

# Steps whose DB mutations are guarded against double-apply by a per-turn
# marker on ``characters`` (see ``last_combat_applied_turn`` /
# ``last_progression_applied_turn``), but whose INPUT payload
# (combat_result, outcome) isn't persisted in the checkpoint — so replay
# from a fresh process can't actually rerun them.
_GUARDED_SKIP_REASON: dict[str, str] = {
    "combat_bookkeeping": (
        "Guarded by character.last_combat_applied_turn so a same-process "
        "retry is safe, but the CombatResult payload isn't persisted; "
        "skipping from cold-start replay."
    ),
    "consequence_and_progression": (
        "Guarded by character.last_progression_applied_turn so a same-process "
        "retry is safe, but the Outcome payload isn't persisted; skipping "
        "from cold-start replay."
    ),
}

# Steps whose inputs aren't persisted and whose outputs aren't dedup-keyed;
# re-running would either hit the LLM with potentially different results
# or drop fresh state.
_NON_IDEMPOTENT_SKIP_REASON: dict[str, str] = {
    "transactional_block": "Umbrella marker — individual steps handled above",
    "entity_extraction": "LLM call; outputs not cached per-turn",
    "relationship_analysis": "LLM call; outputs not cached per-turn",
    "production_check": "LLM call; outputs not cached per-turn",
    "memory_compression": "Summarizes+deletes; re-running could drop fresh memories",
    "state_snapshot": "Tied to director/level-up trigger; not meaningful outside that",
    **_GUARDED_SKIP_REASON,
}


@dataclass
class ReplayResult:
    """Summary of a replay attempt for a single incomplete turn."""
    turn_number: int
    replayed_steps: list[str]
    skipped_steps: dict[str, str]   # step_name -> reason
    already_done_steps: list[str]   # Steps the original run completed
    errors: dict[str, str]          # step_name -> error message
    checkpoint_updated: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "turn_number": self.turn_number,
            "replayed_steps": self.replayed_steps,
            "skipped_steps": self.skipped_steps,
            "already_done_steps": self.already_done_steps,
            "errors": self.errors,
            "checkpoint_updated": self.checkpoint_updated,
        }


async def replay_safe_bookkeeping(orchestrator) -> ReplayResult | None:
    """Replay idempotent bookkeeping for the orchestrator's incomplete turn.

    Returns ``None`` when there's nothing to replay (no incomplete turn
    detected at init time). Otherwise returns a :class:`ReplayResult`
    describing what happened.

    Assumes the orchestrator has already called ``_check_incomplete_turns``
    during ``__init__`` — the incomplete-turn payload is read from
    ``orchestrator.incomplete_turn``.
    """
    incomplete = getattr(orchestrator, "incomplete_turn", None)
    if not incomplete:
        return None

    turn_number = int(incomplete.get("turn_number") or 0)
    already = list(incomplete.get("completed_steps") or [])

    # Synthesize the minimal db_context the bookkeeping helpers need.
    # turn_number is the only field they access.
    db_context = SimpleNamespace(turn_number=turn_number)

    replayed: list[str] = []
    errors: dict[str, str] = {}
    skipped: dict[str, str] = {}

    # Build the set of candidates: idempotent steps not yet completed.
    for step in _IDEMPOTENT_STEPS:
        if step in already:
            continue
        try:
            if step == "entity_graph_snapshot":
                await orchestrator._bg_save_entity_graph(db_context)
            elif step == "memory_heat_decay":
                orchestrator.memory.decay_heat(turn_number)
            elif step == "episodic_memory":
                # Rebuild a minimal episode from checkpoint fields. The
                # MemoryStore dedups on first-200-char content match, so
                # a repeat write with identical text is a no-op.
                incomplete_data = orchestrator.incomplete_turn or {}
                player_preview = (incomplete_data.get("player_input_preview") or "").strip()
                narrative_preview = (incomplete_data.get("narrative_preview") or "").strip()
                if player_preview or narrative_preview:
                    orchestrator.memory.add_episode(
                        turn=turn_number,
                        location="Unknown",  # Full location not in checkpoint
                        summary=f"{player_preview[:150]} — {narrative_preview[:400]}",
                    )
            replayed.append(step)
        except Exception as e:
            errors[step] = str(e)[:200]
            logger.exception("Replay step %s failed", step)

    # Record which non-idempotent steps we refused to touch.
    for step, reason in _NON_IDEMPOTENT_SKIP_REASON.items():
        if step not in already:
            skipped[step] = reason

    # Write a final checkpoint reflecting the replay outcome.
    checkpoint_updated = False
    try:
        from src.db.session import get_session
        from src.db.session_zero_artifacts import (
            get_active_artifact,
            load_artifact_content,
            save_artifact,
        )
        with get_session() as db:
            prior = get_active_artifact(
                db, str(orchestrator.campaign_id), "gameplay_turn_checkpoint"
            )
            prior_data = load_artifact_content(prior) if prior else {}
            merged_completed = sorted(set(already + replayed))
            all_expected = set(_IDEMPOTENT_STEPS) | {"transactional_block"}
            fully_done = all_expected.issubset(set(merged_completed))
            save_artifact(
                db, str(orchestrator.campaign_id), "gameplay_turn_checkpoint",
                {
                    **prior_data,
                    "turn_number": turn_number,
                    "completed_steps": merged_completed,
                    # Only flip background_completed=True if the idempotent
                    # subset is fully covered; otherwise leave it False so
                    # the banner keeps surfacing until an operator resolves.
                    "background_completed": fully_done,
                    "replayed_at": time.time(),
                    "replay_errors": errors,
                },
            )
        checkpoint_updated = True
        # Clear the in-memory flag when the replay succeeded and completed
        # every idempotent step. This lets subsequent /status calls stop
        # surfacing the banner for this session.
        if fully_done and not errors:
            orchestrator.incomplete_turn = None
    except Exception:
        logger.exception("Failed to update checkpoint after replay")

    return ReplayResult(
        turn_number=turn_number,
        replayed_steps=replayed,
        skipped_steps=skipped,
        already_done_steps=already,
        errors=errors,
        checkpoint_updated=checkpoint_updated,
    )


__all__ = ["replay_safe_bookkeeping", "ReplayResult"]
