"""LLM Manager - Provider factory and management with settings integration."""

import os
from enum import Enum

from .anthropic_provider import AnthropicProvider
from .copilot_provider import CopilotProvider
from .google_provider import GoogleProvider
from .openai_provider import OpenAIProvider
from .provider import LLMProvider


class ProviderType(str, Enum):
    """Supported LLM providers."""
    GOOGLE = "google"
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    COPILOT = "copilot"


class LLMManager:
    """Factory and manager for LLM providers.
    
    Supports multiple providers with per-agent model configuration.
    Uses the settings store for user preferences.
    """

    def __init__(
        self,
        primary_provider: str | None = None,
        google_api_key: str | None = None,
        anthropic_api_key: str | None = None,
        openai_api_key: str | None = None,
    ):
        """Initialize the LLM manager.
        
        Args:
            primary_provider: Primary provider to use ('google', 'anthropic', 'openai')
            google_api_key: Google Gemini API key
            anthropic_api_key: Anthropic Claude API key
            openai_api_key: OpenAI ChatGPT API key
        """
        # Try to get API keys from settings store first
        settings_keys = self._load_keys_from_settings()

        # Get API keys from args, settings store, or environment (in that order)
        self._google_key = google_api_key or settings_keys.get("google", "") or os.getenv("GOOGLE_API_KEY", "")
        self._anthropic_key = anthropic_api_key or settings_keys.get("anthropic", "") or os.getenv("ANTHROPIC_API_KEY", "")
        self._openai_key = openai_api_key or settings_keys.get("openai", "") or os.getenv("OPENAI_API_KEY", "")
        self._copilot_token = settings_keys.get("copilot", "")

        # Anthropic OAuth (alternative to API key)
        self._anthropic_oauth_token = settings_keys.get("anthropic_oauth_token", "")
        self._anthropic_refresh_token = settings_keys.get("anthropic_refresh_token", "")
        self._anthropic_oauth_expires_at = float(settings_keys.get("anthropic_oauth_expires_at", 0))

        # Determine primary provider
        self._primary = self._resolve_primary(primary_provider)

        # Cache providers
        self._providers: dict[str, LLMProvider] = {}

    def _load_keys_from_settings(self) -> dict:
        """Load decrypted API keys and OAuth tokens from settings store."""
        try:
            from ..settings import get_settings_store
            store = get_settings_store()
            result = {
                "google": store.get_api_key("google"),
                "anthropic": store.get_api_key("anthropic"),
                "openai": store.get_api_key("openai"),
                "copilot": store.get_api_key("copilot"),
            }
            # Also load Anthropic OAuth tokens
            oauth_token, refresh_token, expires_at = store.get_anthropic_oauth()
            result["anthropic_oauth_token"] = oauth_token
            result["anthropic_refresh_token"] = refresh_token
            result["anthropic_oauth_expires_at"] = expires_at
            return result
        except Exception:
            return {}

    @property
    def _anthropic_available(self) -> bool:
        """True if Anthropic is usable via API key or OAuth."""
        return bool(self._anthropic_key or self._anthropic_oauth_token)

    def _resolve_primary(self, requested: str | None) -> str:
        """Resolve the primary provider based on availability."""
        # If explicitly requested, validate it
        if requested:
            requested = requested.lower()
            if requested == "google" and self._google_key:
                return "google"
            elif requested == "anthropic" and self._anthropic_available:
                return "anthropic"
            elif requested == "openai" and self._openai_key:
                return "openai"
            elif requested == "copilot" and self._copilot_token:
                return "copilot"

        # Check environment variable
        env_provider = os.getenv("LLM_PROVIDER", "").lower()
        if env_provider:
            if env_provider == "google" and self._google_key:
                return "google"
            elif env_provider == "anthropic" and self._anthropic_available:
                return "anthropic"
            elif env_provider == "openai" and self._openai_key:
                return "openai"
            elif env_provider == "copilot" and self._copilot_token:
                return "copilot"

        # Auto-detect based on available keys (prefer Google for affordability)
        if self._google_key:
            return "google"
        elif self._anthropic_available:
            return "anthropic"
        elif self._openai_key:
            return "openai"
        elif self._copilot_token:
            return "copilot"

        raise ValueError(
            "No LLM API keys configured. Set one of: "
            "GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or connect GitHub Copilot."
        )

    def get_provider(self, provider_name: str | None = None) -> LLMProvider:
        """Get an LLM provider instance.
        
        Args:
            provider_name: Specific provider to get, or None for primary
            
        Returns:
            LLMProvider instance
        """
        name = provider_name or self._primary

        if name in self._providers:
            return self._providers[name]

        # Create the provider
        provider = self._create_provider(name)
        self._providers[name] = provider
        return provider

    def _create_provider(self, name: str) -> LLMProvider:
        """Create a new provider instance."""
        if name == "google":
            if not self._google_key:
                raise ValueError("Google API key not configured")
            return GoogleProvider(api_key=self._google_key)

        elif name == "anthropic":
            if not self._anthropic_key and not self._anthropic_oauth_token:
                raise ValueError("Anthropic API key or OAuth not configured")
            return AnthropicProvider(
                api_key=self._anthropic_key,
                oauth_token=self._anthropic_oauth_token,
                refresh_token=self._anthropic_refresh_token,
                oauth_expires_at=self._anthropic_oauth_expires_at,
            )

        elif name == "openai":
            if not self._openai_key:
                raise ValueError("OpenAI API key not configured")
            return OpenAIProvider(api_key=self._openai_key)

        elif name == "copilot":
            if not self._copilot_token:
                raise ValueError("GitHub Copilot not connected — complete the OAuth flow in Settings")
            return CopilotProvider(github_token=self._copilot_token)

        else:
            raise ValueError(f"Unknown provider: {name}")

    def get_provider_for_agent(self, agent_name: str) -> tuple[LLMProvider, str]:
        """Get the provider and model configured for a specific agent.
        
        Uses the settings store to look up user's per-agent configuration.
        
        Args:
            agent_name: One of 'intent_classifier', 'outcome_judge', 'key_animator', 'director'
            
        Returns:
            Tuple of (LLMProvider instance, model name)
        """
        # Import here to avoid circular dependency
        from ..settings import get_settings_store

        store = get_settings_store()
        provider_name, model = store.get_agent_model(agent_name)

        # Validate the provider has a key configured; fall back to primary if not
        key_map = {
            "google": self._google_key,
            "anthropic": self._anthropic_key or self._anthropic_oauth_token,
            "openai": self._openai_key,
            "copilot": self._copilot_token,
        }
        if not key_map.get(provider_name):
            provider_name = self._primary
            model = self.get_provider(provider_name).get_fast_model()

        return self.get_provider(provider_name), model

    @property
    def primary_provider(self) -> str:
        """Get the name of the primary provider."""
        return self._primary

    @property
    def fast_provider(self) -> LLMProvider:
        """Get the provider configured for fast/cheap operations."""
        return self.get_provider(self._primary)

    @property
    def creative_provider(self) -> LLMProvider:
        """Get the provider configured for creative/quality operations."""
        return self.get_provider(self._primary)

    def get_fast_model(self) -> str:
        """Get the fast model name for the primary provider."""
        return self.fast_provider.get_fast_model()

    def get_creative_model(self) -> str:
        """Get the creative model name for the primary provider."""
        return self.creative_provider.get_creative_model()

    def list_available_providers(self) -> list[str]:
        """List providers that have API keys configured."""
        available = []
        if self._google_key:
            available.append("google")
        if self._anthropic_available:
            available.append("anthropic")
        if self._openai_key:
            available.append("openai")
        if self._copilot_token:
            available.append("copilot")
        return available


# Global manager instance
_manager: LLMManager | None = None


def get_llm_manager() -> LLMManager:
    """Get the global LLM manager instance."""
    global _manager
    if _manager is None:
        _manager = LLMManager()
    return _manager


def reset_llm_manager():
    """Reset the global LLM manager (useful for testing)."""
    global _manager
    _manager = None
