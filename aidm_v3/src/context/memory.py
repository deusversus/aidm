"""
Memory Store for AIDM v3.

Manages long-term memory using ChromaDB with heat-based decay.
Memories start "hot" and cool over time, but can be refreshed
when referenced. Per Module 02 spec.
"""

import chromadb
import time
from typing import List, Dict, Optional, Any, Literal
from pydantic import BaseModel, Field
from pathlib import Path


import logging

logger = logging.getLogger(__name__)

# Decay rates per memory type (per-turn multiplier)
DECAY_CURVES = {
    "none": 1.0,      # Plot-critical: never decay
    "very_slow": 0.97, # Relationships: 3% decay per turn (#7: gentler curve)
    "slow": 0.95,     # Important details: 5% decay per turn
    "normal": 0.90,   # Events: 10% decay per turn
    "fast": 0.80,     # Transient details: 20% decay per turn
    "very_fast": 0.70, # Episodes: 30% decay per turn (fades in ~6 turns)
}

# Default decay rates by memory category
CATEGORY_DECAY = {
    "core": "none",           # Origins, abilities
    "character_state": "fast", # HP/MP/SP/inventory
    "relationship": "very_slow",  # Affinity, history (#7: 0.97/turn instead of 0.95)
    "quest": "normal",         # Objectives, consequences
    "world_state": "normal",   # Time, politics, environment
    "consequence": "slow",     # Moral choices, reputation
    "event": "normal",         # General events
    "fact": "slow",            # Persistent facts
    "npc_state": "normal",     # NPC status
    "location": "slow",        # Visited places
    "episode": "very_fast",    # Per-turn summaries (working memory overflow)
    "narrative_beat": "slow",  # Extracted narrative beats (emotional moments, revelations)
    "session_zero": "none",    # Session Zero memories (never decay)
    "session_zero_voice": "none", # Tonal/voice memories (never decay)
}


class Memory(BaseModel):
    """A single memory unit."""
    id: str
    type: str  # Category: core, relationship, quest, etc.
    content: str
    embedding: Optional[List[float]] = None
    heat: float = 100.0  # 0-100, starts hot
    turn_number: int
    decay_rate: str = "normal"  # none, slow, normal, fast
    timestamp: float = Field(default_factory=time.time)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    flags: List[str] = Field(default_factory=list)  # plot_critical, character_milestone


