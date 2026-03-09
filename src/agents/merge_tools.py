"""
Profile Merge Tools — ToolRegistry for the Agentic Profile Merge Agent.

These tools let the merge agent read profiles, search lore, compare fields,
research divergences via web search, and ask the player clarifying questions.

Tool inventory:
    read_profile        — Load a profile YAML by ID and return key fields
    search_lore         — Query scraped wiki pages for a topic
    compare_fields      — Side-by-side comparison of specific profile fields
    search_web          — Research divergences between versions via web search
    ask_player          — Queue a clarifying question for the player (batch)
    save_merged_profile — Save the final merged profile YAML
"""

import json
import logging
from pathlib import Path
from typing import Any

import yaml

from ..llm.tools import ToolDefinition, ToolParam, ToolRegistry

logger = logging.getLogger(__name__)


# ─── Tool Implementations ────────────────────────────────────────────────


def _read_profile(profiles_dir: Path, profile_id: str) -> dict:
    """Load a profile YAML and return its key fields."""
    profile_path = profiles_dir / f"{profile_id}.yaml"
    if not profile_path.exists():
        # Try catalog subdirectory
        profile_path = profiles_dir / "catalog" / f"{profile_id}.yaml"
    if not profile_path.exists():
        return {"error": f"Profile '{profile_id}' not found"}

    with open(profile_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    # Return key fields (omit raw_content to save tokens)
    return {
        "id": data.get("id"),
        "name": data.get("name"),
        "media_type": data.get("media_type"),
        "detected_genres": data.get("detected_genres", []),
        "dna_scales": data.get("dna_scales", {}),
        "power_system": data.get("power_system", {}),
        "power_distribution": data.get("power_distribution", {}),
        "combat_system": data.get("combat_system"),
        "tone": data.get("tone", {}),
        "tropes": data.get("tropes", {}),
        "world_tier": data.get("world_tier"),
        "director_personality": data.get("director_personality"),
        "visual_style": data.get("visual_style", {}),
        "pacing": data.get("pacing", {}),
        "aliases": data.get("aliases", []),
        "series_group": data.get("series_group"),
        "series_position": data.get("series_position"),
    }


def _search_lore(profile_id: str, query: str, limit: int = 5) -> list[dict]:
    """Search scraped wiki/lore pages for a topic within a profile."""
    try:
        from ..db.session import get_session
        from ..db.models import WikiPage

        with get_session() as db:
            pages = (
                db.query(WikiPage)
                .filter(WikiPage.profile_id == profile_id)
                .filter(WikiPage.content.ilike(f"%{query}%"))
                .limit(limit)
                .all()
            )

            if not pages:
                return [{"info": f"No lore pages matching '{query}' for profile '{profile_id}'"}]

            return [
                {
                    "title": p.page_title,
                    "type": p.page_type,
                    "excerpt": p.content[:500] if p.content else "",
                    "word_count": p.word_count,
                }
                for p in pages
            ]
    except Exception as e:
        return [{"error": f"Lore search failed: {e}"}]


def _compare_fields(profiles_dir: Path, profile_id_a: str, profile_id_b: str, fields: str) -> dict:
    """Side-by-side comparison of specific profile fields."""
    field_list = [f.strip() for f in fields.split(",")]

    profile_a = _read_profile(profiles_dir, profile_id_a)
    profile_b = _read_profile(profiles_dir, profile_id_b)

    if "error" in profile_a:
        return {"error": f"Profile A: {profile_a['error']}"}
    if "error" in profile_b:
        return {"error": f"Profile B: {profile_b['error']}"}

    comparison = {}
    for field in field_list:
        val_a = profile_a.get(field, "(not set)")
        val_b = profile_b.get(field, "(not set)")
        comparison[field] = {
            profile_a.get("name", profile_id_a): val_a,
            profile_b.get("name", profile_id_b): val_b,
            "match": val_a == val_b,
        }

    return comparison


async def _search_web(query: str) -> str:
    """Research divergences between versions via LLM web search."""
    try:
        from ..llm import get_llm_manager
        from ..utils.source_trust import get_trust_guidance_prompt

        manager = get_llm_manager()
        provider, model = manager.get_provider_for_agent("profile_merge")

        if hasattr(provider, "complete_with_search"):
            system = (
                "Provide a concise, factual answer about anime/manga differences. "
                "Focus on canon divergences, different endings, different characters, or different power systems."
                + get_trust_guidance_prompt()
            )
            response = await provider.complete_with_search(
                messages=[{"role": "user", "content": query}],
                system=system,
                model=model,
                max_tokens=1024,
                temperature=0.3,
            )
            return response.content
        else:
            return "Web search not available with current provider."
    except Exception as e:
        return f"Web search failed: {e}"


class PlayerQuestionCollector:
    """Collects questions from the merge agent for batch delivery to the player."""

    def __init__(self):
        self.questions: list[dict] = []

    def add_question(self, question: str, context: str = "", field: str = "") -> str:
        """Add a question to the queue. Returns confirmation."""
        self.questions.append({
            "question": question,
            "context": context,
            "field": field,  # Which profile field this relates to
        })
        return f"Question #{len(self.questions)} queued: '{question}'"

    def get_questions(self) -> list[dict]:
        return self.questions

    def has_questions(self) -> bool:
        return len(self.questions) > 0

    def format_for_display(self) -> str:
        """Format questions as a numbered list for Session Zero."""
        if not self.questions:
            return ""
        lines = ["## 🔀 Merge Questions\n"]
        lines.append("I need your input on a few things before merging these profiles:\n")
        for i, q in enumerate(self.questions):
            lines.append(f"**{i+1}.** {q['question']}")
            if q.get("context"):
                lines.append(f"   _{q['context']}_")
            lines.append("")
        lines.append("---\n")
        lines.append("**Answer each by number (e.g., '1. the manga version, 2. keep both')**")
        return "\n".join(lines)


def _save_merged_profile(profiles_dir: Path, profile_data: dict) -> dict:
    """Save the merged profile YAML to disk."""
    try:
        profile_id = profile_data.get("id")
        if not profile_id:
            return {"error": "Profile data must include 'id' field"}

        profile_path = profiles_dir / f"{profile_id}.yaml"
        with open(profile_path, "w", encoding="utf-8") as f:
            yaml.dump(
                profile_data,
                f,
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
            )

        logger.info(f"Saved merged profile: {profile_path}")
        return {"status": "saved", "path": str(profile_path), "profile_id": profile_id}
    except Exception as e:
        return {"error": f"Failed to save profile: {e}"}


# ─── Tool Registry Builder ──────────────────────────────────────────────


def build_merge_tools(
    profiles_dir: Path | None = None,
    question_collector: PlayerQuestionCollector | None = None,
    merge_state: dict | None = None,
) -> tuple[ToolRegistry, PlayerQuestionCollector]:
    """Build the tool registry for the Profile Merge Agent.

    Args:
        profiles_dir: Directory containing profile YAML files
        question_collector: Optional existing collector (created if None)
        merge_state: Optional mutable dict to capture save results.
            After merge, check ``merge_state.get('saved_profile_id')``.

    Returns:
        Tuple of (ToolRegistry, PlayerQuestionCollector)
    """
    if profiles_dir is None:
        profiles_dir = Path(__file__).parent.parent / "profiles"

    if question_collector is None:
        question_collector = PlayerQuestionCollector()

    registry = ToolRegistry()

    # ── read_profile ──
    def read_profile_handler(profile_id: str):
        return _read_profile(profiles_dir, profile_id)

    registry.register(ToolDefinition(
        name="read_profile",
        description=(
            "Load a profile YAML by its ID and return key fields (DNA scales, "
            "power system, tone, tropes, combat, visual style, etc). "
            "Use this to examine each profile before merging."
        ),
        parameters=[
            ToolParam(name="profile_id", type="string", description="Profile ID (e.g., 'solo_leveling_manhwa_anilist_105398')", required=True),
        ],
        handler=read_profile_handler,
    ))

    # ── search_lore ──
    def search_lore_handler(profile_id: str, query: str):
        return _search_lore(profile_id, query)

    registry.register(ToolDefinition(
        name="search_lore",
        description=(
            "Search scraped wiki/lore pages for a specific topic within a profile's "
            "data. Use this to find detailed information about characters, events, "
            "locations, or power systems that might differ between versions."
        ),
        parameters=[
            ToolParam(name="profile_id", type="string", description="Profile ID to search within", required=True),
            ToolParam(name="query", type="string", description="Topic to search for (e.g., 'ending', 'power system', 'antagonist')", required=True),
        ],
        handler=search_lore_handler,
    ))

    # ── compare_fields ──
    def compare_fields_handler(profile_id_a: str, profile_id_b: str, fields: str):
        return _compare_fields(profiles_dir, profile_id_a, profile_id_b, fields)

    registry.register(ToolDefinition(
        name="compare_fields",
        description=(
            "Side-by-side comparison of specific profile fields between two profiles. "
            "Returns the value from each profile and whether they match. "
            "Use this to identify divergences before merging."
        ),
        parameters=[
            ToolParam(name="profile_id_a", type="string", description="First profile ID", required=True),
            ToolParam(name="profile_id_b", type="string", description="Second profile ID", required=True),
            ToolParam(name="fields", type="string", description="Comma-separated field names to compare (e.g., 'power_system,tone,combat_system')", required=True),
        ],
        handler=compare_fields_handler,
    ))

    # ── search_web ──
    async def search_web_handler(query: str):
        return await _search_web(query)

    registry.register(ToolDefinition(
        name="search_web",
        description=(
            "Research divergences between anime/manga versions via web search. "
            "Use this to find out WHERE and HOW two versions of the same IP differ "
            "(e.g., 'How does Fullmetal Alchemist 2003 differ from Brotherhood?'). "
            "Returns factual information about canon differences."
        ),
        parameters=[
            ToolParam(name="query", type="string", description="Research query about divergences or differences", required=True),
        ],
        handler=search_web_handler,
    ))

    # ── ask_player ──
    def ask_player_handler(question: str, context: str = "", field: str = ""):
        return question_collector.add_question(question, context, field)

    registry.register(ToolDefinition(
        name="ask_player",
        description=(
            "Queue a clarifying question for the player. Questions are collected "
            "and presented as a batch after your analysis is complete. Use this "
            "when you find a meaningful divergence where the player's preference "
            "matters (e.g., 'Should the campaign follow the manga ending or the "
            "anime ending?'). Don't ask about trivial differences."
        ),
        parameters=[
            ToolParam(name="question", type="string", description="The question to ask the player", required=True),
            ToolParam(name="context", type="string", description="Brief context explaining why this matters", required=False),
            ToolParam(name="field", type="string", description="Profile field this relates to (e.g., 'power_system', 'tone')", required=False),
        ],
        handler=ask_player_handler,
    ))

    # ── save_merged_profile ──
    def save_handler(profile_data: str):
        """Parse JSON string and save as YAML."""
        try:
            data = json.loads(profile_data) if isinstance(profile_data, str) else profile_data
        except json.JSONDecodeError as e:
            return {"error": f"Invalid JSON: {e}"}
        result = _save_merged_profile(profiles_dir, data)
        # Capture saved profile_id so callers can wire it into the session
        if merge_state is not None and result.get("profile_id"):
            merge_state["saved_profile_id"] = result["profile_id"]
        return result

    registry.register(ToolDefinition(
        name="save_merged_profile",
        description=(
            "Save the final merged profile YAML to disk. Only call this after "
            "you have completed the merge and resolved all divergences. "
            "The profile_data must be a JSON string containing all profile fields."
        ),
        parameters=[
            ToolParam(name="profile_data", type="string", description="JSON string of the merged profile data", required=True),
        ],
        handler=save_handler,
    ))

    return registry, question_collector
