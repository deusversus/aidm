"""Langfuse observability integration.

Opt-in: all functions are no-ops when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
are not set. Nothing outside this module imports langfuse directly.
"""

import logging
import os
from contextvars import ContextVar
from typing import Any

logger = logging.getLogger(__name__)

_client = None
_current_trace: ContextVar = ContextVar("langfuse_trace", default=None)
_current_agent: ContextVar = ContextVar("langfuse_agent", default=None)


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
    """Log an LLM generation (with token usage) on the current trace."""
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
