"""Centralized Prompt Registry for AIDM v3.

Treats prompts as first-class code artifacts with:
- Auto-discovery of all .md files in the prompts/ directory
- Content-hash versioning (SHA-256 fingerprint per prompt)
- Hot reload support for development (re-read files on each get())
- Fragment composition ({placeholder} injection)
- Singleton access via get_registry()

Usage:
    from src.prompts import get_registry

    registry = get_registry()
    prompt = registry.get("director")
    print(prompt.content)       # Full prompt text
    print(prompt.content_hash)  # SHA-256 fingerprint

    # Compose with fragments
    composed = registry.get_composed(
        "vibe_keeper",
        profile_dna=dna_block,
        scene_context=scene_block,
    )
"""

import hashlib
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Project root prompts directory (aidm_v3/prompts/)
_PROMPTS_DIR = Path(__file__).parent.parent.parent / "prompts"


@dataclass(frozen=True)
class PromptVersion:
    """An immutable, versioned snapshot of a prompt.

    Attributes:
        name: Prompt identifier (e.g., "director", "combat")
        content: Raw prompt text (after frontmatter stripped)
        content_hash: SHA-256 hex digest of content
        source: Origin path or identifier
        metadata: Parsed YAML frontmatter (if present)
        loaded_at: When this version was loaded
    """

    name: str
    content: str
    content_hash: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)
    loaded_at: datetime = field(default_factory=datetime.utcnow)

    def __len__(self) -> int:
        """Token-rough estimate: word count."""
        return len(self.content.split())


