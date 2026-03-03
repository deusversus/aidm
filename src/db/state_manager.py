"""StateManager — single entry-point for all game-state persistence.

Composed from four domain-specific mixins:

    CoreMixin      – Infrastructure, sessions, context, turns, foreshadowing
    CharacterMixin – Consequences, world state, character CRUD, combat, OP mode
    NPCMixin       – NPC CRUD, relationships, intelligence, behavior, milestones
    WorldMixin     – Factions, quests, locations, media, state transactions

All downstream code can continue to ``from src.db.state_manager import StateManager``
without any change — the public API surface is identical.
"""

from ._character import CharacterMixin
from ._core import CoreMixin, GameContext  # noqa: F401  (re-export GameContext)
from ._npc import NPCMixin
from ._world import WorldMixin


class StateManager(CoreMixin, CharacterMixin, NPCMixin, WorldMixin):
    """Unified game-state manager.

    Inherits from all four mixins via cooperative multiple inheritance.
    ``__init__`` lives in ``CoreMixin`` and is the only constructor.
    """
    pass
