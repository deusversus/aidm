"""
Centralized logging configuration for AIDM v3.

Call setup_logging() once at application startup (from the FastAPI
lifespan handler or from run_server.py).  Every source module then
gets its own logger via:

    import logging
    logger = logging.getLogger(__name__)

Level mapping:
  DEBUG   – internal state dumps, cache hits, token counts
  INFO    – turn processing, agent invocations, research progress
  WARNING – fallbacks, missing optional data, validation repairs
  ERROR   – failed agent calls, corrupted state, API errors
"""

import logging
import sys


def setup_logging(level: str = "INFO") -> None:
    """Configure root logger and quiet noisy third-party loggers."""
    fmt = "[%(name)s] %(message)s"
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=fmt,
        stream=sys.stdout,
        force=True,
    )

    # Quiet noisy third-party loggers
    for name in (
        "chromadb",
        "httpx",
        "httpcore",
        "uvicorn.access",
        "hpack",
        "openai",
        "anthropic",
    ):
        logging.getLogger(name).setLevel(logging.WARNING)
