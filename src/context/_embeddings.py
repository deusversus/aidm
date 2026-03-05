"""
Shared embedding helper for pgvector-backed context stores.

Calls OpenAI text-embedding-3-small (1536-dim).
Uses the API key from settings store, falling back to OPENAI_API_KEY env var.
"""

import logging
import os

logger = logging.getLogger(__name__)

_MODEL = "text-embedding-3-small"
_DIMS = 1536


def get_api_key() -> str | None:
    """Retrieve OpenAI API key from settings store or environment."""
    try:
        from ..settings.store import get_settings_store
        key = get_settings_store().get_api_key("openai")
        if key:
            return key
    except Exception:
        pass
    return os.getenv("OPENAI_API_KEY")


def embed(text: str, api_key: str | None = None) -> list[float] | None:
    """
    Embed a single text string via OpenAI.

    Returns a 1536-dim float list, or None if the API key is missing/call fails.
    The caller should handle None gracefully (fall back to non-vector search).
    """
    key = api_key or get_api_key()
    if not key:
        logger.warning("embed(): no OpenAI API key — vector search unavailable")
        return None

    try:
        from openai import OpenAI
        client = OpenAI(api_key=key)
        resp = client.embeddings.create(model=_MODEL, input=text, dimensions=_DIMS)
        return resp.data[0].embedding
    except Exception as e:
        logger.error(f"embed() failed: {e}")
        return None


def vec_to_pg(vec: list[float]) -> str:
    """Convert a float list to the pgvector literal format '[0.1,0.2,...]'."""
    return "[" + ",".join(str(v) for v in vec) + "]"
