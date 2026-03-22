"""Langfuse observability integration + per-turn token budget circuit breaker.

Opt-in: all functions are no-ops when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
are not set. Nothing outside this module imports langfuse directly.

The TurnTokenBudget is always active regardless of Langfuse.
"""

import logging
import os
from contextvars import ContextVar
from typing import Any

logger = logging.getLogger(__name__)

_client = None
_current_trace: ContextVar = ContextVar("langfuse_trace", default=None)
_current_agent: ContextVar = ContextVar("langfuse_agent", default=None)


# ── Per-Turn Token Budget (Circuit Breaker) ──────────────────────────────────

class TokenBudgetExceeded(RuntimeError):
    """Raised when a turn exceeds its token budget."""

    def __init__(self, reason: str, budget: "TurnTokenBudget"):
        self.reason = reason
        self.accumulated_input = budget.accumulated_input
        self.accumulated_output = budget.accumulated_output
        self.call_count = budget.call_count
        super().__init__(
            f"CIRCUIT BREAKER: {reason} — "
            f"{budget.call_count} calls, "
            f"{budget.accumulated_input:,} input tokens, "
            f"{budget.accumulated_output:,} output tokens"
        )


_current_budget: ContextVar["TurnTokenBudget | None"] = ContextVar(
    "turn_token_budget", default=None
)


class TurnTokenBudget:
    """Track cumulative token usage across all LLM calls in a single turn.

    Usage::

        async with TurnTokenBudget(max_input=500_000):
            # All LLM calls made in this scope are tracked.
            # If limits are exceeded, TokenBudgetExceeded is raised.
            result = await agent.call(...)

    The budget is automatically registered via ``log_generation()``
    which every LLM provider already calls.
    """

    def __init__(
        self,
        max_input: int = 500_000,
        max_output: int = 100_000,
        max_calls: int = 25,
    ):
        self.max_input = max_input
        self.max_output = max_output
        self.max_calls = max_calls
        self.accumulated_input = 0
        self.accumulated_output = 0
        self.call_count = 0
        self._token: object | None = None

    def record(self, input_tokens: int, output_tokens: int) -> None:
        """Record token usage from a single LLM call and check limits."""
        self.accumulated_input += input_tokens
        self.accumulated_output += output_tokens
        self.call_count += 1

        if self.call_count > self.max_calls:
            raise TokenBudgetExceeded(
                f"Too many LLM calls ({self.call_count} > {self.max_calls})", self
            )
        if self.accumulated_input > self.max_input:
            raise TokenBudgetExceeded(
                f"Input token limit exceeded "
                f"({self.accumulated_input:,} > {self.max_input:,})",
                self,
            )
        if self.accumulated_output > self.max_output:
            raise TokenBudgetExceeded(
                f"Output token limit exceeded "
                f"({self.accumulated_output:,} > {self.max_output:,})",
                self,
            )

    async def __aenter__(self) -> "TurnTokenBudget":
        self._token = _current_budget.set(self)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> bool:
        if self._token is not None:
            _current_budget.reset(self._token)
            self._token = None
        return False  # don't suppress exceptions


def get_current_budget() -> "TurnTokenBudget | None":
    """Get the active turn token budget, if any."""
    return _current_budget.get(None)


def init_langfuse() -> bool:
    """Initialize Langfuse client from environment variables. Returns True if enabled."""
    global _client
    public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
    secret_key = os.getenv("LANGFUSE_SECRET_KEY")
    host = os.getenv("LANGFUSE_HOST") or os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")

    if not (public_key and secret_key):
        logger.info("Langfuse not configured (LANGFUSE_PUBLIC_KEY/SECRET_KEY absent) — observability disabled")
        return False

    try:
        from langfuse import Langfuse
        _client = Langfuse(public_key=public_key, secret_key=secret_key, host=host)
        logger.info(f"Langfuse observability enabled → {host}")
        return True
    except Exception as e:
        logger.warning(f"Langfuse init failed: {e} — observability disabled")
        return False


def get_client():
    return _client


def start_trace(
    name: str,
    session_id: str | None = None,
    user_id: str | None = None,
    metadata: dict | None = None,
    tags: list[str] | None = None,
    input: Any = None,
):
    """Start a new Langfuse trace and store it in the async context var."""
    if not _client:
        return None
    try:
        trace = _client.trace(
            name=name,
            session_id=session_id,
            user_id=user_id,
            metadata=metadata or {},
            tags=[t for t in (tags or []) if t],
            input=input,
        )
        _current_trace.set(trace)
        return trace
    except Exception as e:
        logger.debug(f"Langfuse start_trace error: {e}")
        return None


def get_trace():
    return _current_trace.get()


def set_current_agent(name: str) -> None:
    """Set the currently-executing agent name so providers can annotate traces."""
    _current_agent.set(name)


def get_current_agent() -> str | None:
    """Get the currently-executing agent name."""
    return _current_agent.get()


def end_trace(output: Any = None, metadata: dict | None = None):
    """Finalize the current trace and flush pending events."""
    trace = get_trace()
    if not trace or not _client:
        return
    try:
        if output is not None or metadata:
            trace.update(output=output, metadata=metadata or {})
        _client.flush()
    except Exception as e:
        logger.debug(f"Langfuse end_trace error: {e}")


def log_generation(
    agent_name: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    input: Any = None,
    output: Any = None,
    metadata: dict | None = None,
):
    """Log an LLM generation (with token usage) on the current trace.

    Also records usage against the active TurnTokenBudget (if any),
    raising ``TokenBudgetExceeded`` if limits are breached.
    """
    # Record against circuit breaker (always, regardless of Langfuse)
    budget = get_current_budget()
    if budget is not None:
        budget.record(input_tokens, output_tokens)

    trace = get_trace()
    if not trace:
        return
    try:
        trace.generation(
            name=agent_name,
            model=model,
            usage={"input": input_tokens, "output": output_tokens},
            input=input,
            output=output,
            metadata=metadata or {},
        )
    except Exception as e:
        logger.debug(f"Langfuse log_generation error: {e}")


def log_span(
    name: str,
    input: Any = None,
    output: Any = None,
    metadata: dict | None = None,
):
    """Log a named pipeline span on the current trace."""
    trace = get_trace()
    if not trace:
        return
    try:
        trace.span(name=name, input=input, output=output, metadata=metadata or {})
    except Exception as e:
        logger.debug(f"Langfuse log_span error: {e}")
