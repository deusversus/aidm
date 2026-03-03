"""
Scope Assessment Agent for AIDM v3.

Quickly classifies the complexity/scope of an anime/manga series
to determine how much research depth is needed.

Uses MICRO/STANDARD/COMPLEX/EPIC classification to scale research queries.
"""

import logging

from pydantic import BaseModel, Field

from .base import BaseAgent

logger = logging.getLogger(__name__)


class ScopeOutput(BaseModel):
    """Output from scope classification."""

    # Required field - no default forces Google to populate it
    scope: str = Field(
        ...,  # Ellipsis makes this explicitly required
        description="Series complexity: MICRO, STANDARD, COMPLEX, or EPIC"
    )
    topics: list[str] = Field(
        default_factory=list,
        description="Flat list of all topics (for backward compatibility)"
    )
    bundles: list[list[str]] = Field(
        default_factory=list,
        description="Topic bundles for parallel research+extraction"
    )
    media_variants: list[str] = Field(
        default_factory=list,
        description="Known media variants (manga, anime, movie, spinoff, etc.)"
    )
    has_sequels: bool = Field(
        default=False,
        description="Whether series has sequels or spinoffs"
    )
    known_series_entries: list[str] = Field(
        default_factory=list,
        description="All known entries in this franchise (e.g., ['Naruto', 'Naruto Shippuden', 'Boruto'])"
    )
    is_ongoing: bool = Field(
        default=False,
        description="Whether series is currently ongoing"
    )
    estimated_episodes: int = Field(
        default=0,
        description="Approximate episode/chapter count"
    )
    reasoning: str = Field(
        default="",
        description="Brief explanation for the classification"
    )


# All 11 research topics (never excluded, only bundled differently)
ALL_TOPICS = [
    "power_system", "combat", "tone", "characters", "factions",
    "locations", "arcs", "sequels", "adaptations", "recent", "series_aliases",
    "visual_style"
]

# Bundle definitions by scope level
# Smaller scopes = more topics per bundle (fewer parallel calls)
# Larger scopes = fewer topics per bundle (more depth per topic)
MICRO_BUNDLES = [
    ["power_system", "combat"],
    ["tone", "characters", "visual_style"],
    ["factions", "locations", "arcs", "sequels", "adaptations", "recent", "series_aliases"]
]
STANDARD_BUNDLES = [
    ["power_system", "combat"],
    ["tone", "visual_style"],
    ["characters", "factions"],
    ["locations", "arcs"],
    ["sequels", "adaptations", "recent", "series_aliases"]
]
COMPLEX_BUNDLES = [
    ["power_system"],
    ["combat"],
    ["tone", "visual_style"],
    ["characters"],
    ["factions"],
    ["locations"],
    ["arcs", "sequels", "adaptations", "recent", "series_aliases"]
]
EPIC_BUNDLES = [
    ["power_system"],
    ["combat"],
    ["tone", "visual_style"],
    ["characters"],
    ["factions"],
    ["locations"],
    ["arcs"],
    ["sequels", "series_aliases"],
    ["adaptations"],
    ["recent"]
]

# Legacy topic lists for backward compatibility
MICRO_TOPICS = ALL_TOPICS.copy()
STANDARD_TOPICS = ALL_TOPICS.copy()
COMPLEX_TOPICS = ALL_TOPICS.copy()
EPIC_TOPICS = ALL_TOPICS.copy()


SCOPE_PROMPT = """# Anime/Manga Scope Classifier

You quickly assess the complexity and scope of anime/manga series to determine research depth.

## Classification Criteria

**MICRO** - Single film, OVA, or very short series
- Examples: Akira (1 film), Your Name (1 film), FLCL (6 eps)
- Under 20 episodes or single movie
- Self-contained story, minimal lore

**STANDARD** - Typical anime series
- Examples: Cowboy Bebop (26 eps), Death Note (37 eps), Mob Psycho 100 (37 eps)
- 20-100 episodes, single series
- Complete story, moderate lore depth

**COMPLEX** - Multiple adaptations or longer series
- Examples: Hellsing (TV + Ultimate + manga), FMA (2003 + Brotherhood), Evangelion (TV + movies + rebuilds)
- 100-200 episodes OR significant adaptation differences
- Multiple versions with different continuities

**EPIC** - Massive franchises
- Examples: One Piece (1000+ eps), Naruto (700+ eps + Boruto), Dragon Ball (multiple series spanning decades)
- 200+ episodes OR multiple sequel series
- Ongoing for many years, extensive lore

## Your Task

Given an anime/manga name, classify its scope and return the appropriate research topics.
Be accurate - this determines how thorough the research will be.
"""


