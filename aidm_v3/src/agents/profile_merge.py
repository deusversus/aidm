"""
Profile Merge Agent for AIDM v3.

Agentic profile merge that uses tools to analyze divergences between
two versions of the same IP, ask the player clarifying questions,
and produce an intelligently merged profile.

Two-phase approach:
    Phase 1 (Analysis): Use tools to read profiles, compare fields, search
            lore, research divergences, and queue questions for the player.
    Phase 2 (Merge): After player answers, produce the final merged profile
            using analysis findings + player preferences.

Extends AgenticAgent for tool-calling capability.
"""

import logging
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from .anime_research import AnimeResearchOutput
from .base import AgenticAgent
from .merge_tools import build_merge_tools, PlayerQuestionCollector

logger = logging.getLogger(__name__)


# ─── System Prompt ───────────────────────────────────────────────────────


MERGE_ANALYSIS_PROMPT = """# Profile Merge Analysis Agent

You are analyzing two anime/manga profiles to prepare for merging them into a
single hybrid profile. These are typically different media forms of the same IP
(e.g., a manhwa and its anime adaptation) or related IPs the player wants to blend.

## Your Task

1. **Read both profiles** using the read_profile tool
2. **Compare key fields** using compare_fields (power_system, tone, combat_system, dna_scales, tropes)
3. **Search for divergences** — if profiles are versions of the same IP, use search_web
   to find where/how they differ (changed endings, added characters, different power scaling, etc.)
4. **Search lore** if available, to find detailed information about specific divergences
5. **Ask the player** about meaningful divergences using ask_player. Only ask about:
   - Canon-divergent endings or story arcs
   - Different power system implementations
   - Significantly different character fates
   - Tone/style differences that would change gameplay
   Do NOT ask about trivial differences (animation style, filler episodes, etc.)

## Guidelines

- Be thorough but efficient. 3-5 questions maximum.
- Frame questions as clear choices, not open-ended.
- Include brief context so the player understands WHY you're asking.
- After your analysis, summarize your findings and the questions you've queued.

## Output

End with a structured summary:
- List of key divergences found
- Which fields will need player input vs can be auto-merged
- Your recommended merge approach for each field
"""

MERGE_EXECUTION_PROMPT = """# Profile Merge Execution Agent

You are merging two anime/manga profiles into a single hybrid profile based on
analysis findings and the player's preferences.

## Your Inputs

You will receive:
1. Both original profiles (key fields)
2. Analysis findings (divergences, recommendations)
3. Player's answers to your questions (if any were asked)

## Merge Rules

### DNA Scales (0-10)
- Blend numerically: merged = (primary * 0.6) + (secondary * 0.4)
- Round to nearest integer

### Power System
Based on the specific divergences found, choose:
- **primary**: Use primary's power system with secondary influence
- **secondary**: Use secondary's power system
- **synthesized**: Create a NEW system combining mechanics from both
- **coexist**: Both power systems exist simultaneously (for cross-IP blends)

### Tropes
- Union: a trope is enabled if EITHER source uses it

### Tone
- Blend numerically like DNA scales
- If there's significant tension (one dark, one light), note it in director_personality

### Visual Style
- Prefer the source with stronger/more distinct visual identity
- Blend reference_descriptors from both

### Director Personality
- Synthesize a new director personality that respects both sources
- Incorporate player preferences from their answers

### Detected Genres
- Union of genres from both profiles, primary genres first

## Output

Use the save_merged_profile tool to save the final profile. The profile JSON must include:
- id: slug of the hybrid title (e.g., "solo_leveling_merged")
- name: "Title A × Title B"
- All standard profile fields (dna_scales, power_system, tone, tropes, etc.)
- research_method: "agentic_merge"
- series_group: from primary profile
"""


