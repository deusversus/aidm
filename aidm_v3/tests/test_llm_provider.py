"""Tests for LLMProvider, LLMResponse, MockLLMProvider, and LLMManager.

Covers the provider abstraction, response dataclass,
retry logic, and manager provider resolution.
"""

import os
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from src.llm.provider import LLMProvider, LLMResponse
from src.llm.manager import LLMManager, reset_llm_manager, get_llm_manager


# ---------------------------------------------------------------------------
# Tests: LLMResponse
# ---------------------------------------------------------------------------

class TestLLMResponse:
    def test_creation_with_defaults(self):
        resp = LLMResponse(content="Hello")
        assert resp.content == "Hello"
        assert resp.model == ""
        assert resp.tool_calls == []
        assert resp.usage == {}
        assert resp.raw_response is None

    def test_creation_with_all_fields(self):
        resp = LLMResponse(
            content="World",
            model="gpt-4",
            tool_calls=[{"name": "test"}],
            usage={"prompt_tokens": 10, "completion_tokens": 5},
            raw_response={"raw": True},
            metadata={"latency_ms": 200},
        )
        assert resp.model == "gpt-4"
        assert len(resp.tool_calls) == 1
        assert resp.usage["prompt_tokens"] == 10
        assert resp.metadata["latency_ms"] == 200

    def test_empty_content(self):
        resp = LLMResponse(content="")
        assert resp.content == ""


# ---------------------------------------------------------------------------
# Tests: MockLLMProvider (from conftest)
# ---------------------------------------------------------------------------

class TestMockProvider:
    async def test_complete_returns_queued(self, mock_provider):
        mock_provider.queue_response("Hello from mock")
        resp = await mock_provider.complete(messages=[{"role": "user", "content": "Hi"}])
        assert resp.content == "Hello from mock"

    async def test_complete_default_response(self, mock_provider):
        """When no response is queued, should return default."""
        resp = await mock_provider.complete(messages=[{"role": "user", "content": "Hi"}])
        assert resp.content == "mock response"

    async def test_complete_with_schema_returns_queued(self, mock_provider):
        from pydantic import BaseModel

        class TestSchema(BaseModel):
            value: str = "default"

        mock_provider.queue_schema_response(TestSchema(value="custom"))
        result = await mock_provider.complete_with_schema(
            messages=[{"role": "user", "content": "test"}],
            schema=TestSchema,
        )
        assert result.value == "custom"

    async def test_complete_with_tools(self, mock_provider):
        mock_provider.queue_response("Tool result")
        resp = await mock_provider.complete_with_tools(
            messages=[{"role": "user", "content": "test"}],
            tools=MagicMock(),
        )
        assert resp.content == "Tool result"

    async def test_call_history(self, mock_provider):
        await mock_provider.complete(messages=[{"role": "user", "content": "A"}])
        await mock_provider.complete(messages=[{"role": "user", "content": "B"}])
        assert len(mock_provider.call_history) == 2
        assert mock_provider.call_history[0]["method"] == "complete"

    def test_provider_name(self, mock_provider):
        assert mock_provider.name == "mock"

    def test_model_names(self, mock_provider):
        assert mock_provider.get_default_model() == "mock-model"
        assert mock_provider.get_fast_model() == "mock-fast"
        assert mock_provider.get_creative_model() == "mock-creative"


# ---------------------------------------------------------------------------
# Tests: _is_retryable
# ---------------------------------------------------------------------------

class TestIsRetryable:
    def test_overloaded_error(self):
        class OverloadedError(Exception):
            pass
        assert LLMProvider._is_retryable(OverloadedError()) is True

    def test_rate_limit_error(self):
        class RateLimitError(Exception):
            pass
        assert LLMProvider._is_retryable(RateLimitError()) is True

    def test_status_429(self):
        exc = Exception("rate limited")
        exc.status_code = 429
        assert LLMProvider._is_retryable(exc) is True

    def test_status_529(self):
        exc = Exception("overloaded")
        exc.status_code = 529
        assert LLMProvider._is_retryable(exc) is True

    def test_normal_error_not_retryable(self):
        assert LLMProvider._is_retryable(ValueError("bad value")) is False

    def test_anthropic_body_error(self):
        exc = Exception("api error")
        exc.body = {"error": {"type": "overloaded_error"}}
        assert LLMProvider._is_retryable(exc) is True

    def test_anthropic_body_rate_limit(self):
        exc = Exception("api error")
        exc.body = {"error": {"type": "rate_limit_error"}}
        assert LLMProvider._is_retryable(exc) is True


# ---------------------------------------------------------------------------
# Tests: LLMManager
# ---------------------------------------------------------------------------

class TestLLMManager:
    def test_list_available_providers_empty(self):
        """With no real API keys, should list no providers or only those set."""
        # Use test keys that won't match real providers
        manager = LLMManager(
            google_api_key=None,
            anthropic_api_key="test-key",
            openai_api_key=None,
        )
        available = manager.list_available_providers()
        # At minimum, anthropic should be available since we passed a key
        assert "anthropic" in available

    def test_primary_provider_resolution(self):
        """Should resolve to the provider with an API key."""
        manager = LLMManager(
            primary_provider=None,
            anthropic_api_key="test-key",
        )
        assert manager.primary_provider in ("anthropic", "google", "openai")

    def test_reset_manager(self):
        reset_llm_manager()
        # After reset, should create a new manager instance
        manager = get_llm_manager()
        assert manager is not None
