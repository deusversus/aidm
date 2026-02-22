"""Dependency graph for prompt-as-code system.

Parses `depends_on` from prompt frontmatter and builds a DAG.
When a prompt changes, reports which downstream agents are affected.
"""

from __future__ import annotations

import logging
from collections import defaultdict

from .registry import PromptRegistry, get_registry

logger = logging.getLogger(__name__)


# ── Static edges ─────────────────────────────────────────────────────
# These represent known runtime dependencies between agents that aren't
# captured in frontmatter (e.g., Director decisions feed KeyAnimator).
_STATIC_EDGES: list[tuple[str, str]] = [
    ("director", "vibe_keeper"),       # Director decisions affect narrative
    ("outcome_judge", "vibe_keeper"),   # Outcome shapes narration
    ("pacing", "director"),            # Pacing feeds Director context
    ("combat", "vibe_keeper"),         # Combat results feed narrative
    ("session_zero", "director"),      # S0 profile feeds Director
]


class PromptDependencyGraph:
    """DAG of prompt dependencies.

    Edges point from *dependency* → *dependent*:
        combat → vibe_keeper  means "vibe_keeper depends on combat"

    Supports both:
    - **Frontmatter edges**: `depends_on: [combat, progression]` in `.md` files
    - **Static edges**: Hard-coded runtime dependencies listed above
    """

    def __init__(self, registry: PromptRegistry | None = None):
        self._registry = registry or get_registry()
        # adjacency list: parent → set of children
        self._forward: dict[str, set[str]] = defaultdict(set)
        # reverse: child → set of parents
        self._reverse: dict[str, set[str]] = defaultdict(set)
        self._build()

    def _build(self) -> None:
        """Build the graph from frontmatter + static edges."""
        # 1. Frontmatter edges
        for name in self._registry.list_names():
            pv = self._registry.get(name)
            deps = pv.metadata.get("depends_on", [])
            if isinstance(deps, str):
                deps = [deps]
            for dep in deps:
                self._forward[dep].add(name)
                self._reverse[name].add(dep)

        # 2. Static edges
        for parent, child in _STATIC_EDGES:
            self._forward[parent].add(child)
            self._reverse[child].add(parent)

    def dependents(self, name: str) -> set[str]:
        """Get all prompts that directly depend on `name`."""
        return self._forward.get(name, set())

    def dependencies(self, name: str) -> set[str]:
        """Get all prompts that `name` directly depends on."""
        return self._reverse.get(name, set())

    def transitive_dependents(self, name: str) -> set[str]:
        """Get ALL downstream prompts affected by a change to `name`."""
        visited: set[str] = set()
        queue = [name]
        while queue:
            current = queue.pop(0)
            for dep in self._forward.get(current, set()):
                if dep not in visited:
                    visited.add(dep)
                    queue.append(dep)
        return visited

    def impact_report(self, name: str) -> str:
        """Human-readable impact report for changing a prompt."""
        direct = self.dependents(name)
        transitive = self.transitive_dependents(name)
        indirect = transitive - direct

        lines = [f"Impact report for changing '{name}':"]
        if direct:
            lines.append(f"  Direct dependents: {', '.join(sorted(direct))}")
        if indirect:
            lines.append(f"  Indirect dependents: {', '.join(sorted(indirect))}")
        if not direct and not transitive:
            lines.append("  No known dependents — safe to change in isolation.")
        return "\n".join(lines)

    def as_mermaid(self) -> str:
        """Render the graph as a Mermaid diagram."""
        lines = ["graph TD"]
        seen_edges: set[tuple[str, str]] = set()
        for parent, children in sorted(self._forward.items()):
            for child in sorted(children):
                edge = (parent, child)
                if edge not in seen_edges:
                    seen_edges.add(edge)
                    lines.append(f"    {parent} --> {child}")
        return "\n".join(lines)
