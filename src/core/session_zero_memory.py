"""Session Zero memory integration.

Handles both mid-SZ provisional memory writes and authoritative
handoff memory writes.  Uses the existing ``MemoryStore.add_memory()`` API.

Two entry points:

- ``write_provisional()``: called per-turn during SZ for plot-critical facts
  and key character relationships.  These are flagged with
  ``session_zero_in_progress`` so they can be identified and overwritten.

- ``write_authoritative()``: called at handoff after the Handoff Compiler
  produces the final ``OpeningStatePackage``.  Writes canonical, distilled
  facts using the correct ``memory_type`` and ``decay_rate`` per the Phase 3
  spec table.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.agents.session_zero_schemas import (
        EntityResolutionOutput,
        ExtractionPassOutput,
        OpeningStatePackage,
    )
    from src.context.memory import MemoryStore

logger = logging.getLogger(__name__)


# ── Provisional writes (during SZ) ───────────────────────────────────────────

def write_provisional(
    memory_store: MemoryStore,
    extraction: ExtractionPassOutput,
    turn_number: int,
) -> int:
    """Write provisional memories from a single extraction pass.

    Writes:
    - Plot-critical facts (``fact_type`` contains 'backstory_beat' or
      confidence >= 0.9) → ``memory_type='session_zero'``
    - Character relationships involving the player character →
      ``memory_type='character_state'``

    All provisional writes are flagged ``['session_zero_in_progress']`` so
    they can be identified and overwritten at handoff.

    Returns:
        Number of memories written.
    """
    written = 0

    # Write high-confidence facts
    for fact in extraction.fact_records:
        if fact.confidence >= 0.9 or fact.fact_type in (
            "backstory_beat", "world_rule", "power_constraint",
        ):
            try:
                memory_store.add_memory(
                    content=fact.content,
                    memory_type="session_zero",
                    turn_number=turn_number,
                    decay_rate="none",
                    flags=["plot_critical", "session_zero_in_progress"],
                    metadata={
                        "fact_id": fact.fact_id,
                        "fact_type": fact.fact_type,
                        "source": "sz_pipeline_provisional",
                    },
                )
                written += 1
            except Exception:
                logger.warning("Failed to write provisional fact %s", fact.fact_id)

    # Write relationships involving the player character
    for rel in extraction.relationship_records:
        is_pc = (
            rel.from_entity_id.lower().startswith("pc_")
            or rel.to_entity_id.lower().startswith("pc_")
        )
        if is_pc and rel.confidence >= 0.7:
            content = (
                f"{rel.from_entity_id} → {rel.to_entity_id}: "
                f"{rel.relationship_type}. {rel.description}"
            )
            try:
                memory_store.add_memory(
                    content=content,
                    memory_type="character_state",
                    turn_number=turn_number,
                    decay_rate="none",
                    flags=["session_zero_in_progress"],
                    metadata={
                        "relationship_id": rel.relationship_id,
                        "source": "sz_pipeline_provisional",
                    },
                )
                written += 1
            except Exception:
                logger.warning("Failed to write provisional relationship %s", rel.relationship_id)

    if written:
        logger.info("SZ provisional: wrote %d memories at turn %d", written, turn_number)

    return written


# ── Authoritative writes (at handoff) ────────────────────────────────────────

def write_authoritative(
    memory_store: MemoryStore,
    package: OpeningStatePackage,
    turn_number: int = 0,
) -> int:
    """Write canonical memories from the final OpeningStatePackage.

    This is the authoritative write — it overwrites any provisional
    mid-SZ memories with the compiler's final output.

    Memory mapping (per Phase 3 spec table):

    | Source                       | memory_type      | decay_rate |
    |------------------------------|------------------|------------|
    | Player character identity    | core             | none       |
    | NPC cast members             | character_state  | none       |
    | Canonical relationships      | relationship     | none       |
    | World/setting facts          | session_zero     | none       |
    | Quest/thread seeds           | quest            | normal     |
    | Location facts               | location         | slow       |

    Returns:
        Number of memories written.
    """
    written = 0

    # 1. Player character identity and backstory
    pc = package.player_character
    if pc.name:
        written += _write_safe(
            memory_store,
            content=(
                f"Player character: {pc.name}. {pc.concept}. "
                f"{pc.core_identity}. Power tier: {pc.power_tier}."
            ),
            memory_type="core",
            turn_number=turn_number,
            flags=["plot_critical", "session_zero_canonical"],
            metadata={"source": "sz_handoff_compiler"},
        )

    if pc.backstory_beats:
        for beat in pc.backstory_beats:
            written += _write_safe(
                memory_store,
                content=f"[Backstory] {beat}",
                memory_type="core",
                turn_number=turn_number,
                flags=["plot_critical", "session_zero_canonical"],
                metadata={"source": "sz_handoff_compiler"},
            )

    # 2. NPC cast members
    for cast_list in [
        package.opening_cast.required_present,
        package.opening_cast.optional_present,
        package.opening_cast.offscreen_but_relevant,
    ]:
        for member in cast_list:
            content = (
                f"NPC: {member.display_name} (ID: {member.canonical_id}). "
                f"Role: {member.role_in_scene}. "
                f"Relationship to PC: {member.relationship_to_pc}."
            )
            written += _write_safe(
                memory_store,
                content=content,
                memory_type="character_state",
                turn_number=turn_number,
                decay_rate="none",
                flags=["session_zero_canonical"],
                metadata={
                    "canonical_id": member.canonical_id,
                    "source": "sz_handoff_compiler",
                },
            )

    # 3. Canonical relationships
    for rel in package.relationship_graph:
        content = (
            f"{rel.from_entity_id} → {rel.to_entity_id}: "
            f"{rel.relationship_type}. {rel.description}"
        )
        written += _write_safe(
            memory_store,
            content=content,
            memory_type="relationship",
            turn_number=turn_number,
            decay_rate="none",
            flags=["session_zero_canonical"],
            metadata={
                "relationship_id": rel.relationship_id,
                "source": "sz_handoff_compiler",
            },
        )

    # 4. World/setting facts (from world context)
    for fact_text in package.world_context.setting_truths:
        written += _write_safe(
            memory_store,
            content=fact_text,
            memory_type="session_zero",
            turn_number=turn_number,
            decay_rate="none",
            flags=["session_zero_canonical"],
            metadata={"source": "sz_handoff_compiler"},
        )

    for fact_text in package.world_context.important_recent_facts:
        written += _write_safe(
            memory_store,
            content=fact_text,
            memory_type="session_zero",
            turn_number=turn_number,
            decay_rate="none",
            flags=["session_zero_canonical"],
            metadata={"source": "sz_handoff_compiler"},
        )

    # 5. Quest/thread seeds
    for hook in package.active_threads.quests_or_hooks_to_surface:
        written += _write_safe(
            memory_store,
            content=f"[Quest Hook] {hook}",
            memory_type="quest",
            turn_number=turn_number,
            decay_rate="normal",
            flags=["session_zero_canonical"],
            metadata={"source": "sz_handoff_compiler"},
        )

    # 6. Location facts
    if package.opening_situation.starting_location:
        written += _write_safe(
            memory_store,
            content=(
                f"Starting location: {package.opening_situation.starting_location}. "
                f"{package.world_context.location_description}"
            ),
            memory_type="location",
            turn_number=turn_number,
            decay_rate="slow",
            flags=["session_zero_canonical"],
            metadata={"source": "sz_handoff_compiler"},
        )

    logger.info(
        "SZ authoritative: wrote %d canonical memories from OpeningStatePackage",
        written,
    )
    return written


# ── Helpers ───────────────────────────────────────────────────────────────────

def _write_safe(
    memory_store: MemoryStore,
    content: str,
    memory_type: str,
    turn_number: int,
    decay_rate: str = "none",
    flags: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> int:
    """Write a single memory, returning 1 on success, 0 on failure."""
    try:
        memory_store.add_memory(
            content=content,
            memory_type=memory_type,
            turn_number=turn_number,
            decay_rate=decay_rate,
            flags=flags,
            metadata=metadata,
        )
        return 1
    except Exception:
        logger.warning("Failed to write %s memory: %.80s...", memory_type, content)
        return 0
