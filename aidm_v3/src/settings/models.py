"""Pydantic models for user settings."""

from typing import Literal, Optional
from pydantic import BaseModel, Field


ProviderType = Literal["google", "anthropic", "openai"]


class ModelConfig(BaseModel):
    """Configuration for a single model selection."""
    
    provider: ProviderType = Field(
        description="The LLM provider (google, anthropic, or openai)"
    )
    model: str = Field(
        description="The specific model name (e.g., 'gemini-3-flash-preview')"
    )


class AgentSettings(BaseModel):
    """Per-agent model configuration.
    
    Allows users to select different providers/models for each agent
    based on their preferences for quality, speed, and cost.
    
    Agent Tiers:
    - FAST: intent_classifier, outcome_judge, validator, memory_ranker, 
      combat, progression, scale_selector, relationship_analyzer,
      session_zero, world_builder, compactor, scope, pacing, recap,
      wiki_scout, production
    - THINKING: director, research, profile_merge
    - CREATIVE: key_animator (prose generation)
    
    The 'base_fast', 'base_thinking', and 'base_creative' fields serve as 
    fallbacks when an agent is not explicitly configured.
    """
    
    # === BASE DEFAULTS (Fallback for unconfigured agents) ===
    base_fast: Optional[ModelConfig] = Field(
        default=None,
        description="Default model for fast-tier agents when not explicitly configured"
    )
    base_thinking: Optional[ModelConfig] = Field(
        default=None,
        description="Default model for thinking-tier agents (director, research)"
    )
    base_creative: Optional[ModelConfig] = Field(
        default=None,
        description="Default model for creative-tier agents (key_animator) - prose generation"
    )
    
    # === CORE AGENTS (Phase 1) ===
    intent_classifier: Optional[ModelConfig] = Field(
        default=None,
        description="Model for parsing player actions (fast model preferred)"
    )
    outcome_judge: Optional[ModelConfig] = Field(
        default=None,
        description="Model for determining success/failure (fast model preferred)"
    )
    key_animator: Optional[ModelConfig] = Field(
        default=None,
        description="Model for narrative generation (creative model preferred)"
    )
    
    # === VALIDATION & MEMORY (Phase 2) ===
    validator: Optional[ModelConfig] = Field(
        default=None,
        description="Model for output validation and error handling (fast model preferred)"
    )
    memory_ranker: Optional[ModelConfig] = Field(
        default=None,
        description="Model for memory relevance scoring (fast model preferred)"
    )
    context_selector: Optional[ModelConfig] = Field(
        default=None,
        description="RESERVED: ContextSelector is not a BaseAgent and does not use this field"
    )
    
    # === JUDGMENT AGENTS (Phase 3) ===
    combat: Optional[ModelConfig] = Field(
        default=None,
        description="Model for combat resolution (balanced model preferred)"
    )
    progression: Optional[ModelConfig] = Field(
        default=None,
        description="Model for XP/leveling decisions (balanced model preferred)"
    )
    scale_selector: Optional[ModelConfig] = Field(
        default=None,
        description="Model for narrative scale selection (fast model preferred)"
    )
    # === MEMORY & COMPRESSION ===
    compactor: Optional[ModelConfig] = Field(
        default=None,
        description="Model for memory compaction (fast model preferred)"
    )
    
    # === RESEARCH SUPPORT ===
    scope: Optional[ModelConfig] = Field(
        default=None,
        description="Model for series scope/complexity detection (fast model preferred)"
    )
    profile_merge: Optional[ModelConfig] = Field(
        default=None,
        description="Model for multi-source profile merging (thinking model preferred)"
    )
    
    # === DIRECTOR LAYER (Phase 4) ===
    director: Optional[ModelConfig] = Field(
        default=None,
        description="Model for campaign planning (creative model, extended thinking)"
    )
    
    # === RESEARCH (Phase 4.5) ===
    research: Optional[ModelConfig] = Field(
        default=None,
        description="Model for anime research with web search (uses native search grounding)"
    )
    
    # === NPC INTELLIGENCE (Phase 5) ===
    relationship_analyzer: Optional[ModelConfig] = Field(
        default=None,
        description="Model for NPC relationship analysis (fast model preferred)"
    )
    
    # === SESSION ZERO (Character Creation) ===
    session_zero: Optional[ModelConfig] = Field(
        default=None,
        description="Model for character creation dialogue (fast model preferred)"
    )
    
    # === WORLD BUILDING (Entity Extraction & Validation) ===
    world_builder: Optional[ModelConfig] = Field(
        default=None,
        description="Model for validating player world-building assertions (fast model preferred)"
    )

    # === NARRATIVE PACING ===
    pacing: Optional[ModelConfig] = Field(
        default=None,
        description="Model for arc pacing micro-checks (fast model preferred)"
    )
    recap: Optional[ModelConfig] = Field(
        default=None,
        description="Model for 'Previously On' recap generation (fast model preferred)"
    )

    # === WIKI SCRAPING ===
    wiki_scout: Optional[ModelConfig] = Field(
        default=None,
        description="Model for wiki category classification (fast model preferred)"
    )

    # === POST-NARRATIVE PRODUCTION ===
    production: Optional[ModelConfig] = Field(
        default=None,
        description="Model for post-narrative quest tracking and location discovery (fast model preferred)"
    )


