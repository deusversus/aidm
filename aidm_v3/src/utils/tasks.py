"""
Safe asyncio task creation with error logging.

Replaces bare `asyncio.create_task()` calls that silently swallow
exceptions in fire-and-forget coroutines.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)


def safe_create_task(coro, *, name: str = None) -> asyncio.Task:
    """Create an asyncio task with automatic error logging.

    Use this instead of ``asyncio.create_task()`` for fire-and-forget
    background work.  If the task raises, the exception is logged with
    full traceback instead of being silently ignored.

    Args:
        coro: The coroutine to schedule.
        name: Optional human-readable task name for log messages.

    Returns:
        The created ``asyncio.Task``.
    """
    task = asyncio.create_task(coro, name=name)
    task.add_done_callback(_log_task_exception)
    return task


def _log_task_exception(task: asyncio.Task) -> None:
    """Done-callback that logs unhandled task exceptions."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc:
        logger.error(
            "Background task '%s' failed: %s",
            task.get_name(),
            exc,
            exc_info=exc,
        )
