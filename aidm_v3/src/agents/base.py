"""Base agent class for all AIDM agents."""

from abc import ABC, abstractmethod
from typing import Any, Type, Optional, Tuple
from pydantic import BaseModel

from ..llm import get_llm_manager, LLMProvider
from ..settings import get_settings_store


class BaseAgent(ABC):
    """Base class for all AIDM agents.
    
    Provides structured output support using the LLM manager,
    which supports Google Gemini, Anthropic Claude, and OpenAI.
    Uses per-agent settings from the settings store.
    """
    
    # Subclasses should set this to their agent name
    agent_name: str = "unknown"
    
    def __init__(self, model_override: Optional[str] = None):
        """Initialize the agent.
        
        Args:
            model_override: Specific model to use (overrides settings)
        """
        self._model_override = model_override
    
    def _get_provider_and_model(self) -> Tuple[LLMProvider, str]:
        """Get the provider and model for this agent from settings.
        
        Always gets fresh from LLMManager - no per-agent caching.
        LLMManager handles caching at the global level.
        """
        manager = get_llm_manager()
        
        if self._model_override:
            return manager.get_provider(), self._model_override
        
        return manager.get_provider_for_agent(self.agent_name)
    
    @property
    def provider(self) -> LLMProvider:
        """Get the LLM provider for this agent."""
        provider, _ = self._get_provider_and_model()
        return provider
    
    @property
    def model(self) -> str:
        """Get the model to use for this agent."""
        _, model = self._get_provider_and_model()
        return model
    
    @property
    @abstractmethod
    def system_prompt(self) -> str:
        """The system prompt for this agent."""
        pass
    
    @property
    @abstractmethod
    def output_schema(self) -> Type[BaseModel]:
        """Pydantic model for structured output."""
        pass
    
    async def call(self, user_message: str, system_prompt_override: Optional[str] = None, **context) -> BaseModel:
        """Make a structured API call.
        
        Args:
            user_message: The main user message/query
            system_prompt_override: Optional override for the system prompt (for dynamic personas)
            **context: Additional context to include in the message
            
        Returns:
            Parsed response as Pydantic model
        """
        # Build context into user message
        full_message = self._build_message(user_message, context)
        
        # Use provider for structured completion
        messages = [{"role": "user", "content": full_message}]
        
        # Determine extended thinking status
        settings = get_settings_store().load()
        use_extended_thinking = False
        if settings.extended_thinking:
            # Apply to agents that benefit from deeper reasoning
            # - director: Long-term campaign planning
            # - key_animator: Complex narrative generation
            # - research: Anime research synthesis
            # - combat: Complex tactical decisions (boss fights)
            # - npc_reaction: Nuanced relationship dynamics
            # - calibration: Player preference analysis
            EXTENDED_THINKING_AGENTS = [
                "director", "key_animator", "research",
                "combat", "npc_reaction", "calibration"
            ]
            if self.agent_name in EXTENDED_THINKING_AGENTS:
                use_extended_thinking = True
        
        # Use override if provided, otherwise use default
        system = system_prompt_override if system_prompt_override is not None else self.system_prompt
        
        # Increase token limit for thinking models
        max_tokens = 8192 if use_extended_thinking else 4096
        
        result = await self.provider.complete_with_schema(
            messages=messages,
            schema=self.output_schema,
            system=system,
            model=self.model,
            max_tokens=max_tokens,
            extended_thinking=use_extended_thinking
        )
        return result
    
    def call_sync(self, user_message: str, **context) -> BaseModel:
        """Synchronous version of call (for non-async contexts)."""
        import asyncio
        
        # Check if we're already in an async context
        try:
            loop = asyncio.get_running_loop()
            # We're in an async context, need to use a new thread
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, self.call(user_message, **context))
                return future.result()
        except RuntimeError:
            # No running loop, we can use asyncio.run directly
            return asyncio.run(self.call(user_message, **context))
    
    def _build_message(self, user_message: str, context: dict) -> str:
        """Format message with context sections."""
        parts = []
        
        for key, value in context.items():
            if value:
                # Convert key to title case with spaces
                title = key.replace('_', ' ').title()
                parts.append(f"## {title}\n{value}")
        
        parts.append(f"## Player Action\n{user_message}")
        
        return "\n\n".join(parts)
