"""
Foreshadowing Ledger for AIDM v3.

Tracks narrative seeds planted by the Director and Key Animator,
detects when they should pay off, and alerts when seeds are overdue.

Per Module 12 / Phase 4 spec:
- Seeds are hints/setup planted in narrative
- Callbacks are when seeds pay off
- Overdue seeds need resolution or explicit abandonment

#10: DB-backed write-through cache. Seeds persist across server restarts
via StateManager CRUD methods. In-memory _seeds dict is kept for fast reads.
"""

import logging
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

class SeedStatus(str, Enum):
    """Status of a foreshadowing seed."""
    PLANTED = "planted"       # Seed exists, waiting to grow
    GROWING = "growing"       # Building toward payoff
    CALLBACK = "callback"     # Ready to pay off
    RESOLVED = "resolved"     # Successfully concluded
    ABANDONED = "abandoned"   # Explicitly dropped
    OVERDUE = "overdue"       # Past expected payoff


class SeedType(str, Enum):
    """Types of foreshadowing seeds."""
    PLOT = "plot"             # Main story threads
    CHARACTER = "character"   # Character development arcs
    MYSTERY = "mystery"       # Unanswered questions
    THREAT = "threat"         # Looming dangers
    PROMISE = "promise"       # Narrative promises to player
    CHEKHOV = "chekhov"       # Chekhov's gun items/abilities
    RELATIONSHIP = "relationship"  # Ship/rivalry building


class ForeshadowingSeed(BaseModel):
    """A single foreshadowing seed."""
    id: str
    seed_type: SeedType
    status: SeedStatus = SeedStatus.PLANTED

    # Content
    description: str
    planted_narrative: str  # The actual text that planted the seed
    expected_payoff: str    # What the payoff should look like

    # Tracking
    planted_turn: int
    planted_session: int
    mentions: int = 1       # Times referenced (refreshes)
    last_mentioned_turn: int | None = None

    # Timing
    min_turns_to_payoff: int = 5    # Don't pay off too fast
    max_turns_to_payoff: int = 50   # Overdue threshold
    urgency: float = 0.5            # 0-1, how pressing

    # Resolution
    resolved_turn: int | None = None
    resolution_narrative: str | None = None

    # Metadata
    tags: list[str] = Field(default_factory=list)
    related_npcs: list[str] = Field(default_factory=list)
    related_locations: list[str] = Field(default_factory=list)

    # Causal Chains (#11)
    depends_on: list[str] = Field(default_factory=list)       # Seed IDs that must resolve first
    triggers: list[str] = Field(default_factory=list)          # Seed IDs to plant on resolution
    conflicts_with: list[str] = Field(default_factory=list)    # Seed IDs that can't coexist


