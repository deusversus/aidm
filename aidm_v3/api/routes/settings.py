"""Settings API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Dict, List, Optional

from src.settings import (
    UserSettings,
    AgentSettings,
    ModelConfig,
    get_settings_store,
)
from src.settings.defaults import get_available_models

router = APIRouter()


class ModelInfo(BaseModel):
    """Information about a single model."""
    id: str
    name: str
    tier: str
    description: str


class ModelsResponse(BaseModel):
    """Response for available models endpoint."""
    models: Dict[str, List[ModelInfo]]


class APIKeyRequest(BaseModel):
    """Request to set an API key."""
    key: str


class APIKeyStatus(BaseModel):
    """Status of a single API key."""
    configured: bool
    masked: str  # e.g., "sk-...xxxx" or ""


class APIKeysResponse(BaseModel):
    """Response for API keys status."""
    google: APIKeyStatus
    anthropic: APIKeyStatus
    openai: APIKeyStatus


@router.get("", response_model=UserSettings)
async def get_settings():
    """Get current user settings.
    
    Always reloads from disk to ensure fresh values.
    """
    store = get_settings_store()
    return store.reload()


@router.put("", response_model=UserSettings)
async def update_settings(settings: UserSettings):
    """Update user settings.
    
    IMPORTANT: Preserves existing API keys if the incoming settings
    have empty/default keys (since frontend doesn't send actual keys).
    """
    store = get_settings_store()
    
    # Load current settings to preserve API keys
    current = store.load()
    
    # If incoming API keys are empty/default, preserve the existing ones
    if not settings.api_keys.google_api_key:
        settings.api_keys.google_api_key = current.api_keys.google_api_key
    if not settings.api_keys.anthropic_api_key:
        settings.api_keys.anthropic_api_key = current.api_keys.anthropic_api_key
    if not settings.api_keys.openai_api_key:
        settings.api_keys.openai_api_key = current.api_keys.openai_api_key
    
    # Preserve active session state — these are set by Session Zero / gameplay,
    # not by the settings UI. Without this, saving model config overwrites the
    # active profile with whatever the frontend sends (or null).
    if current.active_profile_id and not settings.active_profile_id:
        settings.active_profile_id = current.active_profile_id
    if current.active_session_id and not settings.active_session_id:
        settings.active_session_id = current.active_session_id
    if current.active_campaign_id and not settings.active_campaign_id:
        settings.active_campaign_id = current.active_campaign_id
    
    store.save(settings)
    
    # Reset LLM manager and cached agents to pick up new provider settings
    from src.llm import reset_llm_manager
    reset_llm_manager()
    
    # Clear cached agent instances (they cache their providers)
    from api.routes.game import reset_session_zero_agent, reset_orchestrator
    reset_session_zero_agent()
    reset_orchestrator()
    
    return settings


@router.put("/agent/{agent_name}")
async def update_agent_model(agent_name: str, config: ModelConfig):
    """Update the model configuration for a specific agent.
    
    Args:
        agent_name: One of 'intent_classifier', 'outcome_judge', 'key_animator', 'director'
        config: The new model configuration
    """
    valid_agents = [
        # Base defaults
        "base_fast", "base_thinking", "base_creative",
        # Core agents
        "intent_classifier", "outcome_judge", "key_animator",
        # Validation & Memory
        "validator", "memory_ranker",
        # Judgment agents
        "combat", "progression", "scale_selector",
        # Director layer
        "director", "research", "scope", "profile_merge",
        # NPC Intelligence
        "relationship_analyzer",
        # Session Zero & World Building
        "session_zero", "world_builder", "wiki_scout",
        # Narrative Pacing
        "pacing", "recap",
        # Memory & Compression
        "compactor",
        # Post-Narrative Production
        "production",
    ]
    if agent_name not in valid_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid agent name. Must be one of: {valid_agents}"
        )
    
    store = get_settings_store()
    current = store.load()
    
    # Update the specific agent
    agent_models_dict = current.agent_models.model_dump()
    agent_models_dict[agent_name] = config.model_dump()
    current.agent_models = AgentSettings.model_validate(agent_models_dict)
    
    store.save(current)
    return {"status": "ok", "agent": agent_name, "config": config}


@router.post("/reset", response_model=UserSettings)
async def reset_settings():
    """Reset settings to defaults."""
    store = get_settings_store()
    return store.reset()


@router.get("/models", response_model=ModelsResponse)
async def get_models(provider: Optional[str] = None):
    """Get available models, optionally filtered by provider."""
    models_data = get_available_models(provider)
    
    # Convert to response format
    result = {}
    for prov, model_list in models_data.items():
        result[prov] = [ModelInfo(**m) for m in model_list]
    
    return ModelsResponse(models=result)


# API Key Management Endpoints

@router.get("/keys", response_model=APIKeysResponse)
async def get_api_keys():
    """Get API key status (masked, not plaintext)."""
    store = get_settings_store()
    
    masked = store.get_masked_keys()
    configured = store.get_configured_providers()
    
    return APIKeysResponse(
        google=APIKeyStatus(configured=configured["google"], masked=masked["google"]),
        anthropic=APIKeyStatus(configured=configured["anthropic"], masked=masked["anthropic"]),
        openai=APIKeyStatus(configured=configured["openai"], masked=masked["openai"]),
    )


@router.put("/keys/{provider}")
async def set_api_key(provider: str, request: APIKeyRequest):
    """Set an API key for a provider.
    
    Args:
        provider: One of 'google', 'anthropic', 'openai'
        request: The API key to set
    """
    valid_providers = ["google", "anthropic", "openai"]
    if provider not in valid_providers:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid provider. Must be one of: {valid_providers}"
        )
    
    store = get_settings_store()
    store.set_api_key(provider, request.key)
    
    # Reset ALL cached providers to pick up new keys
    from src.llm import reset_llm_manager
    reset_llm_manager()
    
    # Also reset agents that cache their own providers
    from api.routes.game import reset_session_zero_agent, reset_orchestrator
    reset_session_zero_agent()
    reset_orchestrator()
    
    return {"status": "ok", "provider": provider}


@router.delete("/keys/{provider}")
async def delete_api_key(provider: str):
    """Remove an API key for a provider.
    
    Args:
        provider: One of 'google', 'anthropic', 'openai'
    """
    valid_providers = ["google", "anthropic", "openai"]
    if provider not in valid_providers:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid provider. Must be one of: {valid_providers}"
        )
    
    store = get_settings_store()
    store.set_api_key(provider, "")  # Clear the key
    
    return {"status": "ok", "provider": provider}


# Validation Endpoint

class ProviderWarning(BaseModel):
    """Warning about a misconfigured provider."""
    tier: str  # e.g., "base_fast", "base_thinking", "base_creative"
    selected_provider: str  # The provider user selected
    selected_model: str  # The model user selected
    fallback_provider: str  # What will actually be used
    fallback_model: str  # The fallback model
    message: str  # Human-readable warning


class ValidationResponse(BaseModel):
    """Response from validation endpoint."""
    warnings: List[ProviderWarning]
    configured_providers: Dict[str, bool]


@router.get("/validate", response_model=ValidationResponse)
async def validate_settings():
    """Check for provider misconfigurations.
    
    Returns warnings when a provider is selected but has no API key configured.
    """
    store = get_settings_store()
    settings = store.load()
    configured = store.get_configured_providers()
    
    warnings = []
    
    # Determine fallback provider (first one with a key)
    fallback_provider = None
    for prov in ["google", "anthropic", "openai"]:
        if configured.get(prov):
            fallback_provider = prov
            break
    
    # Check each base tier config
    tiers = ["base_fast", "base_thinking", "base_creative"]
    tier_display = {
        "base_fast": "Fast Tier",
        "base_thinking": "Thinking Tier", 
        "base_creative": "Creative Tier"
    }
    
    for tier in tiers:
        config = getattr(settings.agent_models, tier, None)
        if config and not configured.get(config.provider):
            # This tier has a provider selected without an API key
            if fallback_provider:
                # Determine fallback model
                fallback_models = {
                    "google": "gemini-3-flash-preview",
                    "anthropic": "claude-haiku-4-5",
                    "openai": "gpt-5.2-chat-latest"
                }
                fallback_model = fallback_models.get(fallback_provider, "unknown")
                
                warnings.append(ProviderWarning(
                    tier=tier,
                    selected_provider=config.provider,
                    selected_model=config.model,
                    fallback_provider=fallback_provider,
                    fallback_model=fallback_model,
                    message=f"{tier_display[tier]} is set to {config.provider.title()} but no API key is configured. Will use {fallback_provider.title()} ({fallback_model}) instead."
                ))
            else:
                # No fallback available!
                warnings.append(ProviderWarning(
                    tier=tier,
                    selected_provider=config.provider,
                    selected_model=config.model,
                    fallback_provider="none",
                    fallback_model="none",
                    message=f"{tier_display[tier]} is set to {config.provider.title()} but no API key is configured. No fallback available - please configure at least one API key."
                ))
    
    return ValidationResponse(
        warnings=warnings,
        configured_providers=configured
    )
