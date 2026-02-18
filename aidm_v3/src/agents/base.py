"""Base agent class for all AIDM agents."""

import logging
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from ..llm import LLMProvider, get_llm_manager
from ..settings import get_settings_store

logger = logging.getLogger(__name__)

# Shared prompts directory (aidm_v3/prompts/)
_PROMPTS_DIR = Path(__file__).parent.parent.parent / "prompts"


class BaseAgent(ABC):
    """Base class for all AIDM agents.
    
    Provides structured output support using the LLM manager,
    which supports Google Gemini, Anthropic Claude, and OpenAI.
    Uses per-agent settings from the settings store.
    """

    # Subclasses should set this to their agent name
    agent_name: str = "unknown"

    def __init__(self, model_override: str | None = None):
        """Initialize the agent.
        
        Args:
            model_override: Specific model to use (overrides settings)
        """
        self._model_override = model_override

    @staticmethod
    def _load_prompt_file(filename: str, fallback: str = "") -> str:
        """Load a system prompt from prompts/{filename}.
        
        Args:
            filename: e.g. 'compactor.md'
            fallback: returned if file doesn't exist
        """
        path = _PROMPTS_DIR / filename
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
        return fallback

    def _get_provider_and_model(self) -> tuple[LLMProvider, str]:
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
    def output_schema(self) -> type[BaseModel]:
        """Pydantic model for structured output."""
        pass

    async def call(self, user_message: str, system_prompt_override: str | None = None, **context) -> BaseModel:
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
            EXTENDED_THINKING_AGENTS = [
                "director", "key_animator", "research",
                "combat"
            ]
            if self.agent_name in EXTENDED_THINKING_AGENTS:
                use_extended_thinking = True

        # Use override if provided, otherwise use default
        system = system_prompt_override if system_prompt_override is not None else self.system_prompt

        # Increase token limit for thinking models
        max_tokens = 16384 if use_extended_thinking else 8192

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


class AgenticAgent(BaseAgent):
    """Agent with tool-calling capability.
    
    Extends BaseAgent with the ability to use tools during generation.
    Supports two operational modes:
    
    1. **call_with_tools()**: Full tool-calling loop using the agent's
       configured model. Returns free-form text.
    
    2. **research_with_tools()**: Fast-model investigation phase that
       returns findings as text. Designed to be called BEFORE the agent's
       main structured output call (via BaseAgent.call()). This is the
       two-model pattern: fast model for research, creative model for writing.
    
    Unlike BaseAgent (single prompt → structured output), AgenticAgent
    can iteratively search, investigate, and gather information before
    producing its final response.
    """

    def __init__(self, model_override: str | None = None):
        super().__init__(model_override=model_override)
        self._tools: Any | None = None

    def set_tools(self, tools) -> 'AgenticAgent':
        """Set the ToolRegistry for this agent. Returns self for chaining."""
        self._tools = tools
        return self

    def get_tools(self):
        """Return the ToolRegistry for this agent.
        
        Override in subclasses, or set self._tools via set_tools().
        Returns None if no tools are available (falls back to standard call).
        """
        return self._tools

    async def research_with_tools(
        self,
        research_prompt: str,
        system: str = "You are a concise researcher. Use tools to gather facts, then summarize.",
        max_tool_rounds: int = 3,
        max_tokens: int = 2048,
    ) -> str:
        """Run a fast-model investigation phase using tools.
        
        Uses the FAST model (cheap, quick) regardless of the agent's
        configured model. Returns free-form text findings that can be
        injected into the agent's main prompt.
        
        This is the recommended way to add agentic research to any agent:
        
            findings = await self.research_with_tools(prompt, tools=tools)
            # ... inject findings into the main structured output call ...
            result = await self.call(message, investigation_findings=findings)
        
        Args:
            research_prompt: What to investigate
            system: System prompt for the research phase
            max_tool_rounds: Maximum tool-call iterations
            max_tokens: Max tokens for research response
            
        Returns:
            Research findings as text, or empty string on failure
        """
        from ..llm.tools import ToolRegistry

        tools = self.get_tools()
        if not tools or not isinstance(tools, ToolRegistry):
            return ""

        try:
            manager = get_llm_manager()
            fast_provider = manager.fast_provider
            fast_model = manager.get_fast_model()

            response = await fast_provider.complete_with_tools(
                messages=[{"role": "user", "content": research_prompt}],
                tools=tools,
                system=system,
                model=fast_model,
                max_tokens=max_tokens,
                max_tool_rounds=max_tool_rounds,
            )

            findings = response.content.strip()
            if findings:
                call_log = tools.call_log
                tool_names = [c.tool_name for c in call_log]
                logger.info(
                    f"[{self.agent_name}] Research phase: {len(call_log)} tool calls "
                    f"({', '.join(tool_names)}), {len(findings)} chars"
                )
                return findings

        except Exception as e:
            logger.error(f"[{self.agent_name}] Research phase failed (non-fatal): {e}")

        return ""

    async def call_with_tools(
        self,
        user_message: str,
        system_prompt_override: str | None = None,
        max_tool_rounds: int = 5,
        **context
    ) -> str:
        """Make a tool-calling API call. Returns free-form text.
        
        Unlike BaseAgent.call() which returns structured Pydantic output,
        this returns free-form text since tool-calling agents produce
        natural language responses after their research phase.
        
        Uses the agent's configured model (not the fast model).
        For fast-model research, use research_with_tools() instead.
        
        Args:
            user_message: The main user message/query
            system_prompt_override: Optional override for the system prompt
            max_tool_rounds: Maximum tool-call iterations (safety limit)
            **context: Additional context sections
            
        Returns:
            Final text response after tool-calling loop completes
        """
        from ..llm.tools import ToolRegistry

        tools = self.get_tools()
        if not tools or not isinstance(tools, ToolRegistry):
            # No tools — fall back to standard text completion
            full_message = self._build_message(user_message, context)
            messages = [{"role": "user", "content": full_message}]
            system = system_prompt_override if system_prompt_override is not None else self.system_prompt
            response = await self.provider.complete(
                messages=messages,
                system=system,
                model=self.model,
                max_tokens=4096,
            )
            return response.content

        # Build context into user message
        full_message = self._build_message(user_message, context)
        messages = [{"role": "user", "content": full_message}]

        # Use override if provided, otherwise use default
        system = system_prompt_override if system_prompt_override is not None else self.system_prompt

        response = await self.provider.complete_with_tools(
            messages=messages,
            tools=tools,
            system=system,
            model=self.model,
            max_tokens=4096,
            max_tool_rounds=max_tool_rounds,
        )

        return response.content

