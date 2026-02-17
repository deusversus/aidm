"""Abstract LLM provider interface."""

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, Type, TypeVar, Union
from pydantic import BaseModel

import logging

logger = logging.getLogger(__name__)

T = TypeVar("T")

# System prompt can be:
#   str                        — plain text (backward compatible, no caching)
#   List[Tuple[str, bool]]     — cache-aware blocks: [(text, should_cache), ...]
#                                Providers that support explicit caching (Anthropic)
#                                will add cache_control breakpoints on marked blocks.
#                                Others (Google) flatten to a single string.
SystemPrompt = Union[str, List[Tuple[str, bool]]]


@dataclass
class LLMResponse:
    """Standard response from any LLM provider."""
    
    content: str
    """The text content of the response."""
    
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    """Tool/function calls if any (for structured output)."""
    
    model: str = ""
    """The model that generated this response."""
    
    usage: Dict[str, int] = field(default_factory=dict)
    """Token usage: {prompt_tokens, completion_tokens, total_tokens}."""
    
    raw_response: Any = None
    """The raw response object from the provider."""
    
    metadata: Dict[str, Any] = field(default_factory=dict)
    """Additional metadata (e.g., search grounding info, citations)."""


class LLMProvider(ABC):
    """Abstract base class for LLM providers.
    
    Implementations must support:
    - Standard text completion
    - Structured output via tool/function calling
    - System prompts
    """
    
    def __init__(self, api_key: str, default_model: Optional[str] = None):
        """Initialize the provider.
        
        Args:
            api_key: API key for the provider
            default_model: Default model to use
        """
        self.api_key = api_key
        self.default_model = default_model or self.get_default_model()
        self._client = None
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name (e.g., 'anthropic', 'google', 'openai')."""
        pass
    
    @abstractmethod
    def get_default_model(self) -> str:
        """Get the default model for this provider."""
        pass
    
    @abstractmethod
    def get_fast_model(self) -> str:
        """Get the fast/cheap model for this provider."""
        pass
    
    @abstractmethod
    def get_creative_model(self) -> str:
        """Get the creative/quality model for this provider."""
        pass
    
    def get_max_concurrent_requests(self) -> int:
        """Get the maximum concurrent requests allowed for this provider.
        
        Override in subclasses based on provider rate limits.
        Default is 5, which is conservative for most providers.
        """
        return 5
    
    @abstractmethod
    async def complete(
        self,
        messages: List[Dict[str, str]],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        extended_thinking: bool = False,
    ) -> LLMResponse:
        """Generate a text completion.
        
        Args:
            messages: List of messages [{role: str, content: str}]
            system: System prompt
            model: Model to use (defaults to provider default)
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature
            
        Returns:
            LLMResponse with the completion
        """
        pass
    
    @abstractmethod
    async def complete_with_schema(
        self,
        messages: List[Dict[str, str]],
        schema: Type[BaseModel],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 1024,
        extended_thinking: bool = False,
    ) -> BaseModel:
        """Generate a structured completion matching a Pydantic schema.
        
        Args:
            messages: List of messages
            schema: Pydantic model class for the output
            system: System prompt
            model: Model to use
            max_tokens: Maximum tokens to generate
            
        Returns:
            Parsed Pydantic model instance
        """
        pass
    
    async def complete_with_tools(
        self,
        messages: List[Dict[str, str]],
        tools: Any,  # ToolRegistry — imported lazily to avoid circular deps
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        max_tool_rounds: int = 5,
    ) -> 'LLMResponse':
        """Run a tool-calling loop until the model produces a final text response.
        
        The loop:
        1. Call the model with tool definitions
        2. If the model returns tool calls → execute them via ToolRegistry
        3. Append function responses to the conversation
        4. Repeat until the model returns text or max_tool_rounds reached
        
        Args:
            messages: Initial conversation messages
            tools: ToolRegistry with available tools
            system: System prompt
            model: Model to use
            max_tokens: Maximum tokens per response
            max_tool_rounds: Safety limit on tool-call loop iterations
            
        Returns:
            LLMResponse with final text content and tool_calls log
        """
        raise NotImplementedError(
            f"{self.name} provider does not support tool-calling yet. "
            f"Implement complete_with_tools() in the provider subclass."
        )
    
    # ── Retry helper ──────────────────────────────────────────────

    @staticmethod
    def _is_retryable(exc: Exception) -> bool:
        """Check if an exception is a transient overload/rate-limit error.
        
        Works for Anthropic (OverloadedError, RateLimitError, APIStatusError 529)
        and OpenAI (RateLimitError, APIStatusError 429) without hard-importing
        either SDK.
        """
        cls_name = type(exc).__name__
        
        # Direct rate-limit / overloaded exception classes
        if cls_name in ("OverloadedError", "RateLimitError"):
            return True
        
        # HTTP-level status errors (both SDKs expose .status_code)
        status = getattr(exc, "status_code", None)
        if status in (429, 529):
            return True
        
        # Anthropic wraps errors as dict-like messages
        err_body = getattr(exc, "body", None)
        if isinstance(err_body, dict):
            err_type = err_body.get("error", {}).get("type", "")
            if err_type in ("overloaded_error", "rate_limit_error"):
                return True
        
        return False

    async def _call_with_retry(
        self,
        fn: Callable[..., T],
        *args,
        max_retries: int = 3,
        base_delay: float = 2.0,
        **kwargs,
    ) -> T:
        """Execute an async callable with exponential backoff on transient errors.
        
        Args:
            fn: async callable to execute
            max_retries: number of retry attempts (default 3)
            base_delay: initial delay in seconds (doubles each retry)
        """
        last_exc = None
        for attempt in range(max_retries + 1):
            try:
                return await fn(*args, **kwargs)
            except Exception as exc:
                if not self._is_retryable(exc) or attempt == max_retries:
                    raise
                last_exc = exc
                delay = base_delay * (2 ** attempt)
                logger.warning(f"[{self.name}] {type(exc).__name__} — retrying in {delay:.0f}s "
                      f"(attempt {attempt + 1}/{max_retries})")
                await asyncio.sleep(delay)
        raise last_exc  # unreachable, but satisfies type checker

    async def _run_with_retry(
        self,
        sync_fn: Callable[..., T],
        max_retries: int = 3,
        base_delay: float = 2.0,
    ) -> T:
        """Run a synchronous function in an executor with retry on overload.
        
        Drop-in replacement for:
            await loop.run_in_executor(None, sync_fn)
        
        Usage:
            result = await self._run_with_retry(lambda: self._client.messages.create(**kwargs))
        """
        loop = asyncio.get_running_loop()
        last_exc = None
        for attempt in range(max_retries + 1):
            try:
                return await loop.run_in_executor(None, sync_fn)
            except Exception as exc:
                if not self._is_retryable(exc) or attempt == max_retries:
                    raise
                last_exc = exc
                delay = base_delay * (2 ** attempt)
                logger.warning(f"[{self.name}] {type(exc).__name__} — retrying in {delay:.0f}s "
                      f"(attempt {attempt + 1}/{max_retries})")
                await asyncio.sleep(delay)
        raise last_exc  # unreachable

    # ── Client lifecycle ─────────────────────────────────────────

    def _ensure_client(self):
        """Ensure the client is initialized (lazy loading)."""
        if self._client is None:
            self._init_client()
    
    @abstractmethod
    def _init_client(self):
        """Initialize the provider's client."""
        pass
