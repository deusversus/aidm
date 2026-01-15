"""
Foreshadowing Ledger for AIDM v3.

Tracks narrative seeds planted by the Director and Key Animator,
detects when they should pay off, and alerts when seeds are overdue.

Per Module 12 / Phase 4 spec:
- Seeds are hints/setup planted in narrative
- Callbacks are when seeds pay off
- Overdue seeds need resolution or explicit abandonment
"""

from typing import List, Dict, Any, Optional, Literal
from pydantic import BaseModel, Field
from datetime import datetime
from enum import Enum


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
    last_mentioned_turn: Optional[int] = None
    
    # Timing
    min_turns_to_payoff: int = 5    # Don't pay off too fast
    max_turns_to_payoff: int = 50   # Overdue threshold
    urgency: float = 0.5            # 0-1, how pressing
    
    # Resolution
    resolved_turn: Optional[int] = None
    resolution_narrative: Optional[str] = None
    
    # Metadata
    tags: List[str] = Field(default_factory=list)
    related_npcs: List[str] = Field(default_factory=list)
    related_locations: List[str] = Field(default_factory=list)


class ForeshadowingLedger:
    """
    Manages the foreshadowing system.
    
    Features:
    - Plant seeds during narrative generation
    - Track seed mentions and momentum
    - Detect callback opportunities
    - Generate overdue alerts
    - Provide Director with seed context
    """
    
    def __init__(self, campaign_id: int):
        self.campaign_id = campaign_id
        self._seeds: Dict[str, ForeshadowingSeed] = {}
        self._next_id = 1
    
    def plant_seed(
        self,
        seed_type: SeedType,
        description: str,
        planted_narrative: str,
        expected_payoff: str,
        turn_number: int,
        session_number: int,
        tags: Optional[List[str]] = None,
        related_npcs: Optional[List[str]] = None,
        min_payoff: int = 5,
        max_payoff: int = 50
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
            max_turns_to_payoff=max_payoff
        )
        
        self._seeds[seed_id] = seed
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
    
    def check_callback_ready(self, seed_id: str, current_turn: int) -> bool:
        """Check if a seed is ready for callback (payoff)."""
        if seed_id not in self._seeds:
            return False
        
        seed = self._seeds[seed_id]
        turns_since_plant = current_turn - seed.planted_turn
        
        return (
            seed.status in [SeedStatus.PLANTED, SeedStatus.GROWING] and
            turns_since_plant >= seed.min_turns_to_payoff
        )
    
    def mark_callback(self, seed_id: str):
        """Mark a seed as ready for callback."""
        if seed_id in self._seeds:
            self._seeds[seed_id].status = SeedStatus.CALLBACK
    
    def resolve_seed(self, seed_id: str, turn_number: int, resolution_narrative: str):
        """Resolve a seed (successful payoff)."""
        if seed_id in self._seeds:
            seed = self._seeds[seed_id]
            seed.status = SeedStatus.RESOLVED
            seed.resolved_turn = turn_number
            seed.resolution_narrative = resolution_narrative[:500]
    
    def abandon_seed(self, seed_id: str, reason: str = ""):
        """Abandon a seed (explicitly drop it)."""
        if seed_id in self._seeds:
            seed = self._seeds[seed_id]
            seed.status = SeedStatus.ABANDONED
            if reason:
                seed.resolution_narrative = f"Abandoned: {reason}"
    
    def get_overdue_seeds(self, current_turn: int) -> List[ForeshadowingSeed]:
        """Get seeds that are past their due date."""
        overdue = []
        
        for seed in self._seeds.values():
            if seed.status in [SeedStatus.PLANTED, SeedStatus.GROWING]:
                turns_since = current_turn - seed.planted_turn
                if turns_since > seed.max_turns_to_payoff:
                    seed.status = SeedStatus.OVERDUE
                    overdue.append(seed)
        
        return overdue
    
    def get_callback_opportunities(self, current_turn: int) -> List[ForeshadowingSeed]:
        """Get seeds that are ready for callback."""
        opportunities = []
        
        for seed in self._seeds.values():
            if self.check_callback_ready(seed.id, current_turn):
                opportunities.append(seed)
        
        # Sort by urgency (highest first)
        opportunities.sort(key=lambda s: s.urgency, reverse=True)
        return opportunities
    
    def get_active_seeds(self) -> List[ForeshadowingSeed]:
        """Get all active (unresolved) seeds."""
        return [
            s for s in self._seeds.values()
            if s.status not in [SeedStatus.RESOLVED, SeedStatus.ABANDONED]
        ]
    
    def get_seeds_by_type(self, seed_type: SeedType) -> List[ForeshadowingSeed]:
        """Get seeds by type."""
        return [s for s in self._seeds.values() if s.seed_type == seed_type]
    
    def get_seeds_for_npc(self, npc_name: str) -> List[ForeshadowingSeed]:
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
            lines.append(f"\n### ⚠️ OVERDUE ({len(overdue)})")
            for seed in overdue:
                turns_over = current_turn - seed.planted_turn - seed.max_turns_to_payoff
                lines.append(f"- **{seed.description}** ({turns_over} turns overdue)")
        
        # Growing
        growing = [s for s in active if s.status == SeedStatus.GROWING]
        if growing:
            lines.append(f"\n### Growing ({len(growing)})")
            for seed in growing[:3]:
                lines.append(f"- {seed.description} (mentions: {seed.mentions})")
        
        return "\n".join(lines)
    
    def detect_seed_in_narrative(
        self,
        narrative: str,
        current_turn: int
    ) -> List[str]:
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
    
    def to_dict(self) -> Dict[str, Any]:
        """Serialize ledger to dict for storage."""
        return {
            "campaign_id": self.campaign_id,
            "next_id": self._next_id,
            "seeds": {sid: seed.model_dump() for sid, seed in self._seeds.items()}
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ForeshadowingLedger":
        """Deserialize ledger from dict."""
        ledger = cls(campaign_id=data["campaign_id"])
        ledger._next_id = data.get("next_id", 1)
        
        for sid, seed_data in data.get("seeds", {}).items():
            ledger._seeds[sid] = ForeshadowingSeed(**seed_data)
        
        return ledger


# Convenience function
def create_foreshadowing_ledger(campaign_id: int) -> ForeshadowingLedger:
    """Create a new foreshadowing ledger for a campaign."""
    return ForeshadowingLedger(campaign_id=campaign_id)
