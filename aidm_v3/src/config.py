"""Configuration management for AIDM v3."""

import os
from pathlib import Path

from dotenv import load_dotenv


# Load environment variables from .env file
def _find_env_file() -> Path | None:
    """Find the .env file, searching up the directory tree."""
    current = Path(__file__).parent
    for _ in range(5):  # Search up to 5 levels
        env_path = current / ".env"
        if env_path.exists():
            return env_path
        current = current.parent
    return None


_env_file = _find_env_file()
if _env_file:
    load_dotenv(_env_file)


class Config:
    """Application configuration from environment variables."""

    # LLM Provider Selection
    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "")  # Empty = auto-detect

    # LLM API Keys
    GOOGLE_API_KEY: str = os.getenv("GOOGLE_API_KEY", "")
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")

    # Model Overrides (optional)
    FAST_MODEL: str = os.getenv("FAST_MODEL", "")
    CREATIVE_MODEL: str = os.getenv("CREATIVE_MODEL", "")

    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./aidm_v3.db")

    # Debug
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"
    LOG_AGENT_DECISIONS: bool = os.getenv("LOG_AGENT_DECISIONS", "false").lower() == "true"

    @classmethod
    def validate(cls) -> list[str]:
        """Validate configuration, return list of issues."""
        issues = []

        # Check for at least one API key
        if not any([cls.GOOGLE_API_KEY, cls.ANTHROPIC_API_KEY, cls.OPENAI_API_KEY]):
            issues.append(
                "No LLM API keys configured. "
                "Set GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY in .env"
            )

        return issues

    @classmethod
    def get_available_providers(cls) -> list[str]:
        """Get list of providers with configured API keys."""
        providers = []
        if cls.GOOGLE_API_KEY:
            providers.append("google")
        if cls.ANTHROPIC_API_KEY:
            providers.append("anthropic")
        if cls.OPENAI_API_KEY:
            providers.append("openai")
        return providers

    @classmethod
    def get_primary_provider(cls) -> str:
        """Get the primary provider name."""
        if cls.LLM_PROVIDER:
            return cls.LLM_PROVIDER.lower()
        # Auto-detect based on available keys (prefer Google for affordability)
        if cls.GOOGLE_API_KEY:
            return "google"
        if cls.ANTHROPIC_API_KEY:
            return "anthropic"
        if cls.OPENAI_API_KEY:
            return "openai"
        return "none"

    @classmethod
    def is_debug(cls) -> bool:
        """Check if debug mode is enabled."""
        return cls.DEBUG

    @classmethod
    def get_database_url(cls) -> str:
        """Get the database URL."""
        return cls.DATABASE_URL


# Singleton config instance
config = Config()
