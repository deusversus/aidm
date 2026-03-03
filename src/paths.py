"""Canonical path resolution for AIDM v3.

All data directories resolve from here to avoid fragile
relative path strings and duplicate Path traversals scattered
across the codebase.
"""
from pathlib import Path

# Project root: aidm_v3/
PROJECT_ROOT = Path(__file__).parent.parent

# Data directories
DATA_DIR = PROJECT_ROOT / "data"
CHROMA_DIR = DATA_DIR / "chroma"
CHROMA_CUSTOM_DIR = DATA_DIR / "chroma_custom"
MEDIA_DIR = DATA_DIR / "media"
TEMPLATES_DIR = MEDIA_DIR / "templates"
LORE_DIR = DATA_DIR / "lore"
PROFILES_DIR = DATA_DIR / "profiles"

# Rule library (YAML genre configs, trope files)
RULE_LIBRARY_DIR = PROJECT_ROOT / "rule_library"