SCOPE_QUERY = """Classify the scope of the anime/manga: {anime_name}

Think about:
1. How many episodes/chapters does it have?
2. Is it still ongoing?
3. Are there multiple adaptations, sequels, or spinoffs?

Based on your analysis, provide:
- scope: Must be exactly one of: MICRO, STANDARD, COMPLEX, or EPIC
- media_variants: List like ["manga", "anime", "movie"] 
- has_sequels: true or false
- known_series_entries: List ALL entries in this franchise with FULL OFFICIAL TITLES
- is_ongoing: true or false  
- estimated_episodes: Number (approximate)
- reasoning: Your brief explanation

CRITICAL for known_series_entries:
- Use ACTUAL OFFICIAL TITLES only (e.g., "Naruto Shippuden", "Dragon Ball Z", "Fate/stay night: Unlimited Blade Works")
- NEVER use generic labels like "Original Series", "Sequel", "Spinoff", "Prequel"
- If you don't know specific titles, return an EMPTY list []
- Include the queried title itself plus any related entries you KNOW exist
- Examples:
  - "Naruto" → ["Naruto", "Naruto Shippuden", "Boruto: Naruto Next Generations"]
  - "Fate/stay night" → ["Fate/stay night", "Fate/Zero", "Fate/stay night: Unlimited Blade Works", "Fate/Grand Order"]
  - "Akira" → ["Akira"] (single film, no sequels)

Remember:
- MICRO = under 20 episodes, single film/OVA
- STANDARD = 20-100 episodes, single series
- COMPLEX = 100-200 episodes OR multiple adaptations
- EPIC = 200+ episodes OR massive franchise like One Piece, Naruto, Dragon Ball
"""


class ScopeAgent(BaseAgent):
    """Agent that classifies anime/manga series scope for research depth scaling.
    
    Uses a fast model for quick classification before deeper research.
    """

    agent_name = "scope"  # Defaults to base_fast in settings
    prompt_name = "scope"

    @property
    def system_prompt(self) -> str:
        return self.get_prompt()

    @property
    def output_schema(self) -> type[BaseModel]:
        return ScopeOutput

    async def classify(self, anime_name: str) -> ScopeOutput:
        """
        Classify the scope of an anime/manga series.
        
        Args:
            anime_name: Name of the anime/manga to classify
            
        Returns:
            ScopeOutput with classification and recommended topics
        """
        from ..llm import get_llm_manager
        manager = get_llm_manager()
        provider, model = manager.get_provider_for_agent(self.agent_name)

        logger.info(f"Classifying scope of '{anime_name}'...")

        query = SCOPE_QUERY.format(anime_name=anime_name)

        try:
            result = await provider.complete_with_schema(
                messages=[{"role": "user", "content": query}],
                schema=ScopeOutput,
                system=self.system_prompt,
                model=model,
                max_tokens=1024
            )

            # Assign topics and bundles based on scope
            result.bundles = self._get_bundles_for_scope(result.scope, result)
            result.topics = [topic for bundle in result.bundles for topic in bundle]

            logger.info(f"Classified as {result.scope} with {len(result.bundles)} bundles ({len(result.topics)} topics)")
            return result

        except Exception as e:
            logger.error(f"ERROR: {e}, defaulting to STANDARD")
            return ScopeOutput(
                scope="STANDARD",
                bundles=STANDARD_BUNDLES.copy(),
                topics=ALL_TOPICS.copy(),
                reasoning=f"Classification failed: {e}"
            )

    def _get_bundles_for_scope(self, scope: str, result: ScopeOutput) -> list[list[str]]:
        """Get the appropriate topic bundles for a given scope."""

        if scope == "MICRO":
            bundles = [b.copy() for b in MICRO_BUNDLES]
        elif scope == "STANDARD":
            bundles = [b.copy() for b in STANDARD_BUNDLES]
        elif scope == "COMPLEX":
            bundles = [b.copy() for b in COMPLEX_BUNDLES]
        elif scope == "EPIC":
            bundles = [b.copy() for b in EPIC_BUNDLES]
        else:
            bundles = [b.copy() for b in STANDARD_BUNDLES]

        return bundles

    def _get_topics_for_scope(self, scope: str, result: ScopeOutput) -> list[str]:
        """Get flat topic list for backward compatibility."""
        bundles = self._get_bundles_for_scope(scope, result)
        return [topic for bundle in bundles for topic in bundle]
