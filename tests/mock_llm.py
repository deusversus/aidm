"""Standalone MockLLMProvider module.

Import from here instead of conftest so the class is available to test
files without going through the conftest fixture machinery.

Usage in tests::

    from tests.mock_llm import MockLLMProvider

    provider = MockLLMProvider()
    provider.queue_schema_response(MySchema(field="value"))
    ...
    provider.assert_queue_empty()
"""

from collections import deque
from typing import Any

from pydantic import BaseModel

from src.llm.provider import LLMProvider, LLMResponse


class MockLLMProvider(LLMProvider):
    """Deterministic LLM stub for offline testing.

    Responses are pre-queued and consumed FIFO.  Any unexpected call (empty
    queue) raises a ``RuntimeError`` immediately — tests must queue exactly the
    responses their code paths consume, no more and no less.

    Usage::

        provider = MockLLMProvider()
        provider.queue_schema_response(MySchema(field="value"))
        result = await agent.run(...)
        provider.assert_queue_empty()          # optional but recommended
        history = provider.last_schema_call()  # inspect what was requested

    Error simulation::

        provider.queue_error(ValueError("LLM unavailable"))
        # next complete_with_schema() call will raise that error

    Multi-pass pipelines: queue responses in the same order the agents will
    request them.  If you are unsure of the order, check the compiler's
    ``_run_*`` methods.
    """

    def __init__(self):
        super().__init__(api_key="mock-key", default_model="mock-model")
        self._schema_queue: deque = deque()    # BaseModel instances OR Exception instances
        self._complete_queue: deque = deque()  # LLMResponse instances OR Exception instances
        self._tools_queue: deque = deque()     # LLMResponse instances OR Exception instances
        self._call_history: list[dict[str, Any]] = []

    # ── Queue helpers ─────────────────────────────────────────────────────────

    def queue_response(self, content: str = "", **kwargs):
        """Queue a plain-text response for ``complete()``."""
        self._complete_queue.append(
            LLMResponse(content=content, model="mock-model", **kwargs)
        )

    def queue_schema_response(self, instance: BaseModel):
        """Queue a structured (Pydantic) response for ``complete_with_schema()``."""
        if not isinstance(instance, BaseModel):
            raise TypeError(
                f"queue_schema_response() expects a Pydantic BaseModel instance, "
                f"got {type(instance).__name__}"
            )
        self._schema_queue.append(instance)

    def queue_tools_response(self, content: str = "", **kwargs):
        """Queue a response for ``complete_with_tools()``."""
        self._tools_queue.append(
            LLMResponse(content=content, model="mock-model", **kwargs)
        )

    def queue_error(self, exc: Exception):
        """Queue an exception to be raised by the *next* ``complete_with_schema()`` call."""
        self._schema_queue.append(exc)

    def queue_complete_error(self, exc: Exception):
        """Queue an exception to be raised by the *next* ``complete()`` call."""
        self._complete_queue.append(exc)

    # ── Inspection helpers ────────────────────────────────────────────────────

    @property
    def call_history(self) -> list[dict[str, Any]]:
        return self._call_history

    def schema_calls(self) -> list[dict[str, Any]]:
        """Return only complete_with_schema call records."""
        return [h for h in self._call_history if h["method"] == "complete_with_schema"]

    def last_schema_call(self) -> dict[str, Any] | None:
        calls = self.schema_calls()
        return calls[-1] if calls else None

    def call_count(self, method: str | None = None) -> int:
        if method is None:
            return len(self._call_history)
        return sum(1 for h in self._call_history if h["method"] == method)

    def assert_queue_empty(self):
        """Assert all queued responses were consumed.  Call at test end."""
        remaining = len(self._schema_queue) + len(self._complete_queue) + len(self._tools_queue)
        if remaining:
            types = (
                [type(r).__name__ for r in self._schema_queue]
                + [type(r).__name__ for r in self._complete_queue]
                + [type(r).__name__ for r in self._tools_queue]
            )
            raise AssertionError(
                f"MockLLMProvider: {remaining} queued response(s) were never consumed: "
                f"{types}. Did an agent call get skipped?"
            )

    def reset(self):
        """Clear all queues and call history (useful between sub-tests)."""
        self._schema_queue.clear()
        self._complete_queue.clear()
        self._tools_queue.clear()
        self._call_history.clear()

    # ── LLMProvider interface ─────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "mock"

    def get_default_model(self) -> str:
        return "mock-model"

    def get_fast_model(self) -> str:
        return "mock-fast"

    def get_creative_model(self) -> str:
        return "mock-creative"

    async def complete(
        self,
        messages,
        system=None,
        model=None,
        max_tokens=1024,
        temperature=0.7,
        extended_thinking=False,
    ) -> LLMResponse:
        self._call_history.append({
            "method": "complete",
            "messages": messages,
            "system": system,
            "model": model,
            "call_index": len(self._call_history),
        })
        if not self._complete_queue:
            raise RuntimeError(
                f"MockLLMProvider: complete() called but response queue is empty. "
                f"Queue a response with provider.queue_response(...) before calling. "
                f"Call #{self.call_count('complete')} of method 'complete'."
            )
        item = self._complete_queue.popleft()
        if isinstance(item, Exception):
            raise item
        return item

    async def complete_with_schema(
        self,
        messages,
        schema,
        system=None,
        model=None,
        max_tokens=1024,
        extended_thinking=False,
    ) -> BaseModel:
        self._call_history.append({
            "method": "complete_with_schema",
            "messages": messages,
            "schema": schema,
            "schema_name": schema.__name__ if hasattr(schema, "__name__") else str(schema),
            "system": system,
            "model": model,
            "call_index": len(self._call_history),
        })
        if not self._schema_queue:
            raise RuntimeError(
                f"MockLLMProvider: complete_with_schema() called for schema "
                f"'{getattr(schema, '__name__', schema)}' but schema queue is empty. "
                f"Queue a response with provider.queue_schema_response(...). "
                f"Call #{self.call_count('complete_with_schema')} of method 'complete_with_schema'."
            )
        item = self._schema_queue.popleft()
        if isinstance(item, Exception):
            raise item
        # Type-check: the queued instance should be compatible with the requested schema
        if not isinstance(item, schema):
            raise TypeError(
                f"MockLLMProvider: type mismatch. "
                f"complete_with_schema() requested schema '{getattr(schema, '__name__', schema)}' "
                f"but the queued response is '{type(item).__name__}'. "
                f"Check that queue_schema_response() calls are in the right order."
            )
        self._call_history[-1]["response_type"] = type(item).__name__
        return item

    async def complete_with_tools(
        self,
        messages,
        tools,
        system=None,
        model=None,
        max_tokens=4096,
        max_tool_rounds=5,
    ) -> LLMResponse:
        self._call_history.append({
            "method": "complete_with_tools",
            "messages": messages,
            "system": system,
            "model": model,
            "call_index": len(self._call_history),
        })
        if not self._tools_queue:
            # Fall back to complete_queue for backwards compat with old tests
            if self._complete_queue:
                item = self._complete_queue.popleft()
                if isinstance(item, Exception):
                    raise item
                return item
            raise RuntimeError(
                f"MockLLMProvider: complete_with_tools() called but tools queue is empty. "
                f"Queue a response with provider.queue_tools_response(...) or provider.queue_response(...)."
            )
        item = self._tools_queue.popleft()
        if isinstance(item, Exception):
            raise item
        return item

    def _init_client(self):
        pass  # No real client needed
