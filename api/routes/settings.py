"""Settings API routes."""

import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from src.settings import (
    AgentSettings,
    ModelConfig,
    UserSettings,
    get_settings_store,
)
from src.settings.defaults import get_available_models

router = APIRouter()

# GitHub Copilot OAuth device-flow constants
_GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"  # VSCode Copilot extension client ID
_GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"
_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"

# In-memory auth state (fine for single-user local app)
_copilot_auth_state: dict = {}


class ModelInfo(BaseModel):
    """Information about a single model."""
    id: str
    name: str
    tier: str
    description: str


class ModelsResponse(BaseModel):
    """Response for available models endpoint."""
    models: dict[str, list[ModelInfo]]


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
    copilot: APIKeyStatus


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
    # Copilot token is never sent by the frontend — always preserve it
    if not settings.api_keys.copilot_github_token:
        settings.api_keys.copilot_github_token = current.api_keys.copilot_github_token
    # Anthropic OAuth tokens — never sent by frontend, always preserve
    if not settings.api_keys.anthropic_oauth_token:
        settings.api_keys.anthropic_oauth_token = current.api_keys.anthropic_oauth_token
    if not settings.api_keys.anthropic_refresh_token:
        settings.api_keys.anthropic_refresh_token = current.api_keys.anthropic_refresh_token
    if settings.api_keys.anthropic_oauth_expires_at == 0.0:
        settings.api_keys.anthropic_oauth_expires_at = current.api_keys.anthropic_oauth_expires_at

    # Preserve the cached Copilot model list — it's populated by the background
    # fetch after auth and should never be cleared by a plain settings save
    if not settings.copilot_models and current.copilot_models:
        settings.copilot_models = current.copilot_models

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
    from api.routes.game import reset_orchestrator, reset_session_zero_agent
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
        # Session Zero Compiler
        "sz_extractor", "sz_gap_analyzer", "sz_entity_resolver", "sz_handoff",
        # Narrative Pacing
        "pacing", "recap",
        # Memory & Compression
        "compactor",
        # Post-Narrative Production
        "production",
        "beat_extractor",
        # Intent Resolution
        "intent_resolution",
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
async def get_models(provider: str | None = None):
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
        copilot=APIKeyStatus(configured=configured["copilot"], masked=masked["copilot"]),
    )


@router.put("/keys/{provider}")
async def set_api_key(provider: str, request: APIKeyRequest):
    """Set an API key for a provider.

    Args:
        provider: One of 'google', 'anthropic', 'openai'
        request: The API key to set
    """
    valid_providers = ["google", "anthropic", "openai"]  # copilot goes through /copilot/auth
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
    from api.routes.game import reset_orchestrator, reset_session_zero_agent
    reset_session_zero_agent()
    reset_orchestrator()

    return {"status": "ok", "provider": provider}


@router.delete("/keys/{provider}")
async def delete_api_key(provider: str):
    """Remove an API key for a provider.

    Args:
        provider: One of 'google', 'anthropic', 'openai'
    """
    valid_providers = ["google", "anthropic", "openai"]  # copilot: use DELETE /copilot/auth
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
    warnings: list[ProviderWarning]
    configured_providers: dict[str, bool]


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


# ── GitHub Copilot OAuth device flow ─────────────────────────────────────────

class CopilotAuthStartResponse(BaseModel):
    """Response from the start-auth endpoint."""
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int


class CopilotAuthStatusResponse(BaseModel):
    """Response from the poll-auth endpoint."""
    status: str  # "pending" | "complete" | "expired" | "error" | "not_started"
    message: str = ""
    next_interval: int | None = None  # seconds — set when GitHub says slow_down