def _compute_hash(content: str) -> str:
    """Compute SHA-256 hash of prompt content."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _parse_frontmatter(raw: str) -> tuple[dict[str, Any], str]:
    """Parse optional YAML frontmatter from a markdown prompt.

    Format:
        ---
        name: director
        depends_on: [key_animator]
        ---
        # Actual prompt content...

    Returns:
        (metadata_dict, content_without_frontmatter)
    """
    if not raw.startswith("---"):
        return {}, raw.strip()

    # Find the closing ---
    end = raw.find("---", 3)
    if end == -1:
        return {}, raw.strip()

    frontmatter_text = raw[3:end].strip()
    content = raw[end + 3:].strip()

    # Simple YAML-like parsing (avoids PyYAML dependency for prompts)
    metadata: dict[str, Any] = {}
    for line in frontmatter_text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()

            # Parse list values: [a, b, c]
            if value.startswith("[") and value.endswith("]"):
                items = [v.strip().strip("'\"") for v in value[1:-1].split(",")]
                metadata[key] = [i for i in items if i]
            # Parse boolean
            elif value.lower() in ("true", "false"):
                metadata[key] = value.lower() == "true"
            # Parse integer
            elif value.isdigit():
                metadata[key] = int(value)
            else:
                metadata[key] = value

    return metadata, content


class PromptRegistry:
    """Central registry for all system prompts.

    Discovers prompt files from the prompts/ directory, loads them
    with content-hash versioning, and provides composition support.
    """

    def __init__(self, prompts_dir: Path | None = None, hot_reload: bool = False):
        """Initialize the registry.

        Args:
            prompts_dir: Override for the prompts directory path
            hot_reload: If True, re-read files on every get() call
                        (useful during development/prompt tuning)
        """
        self._prompts_dir = prompts_dir or _PROMPTS_DIR
        self._hot_reload = hot_reload
        self._cache: dict[str, PromptVersion] = {}
        self._inline_prompts: dict[str, str] = {}
        self._discover()

    def _discover(self) -> None:
        """Scan the prompts directory and pre-load all .md files."""
        if not self._prompts_dir.exists():
            logger.warning(f"Prompts directory not found: {self._prompts_dir}")
            return

        count = 0
        for md_file in sorted(self._prompts_dir.glob("*.md")):
            name = md_file.stem  # e.g., "director.md" → "director"
            self._load_file(name, md_file)
            count += 1

        # Also scan subdirectories (e.g., archive/)
        for subdir in sorted(self._prompts_dir.iterdir()):
            if subdir.is_dir() and subdir.name != "__pycache__":
                for md_file in sorted(subdir.glob("*.md")):
                    name = f"{subdir.name}/{md_file.stem}"
                    self._load_file(name, md_file)
                    count += 1

        logger.info(f"[PromptRegistry] Discovered {count} prompt files")

    def _load_file(self, name: str, path: Path) -> PromptVersion:
        """Load a single prompt file, parse frontmatter, compute hash."""
        raw = path.read_text(encoding="utf-8")
        metadata, content = _parse_frontmatter(raw)

        version = PromptVersion(
            name=name,
            content=content,
            content_hash=_compute_hash(content),
            source=f"file:{path.relative_to(self._prompts_dir.parent)}",
            metadata=metadata,
        )
        self._cache[name] = version
        return version

    def register_inline(self, name: str, content: str, source: str = "") -> PromptVersion:
        """Register a prompt from an inline Python constant.

        Used during migration to bring inline prompts under registry
        management without immediately extracting to .md files.

        Args:
            name: Prompt identifier
            content: Raw prompt text
            source: Source identifier (e.g., "inline:scope.py")
        """
        version = PromptVersion(
            name=name,
            content=content.strip(),
            content_hash=_compute_hash(content.strip()),
            source=source or f"inline:{name}",
        )
        self._cache[name] = version
        self._inline_prompts[name] = content
        return version

    def get(self, name: str) -> PromptVersion:
        """Get a prompt by name.

        In hot_reload mode, re-reads the file from disk on each call.
        Otherwise returns the cached version.

        Args:
            name: Prompt identifier (e.g., "director", "combat")

        Returns:
            PromptVersion with content and hash

        Raises:
            KeyError: If prompt name not found
        """
        if self._hot_reload and name not in self._inline_prompts:
            # Re-read from disk
            path = self._prompts_dir / f"{name}.md"
            if path.exists():
                return self._load_file(name, path)

        if name in self._cache:
            return self._cache[name]

        raise KeyError(
            f"Prompt '{name}' not found. "
            f"Available: {sorted(self._cache.keys())}"
        )

    def get_content(self, name: str, fallback: str = "") -> str:
        """Get prompt content by name, with optional fallback.

        Convenience method that returns just the content string.
        Used as a drop-in replacement for _load_prompt_file().

        Args:
            name: Prompt identifier
            fallback: Returned if prompt not found
        """
        try:
            return self.get(name).content
        except KeyError:
            if fallback:
                return fallback
            raise

    def get_hash(self, name: str) -> str:
        """Get the content hash for a prompt.

        Used for turn-level fingerprinting.
        """
        return self.get(name).content_hash

    def get_composed(self, name: str, **fragments: str) -> PromptVersion:
        """Load a base prompt and inject named fragments.

        Replaces {fragment_name} placeholders in the prompt template
        with the provided fragment values.

        Args:
            name: Base prompt identifier
            **fragments: Named fragments to inject

        Returns:
            New PromptVersion with composed content and fresh hash
        """
        base = self.get(name)
        composed_content = base.content

        for key, value in fragments.items():
            placeholder = "{" + key + "}"
            composed_content = composed_content.replace(placeholder, value)

        # Warn about unfilled placeholders
        unfilled = re.findall(r"\{(\w+)\}", composed_content)
        if unfilled:
            logger.debug(
                f"[PromptRegistry] Unfilled placeholders in '{name}': {unfilled}"
            )

        return PromptVersion(
            name=f"{name}:composed",
            content=composed_content,
            content_hash=_compute_hash(composed_content),
            source=base.source,
            metadata=base.metadata,
        )

    def list_all(self) -> list[PromptVersion]:
        """List all registered prompts."""
        return sorted(self._cache.values(), key=lambda p: p.name)

    def list_names(self) -> list[str]:
        """List all registered prompt names."""
        return sorted(self._cache.keys())

    def diff_hash(self, name: str, old_hash: str) -> bool:
        """Check if a prompt's content has changed since a given hash.

        Args:
            name: Prompt identifier
            old_hash: Previous content hash to compare against

        Returns:
            True if content has changed (hashes differ)
        """
        current = self.get(name)
        return current.content_hash != old_hash

    def get_dependents(self, name: str) -> list[str]:
        """Get prompts that declare a dependency on the given prompt.

        Scans all prompts' `depends_on` metadata.
        """
        dependents = []
        for prompt in self._cache.values():
            deps = prompt.metadata.get("depends_on", [])
            if name in deps:
                dependents.append(prompt.name)
        return dependents

    def summary(self) -> dict[str, Any]:
        """Get a summary of the registry state."""
        prompts = self.list_all()
        return {
            "total_prompts": len(prompts),
            "prompts": [
                {
                    "name": p.name,
                    "hash": p.content_hash[:12],
                    "source": p.source,
                    "words": len(p),
                    "has_metadata": bool(p.metadata),
                }
                for p in prompts
            ],
        }


# ─── Singleton ───────────────────────────────────────────────────────────────

_registry: PromptRegistry | None = None


def get_registry() -> PromptRegistry:
    """Get the global PromptRegistry instance.

    Creates on first call. Uses hot_reload=True if DEBUG env var is set.
    """
    global _registry
    if _registry is None:
        hot_reload = os.getenv("DEBUG", "false").lower() == "true"
        _registry = PromptRegistry(hot_reload=hot_reload)
    return _registry


def reset_registry() -> None:
    """Reset the global registry (for testing)."""
    global _registry
    _registry = None
