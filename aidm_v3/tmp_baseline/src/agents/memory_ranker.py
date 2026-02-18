from typing import List, Dict, Any, Type, Optional
from pydantic import BaseModel, Field, field_validator
from .base import BaseAgent
from ..llm.manager import get_llm_manager

class MemoryRanking(BaseModel):
    memory_id: str
    relevance_score: float = Field(default=0.0, description="0.0 to 1.0 relevance score")
    reason: str = Field(default="", description="Why this memory is relevant or not")
    
    @field_validator('relevance_score', mode='before')
    @classmethod
    def coerce_score(cls, v):
        """Handle None or invalid scores from LLM."""
        if v is None:
            return 0.0
        try:
            score = float(v)
            return max(0.0, min(1.0, score))  # Clamp to 0-1 range
        except (ValueError, TypeError):
            return 0.0

class RankedMemories(BaseModel):
    rankings: List[MemoryRanking] = Field(default_factory=list)

class MemoryRanker(BaseAgent):
    """
    Agent that re-ranks retrieved memories based on narrative relevance.
    Semantic search gives candidates; this agent acts as the 'Judge' of 
    what's truly important for the current context.
    
    Uses a fast model (Flash/Haiku).
    """
    
    agent_name = "memory_ranker"
    
    def __init__(self):
        super().__init__()

    @property
    def system_prompt(self) -> str:
        return self._load_prompt_file("memory_ranker.md", "You are the Memory Ranker.")

    @property
    def output_schema(self) -> Type[BaseModel]:
        return RankedMemories
        
    async def call(self, current_situation: str, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Rank candidate memories.
        Returns the original candidates sorted by relevance, with added 'rank_score'.
        """
        if not candidates:
            return []
            
        # Format candidates for prompt
        candidates_text = ""
        for mem in candidates:
            # Include type and heat in the evaluation context
            candidates_text += f"ID: {mem['id']}\nType: {mem.get('metadata', {}).get('type', 'unknown')}\nContent: {mem['content']}\n\n"
            
        user_prompt = f"""
        CURRENT SITUATION:
        {current_situation}
        
        CANDIDATE MEMORIES:
        {candidates_text}
        
        Rank the memories by relevance.
        """
        
        try:
            # Use BaseAgent flow, or direct LLM manager call if specialized. 
            # BaseAgent.call() expects a simple user message string and context usage.
            # But here we have a complex user prompt construction.  
            # To stick to the pattern, we'll manually call provider completion like before 
            # BUT we now satisfy Abstract Class requirements.
            
            # Re-using the logic from before, but obtaining the provider correctly
            manager = get_llm_manager()
            
            # Get provider/model using BaseAgent method (no args, uses self.agent_name)
            provider, model_name = self._get_provider_and_model()

            response = await provider.complete_with_schema(
                messages=[{"role": "user", "content": user_prompt}],
                schema=RankedMemories,
                system=self.system_prompt,
                model=model_name
            )
            
            # Create a lookup for scores - normalize memory_id to handle "ID:X" vs "X" formats
            scores = {}
            for r in response.rankings:
                # Strip common prefixes like "ID:", "id:", "ID: " that models might add
                normalized_id = r.memory_id.replace("ID:", "").replace("id:", "").strip()
                scores[normalized_id] = r.relevance_score
            
            # Attach scores to candidates
            ranked_candidates = []
            for mem in candidates:
                mem['rank_score'] = scores.get(mem['id'], 0.0)
                ranked_candidates.append(mem)
                
            # Sort by rank_score descending
            ranked_candidates.sort(key=lambda x: x['rank_score'], reverse=True)
            
            return ranked_candidates
            
        except Exception as e:
            # Fallback: Just return candidates as-is if ranking fails
            print(f"Memory Ranking failed: {e}")
            return candidates