@router.post("/copilot/auth/start", response_model=CopilotAuthStartResponse)
async def start_copilot_auth():
    """Initiate GitHub device OAuth flow for Copilot access.

    Returns a one-time user_code + URL the user must visit to authorize.
    Poll GET /copilot/auth/status until status == 'complete'.
    """
    import httpx

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _GITHUB_DEVICE_CODE_URL,
            data={"client_id": _GITHUB_CLIENT_ID, "scope": ""},
            headers={"Accept": "application/json"},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"GitHub device flow failed: {resp.text}")
        data = resp.json()

    _copilot_auth_state.clear()
    _copilot_auth_state.update({
        "device_code": data["device_code"],
        "interval": data.get("interval", 5),
        "started_at": time.time(),
        "expires_in": data.get("expires_in", 900),
    })

    return CopilotAuthStartResponse(
        user_code=data["user_code"],
        verification_uri=data.get("verification_uri", "https://github.com/login/device"),
        expires_in=data.get("expires_in", 900),
        interval=data.get("interval", 5),
    )


@router.get("/copilot/auth/status", response_model=CopilotAuthStatusResponse)
async def poll_copilot_auth():
    """Poll GitHub for Copilot OAuth completion.

    Returns:
        status = 'pending'   — user hasn't authorized yet, keep polling
        status = 'complete'  — success, GitHub token stored, models cached
        status = 'expired'   — code expired, restart the flow
        status = 'error'     — unexpected error
        status = 'not_started' — call /start first
    """
    device_code = _copilot_auth_state.get("device_code")
    if not device_code:
        return CopilotAuthStatusResponse(status="not_started")

    # Check expiry
    started_at = _copilot_auth_state.get("started_at", 0)
    expires_in = _copilot_auth_state.get("expires_in", 900)
    if time.time() - started_at > expires_in:
        _copilot_auth_state.clear()
        return CopilotAuthStatusResponse(status="expired", message="Authorization code expired. Please start over.")

    import httpx

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _GITHUB_TOKEN_URL,
            data={
                "client_id": _GITHUB_CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers={"Accept": "application/json"},
        )
        if resp.status_code != 200:
            return CopilotAuthStatusResponse(status="error", message=f"GitHub error: {resp.text}")
        data = resp.json()

    error = data.get("error", "")
    logger.info(f"[copilot] Poll response: status={resp.status_code} error={error!r} keys={list(data.keys())}")
    if error == "authorization_pending":
        return CopilotAuthStatusResponse(status="pending")
    if error == "slow_down":
        # GitHub requires us to back off — return the new interval so the
        # frontend can slow its polling rate accordingly
        new_interval = data.get("interval", 10)
        logger.info(f"[copilot] slow_down received — new interval: {new_interval}s")
        return CopilotAuthStatusResponse(status="pending", next_interval=new_interval)
    if error == "expired_token":
        _copilot_auth_state.clear()
        return CopilotAuthStatusResponse(status="expired", message="Authorization code expired. Please start over.")
    if error:
        return CopilotAuthStatusResponse(
            status="error",
            message=data.get("error_description", error)
        )

    # Success — we have a GitHub OAuth token
    github_token = data.get("access_token", "")
    if not github_token:
        return CopilotAuthStatusResponse(status="error", message="No access token in GitHub response.")

    logger.info("[copilot] OAuth complete — storing token")

    # Persist the token (encrypted) and clear auth state immediately
    store = get_settings_store()
    store.set_api_key("copilot", github_token)

    # Store expiry time so we can warn the user before it expires.
    # expires_in is seconds until the GitHub OAuth token expires.
    # 0 / absent means GitHub issued a non-expiring token (classic OAuth Apps).
    expires_in = data.get("expires_in", 0)
    expires_at = (time.time() + expires_in) if expires_in else 0.0
    store.set_copilot_token_expiry(expires_at)
    if expires_in:
        logger.info(f"[copilot] GitHub OAuth token expires in {expires_in}s ({expires_in/3600:.1f}h)")
    else:
        logger.info("[copilot] GitHub OAuth token is non-expiring")

    _copilot_auth_state.clear()

    # Reset LLM manager + agents so they pick up the new provider right away
    from src.llm import reset_llm_manager
    reset_llm_manager()
    from api.routes.game import reset_orchestrator, reset_session_zero_agent
    reset_session_zero_agent()
    reset_orchestrator()

    # Kick off model-list fetch in the background — do NOT block auth completion.
    # fetch_models() makes two outbound HTTP calls that can be slow; if we await
    # them here the frontend poll never gets a "complete" response.
    import asyncio
    from src.llm.copilot_provider import CopilotProvider

    async def _bg_fetch():
        try:
            loop = asyncio.get_running_loop()
            models = await asyncio.wait_for(
                loop.run_in_executor(None, lambda: CopilotProvider.fetch_models(github_token)),
                timeout=20.0,
            )
            if models:
                store.set_copilot_models(models)
                logger.info(f"[copilot] Cached {len(models)} models from API")
        except Exception as exc:
            logger.warning(f"[copilot] Background model fetch failed (non-fatal): {exc}")

    asyncio.create_task(_bg_fetch())

    return CopilotAuthStatusResponse(status="complete")