class APIKeySettings(BaseModel):
    """API key configuration for LLM providers.
    
    Keys are stored encrypted in settings.json.
    """
    
    google_api_key: str = Field(
        default="",
        description="Google Gemini API key (stored encrypted)"
    )
    anthropic_api_key: str = Field(
        default="",
        description="Anthropic Claude API key (stored encrypted)"
    )
    openai_api_key: str = Field(
        default="",
        description="OpenAI ChatGPT API key (stored encrypted)"
    )


class UserSettings(BaseModel):
    """Complete user settings for AIDM v3."""
    
    # Model configuration per agent
    agent_models: AgentSettings = Field(
        description="Model selection for each agent"
    )
    
    # API keys (stored encrypted)
    api_keys: APIKeySettings = Field(
        default_factory=APIKeySettings,
        description="API keys for LLM providers"
    )
    
    # UI preferences
    debug_mode: bool = Field(
        default=True,
        description="Show agent decisions and timing in the UI"
    )
    
    # Active campaign (for persistence)
    active_campaign_id: Optional[str] = Field(
        default=None,
        description="Currently active campaign ID (matches profile_id for now)"
    )
    
    active_profile_id: Optional[str] = Field(
        default=None,
        description="Currently active narrative profile. Null means not set - triggers Session Zero recovery."
    )
    
    active_session_id: Optional[str] = Field(
        default=None,
        description="Currently active session ID for memory isolation. Set at Session Zero handoff."
    )
    
    # Extended thinking mode
    extended_thinking: bool = Field(
        default=False,
        description="Enable deeper reasoning for complex agents (increases latency and token usage)"
    )
    
    class Config:
        """Pydantic config."""
        json_schema_extra = {
            "example": {
                "agent_models": {
                    "intent_classifier": {
                        "provider": "google",
                        "model": "gemini-3-flash-preview"
                    },
                    "outcome_judge": {
                        "provider": "google", 
                        "model": "gemini-3-flash-preview"
                    },
                    "key_animator": {
                        "provider": "anthropic",
                        "model": "claude-opus-4-6"
                    },
                    "director": {
                        "provider": "google",
                        "model": "gemini-3-pro-preview"
                    },
                    "research": {
                        "provider": "google",
                        "model": "gemini-3-pro-preview"
                    }
                },
                "api_keys": {
                    "google_api_key": "",
                    "anthropic_api_key": "",
                    "openai_api_key": ""
                },
                "debug_mode": True,
                "active_profile_id": None  # Set by Session Zero
            }
        }
