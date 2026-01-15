"""Default settings and available models configuration."""

from typing import Dict, List
from .models import UserSettings, AgentSettings, ModelConfig


# Available models per provider (December 2025)
AVAILABLE_MODELS: Dict[str, List[Dict[str, str]]] = {
    "google": [
        {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash", "tier": "fast", "description": "Fast, affordable for structured tasks"},
        {"id": "gemini-3-pro-preview", "name": "Gemini 3 Pro", "tier": "creative", "description": "High quality reasoning and generation"},
    ],
    "anthropic": [
        {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5", "tier": "fast", "description": "Fast, affordable for structured tasks"},
        {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "tier": "creative", "description": "Balanced quality and speed"},
        {"id": "claude-opus-4-5", "name": "Claude Opus 4.5", "tier": "premium", "description": "Highest quality, now nearly Sonnet pricing"},
    ],
    "openai": [
        {"id": "gpt-5.2-chat-latest", "name": "GPT-5.2 Chat", "tier": "fast", "description": "Fast, optimized for chat"},
        {"id": "gpt-5.2", "name": "GPT-5.2", "tier": "creative", "description": "Balanced quality and speed"},
        {"id": "gpt-5.2-pro", "name": "GPT-5.2 Pro", "tier": "premium", "description": "Highest quality, more compute"},
    ],
}


def get_available_models(provider: str = None) -> Dict[str, List[Dict[str, str]]]:
    """Get available models, optionally filtered by provider.
    
    Args:
        provider: Optional provider to filter by
        
    Returns:
        Dict of provider -> list of model info
    """
    if provider:
        return {provider: AVAILABLE_MODELS.get(provider, [])}
    return AVAILABLE_MODELS


def get_default_fast_model(provider: str) -> str:
    """Get the default fast model for a provider."""
    models = AVAILABLE_MODELS.get(provider, [])
    for m in models:
        if m.get("tier") == "fast":
            return m["id"]
    return models[0]["id"] if models else ""


def get_default_creative_model(provider: str) -> str:
    """Get the default creative model for a provider."""
    models = AVAILABLE_MODELS.get(provider, [])
    for m in models:
        if m.get("tier") in ("creative", "premium"):
            return m["id"]
    return models[-1]["id"] if models else ""


# Default settings - uses Google Gemini as primary (most affordable)
# Individual agents default to None; the tier-aware fallback in store.py
# will use base_fast, base_thinking, or base_creative as appropriate.
DEFAULT_SETTINGS = UserSettings(
    agent_models=AgentSettings(
        # Base defaults (fallback for unconfigured agents)
        # These are the ONLY required configs - all others use tier fallback
        base_fast=ModelConfig(
            provider="google",
            model="gemini-3-flash-preview"
        ),
        base_thinking=ModelConfig(
            provider="google",
            model="gemini-3-pro-preview"
        ),
        base_creative=ModelConfig(
            provider="google",
            model="gemini-3-pro-preview"  # Prose generation - same as thinking by default
        ),
        # All individual agents default to None (use base defaults)
    ),
    debug_mode=True,
    active_profile_id=None,  # Set by Session Zero - no default profile
    extended_thinking=False  # Deeper reasoning for complex agents (increases latency/cost)
)


def create_settings_for_provider(provider: str) -> UserSettings:
    """Create default settings using a specific provider.
    
    Sets base_fast, base_thinking, and base_creative - all other agents will
    use tier-aware fallback to these base defaults.
    
    Args:
        provider: The provider to use ('google', 'anthropic', 'openai')
        
    Returns:
        UserSettings with that provider's base models
    """
    fast = get_default_fast_model(provider)
    creative = get_default_creative_model(provider)
    
    return UserSettings(
        agent_models=AgentSettings(
            # Only base defaults - individual agents use tier fallback
            base_fast=ModelConfig(provider=provider, model=fast),
            base_thinking=ModelConfig(provider=provider, model=creative),
            base_creative=ModelConfig(provider=provider, model=creative),
        ),
        debug_mode=True,
        active_profile_id=None  # Set by Session Zero - no default profile
    )
