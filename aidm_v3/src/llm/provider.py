"""Abstract LLM provider interface."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel


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
    
    def _ensure_client(self):
        """Ensure the client is initialized (lazy loading)."""
        if self._client is None:
            self._init_client()
    
    @abstractmethod
    def _init_client(self):
        """Initialize the provider's client."""
        pass