class MemoryStore:
    """
    Manages long-term memory using ChromaDB.
    
    Features:
    - Semantic search via embeddings
    - Heat decay over turns (memories fade)
    - Heat boost on access (referenced memories stay relevant)
    - Category-based decay rates
    """
    
    def __init__(self, campaign_id: str, persist_dir: str = "./data/chroma"):
        self.campaign_id = campaign_id
        self.client = chromadb.PersistentClient(path=persist_dir)
        
        # Create or get collection for this campaign
        self.collection = self.client.get_or_create_collection(
            name=f"campaign_{campaign_id}",
            metadata={"hnsw:space": "cosine"}
        )
        
        # Track last decay turn to avoid double-decay
        self._last_decay_turn = 0
        
    def add_memory(
        self, 
        content: str, 
        memory_type: str, 
        turn_number: int, 
        metadata: Optional[Dict[str, Any]] = None,
        decay_rate: Optional[str] = None,
        flags: Optional[List[str]] = None
    ) -> str:
        """
        Add a new memory to the store.
        
        Args:
            content: The memory content
            memory_type: Category (core, relationship, quest, etc.)
            turn_number: When this memory was created
            metadata: Additional metadata
            decay_rate: Override decay rate (none, slow, normal, fast)
            flags: Special flags (plot_critical, character_milestone)
            
        Returns:
            Memory ID, or existing ID if duplicate detected
        """
        # --- Deduplication check ---
        # Compare first 200 chars to catch near-exact duplicates from
        # different indexing paths (process_session_zero_state vs index_session_zero_to_memory)
        content_fingerprint = content.strip()[:200]
        if self.collection.count() > 0:
            try:
                existing = self.collection.get(
                    include=["documents"]
                )
                if existing["documents"]:
                    for i, doc in enumerate(existing["documents"]):
                        if doc.strip()[:200] == content_fingerprint:
                            logger.warning(f"Dedup: skipping duplicate content (matches {existing['ids'][i]})")
                            return existing["ids"][i]
            except Exception:
                pass  # If dedup check fails, proceed with add
        
        memory_id = f"{memory_type}_{turn_number}_{int(time.time()*1000)}"
        
        if metadata is None:
            metadata = {}
        if flags is None:
            flags = []
            
        # Determine decay rate
        if decay_rate is None:
            decay_rate = CATEGORY_DECAY.get(memory_type, "normal")
        
        # Plot-critical flags override decay
        if "plot_critical" in flags:
            decay_rate = "none"
            
        # Build metadata
        metadata.update({
            "type": memory_type,
            "turn": turn_number,
            "heat": 100.0,
            "decay_rate": decay_rate,
            "flags": ",".join(flags),
            "timestamp": time.time()
        })
        
        self.collection.add(
            documents=[content],
            metadatas=[metadata],
            ids=[memory_id]
        )
        
        return memory_id
    
    def add_episode(
        self, 
        turn: int, 
        location: str, 
        summary: str,
        flags: list = None
    ) -> str:
        """
        Write episodic memory for a turn (condensed summary).
        
        Episodes use very_fast decay (30% per turn), fading in ~6 turns.
        This bridges the gap between working memory and long-term.
        
        Args:
            turn: Turn number
            location: Current location
            summary: Condensed summary of what happened
            flags: Optional flags
            
        Returns:
            Memory ID
        """
        content = f"[Turn {turn}] {location}: {summary}"
        return self.add_memory(
            content=content,
            memory_type="episode",
            turn_number=turn,
            decay_rate="very_fast",
            flags=flags or ["recent_event"]
        )
    
    def search(
        self, 
        query: str, 
        limit: int = 5, 
        min_heat: float = 0.0,
        boost_on_access: bool = True,
        memory_type: str = None,
        keyword: str = None,
    ) -> List[Dict[str, Any]]:
        """
        Search for relevant memories with heat filtering.
        
        Args:
            query: Search query
            limit: Max results
            min_heat: Minimum heat threshold (0-100)
            boost_on_access: Whether to boost heat of accessed memories
            memory_type: Optional type filter (core, relationship, quest, etc.)
            keyword: Optional exact keyword filter (uses ChromaDB where_document)
            
        Returns:
            List of matching memories
        """
        # Guard against invalid limit (ChromaDB requires n_results >= 1)
        if limit <= 0:
            return []
        
        # Build optional filters
        where = None
        if memory_type:
            where = {"type": memory_type}
        
        where_document = None
        if keyword:
            where_document = {"$contains": keyword}
        
        # Clamp n_results to collection size to avoid ChromaDB error
        collection_count = self.collection.count()
        if collection_count == 0:
            return []
        n_results = min(limit * 2, collection_count)
        
        # Query with optional filters
        query_kwargs = {
            "query_texts": [query],
            "n_results": n_results,
        }
        if where:
            query_kwargs["where"] = where
        if where_document:
            query_kwargs["where_document"] = where_document
        
        try:
            results = self.collection.query(**query_kwargs)
        except Exception as e:
            # Fallback: if filters cause an error (e.g. no matches), return empty
            logger.error(f"Search with filters failed: {e}")
            return []
        
        memories = []
        if results["ids"]:
            ids = results["ids"][0]
            documents = results["documents"][0]
            metadatas = results["metadatas"][0]
            distances = results["distances"][0]
            
            for i, mem_id in enumerate(ids):
                heat = metadatas[i].get("heat", 100.0)
                
                # Filter by minimum heat
                if heat < min_heat:
                    continue
                
                # Base score from semantic similarity
                base_score = 1.0 - distances[i]
                
                # RETRIEVAL BOOST: Session Zero and recent memories get priority
                boost = 0.0
                flags_str = metadatas[i].get("flags", "")
                
                # Session Zero memories: +0.3 boost (always relevant)
                if "session_zero" in flags_str or "plot_critical" in flags_str:
                    boost += 0.3
                
                # Recent memories: +0.2 boost (last 10 turns)
                mem_turn = int(metadatas[i].get("turn", 0))
                current_turn = int(metadatas[i].get("current_turn", 0))  # May not be set
                # Fallback: look at memory type - episodes are recent by design
                if metadatas[i].get("type") == "episode":
                    boost += 0.15  # Episodes get slight boost
                
                boosted_score = min(1.0, base_score + boost)
                    
                memories.append({
                    "id": mem_id,
                    "content": documents[i],
                    "metadata": metadatas[i],
                    "heat": heat,
                    "distance": distances[i],
                    "score": boosted_score,
                    "base_score": base_score,
                    "boost": boost
                })
                
                # Boost heat on access
                if boost_on_access:
                    self._boost_heat(mem_id, metadatas[i])
                
                if len(memories) >= limit:
                    break
        
        # Re-sort by boosted score (descending)
        memories.sort(key=lambda m: m["score"], reverse=True)
                    
        return memories
    
    def search_hybrid(
        self,
        query: str,
        keyword: str,
        limit: int = 5,
        min_heat: float = 0.0,
        boost_on_access: bool = True,
        memory_type: str = None,
    ) -> List[Dict[str, Any]]:
        """
        Hybrid search: merges keyword-filtered and pure semantic results.
        
        Runs two queries in parallel:
        1. Keyword-filtered semantic search (exact match + embedding)
        2. Pure semantic search (embedding only)
        
        Results are merged and deduplicated. Keyword matches get a +0.25
        score boost to surface exact-name hits above fuzzy semantic matches.
        
        Args:
            query: Semantic search query
            keyword: Exact keyword to match in memory content
            limit: Max results to return
            min_heat: Minimum heat threshold
            boost_on_access: Whether to boost heat of accessed memories
            memory_type: Optional type filter
            
        Returns:
            Merged, deduplicated list of memories sorted by score
        """
        # Run both searches (keyword+semantic and pure semantic)
        keyword_results = self.search(
            query=query,
            limit=limit,
            min_heat=min_heat,
            boost_on_access=boost_on_access,
            memory_type=memory_type,
            keyword=keyword,
        )
        
        semantic_results = self.search(
            query=query,
            limit=limit,
            min_heat=min_heat,
            boost_on_access=False,  # Already boosted in keyword pass
            memory_type=memory_type,
        )
        
        # Merge: keyword matches get a +0.25 boost
        seen_ids = set()
        merged = []
        
        for mem in keyword_results:
            mem = dict(mem)
            mem["score"] = min(1.0, mem["score"] + 0.25)
            mem["boost"] = mem.get("boost", 0.0) + 0.25
            seen_ids.add(mem["id"])
            merged.append(mem)
        
        for mem in semantic_results:
            if mem["id"] not in seen_ids:
                merged.append(mem)
                seen_ids.add(mem["id"])
        
        # Sort by score and trim to limit
        merged.sort(key=lambda m: m["score"], reverse=True)
        return merged[:limit]
    
    def _boost_heat(self, memory_id: str, current_metadata: Dict[str, Any]):
        """Boost memory heat when accessed (referenced memories stay relevant)."""
        current_heat = float(current_metadata.get("heat", 50.0))
        
        # #7: Stronger boost for relationship memories (+30 vs +20)
        category = current_metadata.get("type", "")
        boost_amount = 30.0 if category == "relationship" else 20.0
        
        new_heat = min(100.0, current_heat + boost_amount)
        
        # Update metadata
        updated_metadata = dict(current_metadata)
        updated_metadata["heat"] = new_heat
        
        self.collection.update(
            ids=[memory_id],
            metadatas=[updated_metadata]
        )

    def decay_heat(self, current_turn: int):
        """
        Apply decay to all memory heat based on turns elapsed.
        
        Called at the end of each turn to naturally fade memories.
        Memories with "none" decay rate are not affected.
        """
        # Avoid double-decay in same turn
        if current_turn <= self._last_decay_turn:
            return
        
        turns_elapsed = current_turn - self._last_decay_turn
        self._last_decay_turn = current_turn
        
        # Get all memories
        all_results = self.collection.get(
            include=["metadatas"]
        )
        
        if not all_results["ids"]:
            return
            
        ids_to_update = []
        metadatas_to_update = []
        
        for i, mem_id in enumerate(all_results["ids"]):
            metadata = all_results["metadatas"][i]
            
            # Get decay rate
            decay_rate_name = metadata.get("decay_rate", "normal")
            decay_multiplier = DECAY_CURVES.get(decay_rate_name, 0.90)
            
            # Skip if no decay
            if decay_multiplier >= 1.0:
                continue
                
            # Apply decay for each turn elapsed
            current_heat = float(metadata.get("heat", 100.0))
            new_heat = current_heat * (decay_multiplier ** turns_elapsed)
            
            # Floor at 1.0 (don't go to zero)
            new_heat = max(1.0, new_heat)
        
            # #7: Milestone heat floor — relationship memories with milestones
            # or plot_critical flags never drop below 40
            category = metadata.get("type", "")
            flags_str = metadata.get("flags", "")
            has_milestone = "milestone" in str(flags_str) or "plot_critical" in str(flags_str)
            if category == "relationship" and has_milestone:
                new_heat = max(40.0, new_heat)
            
            # Only update if changed significantly
            if abs(new_heat - current_heat) > 0.1:
                updated_metadata = dict(metadata)
                updated_metadata["heat"] = new_heat
                ids_to_update.append(mem_id)
                metadatas_to_update.append(updated_metadata)
        
        # Batch update
        if ids_to_update:
            self.collection.update(
                ids=ids_to_update,
                metadatas=metadatas_to_update
            )
    
    def get_hot_memories(self, min_heat: float = 50.0, limit: int = 10) -> List[Dict[str, Any]]:
        """Get the hottest memories (most relevant/recent)."""
        all_results = self.collection.get(
            include=["documents", "metadatas"]
        )
        
        if not all_results["ids"]:
            return []
            
        # Sort by heat
        memories = []
        for i, mem_id in enumerate(all_results["ids"]):
            heat = float(all_results["metadatas"][i].get("heat", 0))
            if heat >= min_heat:
                memories.append({
                    "id": mem_id,
                    "content": all_results["documents"][i],
                    "metadata": all_results["metadatas"][i],
                    "heat": heat
                })
        
        memories.sort(key=lambda m: m["heat"], reverse=True)
        return memories[:limit]
    
    def mark_plot_critical(self, memory_id: str):
        """Mark a memory as plot-critical (no decay)."""
        results = self.collection.get(
            ids=[memory_id],
            include=["metadatas"]
        )
        
        if results["ids"]:
            metadata = dict(results["metadatas"][0])
            metadata["decay_rate"] = "none"
            flags = metadata.get("flags", "").split(",")
            if "plot_critical" not in flags:
                flags.append("plot_critical")
            metadata["flags"] = ",".join(f for f in flags if f)
            
            self.collection.update(
                ids=[memory_id],
                metadatas=[metadata]
            )
    
    def count(self) -> int:
        """Get total memory count."""
        return self.collection.count()
    
    async def compress_cold_memories(
        self, 
        heat_threshold: float = 30.0,
        min_memories_to_compress: int = 5,
        max_per_category: int = 10
    ) -> Dict[str, Any]:
        """
        Compress old, cold memories into summarized versions.
        
        This reduces context size while preserving important information.
        Cold memories (below heat threshold) are grouped by category,
        summarized via LLM, and the originals are replaced with summaries.
        
        Args:
            heat_threshold: Memories below this heat are candidates
            min_memories_to_compress: Minimum count needed to compress
            max_per_category: Max memories to compress per category at once
            
        Returns:
            Dict with compression stats
        """
        # (Unused imports removed - summarization handled by _summarize_memories)
        
        # Get cold memories
        cold_memories = self._get_cold_memories(heat_threshold)
        
        if len(cold_memories) < min_memories_to_compress:
            return {
                "compressed": False,
                "reason": f"Only {len(cold_memories)} cold memories, need {min_memories_to_compress}",
                "cold_count": len(cold_memories)
            }
        
        # Group by category
        by_category: Dict[str, List[Dict]] = {}
        for mem in cold_memories:
            cat = mem["metadata"].get("memory_type", "event")
            if cat not in by_category:
                by_category[cat] = []
            by_category[cat].append(mem)
        
        # Skip categories with no decay (plot-critical)
        skip_categories = []
        for cat, mems in by_category.items():
            # Check if all have no decay
            if all(m["metadata"].get("decay_rate") == "none" for m in mems):
                skip_categories.append(cat)
        
        for cat in skip_categories:
            del by_category[cat]
        
        if not by_category:
            return {
                "compressed": False,
                "reason": "All cold memories are plot-critical (no decay)",
                "cold_count": len(cold_memories)
            }
        
        # Compress each category
        compressed_count = 0
        summaries_created = 0
        
        for category, memories in by_category.items():
            if len(memories) < 2:
                continue  # Need at least 2 to compress
                
            batch = memories[:max_per_category]
            
            # Generate summary via LLM
            summary = await self._summarize_memories(category, batch)
            
            if summary:
                # Create compressed memory
                compressed_id = f"compressed_{category}_{int(time.time())}"
                self.add_memory(
                    content=f"[COMPRESSED MEMORIES - {category.upper()}]\n{summary}",
                    memory_type=category,
                    turn_number=batch[0]["metadata"].get("turn_number", 0),
                    metadata={
                        "is_compressed": True,
                        "source_count": len(batch),
                        "source_ids": ",".join(m["id"] for m in batch)
                    },
                    decay_rate="slow",  # Summaries decay slowly
                    flags=["compressed"]
                )
                summaries_created += 1
                
                # Delete originals
                ids_to_delete = [m["id"] for m in batch]
                self.collection.delete(ids=ids_to_delete)
                compressed_count += len(ids_to_delete)
        
        return {
            "compressed": True,
            "memories_removed": compressed_count,
            "summaries_created": summaries_created,
            "categories_processed": list(by_category.keys())
        }
    
    def _get_cold_memories(self, heat_threshold: float) -> List[Dict]:
        """Get all memories below the heat threshold."""
        all_results = self.collection.get(
            include=["metadatas", "documents"]
        )
        
        cold = []
        for i, mem_id in enumerate(all_results["ids"]):
            metadata = all_results["metadatas"][i]
            heat = metadata.get("heat", 50.0)
            
            if heat < heat_threshold:
                cold.append({
                    "id": mem_id,
                    "content": all_results["documents"][i],
                    "metadata": metadata,
                    "heat": heat
                })
        
        return cold
    
    async def _summarize_memories(self, category: str, memories: List[Dict]) -> Optional[str]:
        """Use LLM to summarize a batch of memories."""
        from ..llm import get_llm_manager
        
        # Format memories for prompt
        memory_texts = []
        for i, mem in enumerate(memories, 1):
            memory_texts.append(f"{i}. {mem['content']}")
        
        prompt = f"""Summarize these {len(memories)} old memories from the "{category}" category into a single concise paragraph.
Preserve key facts, names, and important details. Remove redundancy.
Keep the summary under 200 words.

MEMORIES:
{chr(10).join(memory_texts)}

SUMMARY:"""
        
        try:
            # Use context selector model for summarization
            manager = get_llm_manager()
            provider, model = manager.get_provider_for_agent("context_selector")
            
            response = await provider.complete(
                messages=[{"role": "user", "content": prompt}],
                system="You are a memory compression assistant. Create concise summaries that preserve essential information.",
                model=model
            )
            
            return response.content.strip()
        except Exception as e:
            logger.error(f"Compression error for {category}: {e}")
            return None
        
    def close(self):
        """Cleanup if needed."""
        pass

