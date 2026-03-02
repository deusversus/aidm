"""Default settings and available models configuration."""


from .models import AgentSettings, ModelConfig, UserSettings

# Fallback Copilot models shown before the real list is fetched from the API.
# After connecting, get_available_models() replaces this with the live list from GitHub.
# Based on GitHub Copilot supported models documentation (2025).
COPILOT_FALLBACK_MODELS: list[dict[str, str]] = [
    # OpenAI — fast tier
    {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "tier": "fast", "description": "Fast, affordable chat model via Copilot"},
    {"id": "gpt-4.1-mini", "name": "GPT-4.1 Mini", "tier": "fast", "description": "Compact GPT-4.1 via Copilot"},
    # OpenAI — creative tier
    {"id": "gpt-4o", "name": "GPT-4o", "tier": "creative", "description": "Multimodal GPT-4o via Copilot"},
    {"id": "gpt-4.1", "name": "GPT-4.1", "tier": "creative", "description": "Latest GPT-4.1 via Copilot"},
    # OpenAI — reasoning tier
    {"id": "o3-mini", "name": "o3-mini", "tier": "thinking", "description": "Compact reasoning model via Copilot"},
    {"id": "o4-mini", "name": "o4-mini", "tier": "thinking", "description": "Fast reasoning model via Copilot"},
    # Anthropic — creative tier
    {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "tier": "creative", "description": "Anthropic Claude Sonnet 4.5 via Copilot"},
    {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "tier": "creative", "description": "Anthropic Claude Sonnet 4.6 via Copilot"},
    # Anthropic — premium tier
    {"id": "claude-opus-4-5", "name": "Claude Opus 4.5", "tier": "premium", "description": "Anthropic Claude Opus 4.5 via Copilot"},
    {"id": "claude-opus-4-6", "name": "Claude Opus 4.6", "tier": "premium", "description": "Anthropic Claude Opus 4.6 via Copilot"},
    # Google — fast tier
    {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash", "tier": "fast", "description": "Google Gemini 2.0 Flash via Copilot"},
    {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash", "tier": "fast", "description": "Google Gemini 3 Flash (preview) via Copilot"},
    # Google — creative tier
    {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "tier": "creative", "description": "Google Gemini 2.5 Pro via Copilot"},
    {"id": "gemini-3-pro-preview", "name": "Gemini 3 Pro", "tier": "creative", "description": "Google Gemini 3 Pro (preview) via Copilot"},
]

# Available models per provider (December 2025)
AVAILABLE_MODELS: dict[str, list[dict[str, str]]] = {
    "google": [
        {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash", "tier": "fast", "description": "Fast, affordable for structured tasks"},
        {"id": "gemini-3-pro-preview", "name": "Gemini 3 Pro", "tier": "creative", "description": "High quality reasoning and generation"},
        {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro", "tier": "creative", "description": "Latest Gemini Pro — improved reasoning and generation"},
    ],
    "anthropic": [
        {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5", "tier": "fast", "description": "Fast, affordable for structured tasks"},
        {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "tier": "creative", "description": "Balanced quality and speed"},
        {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "tier": "creative", "description": "Latest Sonnet — fast, sharp, excellent coding"},
        {"id": "claude-opus-4-5", "name": "Claude Opus 4.5", "tier": "premium", "description": "Previous-gen Opus, still excellent"},
        {"id": "claude-opus-4-6", "name": "Claude Opus 4.6", "tier": "premium", "description": "Latest Opus — highest quality, nearly Sonnet pricing"},
    ],
    "openai": [
        {"id": "gpt-5.2-chat-latest", "name": "GPT-5.2 Chat", "tier": "fast", "description": "Fast, optimized for chat"},
        {"id": "gpt-5.2", "name": "GPT-5.2", "tier": "creative", "description": "Balanced quality and speed"},
        {"id": "gpt-5.2-pro", "name": "GPT-5.2 Pro", "tier": "premium", "description": "Highest quality, more compute"},
    ],
}


def get_available_models(provider: str = None) -> dict[str, list[dict[str, str]]]:
    """Get available models, optionally filtered by provider.

    For the 'copilot' provider, merges the live cached model list (from the
    settings store) over the static fallback, so the frontend always sees the
    user's actual Copilot subscription models after they connect.

    Args:
        provider: Optional provider to filter by

    Returns:
        Dict of provider -> list of model info
    """
    # Build full model map with dynamic copilot list if available
    models = dict(AVAILABLE_MODELS)

    try:
        from .store import get_settings_store
        settings = get_settings_store().load()
        if settings.copilot_models:
            models["copilot"] = settings.copilot_models
        else:
            models["copilot"] = COPILOT_FALLBACK_MODELS
    except Exception:
        models["copilot"] = COPILOT_FALLBACK_MODELS

    if provider:
        return {provider: models.get(provider, [])}
    return models


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
            model="gemini-3.1-pro-preview"
        ),
        base_creative=ModelConfig(
            provider="google",
            model="gemini-3.1-pro-preview"  # Prose generation - same as thinking by default
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
