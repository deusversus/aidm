"""Resolved anime identity — the canonical output of the disambiguation step.

A ResolvedAnime represents a fully identified anime/manga entry. Once constructed,
downstream consumers (research pipeline, profile generator) use it directly instead
of re-discovering the same information from scratch.

Sources:
- "anilist"    — resolved via AniList relation graph (has integer IDs)
- "web_search" — resolved via LLM web search for obscure titles (IDs are None)
- "direct"     — caller provided the title without disambiguation (e.g. API / CLI)
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FranchiseEntry:
    """A single entry in an anime franchise."""

    title: str
    anilist_id: int | None
    relation_type: str  # e.g. SEQUEL, PREQUEL, SPIN_OFF, SIDE_STORY, ALTERNATIVE, SOURCE


@dataclass
class ResolvedAnime:
    """Canonical identity for an anime/manga series.

    Constructed once — either from a disambiguation pick or from a direct
    AniList lookup — and threaded through the entire research + generation
    pipeline so no step needs to re-discover or re-guess this information.

    Attributes:
        title:             English canonical title (AniList english > romaji > user input).
        anilist_id:        AniList media ID. None when resolved via web search or direct input.
        franchise_entries: All known franchise members with their own IDs and relation types.
                           Used by ScopeAgent to build targeted bundle queries for EPIC series.
        all_titles:        Every known title variant (english, romaji, native, synonyms).
                           Used to populate the aliases list in the saved profile YAML.
        source:            How this object was constructed ("anilist", "web_search", "direct").
        raw_input:         The original string the user typed before resolution.
    """

    title: str
    anilist_id: int | None
    franchise_entries: list[FranchiseEntry] = field(default_factory=list)
    all_titles: list[str] = field(default_factory=list)
    source: str = "direct"
    raw_input: str = ""

    @classmethod
    def from_direct_input(cls, anime_name: str) -> "ResolvedAnime":
        """Minimal ResolvedAnime for callers that bypass disambiguation (API, CLI, tests)."""
        return cls(
            title=anime_name,
            anilist_id=None,
            source="direct",
            raw_input=anime_name,
        )