class CopilotStatusResponse(BaseModel):
    """Copilot connection health."""
    configured: bool
    expires_at: float  # 0 = non-expiring / unknown
    remaining_seconds: float | None  # None if no expiry stored
    is_expired: bool
    is_expiring_soon: bool  # < 2 hours remaining


@router.get("/copilot/status", response_model=CopilotStatusResponse)
async def get_copilot_status():
    """Return GitHub Copilot connection health including OAuth token expiry.

    Clients can poll this (e.g. on settings-page open) to show a proactive
    re-auth warning before the token expires mid-session.
    """
    store = get_settings_store()
    is_configured = store.get_configured_providers().get("copilot", False)
    expires_at = store.get_copilot_token_expiry()

    now = time.time()
    if expires_at > 0:
        remaining = expires_at - now
        is_expired = remaining <= 0
        is_expiring_soon = not is_expired and remaining < 7200  # warn < 2h
    else:
        remaining = None
        is_expired = False
        is_expiring_soon = False

    return CopilotStatusResponse(
        configured=is_configured,
        expires_at=expires_at,
        remaining_seconds=remaining,
        is_expired=is_expired,
        is_expiring_soon=is_expiring_soon,
    )


@router.delete("/copilot/auth", response_model=CopilotAuthStatusResponse)
async def disconnect_copilot():
    """Disconnect GitHub Copilot — clears the stored token."""
    _copilot_auth_state.clear()

    store = get_settings_store()
    store.set_api_key("copilot", "")
    store.set_copilot_models([])
    store.set_copilot_token_expiry(0.0)

    from src.llm import reset_llm_manager
    reset_llm_manager()
    from api.routes.game import reset_orchestrator, reset_session_zero_agent
    reset_session_zero_agent()
    reset_orchestrator()

    return CopilotAuthStatusResponse(status="ok")


# ── Anthropic OAuth (PKCE Authorization Code flow) ────────────────────────────

import base64
import hashlib
import secrets
import urllib.parse

_ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
_ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
_ANTHROPIC_AUTH_URL = "https://claude.ai/oauth/authorize"
_ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"

# In-memory state for the PKCE flow (single-user local app)
_anthropic_auth_state: dict[str, str] = {}


class AnthropicAuthStartResponse(BaseModel):
    """Response from Anthropic auth/start."""
    auth_url: str
    state: str


class AnthropicAuthCallbackRequest(BaseModel):
    """Request body for Anthropic auth/callback."""
    code: str
    state: str


class AnthropicAuthStatusResponse(BaseModel):
    """Response from Anthropic auth status/disconnect."""
    status: str
    message: str = ""
    is_configured: bool = False
    expires_at: float = 0.0
    remaining_seconds: float = 0.0
    is_expired: bool = False
    is_expiring_soon: bool = False


@router.post("/anthropic/auth/start", response_model=AnthropicAuthStartResponse)
async def start_anthropic_auth():
    """Initiate Anthropic OAuth PKCE flow.

    Generates a PKCE code verifier/challenge and returns the authorization URL.
    The user opens this URL in their browser, authorizes, and pastes the
    resulting code back via /anthropic/auth/callback.
    """
    # Generate PKCE pair
    code_verifier = secrets.token_urlsafe(64)  # 86 chars, well within 43-128 range
    code_challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    state = secrets.token_urlsafe(32)

    # Store for callback validation
    _anthropic_auth_state.clear()
    _anthropic_auth_state["code_verifier"] = code_verifier
    _anthropic_auth_state["state"] = state

    # Build authorization URL
    params = {
        "response_type": "code",
        "client_id": _ANTHROPIC_CLIENT_ID,
        "redirect_uri": _ANTHROPIC_REDIRECT_URI,
        "scope": "user:profile user:inference",
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
        "code": "true",
    }
    auth_url = f"{_ANTHROPIC_AUTH_URL}?{urllib.parse.urlencode(params)}"

    return AnthropicAuthStartResponse(auth_url=auth_url, state=state)


