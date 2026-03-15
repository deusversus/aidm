"""Tests for LLMProvider, LLMResponse, MockLLMProvider, and LLMManager.

Covers the provider abstraction, response dataclass,
retry logic, and manager provider resolution.
"""

import os
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from src.llm.manager import LLMManager, get_llm_manager, reset_llm_manager
from src.llm.provider import LLMProvider, LLMResponse

# Import MockLLMProvider for standalone use (also available via conftest fixture)
from tests.mock_llm import MockLLMProvider

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

    async def test_complete_underflow_raises(self, mock_provider):
        """Empty queue should raise RuntimeError, not silently return a default."""
        import pytest
        with pytest.raises(RuntimeError, match="response queue is empty"):
            await mock_provider.complete(messages=[{"role": "user", "content": "Hi"}])

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
        mock_provider.queue_response("A response")
        mock_provider.queue_response("B response")
        await mock_provider.complete(messages=[{"role": "user", "content": "A"}])
        await mock_provider.complete(messages=[{"role": "user", "content": "B"}])
        assert len(mock_provider.call_history) == 2
        assert mock_provider.call_history[0]["method"] == "complete"
        assert mock_provider.call_history[0]["call_index"] == 0
        assert mock_provider.call_history[1]["call_index"] == 1

    async def test_schema_underflow_raises(self, mock_provider):
        """Empty schema queue raises RuntimeError with helpful message."""
        from pydantic import BaseModel
        class S(BaseModel):
            v: str = "x"
        with pytest.raises(RuntimeError, match="schema queue is empty"):
            await mock_provider.complete_with_schema(messages=[], schema=S)

    async def test_schema_type_mismatch_raises(self, mock_provider):
        """Queuing wrong schema type raises TypeError at dequeue time."""
        from pydantic import BaseModel
        class Expected(BaseModel):
            v: str = "x"
        class Wrong(BaseModel):
            w: int = 1
        mock_provider.queue_schema_response(Wrong(w=42))
        with pytest.raises(TypeError, match="type mismatch"):
            await mock_provider.complete_with_schema(messages=[], schema=Expected)

    async def test_queue_error_raises_on_next_call(self, mock_provider):
        """queue_error() causes the next complete_with_schema call to raise."""
        from pydantic import BaseModel
        class S(BaseModel):
            v: str = "x"
        mock_provider.queue_error(ValueError("LLM unavailable"))
        with pytest.raises(ValueError, match="LLM unavailable"):
            await mock_provider.complete_with_schema(messages=[], schema=S)

    def test_assert_queue_empty_passes_when_consumed(self, mock_provider):
        mock_provider.assert_queue_empty()  # nothing queued → should pass

    def test_assert_queue_empty_fails_when_leftover(self, mock_provider):
        from pydantic import BaseModel
        class S(BaseModel):
            v: str = "x"
        # Bypass the fixture's auto-assert by using a standalone provider
        p = MockLLMProvider()
        p.queue_schema_response(S())
        with pytest.raises(AssertionError, match="never consumed"):
            p.assert_queue_empty()

    async def test_schema_call_history_records_schema_name(self, mock_provider):
        """Schema name is recorded in call_history for debugging."""
        from pydantic import BaseModel
        class MySpecialSchema(BaseModel):
            v: str = "x"
        mock_provider.queue_schema_response(MySpecialSchema())
        await mock_provider.complete_with_schema(messages=[], schema=MySpecialSchema)
        call = mock_provider.last_schema_call()
        assert call is not None
        assert call["schema_name"] == "MySpecialSchema"
        assert call["response_type"] == "MySpecialSchema"

    async def test_tools_queue_separate_from_complete_queue(self, mock_provider):
        """complete_with_tools uses its own queue, not the complete queue."""
        mock_provider.queue_response("complete result")
        mock_provider.queue_tools_response("tools result")
        from unittest.mock import MagicMock
        tools_resp = await mock_provider.complete_with_tools(messages=[], tools=MagicMock())
        complete_resp = await mock_provider.complete(messages=[{"role": "user", "content": "x"}])
        assert tools_resp.content == "tools result"
        assert complete_resp.content == "complete result"

    def test_call_count_by_method(self, mock_provider):
        assert mock_provider.call_count() == 0
        assert mock_provider.call_count("complete") == 0

    def test_reset_clears_all_state(self, mock_provider):
        from pydantic import BaseModel
        class S(BaseModel):
            v: str = "x"
        mock_provider.queue_schema_response(S())
        mock_provider.reset()
        mock_provider.assert_queue_empty()  # should pass after reset
        assert mock_provider.call_history == []

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
