"""Media generation module for AIDM v3.

Handles character model sheets, portraits, and future cutscene generation
using Google's Gemini Image Generation and Veo APIs.
"""

from .generator import MediaGenerator

__all__ = ["MediaGenerator"]
