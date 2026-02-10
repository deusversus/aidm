from typing import List, Dict, Any, Optional, Set
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
        
        # 2. Search Memories (multi-query for better recall)
        # Skip for Tier 0 trivial actions (memory_limit == 0)
        if memory_limit > 0:
            queries = self._decompose_queries(player_input, state_context, intent)
            raw_memories = self._multi_query_search(queries, memory_limit)
            
            # Guaranteed plot-critical injection
            critical = self._get_plot_critical_memories()
            raw_memories = self._merge_and_dedup(raw_memories, critical)
        else:
            raw_memories = []  # Tier 0: no memory retrieval
        
        # 2. Search Rules (fast ChromaDB query)
        rule_query = f"{player_input} {state_context.situation}"
        relevant_rules = self.rules.get_relevant_rules(rule_query, limit=3)
        
        # 3. Search Profile Lore (for canon grounding)
        # Intent → preferred page_type for filtered retrieval
        INTENT_LORE_CONFIG = {
            "COMBAT":        {"page_type": None,         "limit": 3},  # broad — techniques, characters, etc.
            "ABILITY":       {"page_type": "techniques",  "limit": 3},
            "LORE_QUESTION": {"page_type": None,         "limit": 3},  # broad search for any lore
            "SOCIAL":        {"page_type": "characters",  "limit": 2},
            "EXPLORATION":   {"page_type": "locations",   "limit": 2},
            "DIALOGUE":      {"page_type": "characters",  "limit": 2},
        }
        
        lore_chunks = []
        lore_config = INTENT_LORE_CONFIG.get(intent.intent if intent else None)
        if lore_config:
            profile_lib = get_profile_library()
            lore_query = f"{intent.action} {intent.target or ''} {state_context.situation}"
            lore_chunks = profile_lib.search_lore(
                profile_id, 
                lore_query, 
                limit=lore_config["limit"],
                page_type=lore_config.get("page_type"),
            )
            if lore_chunks:
                print(f"[ContextSelector] Retrieved {len(lore_chunks)} lore chunks for {profile_id} (type={lore_config.get('page_type', 'any')})")
        
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
    
    def _decompose_queries(
        self, 
        player_input: str, 
        state_context: GameContext,
        intent: Optional[IntentOutput] = None
    ) -> List[str]:
        """Decompose a single action into 2-3 targeted search queries.
        
        Instead of a single concatenated query, generates focused queries:
        1. Action-focused: what the player is doing
        2. Situation-focused: current scene context  
        3. Entity-focused: NPCs/locations mentioned (when present)
        
        Returns:
            List of 2-3 search query strings
        """
        queries = []
        
        # Query 1: Action-focused (what the player is doing)
        if intent and intent.action:
            queries.append(f"{intent.action} {intent.target or ''}")
        else:
            queries.append(player_input)
        
        # Query 2: Situation-focused (where they are, what's happening)
        if state_context.situation:
            queries.append(state_context.situation)
        
        # Query 3: Entity-focused (NPCs or locations mentioned) 
        if intent and intent.target:
            # Target-specific query for NPC or location recall
            queries.append(f"{intent.target} relationship history")
        elif state_context.location:
            queries.append(f"{state_context.location} events")
        
        # Ensure at least 2 queries — fallback to combined
        if len(queries) < 2:
            queries.append(f"{player_input} {state_context.situation or ''}")
        
        # Cap at 3 queries to limit ChromaDB calls
        return queries[:3]
    
    def _multi_query_search(
        self, 
        queries: List[str], 
        total_limit: int
    ) -> List[Dict[str, Any]]:
        """Run multiple queries against memory and deduplicate results.
        
        Distributes the total limit across queries, then merges and
        deduplicates by content. Higher-scoring duplicates win.
        
        Args:
            queries: List of search query strings
            total_limit: Total number of memories to return
            
        Returns:
            Deduplicated list of memory dicts, sorted by score
        """
        per_query_limit = max(3, total_limit // len(queries) + 1)
        all_results = []
        
        for query in queries:
            query = query.strip()
            if not query:
                continue
            results = self.memory.search(query, limit=per_query_limit)
            all_results.extend(results)
        
        # Deduplicate by content (keep highest score)
        seen: Dict[str, Dict[str, Any]] = {}
        for mem in all_results:
            content = mem.get("content", "")
            content_key = content[:100]  # First 100 chars as key
            existing = seen.get(content_key)
            if not existing or mem.get("score", 0) > existing.get("score", 0):
                seen[content_key] = mem
        
        # Sort by score descending
        deduped = sorted(seen.values(), key=lambda m: m.get("score", 0), reverse=True)
        
        if len(deduped) != len(all_results):
            print(f"[ContextSelector] Multi-query: {len(all_results)} raw → {len(deduped)} unique (from {len(queries)} queries)")
        
        return deduped[:total_limit]
    
    def _get_plot_critical_memories(self) -> List[Dict[str, Any]]:
        """Get guaranteed-include plot-critical and session-zero memories.
        
        These memories are ALWAYS included regardless of query similarity,
        ensuring important established facts are never missed.
        
        Returns:
            List of critical memory dicts (empty if none found)
        """
        try:
            collection = self.memory.collection
            # Query for plot-critical memories
            results = collection.get(
                where={"flags": {"$contains": "plot_critical"}},
                limit=3,
            )
            
            critical = []
            if results and results.get("documents"):
                for i, doc in enumerate(results["documents"]):
                    meta = results["metadatas"][i] if results.get("metadatas") else {}
                    critical.append({
                        "content": doc,
                        "metadata": meta,
                        "score": 1.0,  # Max score — always relevant
                        "source": "plot_critical",
                    })
            
            return critical
            
        except Exception:
            # ChromaDB filter may not match — not all collections have this flag
            return []
    
    def _merge_and_dedup(
        self, 
        primary: List[Dict[str, Any]], 
        additional: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Merge two memory lists, deduplicating by content.
        
        Additional memories are prepended (highest priority) but
        duplicates from primary are removed.
        """
        if not additional:
            return primary
        
        # Build set of content keys from additional
        additional_keys: Set[str] = set()
        for mem in additional:
            additional_keys.add(mem.get("content", "")[:100])
        
        # Filter primary to remove duplicates
        filtered_primary = [
            m for m in primary
            if m.get("content", "")[:100] not in additional_keys
        ]
        
        # Prepend critical memories
        merged = additional + filtered_primary
        return merged
    
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
