"""Compactor Agent - Micro-summarizes dropped messages for narrative continuity."""

from typing import List, Dict, Optional

from .base import BaseAgent
from ..llm import get_llm_manager


class CompactorAgent(BaseAgent):
    """Summarizes messages that fall off the working memory sliding window.
    
    Produces ~100-200 word narrative beats that capture emotional texture,
    character dynamics, and story momentum — NOT log entries or event lists.
    
    Uses fast-tier model (cheap, high throughput summarization).
    """
    
    agent_name = "compactor"
    
    # Budget constants
    MAX_WORDS_PER_ENTRY = 200
    
    @property
    def system_prompt(self) -> str:
        return self._load_prompt_file("compactor.md", "You are a narrative compactor.")

    @property
    def output_schema(self):
        return None  # Free-form text output, not structured
    
    async def compact(
        self,
        dropped_messages: List[Dict[str, str]],
        prior_context: str = ""
    ) -> str:
        """Summarize 1-2 dropped messages into a narrative beat.
        
        Args:
            dropped_messages: Messages that just fell off the sliding window.
                Each dict has 'role' and 'content' keys.
            prior_context: Last few micro-summaries for continuity reference.
            
        Returns:
            Micro-summary as a narrative beat (~100-200 words).
        """
        if not dropped_messages:
            return ""
        
        # Build the messages to summarize
        transcript_lines = []
        for msg in dropped_messages:
            role = "PLAYER" if msg.get("role") == "user" else "DM"
            content = msg.get("content", "")
            transcript_lines.append(f"[{role}]: {content}")
        
        transcript = "\n\n".join(transcript_lines)
        
        # Build the prompt
        parts = []
        if prior_context:
            parts.append(f"## Recent Story Beats (for continuity)\n{prior_context}")
        parts.append(f"## Messages to Summarize\n{transcript}")
        parts.append(
            "\nWrite a single narrative beat (100-200 words) capturing the emotional "
            "texture and character dynamics of these messages. Focus on subtext, not events."
        )
        
        user_message = "\n\n".join(parts)
        
        # Use the provider directly for free-form completion
        provider, model = self._get_provider_and_model()
        
        from ..llm.provider import LLMResponse
        response = await provider.complete(
            messages=[{"role": "user", "content": user_message}],
            system=self.system_prompt,
            model=model,
            max_tokens=512,  # ~200 words max
            temperature=0.3,  # Low creativity — faithful summarization
        )
        
        result = response.content.strip()
        
        # Enforce word budget (hard cap)
        words = result.split()
        if len(words) > self.MAX_WORDS_PER_ENTRY:
            result = " ".join(words[:self.MAX_WORDS_PER_ENTRY])
            # Try to end on a sentence boundary
            last_period = result.rfind(".")
            if last_period > len(result) // 2:
                result = result[:last_period + 1]
        
        return result
