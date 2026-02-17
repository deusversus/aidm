"""Settings persistence store with encrypted API key support."""

import json
import os
from pathlib import Path
from typing import Optional, Tuple, Dict

from .models import UserSettings, APIKeySettings
from .defaults import DEFAULT_SETTINGS
from .crypto import encrypt_api_key, decrypt_api_key, mask_api_key, is_key_configured


import logging

logger = logging.getLogger(__name__)

class SettingsStore:
    """Persists user settings to JSON file.
    
    Settings are stored in the project root as 'settings.json'.
    API keys are encrypted before storage and decrypted on load.
    """
    
    def __init__(self, settings_path: Optional[Path] = None):
        """Initialize the settings store.
        
        Args:
            settings_path: Path to settings file. Defaults to project root.
        """
        if settings_path:
            self._path = settings_path
        else:
            # Default to project root
            self._path = Path(__file__).parent.parent.parent / "settings.json"
        
        self._settings: Optional[UserSettings] = None
    
    def load(self) -> UserSettings:
        """Load settings from file, or return defaults.
        
        Returns:
            UserSettings instance
        """
        if self._settings is not None:
            return self._settings
        
        if self._path.exists():
            try:
                with open(self._path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                self._settings = UserSettings.model_validate(data)
            except (json.JSONDecodeError, Exception) as e:
                logger.warning(f"Warning: Could not load settings: {e}")
                self._settings = DEFAULT_SETTINGS.model_copy()
        else:
            self._settings = DEFAULT_SETTINGS.model_copy()
        
        return self._settings
    
    def reload(self) -> UserSettings:
        """Force reload settings from disk, bypassing the cache.
        
        Use this when settings may have been updated by another endpoint
        and you need the latest values (e.g., after Session Zero handoff).
        
        Returns:
            Fresh UserSettings from disk
        """
        self._settings = None  # Clear cache
        return self.load()     # Re-read from disk
    
    def save(self, settings: Optional[UserSettings] = None) -> None:
        """Save settings to file.
        
        Args:
            settings: Settings to save. If None, saves current settings.
        """
        if settings:
            self._settings = settings
        
        if self._settings is None:
            self._settings = DEFAULT_SETTINGS.model_copy()
        
        with open(self._path, 'w', encoding='utf-8') as f:
            json.dump(self._settings.model_dump(), f, indent=2)
    
    def update(self, **kwargs) -> UserSettings:
        """Update specific settings fields.
        
        Args:
            **kwargs: Fields to update
            
        Returns:
            Updated UserSettings
        """
        current = self.load()
        updated_data = current.model_dump()
        
        for key, value in kwargs.items():
            if key in updated_data:
                updated_data[key] = value
        
        self._settings = UserSettings.model_validate(updated_data)
        self.save()
        return self._settings
    
    def reset(self) -> UserSettings:
        """Reset model settings to defaults, preserving API keys and campaign state.
        
        Only resets agent_models (base configs to Google Flash, per-agent to None).
        Preserves: api_keys, active_profile_id, active_campaign_id, debug_mode.
        
        Returns:
            Updated UserSettings
        """
        # Use reload() to get fresh settings from disk
        current = self.reload()
        
        # Preserve these fields
        preserved_api_keys = current.api_keys
        preserved_profile_id = current.active_profile_id
        preserved_campaign_id = current.active_campaign_id
        
        # Reset agent models to defaults (Google Flash for all base configs)
        from .defaults import DEFAULT_SETTINGS
        from .models import AgentSettings, ModelConfig
        
        # Create fresh agent settings with Google Flash for all 3 base configs
        default_flash = ModelConfig(provider="google", model="gemini-3-flash-preview")
        fresh_agent_models = AgentSettings(
            base_fast=default_flash,
            base_thinking=default_flash,
            base_creative=default_flash,
            # All per-agent configs reset to None (use base defaults)
        )
        
        # Apply reset with preserved fields
        self._settings = current.model_copy(update={
            "agent_models": fresh_agent_models,
            "api_keys": preserved_api_keys,
            "active_profile_id": preserved_profile_id,
            "active_campaign_id": preserved_campaign_id,
            "extended_thinking": False,  # Reset this preference
        })
        self.save()
        return self._settings
    
    def get_agent_model(self, agent_name: str) -> Tuple[str, str]:
        """Get the provider and model for a specific agent.
        
        Uses 3-tier fallback:
        1. Agent's explicit config (if set)
        2. Tier-based fallback: base_fast, base_thinking, or base_creative
        3. Hardcoded last resort: google/gemini-3-flash-preview
        
        Args:
            agent_name: Name of the agent
            
        Returns:
            Tuple of (provider, model)
        """
        settings = self.load()
        agent_models = settings.agent_models
        
        # Try agent-specific config first
        config = getattr(agent_models, agent_name, None)
        if config:
            return config.provider, config.model
        
        # Determine agent tier for fallback
        fast_tier_agents = {
            "intent_classifier", "outcome_judge", "validator", "memory_ranker",
            "combat", "progression", "scale_selector",
            "relationship_analyzer", "session_zero", "world_builder",
            "wiki_scout", "compactor", "scope", "pacing", "recap",
            "production",
        }
        creative_tier_agents = {"key_animator"}  # Prose generation
        thinking_tier_agents = {"director", "research", "profile_merge"}  # Reasoning/planning
        
        if agent_name in fast_tier_agents:
            base_config = getattr(agent_models, "base_fast", None)
        elif agent_name in creative_tier_agents:
            base_config = getattr(agent_models, "base_creative", None)
        elif agent_name in thinking_tier_agents:
            base_config = getattr(agent_models, "base_thinking", None)
        else:
            # Unknown agent - fall back to thinking tier as safest default
            base_config = getattr(agent_models, "base_thinking", None)
        
        if base_config:
            return base_config.provider, base_config.model
        
        # Last resort fallback
        return "google", "gemini-3-flash-preview"
    
    # API Key Management
    
    def set_api_key(self, provider: str, key: str) -> None:
        """Set an API key for a provider (will be encrypted).
        
        Args:
            provider: One of 'google', 'anthropic', 'openai'
            key: The plain API key
        """
        settings = self.load()
        
        # Encrypt the key before storage
        encrypted = encrypt_api_key(key) if key else ""
        
        # Update the appropriate key
        if provider == "google":
            settings.api_keys.google_api_key = encrypted
        elif provider == "anthropic":
            settings.api_keys.anthropic_api_key = encrypted
        elif provider == "openai":
            settings.api_keys.openai_api_key = encrypted
        else:
            raise ValueError(f"Unknown provider: {provider}")
        
        self.save()
        # Clear cache so LLM manager reloads
        self._settings = None
    
    def get_api_key(self, provider: str) -> str:
        """Get a decrypted API key for a provider.
        
        Args:
            provider: One of 'google', 'anthropic', 'openai'
            
        Returns:
            Decrypted API key or empty string
        """
        settings = self.load()
        
        encrypted = ""
        if provider == "google":
            encrypted = settings.api_keys.google_api_key
        elif provider == "anthropic":
            encrypted = settings.api_keys.anthropic_api_key
        elif provider == "openai":
            encrypted = settings.api_keys.openai_api_key
        
        if not encrypted:
            # Fallback to environment variable
            env_var = f"{provider.upper()}_API_KEY"
            return os.getenv(env_var, "")
        
        try:
            return decrypt_api_key(encrypted)
        except Exception:
            return ""
    
    def get_masked_keys(self) -> Dict[str, str]:
        """Get masked versions of all API keys for display.
        
        Returns:
            Dict of provider -> masked key
        """
        settings = self.load()
        
        return {
            "google": mask_api_key(settings.api_keys.google_api_key),
            "anthropic": mask_api_key(settings.api_keys.anthropic_api_key),
            "openai": mask_api_key(settings.api_keys.openai_api_key),
        }
    
    def get_configured_providers(self) -> Dict[str, bool]:
        """Check which providers have API keys configured.
        
        Returns:
            Dict of provider -> is_configured
        """
        settings = self.load()
        
        return {
            "google": is_key_configured(settings.api_keys.google_api_key) or bool(os.getenv("GOOGLE_API_KEY")),
            "anthropic": is_key_configured(settings.api_keys.anthropic_api_key) or bool(os.getenv("ANTHROPIC_API_KEY")),
            "openai": is_key_configured(settings.api_keys.openai_api_key) or bool(os.getenv("OPENAI_API_KEY")),
        }


# Global store instance
_store: Optional[SettingsStore] = None


def get_settings_store() -> SettingsStore:
    """Get the global settings store instance."""
    global _store
    if _store is None:
        _store = SettingsStore()
    return _store


def reset_settings_store():
    """Reset the global settings store (useful for testing)."""
    global _store
    _store = None
