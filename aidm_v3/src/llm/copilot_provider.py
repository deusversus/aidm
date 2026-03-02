"""GitHub Copilot LLM provider.

Uses GitHub Copilot's OpenAI-compatible API endpoint. Handles the two-token
dance automatically:
  1. GitHub OAuth token  (long-lived, stored encrypted in settings)
  2. Copilot session token  (expires ~1 h, refreshed transparently)

The Copilot API is wire-compatible with OpenAI's Chat Completions API, so
this class simply subclasses OpenAIProvider and overrides:
  - _ensure_client()  — refresh the session token when needed, then init client
  - _init_client()    — point the OpenAI client at the Copilot base URL
  - get_*_model()     — return Copilot-appropriate defaults
"""

import json
import logging
import time
import urllib.error
import urllib.request

from .openai_provider import OpenAIProvider

logger = logging.getLogger(__name__)

# Copilot API endpoints
_COPILOT_CHAT_URL = "https://api.githubcopilot.com"
_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"

# Use the VSCode Copilot extension identity so GitHub recognises the request
_EDITOR_VERSION = "vscode/1.95.3"
_EDITOR_PLUGIN_VERSION = "copilot/1.246.0"
_USER_AGENT = "GitHubCopilotChat/0.22.4"

# Copilot-specific headers required on every API call
_COPILOT_HEADERS = {
    "Editor-Version": _EDITOR_VERSION,
    "Editor-Plugin-Version": _EDITOR_PLUGIN_VERSION,
    "Copilot-Integration-Id": "vscode-chat",
}


class CopilotProvider(OpenAIProvider):
    """GitHub Copilot provider — uses your Copilot Pro/Business subscription."""

    def __init__(self, github_token: str):
        """Initialize with a GitHub OAuth token.

        Args:
            github_token: The GitHub OAuth token obtained via the device flow.
                          Stored in settings as api_keys.copilot_github_token.
        """
        # Pass the GitHub token as 'api_key' so the base class stores it.
        # We never actually use it as an OpenAI key — see _ensure_client().
        super().__init__(api_key=github_token)
        self._copilot_token: str | None = None
        self._token_expires_at: float = 0.0

    # ── Provider identity ──────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "copilot"

    def get_default_model(self) -> str:
        return "gpt-4.1"

    def get_fast_model(self) -> str:
        return "gpt-4o-mini"

    def get_creative_model(self) -> str:
        return "gpt-4.1"

    def get_research_model(self) -> str:
        return "gpt-4.1"

    def get_fallback_model(self) -> str:
        return "gpt-4o"

    # ── Token management ───────────────────────────────────────────────────

    def _ensure_client(self):
        """Override: refresh the Copilot session token if needed, then (re)init client."""
        needs_refresh = (
            self._copilot_token is None
            or time.time() >= self._token_expires_at - 60  # 60 s buffer
        )
        if needs_refresh:
            self._refresh_copilot_token()
            self._client = None  # force client reinit with new token

        if self._client is None:
            self._init_client()

    def _refresh_copilot_token(self):
        """Synchronously exchange the GitHub OAuth token for a Copilot session token."""
        req = urllib.request.Request(
            _COPILOT_TOKEN_URL,
            headers={
                "Authorization": f"token {self.api_key}",
                "Editor-Version": _EDITOR_VERSION,
                "Editor-Plugin-Version": _EDITOR_PLUGIN_VERSION,
                "User-Agent": _USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"Failed to obtain Copilot session token (HTTP {exc.code}). "
                "Check that your GitHub Copilot subscription is active."
            ) from exc

        self._copilot_token = data["token"]

        # expires_at is an ISO-8601 string: "2025-01-01T12:00:00Z"
        expires_str = data.get("expires_at", "")
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(expires_str.replace("Z", "+00:00"))
            self._token_expires_at = dt.timestamp()
        except Exception:
            self._token_expires_at = time.time() + 3600  # fallback: 1 hour

        logger.debug(f"[copilot] Session token refreshed, expires at {expires_str}")

    def _init_client(self):
        """Initialize the OpenAI client pointed at the Copilot API with Copilot headers."""
        import openai

        self._client = openai.OpenAI(
            api_key=self._copilot_token,
            base_url=_COPILOT_CHAT_URL,
            default_headers=_COPILOT_HEADERS,
        )

    # ── Model list helper (used by auth endpoint) ──────────────────────────

    @classmethod
    def fetch_models(cls, github_token: str) -> list[dict]:
        """Fetch the live model list from the Copilot API.

        Called once after successful auth to populate the cached model list.

        Args:
            github_token: Valid GitHub OAuth token.

        Returns:
            List of model dicts: {id, name, tier, description}
        """
        # Step 1: Exchange GitHub OAuth token for a short-lived Copilot session token
        req = urllib.request.Request(
            _COPILOT_TOKEN_URL,
            headers={
                "Authorization": f"token {github_token}",
                "Editor-Version": _EDITOR_VERSION,
                "Editor-Plugin-Version": _EDITOR_PLUGIN_VERSION,
                "User-Agent": _USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                token_data = json.loads(response.read())
        except Exception as exc:
            logger.warning(f"[copilot] Could not fetch session token for model list: {exc}")
            return []

        copilot_token = token_data.get("token", "")
        if not copilot_token:
            logger.warning("[copilot] Session token response missing 'token' field")
            return []

        # Step 2: Fetch models — try both path conventions used by the Copilot API
        common_headers = {
            "Authorization": f"Bearer {copilot_token}",
            **_COPILOT_HEADERS,
            "User-Agent": _USER_AGENT,
        }
        for path in ("/models", "/v1/models"):
            url = f"{_COPILOT_CHAT_URL}{path}"
            models_req = urllib.request.Request(url, headers=common_headers)
            try:
                with urllib.request.urlopen(models_req, timeout=10) as response:
                    models_data = json.loads(response.read())
                result = cls._parse_models(models_data)
                logger.info(f"[copilot] Fetched {len(result)} models from {url}")
                if result:
                    return result
            except Exception as exc:
                logger.warning(f"[copilot] Could not fetch models from {url}: {exc}")

        return []

    @staticmethod
    def _parse_models(data: dict) -> list[dict]:
        """Convert Copilot models API response to our standard format."""
        result = []
        for item in data.get("data", []):
            model_id = item.get("id", "")
            if not model_id:
                continue

            # Infer tier from model name patterns
            low = model_id.lower()
            if any(k in low for k in ("mini", "flash", "haiku", "nano")):
                tier = "fast"
            elif any(k in low for k in ("o1", "o3", "o4", "reasoning")):
                tier = "thinking"
            else:
                tier = "creative"

            # Human-friendly name
            name = item.get("name") or model_id

            result.append({
                "id": model_id,
                "name": name,
                "tier": tier,
                "description": f"{name} via GitHub Copilot",
            })

        # Sort: fast first, then creative, then thinking
        tier_order = {"fast": 0, "creative": 1, "thinking": 2}
        result.sort(key=lambda m: (tier_order.get(m["tier"], 9), m["id"]))
        return result