class ForeshadowingLedger:
    """
    Manages the foreshadowing system.
    
    DB-backed write-through cache (#10):
    - On init, loads all seeds from DB (survives server restarts)
    - Every mutation (plant/mention/resolve/abandon) writes through to DB
    - In-memory _seeds dict provides fast reads during gameplay
    
    Features:
    - Plant seeds during narrative generation
    - Track seed mentions and momentum
    - Detect callback opportunities
    - Generate overdue alerts
    - Provide Director with seed context
    """

    def __init__(self, campaign_id: int, state_manager=None):
        self.campaign_id = campaign_id
        self._state = state_manager  # Optional: None = pure in-memory (tests)
        self._seeds: dict[str, ForeshadowingSeed] = {}
        self._next_id = 1

        # Load from DB if state_manager provided (#10)
        if self._state:
            self._load_from_db()

    def _load_from_db(self):
        """Load seeds from DB into in-memory cache."""
        try:
            seed_rows = self._state.load_foreshadowing_seeds()
            for row in seed_rows:
                seed = ForeshadowingSeed(
                    id=row["seed_id"],
                    seed_type=SeedType(row["seed_type"]),
                    status=SeedStatus(row["status"]),
                    description=row["description"],
                    planted_narrative=row["planted_narrative"],
                    expected_payoff=row["expected_payoff"],
                    planted_turn=row["planted_turn"],
                    planted_session=row["planted_session"],
                    mentions=row["mentions"],
                    last_mentioned_turn=row["last_mentioned_turn"],
                    min_turns_to_payoff=row["min_turns_to_payoff"],
                    max_turns_to_payoff=row["max_turns_to_payoff"],
                    urgency=row["urgency"],
                    resolved_turn=row["resolved_turn"],
                    resolution_narrative=row["resolution_narrative"],
                    tags=row["tags"],
                    related_npcs=row["related_npcs"],
                    related_locations=row["related_locations"],
                    # #11: Causal chains
                    depends_on=row.get("depends_on", []),
                    triggers=row.get("triggers", []),
                    conflicts_with=row.get("conflicts_with", []),
                )
                self._seeds[seed.id] = seed

            # Restore _next_id from DB to avoid ID collision
            self._next_id = self._state.get_max_seed_sequence()

            if self._seeds:
                logger.info(f"Loaded {len(self._seeds)} seeds from DB (next_id={self._next_id})")
        except Exception as e:
            logger.error(f"Failed to load seeds from DB: {e}")

    def _persist_seed(self, seed: ForeshadowingSeed):
        """Write-through: persist a seed to DB."""
        if not self._state:
            return
        try:
            self._state.save_foreshadowing_seed({
                "seed_id": seed.id,
                "seed_type": seed.seed_type.value,
                "status": seed.status.value,
                "description": seed.description,
                "planted_narrative": seed.planted_narrative,
                "expected_payoff": seed.expected_payoff,
                "planted_turn": seed.planted_turn,
                "planted_session": seed.planted_session,
                "mentions": seed.mentions,
                "last_mentioned_turn": seed.last_mentioned_turn,
                "min_turns_to_payoff": seed.min_turns_to_payoff,
                "max_turns_to_payoff": seed.max_turns_to_payoff,
                "urgency": seed.urgency,
                "resolved_turn": seed.resolved_turn,
                "resolution_narrative": seed.resolution_narrative,
                "tags": seed.tags,
                "related_npcs": seed.related_npcs,
                "related_locations": seed.related_locations,
                # #11: Causal chains
                "depends_on": seed.depends_on,
                "triggers": seed.triggers,
                "conflicts_with": seed.conflicts_with,
            })
        except Exception as e:
            logger.error(f"Failed to persist seed {seed.id}: {e}")

    def _update_seed_db(self, seed_id: str, **fields):
        """Write-through: partial update to DB."""
        if not self._state:
            return
        try:
            self._state.update_foreshadowing_seed(seed_id, **fields)
        except Exception as e:
            logger.error(f"Failed to update seed {seed_id}: {e}")

    def plant_seed(
        self,
        seed_type: SeedType,
        description: str,
        planted_narrative: str,
        expected_payoff: str,
        turn_number: int,
        session_number: int,
        tags: list[str] | None = None,
        related_npcs: list[str] | None = None,
        min_payoff: int = 5,
        max_payoff: int = 50,
        depends_on: list[str] | None = None,
        triggers: list[str] | None = None,
        conflicts_with: list[str] | None = None
    ) -> str:
        """
        Plant a new foreshadowing seed.
        
        Args:
            seed_type: Type of seed (plot, character, mystery, etc.)
            description: Brief description for tracking
            planted_narrative: The actual narrative text that planted it
            expected_payoff: What the resolution should look like
            turn_number: When planted
            session_number: Session when planted
            tags: Searchable tags
            related_npcs: NPCs involved
            min_payoff: Minimum turns before payoff (avoid premature)
            max_payoff: Maximum turns before overdue
            depends_on: (#11) Seed IDs that must resolve before callback
            triggers: (#11) Seed IDs to auto-plant on resolution
            conflicts_with: (#11) Seed IDs to abandon on resolution
            
        Returns:
            Seed ID
        """
        seed_id = f"seed_{self.campaign_id}_{self._next_id}"
        self._next_id += 1

        seed = ForeshadowingSeed(
            id=seed_id,
            seed_type=seed_type,
            description=description,
            planted_narrative=planted_narrative[:500],  # Truncate
            expected_payoff=expected_payoff,
            planted_turn=turn_number,
            planted_session=session_number,
            tags=tags or [],
            related_npcs=related_npcs or [],
            min_turns_to_payoff=min_payoff,
            max_turns_to_payoff=max_payoff,
            depends_on=depends_on or [],
            triggers=triggers or [],
            conflicts_with=conflicts_with or [],
        )

        self._seeds[seed_id] = seed
        self._persist_seed(seed)  # Write-through (#10)
        return seed_id

    def mention_seed(self, seed_id: str, turn_number: int):
        """Record a seed mention (refreshes relevance)."""
        if seed_id in self._seeds:
            seed = self._seeds[seed_id]
            seed.mentions += 1
            seed.last_mentioned_turn = turn_number

            # Increase urgency with mentions
            seed.urgency = min(1.0, seed.urgency + 0.1)

            # Upgrade status if mentioned enough
            if seed.status == SeedStatus.PLANTED and seed.mentions >= 3:
                seed.status = SeedStatus.GROWING

            # Write-through (#10)
            self._update_seed_db(seed_id,
                mentions=seed.mentions,
                last_mentioned_turn=seed.last_mentioned_turn,
                urgency=seed.urgency,
                status=seed.status.value
            )

    def check_callback_ready(self, seed_id: str, current_turn: int) -> bool:
        """Check if a seed is ready for callback (payoff).
        
        #11: Also checks that all dependencies are resolved.
        """
        if seed_id not in self._seeds:
            return False

        seed = self._seeds[seed_id]
        turns_since_plant = current_turn - seed.planted_turn

        # Basic readiness
        if not (seed.status in [SeedStatus.PLANTED, SeedStatus.GROWING] and
                turns_since_plant >= seed.min_turns_to_payoff):
            return False

        # #11: Dependency gate — all depends_on seeds must be resolved
        if seed.depends_on:
            for dep_id in seed.depends_on:
                dep = self._seeds.get(dep_id)
                if not dep or dep.status != SeedStatus.RESOLVED:
                    return False

        return True

    def mark_callback(self, seed_id: str):
        """Mark a seed as ready for callback."""
        if seed_id in self._seeds:
            self._seeds[seed_id].status = SeedStatus.CALLBACK
            self._update_seed_db(seed_id, status=SeedStatus.CALLBACK.value)

    def resolve_seed(self, seed_id: str, turn_number: int, resolution_narrative: str):
        """Resolve a seed (successful payoff).
        
        #11: Also triggers causal chain effects — auto-abandons conflicting
        seeds and logs triggered seeds for the Director to plant.
        """
        if seed_id in self._seeds:
            seed = self._seeds[seed_id]
            seed.status = SeedStatus.RESOLVED
            seed.resolved_turn = turn_number
            seed.resolution_narrative = resolution_narrative[:500]

            # Write-through (#10)
            self._update_seed_db(seed_id,
                status=SeedStatus.RESOLVED.value,
                resolved_turn=turn_number,
                resolution_narrative=resolution_narrative[:500]
            )

            # #11: Causal chain — abandon conflicting seeds
            for conflict_id in seed.conflicts_with:
                if conflict_id in self._seeds:
                    conflict_seed = self._seeds[conflict_id]
                    if conflict_seed.status not in (SeedStatus.RESOLVED, SeedStatus.ABANDONED):
                        self.abandon_seed(conflict_id, reason=f"Conflicting seed {seed_id} resolved")
                        logger.info(f"Auto-abandoned {conflict_id} (conflicts with resolved {seed_id})")

            # #11: Causal chain — store triggered seed IDs for Director to plant
            # We don't auto-plant here because triggered seeds need Director context
            # (description, expected_payoff, etc). Instead, surface them in director context.
            if seed.triggers:
                logger.info(f"Seed {seed_id} resolved — triggers pending: {seed.triggers}")

    def abandon_seed(self, seed_id: str, reason: str = ""):
        """Abandon a seed (explicitly drop it)."""
        if seed_id in self._seeds:
            seed = self._seeds[seed_id]
            seed.status = SeedStatus.ABANDONED
            resolution = f"Abandoned: {reason}" if reason else None
            if reason:
                seed.resolution_narrative = resolution

            # Write-through (#10)
            self._update_seed_db(seed_id,
                status=SeedStatus.ABANDONED.value,
                resolution_narrative=resolution
            )

    def get_overdue_seeds(self, current_turn: int) -> list[ForeshadowingSeed]:
        """Get seeds that are past their due date."""
        overdue = []

        for seed in self._seeds.values():
            if seed.status in [SeedStatus.PLANTED, SeedStatus.GROWING]:
                turns_since = current_turn - seed.planted_turn
                if turns_since > seed.max_turns_to_payoff:
                    seed.status = SeedStatus.OVERDUE
                    self._update_seed_db(seed.id, status=SeedStatus.OVERDUE.value)
                    overdue.append(seed)

        return overdue

    def get_callback_opportunities(self, current_turn: int) -> list[ForeshadowingSeed]:
        """Get seeds that are ready for callback."""
        opportunities = []

        for seed in self._seeds.values():
            if self.check_callback_ready(seed.id, current_turn):
                opportunities.append(seed)

        # Sort by urgency (highest first)
        opportunities.sort(key=lambda s: s.urgency, reverse=True)
        return opportunities

    def get_active_seeds(self) -> list[ForeshadowingSeed]:
        """Get all active (unresolved) seeds."""
        return [
            s for s in self._seeds.values()
            if s.status not in [SeedStatus.RESOLVED, SeedStatus.ABANDONED]
        ]

    def get_seeds_by_type(self, seed_type: SeedType) -> list[ForeshadowingSeed]:
        """Get seeds by type."""
        return [s for s in self._seeds.values() if s.seed_type == seed_type]

    def get_seeds_for_npc(self, npc_name: str) -> list[ForeshadowingSeed]:
        """Get seeds related to an NPC."""
        return [
            s for s in self._seeds.values()
            if npc_name.lower() in [n.lower() for n in s.related_npcs]
        ]

    def generate_director_context(self, current_turn: int) -> str:
        """Generate context for the Director Agent about foreshadowing state."""
        lines = ["## Foreshadowing Status"]

        # Active seeds
        active = self.get_active_seeds()
        lines.append(f"\n**Active Seeds:** {len(active)}")

        # Ready for callback
        ready = self.get_callback_opportunities(current_turn)
        if ready:
            lines.append(f"\n### Ready for Callback ({len(ready)})")
            for seed in ready[:5]:  # Top 5
                lines.append(f"- **{seed.description}** (urgency: {seed.urgency:.1f})")
                lines.append(f"  Expected: {seed.expected_payoff[:100]}...")

        # Overdue
        overdue = self.get_overdue_seeds(current_turn)
        if overdue:
            lines.append(f"\n### \u26a0\ufe0f OVERDUE ({len(overdue)})")
            for seed in overdue:
                turns_over = current_turn - seed.planted_turn - seed.max_turns_to_payoff
                lines.append(f"- **{seed.description}** ({turns_over} turns overdue)")

        # Growing
        growing = [s for s in active if s.status == SeedStatus.GROWING]
        if growing:
            lines.append(f"\n### Growing ({len(growing)})")
            for seed in growing[:3]:
                lines.append(f"- {seed.description} (mentions: {seed.mentions})")

        # #11: Convergence detection — seeds sharing dependencies approaching callback
        convergence = self._detect_convergence(current_turn)
        if convergence:
            lines.append("\n### \U0001f4a5 Convergence Points")
            lines.append("Multiple plot threads are approaching climax simultaneously:")
            for group_desc, seeds in convergence:
                seed_names = ", ".join(s.description[:40] for s in seeds)
                lines.append(f"- **{group_desc}:** {seed_names}")

        # #11: Pending triggers — seeds that need planting after resolution
        for seed in active:
            if seed.triggers:
                # Check if any trigger targets are from resolved seeds
                resolved_triggers = [
                    tid for tid in seed.triggers
                    if tid not in self._seeds  # Not yet planted
                ]
                if resolved_triggers:
                    lines.append("\n### \U0001f331 Pending Trigger Seeds")
                    lines.append(f"- **{seed.description}** resolving would trigger: {resolved_triggers}")
                    break  # Only show first to avoid context bloat

        return "\n".join(lines)

    def _detect_convergence(self, current_turn: int) -> list[tuple]:
        """#11: Detect seeds sharing dependencies that are all near callback.
        
        Returns list of (description, [seeds]) tuples for convergence groups.
        """
        active = self.get_active_seeds()
        if len(active) < 2:
            return []

        # Group seeds by shared dependencies
        dep_groups: dict[str, list[ForeshadowingSeed]] = {}
        for seed in active:
            for dep_id in seed.depends_on:
                dep_groups.setdefault(dep_id, []).append(seed)

        convergences = []
        for dep_id, seeds in dep_groups.items():
            if len(seeds) >= 2:
                # Check if the shared dependency is resolved (convergence imminent)
                dep = self._seeds.get(dep_id)
                if dep and dep.status == SeedStatus.RESOLVED:
                    convergences.append(
                        (f"Shared resolution of '{dep.description[:40]}'", seeds)
                    )
                # Or if 2+ seeds are both callback-ready
                elif all(self.check_callback_ready(s.id, current_turn) for s in seeds):
                    convergences.append(
                        (f"Multiple threads ready (dep: {dep_id})", seeds)
                    )

        # Also detect seeds with no shared deps but both callback-ready AND related
        ready = self.get_callback_opportunities(current_turn)
        if len(ready) >= 2:
            for i, s1 in enumerate(ready):
                for s2 in ready[i+1:]:
                    shared_npcs = set(s1.related_npcs) & set(s2.related_npcs)
                    if shared_npcs and (s1, s2) not in [(s for _, ss in convergences for s in ss)]:
                        convergences.append(
                            (f"Shared NPCs: {', '.join(shared_npcs)}", [s1, s2])
                        )
                        break  # Cap at 1 NPC convergence

        return convergences[:3]  # Cap output

    def detect_seed_in_narrative(
        self,
        narrative: str,
        current_turn: int
    ) -> list[str]:
        """
        Detect if any active seeds are mentioned in narrative.
        Returns list of seed IDs that were referenced.
        """
        mentioned = []
        narrative_lower = narrative.lower()

        for seed in self.get_active_seeds():
            # Check for NPC name mentions
            for npc in seed.related_npcs:
                if npc.lower() in narrative_lower:
                    self.mention_seed(seed.id, current_turn)
                    mentioned.append(seed.id)
                    break

            # Check for tag mentions
            for tag in seed.tags:
                if tag.lower() in narrative_lower:
                    self.mention_seed(seed.id, current_turn)
                    if seed.id not in mentioned:
                        mentioned.append(seed.id)
                    break

        return mentioned

    def to_dict(self) -> dict[str, Any]:
        """Serialize ledger to dict for storage."""
        return {
            "campaign_id": self.campaign_id,
            "next_id": self._next_id,
            "seeds": {sid: seed.model_dump() for sid, seed in self._seeds.items()}
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ForeshadowingLedger":
        """Deserialize ledger from dict."""
        ledger = cls(campaign_id=data["campaign_id"])
        ledger._next_id = data.get("next_id", 1)

        for sid, seed_data in data.get("seeds", {}).items():
            ledger._seeds[sid] = ForeshadowingSeed(**seed_data)

        return ledger


# Convenience function
def create_foreshadowing_ledger(campaign_id: int, state_manager=None) -> ForeshadowingLedger:
    """Create a new foreshadowing ledger for a campaign."""
    return ForeshadowingLedger(campaign_id=campaign_id, state_manager=state_manager)
