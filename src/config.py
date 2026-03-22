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
    DATABASE_URL: str = os.getenv("DATABASE_URL", "postgresql://aidm:aidm@localhost:5432/aidm")

    # Debug
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"
    LOG_AGENT_DECISIONS: bool = os.getenv("LOG_AGENT_DECISIONS", "false").lower() == "true"

    # ── Session Zero Compiler feature flags ──────────────────────────────────
    # Enable the HandoffCompiler to run at SZ→gameplay handoff.
    # When False, the legacy _build_session_zero_summary() path is used.
    # REMOVAL CONDITION: Remove once HandoffCompiler is proven stable in
    # production (>50 successful handoffs, zero critical failures). Compiler
    # always runs; remove all `if SESSION_ZERO_COMPILER_ENABLED:` branches.
    SESSION_ZERO_COMPILER_ENABLED: bool = os.getenv("SESSION_ZERO_COMPILER_ENABLED", "false").lower() == "true"

    # Enable the dedicated opening-scene generation path (SZ§12.4).
    # When False, the legacy synthetic-turn path is used.
    # REMOVAL CONDITION: Remove after dedicated path is default for 2+ weeks
    # with zero scene generation failures. The synthetic-turn fallback stays
    # as an error-recovery path, not a feature flag branch.
    SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED: bool = os.getenv("SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED", "false").lower() == "true"

    # Enable the full SZ Orchestrator (M6 — turn-level extraction during SZ).
    # When False, the current monolithic SessionZeroAgent handles all turns.
    # REMOVAL CONDITION: Remove after orchestrator is stable in production.
    # This also gates the removal of detected_info (Phase 6.1) — once this
    # flag is removed, apply_detected_info() and process_session_zero_state()
    # can be replaced by pipeline extraction + memory writes.
    SESSION_ZERO_ORCHESTRATOR_ENABLED: bool = os.getenv("SESSION_ZERO_ORCHESTRATOR_ENABLED", "false").lower() == "true"

    # Enable tool-assisted research (wiki_scout, world_builder) during SZ turns.
    # When False, pipeline relies only on profile context and player input.
    # REMOVAL CONDITION: Opt-in feature. Remove flag when research is proven
    # to always improve SZ quality (measured via handoff compiler gap counts).
    # At that point, research becomes always-on within the orchestrator pipeline.
    SESSION_ZERO_RESEARCH_ENABLED: bool = os.getenv("SESSION_ZERO_RESEARCH_ENABLED", "false").lower() == "true"

    # ── Token Budget / Circuit Breaker ───────────────────────────────────────
    # Per-turn limits to prevent runaway token burn.
    # Env vars serve as fallback; UI settings (settings.json) take priority
    # when accessed via get_turn_limits().
    MAX_TURN_INPUT_TOKENS: int = int(os.getenv("MAX_TURN_INPUT_TOKENS", "500000"))
    MAX_TURN_OUTPUT_TOKENS: int = int(os.getenv("MAX_TURN_OUTPUT_TOKENS", "100000"))
    MAX_TURN_LLM_CALLS: int = int(os.getenv("MAX_TURN_LLM_CALLS", "25"))

    # ── Network Security ─────────────────────────────────────────────────────
    # Bind address for the server (default: localhost only).
    BIND_HOST: str = os.getenv("AIDM_BIND_HOST", "127.0.0.1")

    # Optional API key gate. When set, all /api/* routes require this key.
    # When empty, no auth is enforced (local development default).
    AIDM_API_KEY: str = os.getenv("AIDM_API_KEY", "")

    # CORS allowed origins (comma-separated). Empty = localhost only.
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "")

    # Rate limit: max requests per minute on expensive endpoints.
    RATE_LIMIT_PER_MINUTE: int = int(os.getenv("RATE_LIMIT_PER_MINUTE", "30"))

    @classmethod
    def get_turn_limits(cls) -> tuple[int, int, int]:
        """Get per-turn token budget limits (settings.json > env vars).

        Returns:
            (max_input_tokens, max_output_tokens, max_llm_calls)
        """
        try:
            from .settings import get_settings_store
            s = get_settings_store().load()
            return (
                s.max_turn_input_tokens,
                s.max_turn_output_tokens,
                s.max_turn_llm_calls,
            )
        except Exception:
            return (cls.MAX_TURN_INPUT_TOKENS, cls.MAX_TURN_OUTPUT_TOKENS, cls.MAX_TURN_LLM_CALLS)

    @classmethod
    def get_rate_limit(cls) -> int:
        """Get rate limit per minute (settings.json > env var)."""
        try:
            from .settings import get_settings_store
            return get_settings_store().load().rate_limit_per_minute
        except Exception:
            return cls.RATE_LIMIT_PER_MINUTE

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
