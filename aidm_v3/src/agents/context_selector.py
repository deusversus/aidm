from typing import List, Dict, Any, Optional
from pydantic import BaseModel
import time

from ..context.memory import MemoryStore
from ..context.rule_library import RuleLibrary
from ..context.profile_library import get_profile_library
from .memory_ranker import MemoryRanker
from .intent_classifier import IntentOutput
from ..db.state_manager import GameContext

class ContextSelector:
    """
    Orchestrates context retrieval and assembly.
    Combines:
    1. Short-term state (from StateManager)
    2. Long-term memory (from ChromaDB + MemoryRanker)
    3. System rules (from RuleLibrary)
    4. Profile DNA (static)
    """
    
    def __init__(self, 
                 memory_store: MemoryStore, 
                 rule_library: RuleLibrary,
                 memory_ranker: Optional[MemoryRanker] = None):
        self.memory = memory_store
        self.rules = rule_library
        self.ranker = memory_ranker or MemoryRanker()
    
    def is_trivial_action(self, intent: Optional[IntentOutput]) -> bool:
        """Check if an action is trivial and can skip most processing.
        
        Trivial actions:
        - Very low epicness (< 0.2)
        - Not combat, ability, or social (those need context)
        - No special conditions flagged
        
        Returns:
            True if action is trivial and can use fast-path
        """
        if intent is None:
            return False
        
        return (
            intent.declared_epicness < 0.2 and
            intent.intent not in ["COMBAT", "ABILITY", "SOCIAL"] and
            not intent.special_conditions
        )
    
    def determine_memory_tier(self, intent: Optional[IntentOutput] = None) -> int:
        """Determine memory candidate count based on action complexity.
        
        Uses IntentClassifier signals to tier memory retrieval:
        - Tier 0 (0): Trivial actions (skip memory entirely)
        - Tier 1 (3): Mundane actions (walking, casual chat)
        - Tier 2 (6): Normal actions (combat, investigation)
        - Tier 3 (9): Dramatic actions (climactic moments, special moves)
        
        Returns:
            Number of memory candidates to retrieve (0, 3, 6, or 9)
        """
        if intent is None:
            return 6  # Default to Tier 2
        
        # Tier 0: Trivial actions skip memory entirely
        if self.is_trivial_action(intent):
            return 0
        
        # Base tier from declared epicness
        if intent.declared_epicness <= 0.3:
            tier = 1
        elif intent.declared_epicness <= 0.6:
            tier = 2
        else:
            tier = 3
        
        # Combat always gets at least Tier 2
        if intent.intent == "COMBAT" and tier < 2:
            tier = 2
        
        # Special conditions boost tier by 1
        if intent.special_conditions:
            tier = min(tier + 1, 3)
        
        return {0: 0, 1: 3, 2: 6, 3: 9}[tier]
        
    async def get_base_context(self, 
                               game_id: str,
                               player_input: str,
                               state_context: GameContext,
                               profile_id: str,
                               intent: Optional[IntentOutput] = None) -> Dict[str, Any]:
        """
        Fast context retrieval with intent-based memory tiering.
        
        Args:
            intent: Optional IntentOutput from classifier. If provided, 
                    memory retrieval is tiered based on action complexity.
        
        Returns raw memories and rules for later parallel processing.
        """
        start_time = time.time()
        
        # 1. Determine memory tier based on intent complexity
        memory_limit = self.determine_memory_tier(intent)
        
        # 2. Search Memories (fast ChromaDB query)
        # Skip for Tier 0 trivial actions (memory_limit == 0)
        search_query = f"{player_input} {state_context.situation}"
        if memory_limit > 0:
            raw_memories = self.memory.search(search_query, limit=memory_limit)
        else:
            raw_memories = []  # Tier 0: no memory retrieval
        
        # 2. Search Rules (fast ChromaDB query)
        rule_query = f"{player_input} {state_context.situation}"
        relevant_rules = self.rules.get_relevant_rules(rule_query, limit=3)
        
        # 3. Search Profile Lore (for canon grounding)
        # Query lore for relevant intents: COMBAT, ABILITY, LORE_QUESTION, SOCIAL
        lore_chunks = []
        if intent and intent.intent in ["COMBAT", "ABILITY", "LORE_QUESTION", "SOCIAL"]:
            profile_lib = get_profile_library()
            lore_query = f"{intent.action} {intent.target or ''} {state_context.situation}"
            lore_chunks = profile_lib.search_lore(profile_id, lore_query, limit=2)
            if lore_chunks:
                print(f"[ContextSelector] Retrieved {len(lore_chunks)} lore chunks for {profile_id}")
        
        return {
            "raw_memories": raw_memories,
            "rules": relevant_rules,
            "lore": "\n\n".join(lore_chunks) if lore_chunks else "",
            "short_term": str(state_context),
            "stats": {
                "base_retrieval_ms": int((time.time() - start_time) * 1000),
                "raw_memory_count": len(raw_memories),
                "lore_chunk_count": len(lore_chunks)
            }
        }
    
    async def rank_memories(self, 
                           raw_memories: List[Dict[str, Any]], 
                           situation: str,
                           intent: Optional[IntentOutput] = None) -> str:
        """
        LLM-based memory ranking with conditional skip.
        
        Skips LLM ranking when:
        - Intent is META_FEEDBACK, OVERRIDE_COMMAND, or OP_COMMAND
        - Candidate count ≤ 3 (no need to rank few candidates)
        
        Args:
            raw_memories: Raw memory candidates from get_base_context()
            situation: Current situation string for ranking context
            intent: Optional intent for skip detection
            
        Returns:
            Formatted memories string for prompt injection
        """
        if not raw_memories:
            return "No relevant past memories found."
        
        # Determine if we should skip LLM ranking
        skip_ranking = False
        skip_reason = None
        
        # Skip for system commands (no narrative relevance)
        if intent and intent.intent in ["META_FEEDBACK", "OVERRIDE_COMMAND", "OP_COMMAND"]:
            skip_ranking = True
            skip_reason = f"system_command:{intent.intent}"
        
        # Skip if few candidates (no need to rank)
        if len(raw_memories) <= 3:
            skip_ranking = True
            skip_reason = f"low_candidates:{len(raw_memories)}"
        
        if skip_ranking:
            # Use raw memories directly without LLM ranking
            print(f"[ContextSelector] Skipping memory ranking: {skip_reason}")
            relevant_memories = raw_memories[:5]
        else:
            # LLM-based ranking
            ranked_memories = await self.ranker.call(
                current_situation=situation,
                candidates=raw_memories
            )
            relevant_memories = [m for m in ranked_memories if m.get('rank_score', 0) > 0.4][:5]
        
        # Format for prompt
        if relevant_memories:
            memories_text = "\n".join([
                f"- [{m.get('metadata', {}).get('type', 'event').upper()}] {m['content']}" 
                for m in relevant_memories
            ])
        else:
            memories_text = "No relevant past memories found."
        
        return memories_text
    
    async def get_context(self, 
                         game_id: str,
                         player_input: str,
                         state_context: GameContext,
                         profile_id: str) -> Dict[str, Any]:
        """
        Assemble full context for the turn (backward-compatible).
        
        This runs both base retrieval and ranking sequentially.
        For parallel execution, use get_base_context() + rank_memories() separately.
        """
        # Get base context
        base = await self.get_base_context(game_id, player_input, state_context, profile_id)
        
        # Rank memories
        memories_text = await self.rank_memories(base["raw_memories"], state_context.situation)
        
        # Assemble result (same format as before)
        return {
            "memories": memories_text,
            "rules": base["rules"],
            "short_term": base["short_term"],
            "stats": {
                "retrieval_ms": base["stats"]["base_retrieval_ms"],
                "memory_count": len([m for m in base["raw_memories"] if m.get('rank_score', 0) > 0.4])
            }
        }