@router.post("/anthropic/auth/callback")
async def anthropic_auth_callback(request: AnthropicAuthCallbackRequest):
    """Exchange authorization code for OAuth tokens.

    Called after the user authorizes in the browser and pastes the code.
    """
    import httpx

    # Validate state
    stored_state = _anthropic_auth_state.get("state")
    code_verifier = _anthropic_auth_state.get("code_verifier")

    if not stored_state or not code_verifier:
        raise HTTPException(
            status_code=400,
            detail="No pending OAuth flow. Start a new flow via /anthropic/auth/start.",
        )

    # The callback page may return code as "code#state" — split if needed
    raw_code = request.code.strip()
    if "#" in raw_code:
        auth_code, callback_state = raw_code.split("#", 1)
    else:
        auth_code = raw_code
        callback_state = request.state

    if callback_state != stored_state:
        raise HTTPException(status_code=400, detail="State mismatch — possible CSRF. Try again.")

    # Exchange code for tokens
    try:
        payload = {
            "grant_type": "authorization_code",
            "code": auth_code,
            "state": stored_state,
            "code_verifier": code_verifier,
            "client_id": _ANTHROPIC_CLIENT_ID,
            "redirect_uri": _ANTHROPIC_REDIRECT_URI,
        }

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                _ANTHROPIC_TOKEN_URL,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        detail = f"Token exchange failed (HTTP {exc.response.status_code})"
        try:
            err_body = exc.response.json()
            detail += f": {err_body}"
        except Exception:
            detail += f": {exc.response.text[:300]}"
        raise HTTPException(status_code=400, detail=detail)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Token exchange error: {exc}")

    access_token = data.get("access_token", "")
    refresh_token = data.get("refresh_token", "")
    expires_in = data.get("expires_in", 3600)

    if not access_token:
        raise HTTPException(status_code=400, detail="No access_token in response")

    import time
    expires_at = time.time() + expires_in

    # Store tokens
    store = get_settings_store()
    store.set_anthropic_oauth(access_token, refresh_token, expires_at)

    # Clear auth state
    _anthropic_auth_state.clear()

    # Reset LLM manager to pick up new auth
    from src.llm import reset_llm_manager
    reset_llm_manager()
    from api.routes.game import reset_orchestrator, reset_session_zero_agent
    reset_session_zero_agent()
    reset_orchestrator()

    return {"status": "complete", "expires_in": expires_in}


@router.get("/anthropic/auth/status", response_model=AnthropicAuthStatusResponse)
async def anthropic_auth_status():
    """Check Anthropic OAuth connection health."""
    import time

    store = get_settings_store()
    access, refresh, expires_at = store.get_anthropic_oauth()

    is_configured = bool(access)
    remaining = max(0, expires_at - time.time()) if expires_at > 0 else 0

    return AnthropicAuthStatusResponse(
        status="connected" if is_configured else "disconnected",
        is_configured=is_configured,
        expires_at=expires_at,
        remaining_seconds=remaining,
        is_expired=is_configured and expires_at > 0 and remaining <= 0,
        is_expiring_soon=is_configured and 0 < remaining < 7200,  # < 2 hours
    )


@router.delete("/anthropic/auth", response_model=AnthropicAuthStatusResponse)
async def disconnect_anthropic_oauth():
    """Disconnect Anthropic OAuth — clears stored tokens."""
    _anthropic_auth_state.clear()

    store = get_settings_store()
    store.clear_anthropic_oauth()

    from src.llm import reset_llm_manager
    reset_llm_manager()
    from api.routes.game import reset_orchestrator, reset_session_zero_agent
    reset_session_zero_agent()
    reset_orchestrator()

    return AnthropicAuthStatusResponse(status="ok")
