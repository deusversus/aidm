"""Prompt management package for AIDM v3.

Provides centralized prompt loading, content-hash versioning,
and composition primitives. Treats prompts as first-class code.
"""

from .registry import PromptRegistry, PromptVersion, get_registry

__all__ = ["PromptRegistry", "PromptVersion", "get_registry"]