class ProfileMergeAgent(AgenticAgent):
    """
    Agentic profile merge with tool-calling capability.

    Phase 1: Analysis — reads profiles, compares fields, searches for
             divergences, queues questions for the player.
    Phase 2: Merge — uses analysis + player answers to produce the final profile.
    """

    agent_name = "profile_merge"
    prompt_name = "profile_merge"

    def __init__(self, model_override: str | None = None):
        super().__init__(model_override=model_override)
        self._question_collector: PlayerQuestionCollector | None = None

    @property
    def system_prompt(self) -> str:
        return self.get_prompt(fallback=MERGE_ANALYSIS_PROMPT)

    @property
    def output_schema(self) -> type[BaseModel] | None:
        return None  # AgenticAgent uses free-form text, not structured output

    # ── Phase 1: Analysis ──

    async def analyze(
        self,
        profile_id_a: str,
        profile_id_b: str,
    ) -> tuple[str, PlayerQuestionCollector]:
        """
        Analyze two profiles for divergences and queue questions.

        Args:
            profile_id_a: First profile ID
            profile_id_b: Second profile ID

        Returns:
            Tuple of (analysis_findings_text, question_collector)
        """
        tools, collector = build_merge_tools()
        self._question_collector = collector
        self.set_tools(tools)

        analysis_prompt = (
            f"Analyze these two profiles for merging:\n"
            f"- Profile A: {profile_id_a}\n"
            f"- Profile B: {profile_id_b}\n\n"
            f"Read both profiles, compare their fields, search for divergences "
            f"between these versions, and ask the player about any meaningful "
            f"differences that would affect gameplay."
        )

        findings = await self.call_with_tools(
            user_message=analysis_prompt,
            system_prompt_override=MERGE_ANALYSIS_PROMPT,
            max_tool_rounds=8,
        )

        return findings, collector

    # ── Phase 2: Merge ──

    async def merge_with_answers(
        self,
        profile_id_a: str,
        profile_id_b: str,
        analysis_findings: str,
        player_answers: str = "",
    ) -> dict:
        """
        Execute the merge using analysis findings and player preferences.

        Args:
            profile_id_a: First profile ID
            profile_id_b: Second profile ID
            analysis_findings: Text from Phase 1 analysis
            player_answers: Player's answers to merge questions

        Returns:
            Dict with merged profile data and metadata
        """
        tools, _ = build_merge_tools()
        self.set_tools(tools)

        merge_prompt = (
            f"Merge these two profiles based on the analysis and player preferences:\n\n"
            f"## Profile IDs\n"
            f"- Profile A: {profile_id_a}\n"
            f"- Profile B: {profile_id_b}\n\n"
            f"## Analysis Findings\n{analysis_findings}\n\n"
        )

        if player_answers:
            merge_prompt += f"## Player's Preferences\n{player_answers}\n\n"

        merge_prompt += (
            "Read both profiles using read_profile, apply the merge rules, "
            "and save the final merged profile using save_merged_profile."
        )

        result_text = await self.call_with_tools(
            user_message=merge_prompt,
            system_prompt_override=MERGE_EXECUTION_PROMPT,
            max_tool_rounds=6,
        )

        return {
            "status": "merged",
            "result_text": result_text,
            "profile_id_a": profile_id_a,
            "profile_id_b": profile_id_b,
        }

    # ── Legacy compatibility: single-shot merge (no questions) ──

    async def merge(
        self,
        profile_a: AnimeResearchOutput,
        profile_b: AnimeResearchOutput,
        blend_ratio: float = 0.6,
        primary_name: str = "Primary",
        secondary_name: str = "Secondary",
    ) -> AnimeResearchOutput:
        """
        Legacy merge — single-shot blend without player interaction.

        Kept for backward compatibility. For new code, use
        analyze() + merge_with_answers().
        """
        # Numeric blends (pure Python)
        merged_dna = self._blend_dna_scales(
            profile_a.dna_scales,
            profile_b.dna_scales,
            blend_ratio
        )

        merged_tone = self._blend_tone(
            profile_a.tone,
            profile_b.tone,
            blend_ratio
        )

        merged_tropes = self._merge_tropes(
            profile_a.storytelling_tropes,
            profile_b.storytelling_tropes
        )

        # Complex merges via tools
        tools, _ = build_merge_tools()
        self.set_tools(tools)

        context = self._build_merge_context(
            profile_a, profile_b,
            primary_name, secondary_name,
            blend_ratio
        )

        result_text = await self.call_with_tools(
            user_message=context,
            system_prompt_override=MERGE_EXECUTION_PROMPT,
            max_tool_rounds=5,
        )

        # Build output
        hybrid_title = f"{profile_a.title} × {profile_b.title}"
        merged = AnimeResearchOutput(
            title=hybrid_title,
            alternate_titles=[profile_a.title, profile_b.title],
            media_type="hybrid",
            status="completed",
            dna_scales=merged_dna,
            tone=merged_tone,
            storytelling_tropes=merged_tropes,
            power_system=profile_a.power_system,  # Primary wins as fallback
            combat_style=profile_a.combat_style,
            raw_content=self._combine_raw_content(profile_a, profile_b, result_text),
            sources_consulted=profile_a.sources_consulted + profile_b.sources_consulted,
            confidence=80,
            research_method="hybrid_merge"
        )

        return merged

    # ── Helpers (kept from original) ──

    def _blend_dna_scales(
        self,
        dna_a: dict[str, int],
        dna_b: dict[str, int],
        ratio: float
    ) -> dict[str, int]:
        """Blend DNA scales numerically."""
        merged = {}
        all_keys = set(dna_a.keys()) | set(dna_b.keys())
        for key in all_keys:
            val_a = dna_a.get(key, 5)
            val_b = dna_b.get(key, 5)
            merged[key] = round(val_a * ratio + val_b * (1 - ratio))
        return merged

    def _blend_tone(
        self,
        tone_a: dict[str, Any],
        tone_b: dict[str, Any],
        ratio: float
    ) -> dict[str, Any]:
        """Blend tone values numerically."""
        merged = {}
        for key in ["comedy_level", "darkness_level", "optimism"]:
            val_a = tone_a.get(key, 5) if tone_a else 5
            val_b = tone_b.get(key, 5) if tone_b else 5
            merged[key] = round(val_a * ratio + val_b * (1 - ratio))
        return merged

    def _merge_tropes(
        self,
        tropes_a: dict[str, bool],
        tropes_b: dict[str, bool]
    ) -> dict[str, bool]:
        """Union of tropes from both series."""
        merged = {}
        all_keys = set(tropes_a.keys()) | set(tropes_b.keys())
        for key in all_keys:
            merged[key] = tropes_a.get(key, False) or tropes_b.get(key, False)
        return merged

    def _build_merge_context(
        self,
        profile_a: AnimeResearchOutput,
        profile_b: AnimeResearchOutput,
        name_a: str,
        name_b: str,
        ratio: float
    ) -> str:
        """Build context for LLM merge of complex fields."""
        return f"""## Merge Request

**Primary Series (weight: {ratio*100:.0f}%):** {name_a}
- Power System: {profile_a.power_system}
- Combat Style: {profile_a.combat_style}
- World Setting: {profile_a.world_setting}

**Secondary Series (weight: {(1-ratio)*100:.0f}%):** {name_b}
- Power System: {profile_b.power_system}
- Combat Style: {profile_b.combat_style}
- World Setting: {profile_b.world_setting}

## Your Task

Create a merged profile that blends these two series. Focus on:
1. Power system resolution (how do these mechanics coexist or combine?)
2. Combat style (which dominates, or how do they blend?)
3. World setting (create a coherent hybrid setting)

Use read_profile and save_merged_profile tools to complete the merge.
"""

    def _combine_raw_content(
        self,
        profile_a: AnimeResearchOutput,
        profile_b: AnimeResearchOutput,
        blend_summary: str
    ) -> str:
        """Combine raw content from both profiles for RAG."""
        sections = [
            f"# Hybrid Profile: {profile_a.title} × {profile_b.title}\n",
            f"## Blend Summary\n{blend_summary}\n",
        ]
        if profile_a.raw_content:
            sections.append(f"## From {profile_a.title}\n{profile_a.raw_content[:4000]}\n")
        if profile_b.raw_content:
            sections.append(f"## From {profile_b.title}\n{profile_b.raw_content[:4000]}\n")
        return "\n".join(sections)
