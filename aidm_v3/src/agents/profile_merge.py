"""
Profile Merge Agent for AIDM v3.

Intelligently blends two anime research outputs into a hybrid profile.
Used when players want to mix elements from multiple series.
"""

from typing import Any

from pydantic import BaseModel, Field

from .anime_research import AnimeResearchOutput
from .base import BaseAgent


class ProfileMergeOutput(BaseModel):
    """Output from profile merge operation."""

    merged_profile: dict[str, Any] = Field(
        description="The merged profile data"
    )

    blend_summary: str = Field(
        description="Human-readable summary of how profiles were blended"
    )

    power_system_resolution: str = Field(
        description="How power systems were combined: 'primary', 'secondary', 'synthesized', 'coexist'"
    )

    confidence: int = Field(
        default=85,
        description="Confidence in the merge quality (0-100)"
    )


MERGE_PROMPT = """# Profile Merge Agent

You specialize in blending two anime/manga profiles into a cohesive hybrid world.

## Your Task

Given research outputs from two anime series, create a merged profile that:
1. Combines the best narrative elements from both
2. Resolves conflicts intelligently
3. Creates a coherent world that fans of either series would recognize

## Merge Guidelines

### DNA Scales (0-10)
Blend numerically based on the ratio provided. For a 60/40 blend:
- merged_value = (primary_value * 0.6) + (secondary_value * 0.4)
- Round to nearest integer

### Power Systems
Choose ONE approach:
- **primary**: Use primary anime's power system, with influence from secondary
- **secondary**: Use secondary anime's power system
- **synthesized**: Create a NEW system that combines mechanics from both
- **coexist**: Both power systems exist in the world

### Tropes
- Union of both series' tropes (trope is true if either series uses it)
- Note any conflicting tropes in the summary

### Combat Style
- Pick the dominant style, or synthesize if compatible
- e.g., "tactical" + "spectacle" could become "tactical_spectacle"

### Tone
- Blend the tone values like DNA scales
- Note any tension (e.g., one dark, one light)

## Output Format

Return a complete merged profile following the AnimeResearchOutput structure.
"""


class ProfileMergeAgent(BaseAgent):
    """
    Agent that blends two anime profiles into a hybrid.
    
    Uses LLM intelligence for complex field merging (power systems, tone)
    and simple math for numeric scales.
    """

    agent_name = "profile_merge"

    def __init__(self, model_override: str | None = None):
        super().__init__(model_override=model_override)
        self._system_prompt = MERGE_PROMPT

    @property
    def system_prompt(self) -> str:
        return self._system_prompt

    @property
    def output_schema(self) -> type[BaseModel]:
        return ProfileMergeOutput

    async def merge(
        self,
        profile_a: AnimeResearchOutput,
        profile_b: AnimeResearchOutput,
        blend_ratio: float = 0.6,
        primary_name: str = "Primary",
        secondary_name: str = "Secondary"
    ) -> AnimeResearchOutput:
        """
        Merge two anime research outputs into a hybrid profile.
        
        Args:
            profile_a: Primary anime research output
            profile_b: Secondary anime research output
            blend_ratio: 0.0-1.0, weight given to primary (default 0.6 = 60% primary)
            primary_name: Name of primary anime (for logging)
            secondary_name: Name of secondary anime (for logging)
            
        Returns:
            Merged AnimeResearchOutput
        """
        # Step 1: Numeric blends (pure Python, no LLM)
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

        # Step 2: Complex merges (LLM-assisted)
        context = self._build_merge_context(
            profile_a, profile_b,
            primary_name, secondary_name,
            blend_ratio
        )

        llm_result = await self.call(context)

        # Step 3: Combine into final output
        hybrid_title = f"{profile_a.title} × {profile_b.title}"

        merged = AnimeResearchOutput(
            title=hybrid_title,
            alternate_titles=[profile_a.title, profile_b.title],
            media_type="hybrid",
            status="completed",

            # Numeric blends
            dna_scales=merged_dna,
            tone=merged_tone,
            storytelling_tropes=merged_tropes,

            # From LLM merge
            power_system=llm_result.merged_profile.get("power_system", profile_a.power_system),
            combat_style=llm_result.merged_profile.get("combat_style", profile_a.combat_style),
            world_setting=llm_result.merged_profile.get("world_setting", {}),

            # Combine raw content for RAG
            raw_content=self._combine_raw_content(profile_a, profile_b, llm_result.blend_summary),

            # Sources from both
            sources_consulted=profile_a.sources_consulted + profile_b.sources_consulted,

            # Confidence based on merge quality
            confidence=llm_result.confidence,
            research_method="hybrid_merge"
        )

        return merged

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
            # Trope is enabled if either series uses it
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

Provide a brief summary explaining your merge decisions.
"""

    def _combine_raw_content(
        self,
        profile_a: AnimeResearchOutput,
        profile_b: AnimeResearchOutput,
        blend_summary: str
    ) -> str:
        """Combine raw content from both profiles for RAG."""
        sections = []

        sections.append(f"# Hybrid Profile: {profile_a.title} × {profile_b.title}\n")
        sections.append(f"## Blend Summary\n{blend_summary}\n")

        if profile_a.raw_content:
            sections.append(f"## From {profile_a.title}\n{profile_a.raw_content[:4000]}\n")

        if profile_b.raw_content:
            sections.append(f"## From {profile_b.title}\n{profile_b.raw_content[:4000]}\n")

        return "\n".join(sections)
