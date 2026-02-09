"""
Anime Research Agent for AIDM v3.

Performs research on anime/manga using a TWO-PASS approach:
1. Pass 1: Web search grounding → raw comprehensive text
2. Pass 2: Parse text → structured schema

Includes robust error handling:
- Validation of research completeness
- Retry logic for missing critical fields
- Confidence assessment and supplemental searches
- Graceful fallback to training data if search fails
"""

from typing import Optional, Dict, Any, List, Type
from pydantic import BaseModel, Field
from pathlib import Path
import asyncio

from .base import BaseAgent
from .progress import ProgressTracker, ProgressPhase
from ..settings import get_settings_store


class AnimeResearchOutput(BaseModel):
    """Structured output from anime research."""
    
    # Core identification
    title: str = Field(default="Unknown", description="Official title of the anime/manga")
    alternate_titles: List[str] = Field(default_factory=list, description="Other names (native script, romanized, abbreviations)")
    media_type: str = Field(default="anime", description="anime, manga, manhwa, donghua, light_novel")
    status: str = Field(default="completed", description="ongoing, completed, hiatus")
    
    # Series detection
    series_group: Optional[str] = Field(default=None, description="Franchise identifier in snake_case (canonical sequels share this)")
    series_position: Optional[int] = Field(default=1, description="Chronological position in franchise")
    related_franchise: Optional[str] = Field(default=None, description="Parent franchise for spinoffs/alternates")
    relation_type: Optional[str] = Field(default="canonical", description="canonical, spinoff, alternate_timeline, parody")
    
    # Narrative DNA (0-10 scales)
    dna_scales: Dict[str, int] = Field(
        default_factory=dict,
        description="11 narrative DNA scales from 0-10"
    )
    
    # Power system
    power_system: Dict[str, Any] = Field(
        default_factory=dict,
        description="Name, mechanics, limitations, tiers"
    )
    
    # World setting
    world_setting: Dict[str, Any] = Field(
        default_factory=dict,
        description="Genre, locations, factions, time period"
    )
    
    # Storytelling style
    storytelling_tropes: Dict[str, bool] = Field(
        default_factory=dict,
        description="15 storytelling tropes (enabled/disabled)"
    )
    
    # Genre detection (for arc templates)
    detected_genres: List[str] = Field(
        default_factory=list,
        description="Detected genres (primary + secondary): shonen, seinen, shoujo_romance, isekai, supernatural, etc."
    )
    
    # Character voice cards (for NPC differentiation)
    voice_cards: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Voice cards for main cast: [{name, speech_patterns, humor_type, signature_phrases, dialogue_rhythm}]"
    )
    
    # Author's voice (for IP authentic writing style)
    author_voice: Dict[str, Any] = Field(
        default_factory=dict,
        description="Author's distinctive style: sentence_patterns, structural_motifs, dialogue_quirks, emotional_rhythm"
    )
    
    # Combat style
    combat_style: str = Field(default="spectacle", description="tactical, spectacle, comedy, spirit, narrative")
    
    # Tone
    tone: Dict[str, Any] = Field(
        default_factory=dict,
        description="comedy_level, darkness_level, optimism"
    )
    
    # Director personality (LLM-synthesized narrative directing prompt)
    director_personality: str = Field(
        default="",
        description="3-5 sentence directing style prompt, IP-specific"
    )
    
    # Pacing style (LLM-synthesized)
    pacing_style: str = Field(
        default="moderate",
        description="Scene pacing: rapid, moderate, or deliberate"
    )
    
    # Power Distribution (replaces single world_tier)
    power_distribution: Dict[str, str] = Field(
        default_factory=lambda: {"peak_tier": "T6", "typical_tier": "T8", "floor_tier": "T9", "gradient": "flat"},
        description="Power distribution: peak_tier, typical_tier, floor_tier, gradient (spike/top_heavy/flat/compressed)"
    )
    
    # Raw Content (for RAG)
    raw_content: Optional[str] = Field(default=None, description="The full research text from Pass 1")
    
    # Structured Fandom pages (for SQL lore storage)
    # List of dicts with keys: title, page_type, content
    fandom_pages: List[Dict[str, Any]] = Field(default_factory=list, description="Individual wiki pages for structured storage")
    fandom_wiki_url: str = Field(default="", description="Source wiki URL for provenance")
    
    # Recent updates (for ongoing series)
    recent_updates: Optional[str] = Field(default=None, description="Latest arc/chapter info if ongoing")
    
    # Research sources
    sources_consulted: List[str] = Field(default_factory=list, description="URLs/sources used")
    
    # Confidence
    confidence: int = Field(default=80, description="0-100 confidence in research accuracy")
    research_method: str = Field(default="web_search", description="web_search, existing_profile, training_data_fallback")
    
    # Research quality indicators (internal tracking)
    research_passes: int = Field(default=1, description="Number of research passes performed")
    supplemental_searches: List[str] = Field(default_factory=list, description="Additional queries made")


# Critical fields that MUST be populated for a valid profile
REQUIRED_FIELDS = ["title", "power_system", "dna_scales", "combat_style"]
POWER_SYSTEM_REQUIRED = ["name", "mechanics"]
DNA_SCALES_REQUIRED = [
    "introspection_vs_action", "comedy_vs_drama", "power_fantasy_vs_struggle",
    "tactical_vs_instinctive", "grounded_vs_absurd"
]


ANIME_RESEARCH_PROMPT = """# Anime Research Agent

You research anime and manga series to create comprehensive RPG profiles.

## Your Research Focus

When researching a series, gather:

1. **Core Identity**
   - Official title and alternate names
   - Origin country (Japan, Korea, China, etc.)
   - Native title in original script (Japanese/Korean/Chinese)
   - Romanized version of native title
   - Common abbreviations (e.g., "AOT", "HxH", "SL")
   - Media type (anime, manga, manhwa, donghua, light novel)
   - Status (ongoing, completed, hiatus)

2. **Power System** (CRITICAL)
   - Name of the power system (e.g., "Nen", "Breathing Styles", "Quirks")
   - Core mechanics and rules
   - Limitations and costs
   - Power tiers/levels

3. **Narrative DNA Scales** (0-10 where 0 is left extreme, 10 is right)
   - introspection_vs_action: Internal reflection vs External action
   - comedy_vs_drama: Light-hearted vs Serious tone
   - simple_vs_complex: Straightforward vs Layered narrative
   - power_fantasy_vs_struggle: Overpowered protagonist vs Underdog
   - explained_vs_mysterious: Clear rules vs Enigmatic world
   - fast_paced_vs_slow_burn: Rapid escalation vs Gradual development
   - episodic_vs_serialized: Self-contained stories vs Continuous arc
   - grounded_vs_absurd: Realistic vs Over-the-top
   - tactical_vs_instinctive: Strategic combat vs Instinct-driven
   - hopeful_vs_cynical: Optimistic vs Dark worldview
   - ensemble_vs_solo: Team focus vs Solo protagonist

4. **Combat Style**
   - tactical: Strategic, methodical combat (e.g., Hunter x Hunter)
   - spectacle: Flashy, visually impressive (e.g., Demon Slayer)
   - comedy: Humor-focused combat (e.g., Konosuba)
   - spirit: Willpower/emotional-driven (e.g., Naruto)
   - narrative: Combat serves story over mechanics (e.g., Death Note)

5. **Storytelling Tropes**
   Check which are present: tournament_arc, training_montage, power_of_friendship,
   mentor_death, chosen_one, tragic_backstory, redemption_arc, betrayal,
   sacrifice, transformation, forbidden_technique, time_loop, false_identity,
   ensemble_focus, slow_burn_romance

6. **World Setting**
   - Genre(s)
   - Key locations
   - Major factions/organizations
   - Time period/era

7. **Tone**
   - Comedy level (0-10)
   - Darkness level (0-10)
   - Overall optimism (0-10)

## Research Quality

Provide accurate, specific information. Cite sources when possible.
If uncertain about something, indicate lower confidence.

## Source Prioritization
When synthesizing information from web sources, prioritize by trust level:

**HIGH TRUST** (use as primary source):
- wikipedia.org, myanimelist.net, anilist.co, anidb.net

**MEDIUM TRUST** (supplement, verify against HIGH):
- fandom.com wikis, reddit.com, crunchyroll.com, animenewsnetwork.com

**LOW TRUST** (verify against multiple other sources):
- Other sites, SEO content farms

If sources conflict, prefer HIGH trust sources.
"""


RESEARCH_QUERY_TEMPLATE = """# Research Request: {anime_name}

Please research this anime/manga comprehensively using web search.
Focus on:
- Power system mechanics and rules
- Narrative style and tone
- Combat approach
- Key storytelling elements

Provide detailed, accurate information from official sources, wikis, and analysis.
{existing_context}
"""


PARSE_PROMPT = """# Parse Research into Structured Profile

Below is raw research data about an anime/manga. Parse it into the exact JSON schema.

## Raw Research Data:
{research_text}

## Instructions:
1. Extract all available information into the schema
2. For DNA scales, provide 0-10 integer values based on the research
3. For power_system, include "name" and "mechanics" at minimum
4. Mark unknown fields with appropriate defaults
5. Set confidence based on how complete and verified the information is
6. For series_group: determine if this is a canonical sequel or spinoff

## Series Detection Rules:
- CANONICAL SEQUELS share the same series_group, related_franchise=null:
  - Dragon Ball Z: series_group="dragon_ball", related_franchise=null
  - Naruto Shippuden: series_group="naruto", related_franchise=null
- SPINOFFS/ALTERNATES get their own series_group + link to parent:
  - Dragon Ball Heroes: series_group="dragon_ball_heroes", related_franchise="dragon_ball"
  - Hellsing Ultimate: series_group="hellsing_ultimate", related_franchise="hellsing"
- Always use snake_case (dragon_ball NOT "Dragon Ball")

Respond with ONLY valid JSON matching the schema, no markdown or explanation.
"""


SUPPLEMENTAL_QUERY_TEMPLATES = {
    "power_system": "What is the power system in {anime_name}? Explain the name, mechanics, and rules.",
    "dna_scales": "Describe the narrative style of {anime_name}. Is it action or dialogue heavy? Comedy or drama? Fast or slow paced?",
    "combat_style": "How is combat portrayed in {anime_name}? Is it tactical, flashy/spectacle, comedic, or emotion-driven?",
    "world_setting": "What is the world setting of {anime_name}? Genre, time period, major factions and locations?",
}

# Topic-focused query templates for multi-pass research
TOPIC_QUERY_TEMPLATES = {
    "power_system": "{anime_name} power system mechanics abilities rules limitations tiers progression",
    "factions": "{anime_name} organizations factions groups world powers alliances enemies",
    "locations": "{anime_name} important locations places world geography setting map regions",
    "characters": "{anime_name} main characters abilities roles relationships protagonist antagonist",
    "arcs": "{anime_name} major story arcs plot summary progression timeline events",
    "combat": "{anime_name} combat fighting style tactical emotional flashy spectacle battles",
    "tone": "{anime_name} tone themes dark comedy optimism atmosphere genre mood",
    "sequels": "{anime_name} sequels spinoffs prequels related series differences continuity",
    "adaptations": "{anime_name} manga vs anime differences changes adaptations versions",
    "recent": "{anime_name} latest arc current events ongoing updates newest chapters episodes",
    "series_aliases": "{anime_name} sequel prequel spinoff alternate timeline canon non-canon Japanese title romanized abbreviation original series relationship",
}


class AnimeResearchAgent(BaseAgent):
    """Agent that researches anime/manga using a two-pass approach.
    
    Pass 1: Web search to gather comprehensive raw text
    Pass 2: Parse raw text into structured schema
    
    Includes retry logic for incomplete research.
    """
    
    agent_name = "research"  # Maps to settings.agent_models.research
    
    # Configuration
    MAX_SUPPLEMENTAL_SEARCHES = 3  # Max follow-up queries for missing data
    MIN_CONFIDENCE_THRESHOLD = 60  # Below this, try supplemental search
    
    def __init__(self, model_override: Optional[str] = None):
        super().__init__(model_override=model_override)
        self._system_prompt = ANIME_RESEARCH_PROMPT
    
    @property
    def system_prompt(self) -> str:
        return self._system_prompt
    
    @property
    def output_schema(self) -> Type[BaseModel]:
        return AnimeResearchOutput
    
    async def _normalize_title(self, provider, model: str, anime_name: str) -> Optional[str]:
        """
        Resolve informal/abbreviated anime names to official titles.
        
        Examples:
        - "Dragon Ball Kai" → "Dragon Ball Z Kai"
        - "FMAB" → "Fullmetal Alchemist: Brotherhood"
        - "HxH" → "Hunter x Hunter"
        
        Returns the official title, or None if no change needed.
        """
        query = f'''What is the official English title for the anime "{anime_name}"?

Rules:
1. Keep variant names! "Dragon Ball Kai" is a SEPARATE anime from "Dragon Ball Z" - it's officially titled "Dragon Ball Z Kai"
2. Fix abbreviations: "FMAB" → "Fullmetal Alchemist: Brotherhood"
3. Add proper punctuation: "Naruto Shippuden" → "Naruto: Shippuden"
4. If already official, return unchanged

Examples:
- "Dragon Ball Kai" → "Dragon Ball Z Kai" (NOT "Dragon Ball Z" - Kai is its own show!)
- "HxH" → "Hunter x Hunter"  
- "Mob Psycho" → "Mob Psycho 100"

Return ONLY the title.'''

        try:
            # Use regular completion - LLM training data knows anime titles
            # Web search can confuse matters by providing too much context
            response = await provider.complete(
                messages=[{"role": "user", "content": query}],
                system="Return only the official anime title. No explanation or extra text.",
                model=model,
                max_tokens=200,
            )
            
            # Parse response - take first line only, clean up
            raw = response.content.strip()
            # Take first line only (LLM sometimes adds explanation)
            official = raw.split('\n')[0].strip().strip('"').strip("'").strip('.')
            
            print(f"[AnimeResearch] Title normalization: '{official}'")
            
            # Basic validation - should look like a title
            if official and len(official) < 150 and not official.startswith("I ") and "Let's" not in official:
                return official
            return None
        except Exception as e:
            print(f"[AnimeResearch] Title normalization failed: {e}")
            return None
    
    async def research_anime(
        self, 
        anime_name: str,
        progress_tracker: Optional[ProgressTracker] = None
    ) -> AnimeResearchOutput:
        """
        Research an anime/manga using bundle-based parallel research+extraction.
        
        Flow:
        1. Scope Agent classifies series complexity → returns bundles
        2. Parallel bundle research+extraction (each bundle researches then extracts)
        3. Code merge of extracted fields into final AnimeResearchOutput
        
        Args:
            anime_name: Name of the anime/manga to research
            progress_tracker: Optional tracker for streaming progress updates
            
        Returns:
            AnimeResearchOutput with comprehensive series data
        """
        from ..llm import get_llm_manager
        from .scope import ScopeAgent
        from .extraction_schemas import build_bundle_schema, get_extraction_prompt
        
        manager = get_llm_manager()
        provider, model = manager.get_provider_for_agent(self.agent_name)
        
        settings = get_settings_store().load()
        use_extended_thinking = settings.extended_thinking
        
        # ========== STEP 0: Title Normalization ==========
        # Resolve informal names to official titles (e.g., "Dragon Ball Kai" → "Dragon Ball Z Kai")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.SCOPE, 
                f"Resolving title...", 
                2
            )
        
        official_title = await self._normalize_title(provider, model, anime_name)
        if official_title and official_title != anime_name:
            print(f"[AnimeResearch] Title normalized: '{anime_name}' → '{official_title}'")
            anime_name = official_title
        
        # ========== STEP 1: Scope Classification ==========
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.SCOPE, 
                f"Classifying series scope...", 
                5
            )
        
        scope_agent = ScopeAgent()
        scope = await scope_agent.classify(anime_name)
        
        print(f"[AnimeResearch] Scope: {scope.scope} ({len(scope.bundles)} bundles, {len(scope.topics)} topics)")
        
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.SCOPE,
                f"Scope: {scope.scope.upper()} ({len(scope.bundles)} bundles)",
                10,
                {"scope": scope.scope, "bundles": len(scope.bundles), "topics": scope.topics}
            )
        
        # ========== STEP 2: Parallel Bundle Research + Extraction ==========
        # Get provider's concurrency limit
        max_concurrent = provider.get_max_concurrent_requests() if hasattr(provider, 'get_max_concurrent_requests') else 5
        max_retries = 3
        
        async def research_and_extract_bundle(bundle: List[str]) -> dict:
            """Research a bundle of topics, then immediately extract structured data."""
            bundle_name = "+".join(bundle)
            
            # Build combined query for all topics in bundle
            queries = []
            for topic in bundle:
                if topic in TOPIC_QUERY_TEMPLATES:
                    queries.append(TOPIC_QUERY_TEMPLATES[topic].format(anime_name=anime_name))
            
            combined_query = f"Research {anime_name}:\n" + "\n".join(f"- {q}" for q in queries)
            
            # Research the bundle with retry logic
            research_text = ""
            for attempt in range(max_retries):
                try:
                    if hasattr(provider, 'complete_with_search'):
                        response = await provider.complete_with_search(
                            messages=[{"role": "user", "content": combined_query}],
                            system=f"Provide detailed, accurate information about {anime_name}. Cover: {', '.join(bundle)}.",
                            model=model,
                            max_tokens=4096,
                            temperature=0.4,
                            extended_thinking=use_extended_thinking
                        )
                        research_text = response.content
                        break
                    else:
                        response = await provider.complete(
                            messages=[{"role": "user", "content": combined_query}],
                            model=model,
                            max_tokens=2048
                        )
                        research_text = response.content
                        break
                except Exception as e:
                    error_str = str(e).lower()
                    if "429" in str(e) or "rate limit" in error_str:
                        wait_time = (2 ** attempt) * 2
                        print(f"[AnimeResearch] Rate limited on bundle '{bundle_name}', retry in {wait_time}s...")
                        await asyncio.sleep(wait_time)
                    else:
                        print(f"[AnimeResearch] Bundle '{bundle_name}' error: {e}")
                        if attempt == max_retries - 1:
                            return {"bundle": bundle, "research": "", "extracted": None, "error": str(e)}
            
            if not research_text:
                return {"bundle": bundle, "research": "", "extracted": None, "error": "Empty research"}
            
            # Build dynamic schema for this bundle
            bundle_schema = build_bundle_schema(bundle)
            extraction_prompt = get_extraction_prompt(bundle, anime_name) + research_text
            
            # Extract structured data with retry
            extracted = None
            for attempt in range(max_retries):
                try:
                    extracted = await provider.complete_with_schema(
                        messages=[{"role": "user", "content": extraction_prompt}],
                        schema=bundle_schema,
                        system=f"Extract EVERY field for {anime_name}. Do NOT return empty objects. Analyze the research and provide specific values for ALL fields. For numeric scales (0-10), choose appropriate values based on the content. For booleans, set true if the trope appears.",
                        model=model,
                        max_tokens=4096  # Increased for complex schemas like tone/dna_scales
                    )
                    break
                except Exception as e:
                    if attempt < max_retries - 1:
                        await asyncio.sleep((2 ** attempt))
                    else:
                        print(f"[AnimeResearch] Extraction failed for bundle '{bundle_name}': {e}")
            
            # Log extraction status
            if extracted:
                print(f"[AnimeResearch] Bundle '{bundle_name}' extracted: OK")
            else:
                print(f"[AnimeResearch] Bundle '{bundle_name}' extraction: FAILED")
            
            return {
                "bundle": bundle,
                "research": research_text,
                "extracted": extracted,
                "error": None
            }
        
        # Process bundles with real-time progress
        bundle_results = []
        total_bundles = len(scope.bundles)
        completed_count = 0
        
        print(f"[AnimeResearch] Running {total_bundles} bundles (max {max_concurrent} concurrent)...")
        
        for i in range(0, total_bundles, max_concurrent):
            batch = scope.bundles[i:i + max_concurrent]
            batch_num = (i // max_concurrent) + 1
            total_batch_count = (total_bundles + max_concurrent - 1) // max_concurrent
            
            if total_batch_count > 1:
                print(f"[AnimeResearch] Batch {batch_num}/{total_batch_count}")
            
            # Create tasks for this batch
            batch_tasks = {asyncio.create_task(research_and_extract_bundle(bundle)): bundle for bundle in batch}
            
            # Process results as they complete (real-time progress)
            for coro in asyncio.as_completed(batch_tasks.keys()):
                result = await coro
                bundle_results.append(result)
                completed_count += 1
                
                # Log warning for empty bundles to surface silent failures
                if not result.get("research"):
                    bundle_name = "+".join(result.get("bundle", []))
                    print(f"[AnimeResearch] WARNING: Bundle '{bundle_name}' returned empty research")
                
                # Emit progress immediately as each bundle completes
                if progress_tracker and result.get("research"):
                    percent = 10 + int((completed_count / total_bundles) * 80)
                    bundle_str = ", ".join(result["bundle"])
                    await progress_tracker.emit(
                        ProgressPhase.RESEARCH,
                        f"{bundle_str} ✓",
                        percent,
                        {"bundle": result["bundle"], "completed": completed_count, "total": total_bundles}
                    )
        
        # ========== STEP 3: Code Merge ==========
        if progress_tracker:
            await progress_tracker.emit(ProgressPhase.PARSING, "Merging extracted data...", 92)
        
        result = self._merge_bundle_results(bundle_results, anime_name, scope)
        
        # Confidence assessment
        result = self._assess_and_adjust_confidence(result)
        
        # Emit completion
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.COMPLETE,
                f"Research complete! Confidence: {result.confidence}%",
                100,
                {"confidence": result.confidence, "title": result.title}
            )
        
        return result
    
    def _merge_bundle_results(
        self, 
        bundle_results: List[dict], 
        anime_name: str,
        scope
    ) -> AnimeResearchOutput:
        """
        Merge extracted data from all bundles into final AnimeResearchOutput.
        
        This is pure Python - no LLM calls.
        """
        output = AnimeResearchOutput(title=anime_name)
        raw_sections = []
        
        for result in bundle_results:
            # Collect raw research for RAG
            if result["research"]:
                bundle_header = ", ".join(result["bundle"]).replace("_", " ").title()
                raw_sections.append(f"## {bundle_header}\n{result['research']}")
            
            # Merge extracted fields
            extracted = result.get("extracted")
            if not extracted:
                continue
            
            # Power system
            if hasattr(extracted, 'power_system') and extracted.power_system:
                ps = extracted.power_system
                output.power_system = {
                    "name": getattr(ps, 'name', ''),
                    "mechanics": getattr(ps, 'mechanics', ''),
                    "limitations": getattr(ps, 'limitations', ''),
                    "tiers": getattr(ps, 'tiers', [])
                }
            
            # Combat style
            if hasattr(extracted, 'combat') and extracted.combat:
                output.combat_style = getattr(extracted.combat, 'style', 'spectacle')
            
            # Tone
            if hasattr(extracted, 'tone') and extracted.tone:
                t = extracted.tone
                output.tone = {
                    "comedy_level": getattr(t, 'comedy_level', 5),
                    "darkness_level": getattr(t, 'darkness_level', 5),
                    "optimism": getattr(t, 'optimism', 5)
                }
            
            # Power Distribution (LLM-researched)
            if hasattr(extracted, 'power_distribution') and extracted.power_distribution:
                pd = extracted.power_distribution
                output.power_distribution = {
                    "peak_tier": getattr(pd, 'peak_tier', 'T6'),
                    "typical_tier": getattr(pd, 'typical_tier', 'T8'),
                    "floor_tier": getattr(pd, 'floor_tier', 'T9'),
                    "gradient": getattr(pd, 'gradient', 'flat'),
                }
            
            # DNA Scales
            if hasattr(extracted, 'dna_scales') and extracted.dna_scales:
                ds = extracted.dna_scales
                output.dna_scales = {
                    "introspection_vs_action": getattr(ds, 'introspection_vs_action', 5),
                    "comedy_vs_drama": getattr(ds, 'comedy_vs_drama', 5),
                    "simple_vs_complex": getattr(ds, 'simple_vs_complex', 5),
                    "power_fantasy_vs_struggle": getattr(ds, 'power_fantasy_vs_struggle', 5),
                    "explained_vs_mysterious": getattr(ds, 'explained_vs_mysterious', 5),
                    "fast_paced_vs_slow_burn": getattr(ds, 'fast_paced_vs_slow_burn', 5),
                    "episodic_vs_serialized": getattr(ds, 'episodic_vs_serialized', 5),
                    "grounded_vs_absurd": getattr(ds, 'grounded_vs_absurd', 5),
                    "tactical_vs_instinctive": getattr(ds, 'tactical_vs_instinctive', 5),
                    "hopeful_vs_cynical": getattr(ds, 'hopeful_vs_cynical', 5),
                    "ensemble_vs_solo": getattr(ds, 'ensemble_vs_solo', 5),
                }
            
            # Tropes
            if hasattr(extracted, 'tropes') and extracted.tropes:
                tr = extracted.tropes
                output.storytelling_tropes = {
                    "tournament_arc": getattr(tr, 'tournament_arc', False),
                    "training_montage": getattr(tr, 'training_montage', False),
                    "power_of_friendship": getattr(tr, 'power_of_friendship', False),
                    "mentor_death": getattr(tr, 'mentor_death', False),
                    "chosen_one": getattr(tr, 'chosen_one', False),
                    "tragic_backstory": getattr(tr, 'tragic_backstory', False),
                    "redemption_arc": getattr(tr, 'redemption_arc', False),
                    "betrayal": getattr(tr, 'betrayal', False),
                    "sacrifice": getattr(tr, 'sacrifice', False),
                    "transformation": getattr(tr, 'transformation', False),
                    "forbidden_technique": getattr(tr, 'forbidden_technique', False),
                    "time_loop": getattr(tr, 'time_loop', False),
                    "false_identity": getattr(tr, 'false_identity', False),
                    "ensemble_focus": getattr(tr, 'ensemble_focus', False),
                    "slow_burn_romance": getattr(tr, 'slow_burn_romance', False),
                }
            
            # World setting (from factions, locations)
            if hasattr(extracted, 'factions') and extracted.factions:
                if 'factions' not in output.world_setting:
                    output.world_setting['factions'] = []
                output.world_setting['factions'] = getattr(extracted.factions, 'factions', [])
            
            if hasattr(extracted, 'locations') and extracted.locations:
                loc = extracted.locations
                output.world_setting['setting'] = getattr(loc, 'setting', '')
                output.world_setting['locations'] = getattr(loc, 'key_locations', [])
                output.world_setting['time_period'] = getattr(loc, 'time_period', '')
            
            # Characters
            if hasattr(extracted, 'characters') and extracted.characters:
                ch = extracted.characters
                output.world_setting['protagonist'] = getattr(ch, 'protagonist', '')
                output.world_setting['antagonist'] = getattr(ch, 'antagonist', '')
                output.world_setting['key_characters'] = getattr(ch, 'key_characters', [])
            
            # Series relationship and aliases
            if hasattr(extracted, 'series_aliases') and extracted.series_aliases:
                sa = extracted.series_aliases
                # Set series fields on output
                output.series_group = getattr(sa, 'series_group', None)
                output.series_position = getattr(sa, 'series_position', 1)
                output.related_franchise = getattr(sa, 'related_franchise', None)
                output.relation_type = getattr(sa, 'relation_type', 'canonical')
                # Build alternate_titles from extracted aliases
                alt_titles = []
                if getattr(sa, 'native_title', ''):
                    alt_titles.append(sa.native_title)
                if getattr(sa, 'romanized_title', ''):
                    alt_titles.append(sa.romanized_title)
                alt_titles.extend(getattr(sa, 'abbreviations', []))
                alt_titles.extend(getattr(sa, 'alternate_titles', []))
                if alt_titles:
                    output.alternate_titles = list(set(alt_titles))  # Dedupe
        
        # Set raw content from all research (explicit None if empty, not empty string)
        raw_text = "\n\n".join(raw_sections)
        output.raw_content = raw_text if raw_text.strip() else None
        output.research_method = "bundled_parallel"
        output.research_passes = len(bundle_results)
        output.sources_consulted = scope.topics
        
        return output

    
    async def _research_topic(
        self,
        provider,
        model: str,
        anime_name: str,
        topic: str,
        query: str,
        extended_thinking: bool = False
    ) -> str:
        """Research a single topic using web search.
        
        Raises exceptions to allow retry logic to handle rate limits.
        """
        if hasattr(provider, 'complete_with_search'):
            response = await provider.complete_with_search(
                messages=[{"role": "user", "content": f"Research: {query}"}],
                system=f"Provide detailed, accurate information about {anime_name}'s {topic}. Use web sources.",
                model=model,
                max_tokens=4096,
                temperature=0.4,
                extended_thinking=extended_thinking
            )
            return response.content
        else:
            # Fallback to regular completion with training data
            response = await provider.complete(
                messages=[{"role": "user", "content": f"Describe {anime_name}'s {topic} in detail."}],
                system=f"Provide accurate information about anime/manga from your knowledge.",
                model=model,
                max_tokens=1024
            )
            return response.content
    
    async def _pass1_web_search(
        self, 
        provider, 
        model: str, 
        anime_name: str,
        existing_context: str,
        extended_thinking: bool = False
    ) -> str:
        """Pass 1: Use web search to gather raw research text."""
        
        query = RESEARCH_QUERY_TEMPLATE.format(
            anime_name=anime_name,
            existing_context=existing_context
        )
        
        print(f"[AnimeResearch] Pass 1: Web search via {provider.name}...")
        
        try:
            if hasattr(provider, 'complete_with_search'):
                response = await provider.complete_with_search(
                    messages=[{"role": "user", "content": query}],
                    system=self.system_prompt,
                    model=model,
                    max_tokens=4096,
                    temperature=0.5,
                    extended_thinking=extended_thinking
                )
                return response.content
            else:
                print(f"[AnimeResearch] WARNING: Provider doesn't support search")
                return ""
        except Exception as e:
            print(f"[AnimeResearch] ERROR in Pass 1: {e}")
            return ""
    
    async def _pass2_parse_to_schema(
        self,
        provider,
        model: str,
        research_text: str,
        anime_name: str,
        extended_thinking: bool = False
    ) -> AnimeResearchOutput:
        """Pass 2: Parse raw research text into structured schema."""
        
        parse_prompt = PARSE_PROMPT.format(research_text=research_text)
        
        print(f"[AnimeResearch] Pass 2: Parsing to schema...")
        
        try:
            result = await provider.complete_with_schema(
                messages=[{"role": "user", "content": parse_prompt}],
                schema=AnimeResearchOutput,
                system="Parse the research into the exact JSON schema. Be accurate and complete.",
                model=model,
                max_tokens=4096,
                extended_thinking=extended_thinking
            )
            
            # Ensure title is set
            if result.title == "Unknown" or not result.title:
                result.title = anime_name
            
            return result
            
        except Exception as e:
            print(f"[AnimeResearch] ERROR in Pass 2: {e}")
            
            # ATTEMPT REPAIR using Validator Agent
            try:
                print(f"[AnimeResearch] Attempting repair via Validator...")
                from .validator import ValidatorAgent
                validator = ValidatorAgent()
                repaired = await validator.repair_json(
                    broken_json=research_text,
                    target_schema=AnimeResearchOutput,
                    error_msg=str(e)
                )
                if repaired:
                    print(f"[AnimeResearch] Validator successfully extracted schema!")
                    if repaired.title == "Unknown" or not repaired.title:
                        repaired.title = anime_name
                    return repaired
            except Exception as repair_error:
                 print(f"[AnimeResearch] Repair failed validation: {repair_error}")
            
            # Fallback if repair fails
            return AnimeResearchOutput(
                title=anime_name,
                confidence=30,
                research_method="parse_failed"
            )
    
    async def _supplemental_search(
        self,
        provider,
        model: str,
        anime_name: str,
        field: str,
        extended_thinking: bool = False
    ) -> str:
        """Run a targeted supplemental search for a specific missing field."""
        
        if field not in SUPPLEMENTAL_QUERY_TEMPLATES:
            return ""
        
        query = SUPPLEMENTAL_QUERY_TEMPLATES[field].format(anime_name=anime_name)
        
        print(f"[AnimeResearch] Supplemental search for: {field}")
        
        try:
            if hasattr(provider, 'complete_with_search'):
                response = await provider.complete_with_search(
                    messages=[{"role": "user", "content": query}],
                    system="Provide specific, accurate information from web sources.",
                    model=model,
                    max_tokens=1024,
                    temperature=0.3,
                    extended_thinking=extended_thinking
                )
                return response.content
            return ""
        except Exception as e:
            print(f"[AnimeResearch] ERROR in supplemental search: {e}")
            return ""
    
    async def _training_data_fallback(
        self,
        provider,
        model: str,
        anime_name: str,
        extended_thinking: bool = False
    ) -> AnimeResearchOutput:
        """Fallback to LLM training data when search fails."""
        
        print(f"[AnimeResearch] Using training data fallback...")
        
        context = f"""# Research Request: {anime_name}

Please provide comprehensive information about this anime/manga from your knowledge.
Include: power system, narrative style, combat approach, key themes.
"""
        
        try:
            result = await provider.complete_with_schema(
                messages=[{"role": "user", "content": context}],
                schema=AnimeResearchOutput,
                system=self.system_prompt,
                model=model,
                max_tokens=4096,
                extended_thinking=extended_thinking
            )
            result.research_method = "training_data_fallback"
            result.confidence = min(result.confidence, 75)  # Cap confidence
            
            # Generate synthetic lore from the structured knowledge since we skipped text generation
            lore_parts = [
                f"# {result.title} (Training Data Knowledge)",
                f"## Premise\n{result.world_setting.get('premise', 'Unknown premise')}",
                f"## Power System: {result.power_system.get('name', 'Unknown')}\n{result.power_system.get('mechanics', '')}",
                f"## Combat Style\n{result.combat_style}",
            ]
            result.raw_content = "\n\n".join(lore_parts)
            
            return result
        except Exception as e:
            print(f"[AnimeResearch] ERROR in training fallback: {e}")
            return AnimeResearchOutput(
                title=anime_name,
                confidence=20,
                research_method="error_fallback"
            )
    
    async def _supplement_with_training_data(
        self,
        provider,
        model: str,
        partial_result: AnimeResearchOutput,
        anime_name: str,
        extended_thinking: bool = False
    ) -> AnimeResearchOutput:
        """Supplement incomplete research with training data."""
        
        # Identify what's still missing
        missing = []
        if not partial_result.power_system or not partial_result.power_system.get("name"):
            missing.append("power_system")
        if not partial_result.dna_scales:
            missing.append("dna_scales")
        
        if not missing:
            return partial_result
        
        print(f"[AnimeResearch] Supplementing missing: {missing}")
        
        # Get training data for missing fields
        supplement_query = f"""For the anime/manga "{anime_name}", provide information about:
{', '.join(missing)}

Use your training knowledge. Be specific and accurate.
"""
        
        try:
            response = await provider.complete(
                messages=[{"role": "user", "content": supplement_query}],
                system="Provide accurate anime/manga information from your knowledge.",
                model=model,
                max_tokens=1024,
                extended_thinking=extended_thinking
            )
            
            # Re-parse with supplemented data
            combined_text = f"""Original research: {partial_result.model_dump_json()}

Supplemental knowledge: {response.content}
"""
            supplemented_result = await self._pass2_parse_to_schema(provider, model, combined_text, anime_name, extended_thinking=False)
            
            # Preserve raw content from original result and append new knowledge
            if partial_result.raw_content:
                supplemented_result.raw_content = partial_result.raw_content + f"\n\n## Supplemental Training Data\n{response.content}"
            else:
                 supplemented_result.raw_content = response.content
                 
            return supplemented_result
            
        except Exception as e:
            print(f"[AnimeResearch] ERROR in supplement: {e}")
            return partial_result
    
    def _identify_missing_fields(self, research_text: str) -> List[str]:
        """Identify critical fields that appear to be missing from research text."""
        
        text_lower = research_text.lower()
        missing = []
        
        # Check for power system keywords
        power_keywords = ["power system", "abilities", "powers", "techniques", "magic", 
                         "jutsu", "nen", "quirk", "breathing", "devil fruit"]
        if not any(kw in text_lower for kw in power_keywords):
            missing.append("power_system")
        
        # Check for combat/style keywords
        combat_keywords = ["combat", "fight", "battle", "action", "tactical", "spectacle"]
        if not any(kw in text_lower for kw in combat_keywords):
            missing.append("combat_style")
        
        # Check for tone/narrative keywords
        tone_keywords = ["tone", "comedy", "drama", "serious", "dark", "lighthearted", "pacing"]
        if not any(kw in text_lower for kw in tone_keywords):
            missing.append("dna_scales")
        
        # Check for world/setting keywords
        world_keywords = ["world", "setting", "location", "faction", "organization", "era", "period"]
        if not any(kw in text_lower for kw in world_keywords):
            missing.append("world_setting")
        
        return missing
    
    def _assess_and_adjust_confidence(self, result: AnimeResearchOutput) -> AnimeResearchOutput:
        """Assess result completeness and adjust confidence accordingly."""
        
        base_confidence = result.confidence
        penalties = 0
        
        # Penalize missing critical fields
        if not result.power_system or not result.power_system.get("name"):
            penalties += 15
        if not result.dna_scales or len(result.dna_scales) < 5:
            penalties += 15
        if result.combat_style == "spectacle":  # Default value suggests not properly set
            # Only penalize if other indicators suggest it wasn't actually researched
            if not result.power_system:
                penalties += 5
        if not result.sources_consulted:
            penalties += 10
        
        # Boost for completeness
        boosts = 0
        if result.power_system and result.power_system.get("mechanics"):
            boosts += 5
        if result.dna_scales and len(result.dna_scales) >= 8:
            boosts += 5
        if result.storytelling_tropes and len(result.storytelling_tropes) >= 5:
            boosts += 5
        
        result.confidence = max(20, min(100, base_confidence - penalties + boosts))
        return result
    
    # ====================================================================
    # API-First Research Pipeline (Phase 2)
    # ====================================================================
    
    @staticmethod
    def _determine_scope_from_count(article_count: int) -> str:
        """Deterministic scope from Fandom article count. No LLM needed."""
        if article_count == 0:
            return "MICRO"
        elif article_count <= 50:
            return "STANDARD"
        elif article_count <= 300:
            return "COMPLEX"
        else:
            return "EPIC"
    
    async def research_anime_api(
        self,
        anime_name: str,
        progress_tracker: Optional[ProgressTracker] = None
    ) -> AnimeResearchOutput:
        """
        API-first research pipeline: AniList + Fandom + 2-3 LLM calls.
        
        Flow:
        1. AniList GraphQL → structured metadata (titles, genres, tags, characters)
        2. Fandom MediaWiki → wiki pages (techniques, characters, locations)
        3. LLM interpretation → DNA scales, power system synthesis, voice cards
        
        Falls back to web-search pipeline if APIs fail.
        """
        from ..scrapers.anilist import AniListClient
        from ..scrapers.fandom import FandomClient, guess_wiki_url
        from ..scrapers.cache import ScraperCache
        from ..llm import get_llm_manager
        
        manager = get_llm_manager()
        provider, model = manager.get_provider_for_agent(self.agent_name)
        cache = ScraperCache()
        
        # ========== STEP 1: AniList Metadata ==========
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.SCOPE,
                "Fetching AniList metadata...",
                5
            )
        
        anilist_client = AniListClient()
        anilist = await anilist_client.search_with_fallback(anime_name)
        
        if not anilist:
            print(f"[AnimeResearch/API] AniList returned nothing for '{anime_name}', falling back to web search")
            return await self.research_anime(anime_name, progress_tracker=progress_tracker)
        
        # Merge all seasons of the same series (walks SEQUEL/PREQUEL relations)
        anilist = await anilist_client.fetch_full_series(anilist)
        
        # Use the official title from AniList
        official_title = anilist.title_english or anilist.title_romaji
        print(f"[AnimeResearch/API] AniList: {official_title} ({anilist.status}, {anilist.format})")
        
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.SCOPE,
                f"Found: {official_title} ({anilist.status})",
                10,
                {"source": "anilist", "title": official_title}
            )
        
        # ========== STEP 2: Fandom Wiki Content ==========
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                "Searching for Fandom wiki...",
                15
            )
        
        fandom_client = FandomClient()
        # Pass both English and romaji titles so wiki discovery can try all variants
        # (mirrors profile aliasing system that indexes multiple title forms)
        alt_titles = []
        if anilist.title_english and anilist.title_english != official_title:
            alt_titles.append(anilist.title_english)
        if anilist.title_romaji and anilist.title_romaji != official_title:
            alt_titles.append(anilist.title_romaji)
        wiki_url = await fandom_client.find_wiki_url(official_title, alt_titles=alt_titles or None)
        
        fandom_result = None
        if wiki_url:
            scope = self._determine_scope_from_count(0)  # Will update after stats
            
            if progress_tracker:
                await progress_tracker.emit(
                    ProgressPhase.RESEARCH,
                    f"Scraping wiki: {wiki_url}...",
                    20
                )
            
            fandom_result = await fandom_client.scrape_wiki(
                wiki_url,
                max_pages_per_type=25,
                character_limit=15,
            )
            
            scope = self._determine_scope_from_count(fandom_result.article_count)
            print(f"[AnimeResearch/API] Fandom: {fandom_result.article_count} articles, scope={scope}")
            print(f"[AnimeResearch/API] Scraped: {fandom_result.get_total_page_count()} pages")
            
            if progress_tracker:
                await progress_tracker.emit(
                    ProgressPhase.RESEARCH,
                    f"Wiki scraped: {fandom_result.get_total_page_count()} pages ({scope})",
                    50,
                    {"wiki": wiki_url, "pages": fandom_result.get_total_page_count(), "scope": scope}
                )
        else:
            scope = "MICRO"
            print(f"[AnimeResearch/API] No Fandom wiki found, proceeding with AniList-only")
            
            if progress_tracker:
                await progress_tracker.emit(
                    ProgressPhase.RESEARCH,
                    "No wiki found, using AniList data only",
                    50
                )
        
        # ========== STEP 3: Build Output from API Data (No LLM) ==========
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.PARSING,
                "Mapping API data to profile...",
                55
            )
        
        output = AnimeResearchOutput(
            title=official_title,
            alternate_titles=anilist.get_all_titles(),
            media_type=self._map_format(anilist.format),
            status=anilist.status.lower() if anilist.status else "completed",
            detected_genres=anilist.genres,
            sources_consulted=["anilist.co"],
            research_method="api_first",
            confidence=85,
        )
        
        # Map AniList relations to series fields
        self._map_relations(output, anilist)
        
        # Map characters from AniList
        if anilist.characters:
            main_chars = anilist.get_main_characters()
            output.world_setting["protagonist"] = main_chars[0].name if main_chars else ""
            output.world_setting["key_characters"] = [c.name for c in anilist.characters[:15]]
        
        # Add description to raw content
        raw_sections = []
        if anilist.description:
            raw_sections.append(f"## Synopsis\n{anilist.description}")
        
        # Add Fandom content
        if fandom_result and fandom_result.all_content:
            raw_sections.append(fandom_result.all_content)
            output.sources_consulted.append(wiki_url)
            
            # Map fandom pages to world_setting
            if fandom_result.pages.get("locations"):
                output.world_setting["locations"] = [p.title for p in fandom_result.pages["locations"]]
            if fandom_result.pages.get("factions"):
                output.world_setting["factions"] = [
                    {"name": p.title, "description": p.clean_text[:200]} 
                    for p in fandom_result.pages["factions"][:10]
                ]
            if fandom_result.pages.get("arcs"):
                arc_titles = [p.title for p in fandom_result.pages["arcs"][:10]]
                # Filter out episode-style titles ("Episode 1", "Episode 2", etc.)
                real_arcs = [t for t in arc_titles if not t.lower().startswith("episode")]
                if real_arcs:
                    output.recent_updates = ", ".join(real_arcs)
        
        output.raw_content = "\n\n".join(raw_sections) if raw_sections else None
        
        # Pass structured pages for SQL lore storage
        if fandom_result:
            output.fandom_wiki_url = wiki_url or ""
            for page_type, page_list in fandom_result.pages.items():
                for page in page_list:
                    output.fandom_pages.append({
                        "title": page.title,
                        "page_type": page_type,
                        "content": page.clean_text,
                    })
        
        # ========== STEP 4: LLM Interpretation (2-3 calls) ==========
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.PARSING,
                "LLM: Deriving DNA scales and power system...",
                60
            )
        
        # Build context string for LLM interpretation
        tag_context = "\n".join(
            f"- {t.name}: {t.rank}%" 
            for t in anilist.get_non_spoiler_tags(20)
        )
        genre_context = ", ".join(anilist.genres)
        synopsis = anilist.description or "No synopsis available."
        
        # Power system and technique context from wiki
        power_context = ""
        if fandom_result:
            tech_pages = fandom_result.get_pages_by_type("techniques")
            if tech_pages:
                power_context = "\n\n".join(
                    f"### {p.title}\n{p.clean_text[:1000]}" for p in tech_pages[:5]
                )
        
        # --- LLM Call 1: DNA Scales + Tone + Combat + World Tier ---
        interpretation_prompt = f"""# Interpret Anime Profile: {official_title}

## AniList Data
- Genres: {genre_context}
- Format: {anilist.format}, Episodes: {anilist.episodes or 'N/A'}
- Score: {anilist.average_score}/100
- Synopsis: {synopsis[:500]}

## AniList Tags (community-voted relevance):
{tag_context}

## Task
Based on the above data, provide:

1. **dna_scales** (all 11 scales, 0-10):
   - introspection_vs_action, comedy_vs_drama, simple_vs_complex
   - power_fantasy_vs_struggle, explained_vs_mysterious, fast_paced_vs_slow_burn
   - episodic_vs_serialized, grounded_vs_absurd, tactical_vs_instinctive
   - hopeful_vs_cynical, ensemble_vs_solo

2. **tone**: comedy_level (0-10), darkness_level (0-10), optimism (0-10)

3. **combat_style**: exactly one of: tactical, spectacle, comedy, spirit, narrative

4. **power_distribution**: Power gradient for the anime world.
   VS Battles tiers: T10=human, T9=street, T8=building, T7=city block, T6=city, T5=island, T4=planet, T3=stellar, T2=universal
   Provide: peak_tier (strongest), typical_tier (most encounters), floor_tier (weakest relevant), gradient (spike/top_heavy/flat/compressed)

5. **storytelling_tropes** (true/false for each):
   tournament_arc, training_montage, power_of_friendship, mentor_death, chosen_one,
   tragic_backstory, redemption_arc, betrayal, sacrifice, transformation,
   forbidden_technique, time_loop, false_identity, ensemble_focus, slow_burn_romance

Respond with ONLY valid JSON, no markdown or explanation."""
        
        try:
            from .extraction_schemas import DNAScalesExtract, ToneExtract, CombatExtract, PowerDistributionExtract
            
            # Use a combined schema for efficiency
            from pydantic import create_model
            InterpretationSchema = create_model(
                "InterpretationSchema",
                dna_scales=(DNAScalesExtract, ...),
                tone=(ToneExtract, ...),
                combat=(CombatExtract, ...),
                power_distribution=(PowerDistributionExtract, ...),
                storytelling_tropes=(Dict[str, bool], {}),
            )
            
            interp = await provider.complete_with_schema(
                messages=[{"role": "user", "content": interpretation_prompt}],
                schema=InterpretationSchema,
                system="You are interpreting anime metadata into profile scales. Use the AniList tags as primary signal — they are community-voted relevance scores.",
                model=model,
                max_tokens=2048,
            )
            
            # Apply interpretation results
            ds = interp.dna_scales
            output.dna_scales = {
                "introspection_vs_action": getattr(ds, 'introspection_vs_action', 5),
                "comedy_vs_drama": getattr(ds, 'comedy_vs_drama', 5),
                "simple_vs_complex": getattr(ds, 'simple_vs_complex', 5),
                "power_fantasy_vs_struggle": getattr(ds, 'power_fantasy_vs_struggle', 5),
                "explained_vs_mysterious": getattr(ds, 'explained_vs_mysterious', 5),
                "fast_paced_vs_slow_burn": getattr(ds, 'fast_paced_vs_slow_burn', 5),
                "episodic_vs_serialized": getattr(ds, 'episodic_vs_serialized', 5),
                "grounded_vs_absurd": getattr(ds, 'grounded_vs_absurd', 5),
                "tactical_vs_instinctive": getattr(ds, 'tactical_vs_instinctive', 5),
                "hopeful_vs_cynical": getattr(ds, 'hopeful_vs_cynical', 5),
                "ensemble_vs_solo": getattr(ds, 'ensemble_vs_solo', 5),
            }
            
            t = interp.tone
            output.tone = {
                "comedy_level": getattr(t, 'comedy_level', 5),
                "darkness_level": getattr(t, 'darkness_level', 5),
                "optimism": getattr(t, 'optimism', 5),
            }
            
            output.combat_style = getattr(interp.combat, 'style', 'spectacle')
            pd = interp.power_distribution
            output.power_distribution = {
                "peak_tier": getattr(pd, 'peak_tier', 'T6'),
                "typical_tier": getattr(pd, 'typical_tier', 'T8'),
                "floor_tier": getattr(pd, 'floor_tier', 'T9'),
                "gradient": getattr(pd, 'gradient', 'flat'),
            }
            output.storytelling_tropes = interp.storytelling_tropes or {}
            
            print(f"[AnimeResearch/API] LLM interpretation: DNA={len(output.dna_scales)} scales, combat={output.combat_style}, power={output.power_distribution}")
            
        except Exception as e:
            import traceback
            print(f"[AnimeResearch/API] LLM interpretation failed: {e}")
            traceback.print_exc()
            output.confidence -= 20
        
        # --- LLM Call 2: Power System Synthesis (only if wiki has content) ---
        if power_context:
            if progress_tracker:
                await progress_tracker.emit(
                    ProgressPhase.PARSING,
                    "LLM: Synthesizing power system from wiki...",
                    75
                )
            
            power_prompt = f"""# Synthesize Power System: {official_title}

## Wiki Technique/Ability Pages:
{power_context}

## Task
From the wiki pages above, extract the power system:
- name: The name of the power system (e.g., "Nen", "Cursed Energy", "Quirks")
- mechanics: How it works (2-3 sentences)
- limitations: Costs, restrictions, drawbacks
- tiers: Power levels/ranks if applicable (list of strings)

Respond with ONLY valid JSON."""
            
            try:
                from .extraction_schemas import PowerSystemExtract
                
                ps_result = await provider.complete_with_schema(
                    messages=[{"role": "user", "content": power_prompt}],
                    schema=PowerSystemExtract,
                    system="Extract the power system from wiki page content. Be specific and use canon terminology.",
                    model=model,
                    max_tokens=1024,
                )
                
                output.power_system = {
                    "name": ps_result.name,
                    "mechanics": ps_result.mechanics,
                    "limitations": ps_result.limitations,
                    "tiers": ps_result.tiers,
                }
                print(f"[AnimeResearch/API] Power system: {ps_result.name}")
                
            except Exception as e:
                import traceback
                print(f"[AnimeResearch/API] Power system synthesis failed: {e}")
                traceback.print_exc()
        
        # --- LLM Call 3: Voice Cards (only if character pages with quotes exist) ---
        char_pages_with_quotes = []
        if fandom_result:
            for p in fandom_result.get_pages_by_type("characters"):
                if p.quotes:
                    char_pages_with_quotes.append(p)
        
        # Build main character list from AniList for gap-filling
        main_char_names = []
        if anilist:
            for char in anilist.characters:
                if char.role == "MAIN":
                    main_char_names.append(char.name)
        
        # Identify which main characters are NOT covered by wiki voice cards
        wiki_covered_names = {p.title.lower() for p in char_pages_with_quotes}
        missing_main_chars = [n for n in main_char_names if n.lower() not in wiki_covered_names]
        
        if char_pages_with_quotes or missing_main_chars:
            if progress_tracker:
                await progress_tracker.emit(
                    ProgressPhase.PARSING,
                    "LLM: Extracting voice patterns...",
                    85
                )
            
            quote_context = ""
            for page in char_pages_with_quotes[:5]:
                quotes_str = "\n".join(f'  "{q}"' for q in page.quotes[:5])
                quote_context += f"\n### {page.title}\n{quotes_str}\n"
            
            # Build gap-filling instruction for main characters without wiki quotes
            gap_instruction = ""
            if missing_main_chars:
                gap_instruction = f"""

## Missing Main Characters (NO wiki quotes available)
The following main characters have no quotes on the wiki. Using your knowledge of {official_title}, 
generate voice cards for them based on how they speak in the series:
{', '.join(missing_main_chars)}
"""
            
            voice_prompt = f"""# Extract Character Voice Patterns: {official_title}

## Character Quotes from Wiki:
{quote_context if quote_context else '(No wiki quotes found)'}
{gap_instruction}
## Task
For each character (both wiki-quoted AND missing main characters listed above), create a voice card with:
- name: Character name
- speech_patterns: How they talk (formal, casual, rough, etc.)
- humor_type: Their comedy style if any
- signature_phrases: Catchphrases or common expressions
- dialogue_rhythm: Sentence structure patterns

Return as a JSON object with key "voice_cards" containing a list of voice card objects."""
            
            try:
                from .extraction_schemas import CharacterVoiceCardsExtract
                
                vc_result = await provider.complete_with_schema(
                    messages=[{"role": "user", "content": voice_prompt}],
                    schema=CharacterVoiceCardsExtract,
                    system="Extract speech patterns from character dialogue quotes. Be specific about HOW they speak.",
                    model=model,
                    max_tokens=2048,
                )
                
                output.voice_cards = [
                    {
                        "name": vc.name,
                        "speech_patterns": vc.speech_patterns,
                        "humor_type": getattr(vc, 'humor_type', ''),
                        "signature_phrases": getattr(vc, 'signature_phrases', ''),
                        "dialogue_rhythm": getattr(vc, 'dialogue_rhythm', ''),
                    }
                    for vc in vc_result.voice_cards
                ]
                print(f"[AnimeResearch/API] Voice cards: {len(output.voice_cards)} characters")
                
            except Exception as e:
                import traceback
                print(f"[AnimeResearch/API] Voice card extraction failed: {e}")
                traceback.print_exc()
        
        # --- LLM Call 4: Narrative Synthesis (director personality + author voice) ---
        # This runs LAST because it needs the full assembled profile context
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.PARSING,
                "LLM: Synthesizing narrative direction...",
                90
            )
        
        # Build full context from all previously computed fields
        dna_summary = ", ".join(f"{k}: {v}/10" for k, v in output.dna_scales.items()) if output.dna_scales else "Not computed"
        tone_summary = ", ".join(f"{k}: {v}" for k, v in (output.tone or {}).items()) if output.tone else "Not computed"
        tropes_on = [k.replace('_', ' ') for k, v in output.storytelling_tropes.items() if v]
        tropes_off = [k.replace('_', ' ') for k, v in output.storytelling_tropes.items() if not v]
        ps = output.power_system or {}
        power_summary = f"{ps.get('name', 'None')} — {ps.get('mechanics', 'N/A')}" if ps.get('name') else "No power system"
        genre_list = ", ".join(output.detected_genres) if output.detected_genres else "Unknown"
        
        synthesis_prompt = f"""# Narrative Synthesis: {official_title}

You are creating the narrative DNA for a tabletop RPG campaign set in this anime's world. 
Your output will directly steer the AI Director that plans story arcs and the AI Writer that generates prose.

## Full Profile Context

**Title:** {official_title}
**Genres:** {genre_list}
**Synopsis:** {synopsis[:600]}
**Format:** {anilist.format if anilist else 'Unknown'}, Episodes: {anilist.episodes if anilist else 'N/A'}

**DNA Scales:** {dna_summary}
**Tone:** {tone_summary}
**Combat Style:** {output.combat_style}
**Power Distribution:** peak={output.power_distribution.get('peak_tier', 'T6')}, typical={output.power_distribution.get('typical_tier', 'T8')}, floor={output.power_distribution.get('floor_tier', 'T9')}, gradient={output.power_distribution.get('gradient', 'flat')}
**Power System:** {power_summary}

**Active Tropes:** {', '.join(tropes_on) if tropes_on else 'None'}
**Inactive Tropes:** {', '.join(tropes_off) if tropes_off else 'None'}

## Task: Generate Three Things

### 1. director_personality (CRITICAL — Steers the Entire Campaign)
Write a 3-5 sentence directing style prompt in second person ("You...").

This must capture:
- The IP's **emotional core** (what makes this anime FEEL like THIS anime, not just any anime)
- **Pacing philosophy** (how scenes should breathe, when to linger vs cut)
- **What matters** in this world (what the camera focuses on, what's worth a scene)
- **How to frame conflict** (is it tactical chess or emotional catharsis?)

BAD example (generic): "You favor action and momentum. You maintain dramatic weight."
GOOD example (IP-specific): "You are patient — you let moments breathe and find meaning in what others overlook. Time is your most powerful narrative tool; show how decades compress into memories. Combat reveals character, never just power levels."

### 2. author_voice (Writing Style Fingerprint)
Capture the distinctive stylistic patterns of this IP:
- sentence_patterns: How prose is structured (short vs flowing, etc.)
- structural_motifs: Narrative techniques (flashbacks, parallel timelines, cold opens, etc.)
- dialogue_quirks: How characters speak in this world
- emotional_rhythm: How emotional beats are paced
- example_voice: One sample sentence that exemplifies this IP's voice

### 3. pacing_style
Choose exactly one: "rapid" (action-driven, short scenes), "moderate" (balanced), or "deliberate" (slow-burn, scenes breathe, emotional weight)

Respond with ONLY valid JSON."""

        try:
            from .extraction_schemas import NarrativeSynthesisExtract
            
            synth_result = await provider.complete_with_schema(
                messages=[{"role": "user", "content": synthesis_prompt}],
                schema=NarrativeSynthesisExtract,
                system="You are synthesizing narrative direction for a tabletop RPG. Be specific to this IP — generic output is useless. Every sentence should be something that could NOT apply to a different anime.",
                model=model,
                max_tokens=2048,
            )
            
            output.director_personality = synth_result.director_personality
            output.pacing_style = synth_result.pacing_style
            
            # Author voice
            av = synth_result.author_voice
            output.author_voice = {
                "sentence_patterns": av.sentence_patterns,
                "structural_motifs": av.structural_motifs,
                "dialogue_quirks": av.dialogue_quirks,
                "emotional_rhythm": av.emotional_rhythm,
                "example_voice": av.example_voice,
            }
            
            print(f"[AnimeResearch/API] Narrative synthesis: pacing={output.pacing_style}, director={output.director_personality[:80]}...")
            print(f"[AnimeResearch/API] Author voice: {len(av.sentence_patterns)} patterns, {len(av.structural_motifs)} motifs")
            
        except Exception as e:
            import traceback
            print(f"[AnimeResearch/API] Narrative synthesis failed (non-fatal): {e}")
            traceback.print_exc()
        
        # ========== STEP 5: Confidence Assessment ==========
        output = self._assess_and_adjust_confidence(output)
        
        # Boost confidence for API-sourced data
        if anilist:
            output.confidence = min(100, output.confidence + 5)
        if fandom_result and fandom_result.get_total_page_count() > 0:
            output.confidence = min(100, output.confidence + 5)
        
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.COMPLETE,
                f"Research complete! Confidence: {output.confidence}%",
                100,
                {"confidence": output.confidence, "title": output.title, "method": "api_first"}
            )
        
        print(f"[AnimeResearch/API] Complete: {output.title}, confidence={output.confidence}%, method=api_first")
        return output
    
    @staticmethod
    def _map_format(anilist_format: Optional[str]) -> str:
        """Map AniList format to our media_type field."""
        mapping = {
            "TV": "anime", "TV_SHORT": "anime", "MOVIE": "anime",
            "SPECIAL": "anime", "OVA": "anime", "ONA": "anime",
            "MANGA": "manga", "ONE_SHOT": "manga",
            "NOVEL": "light_novel",
        }
        return mapping.get(anilist_format or "", "anime")
    
    @staticmethod
    def _map_relations(output: AnimeResearchOutput, anilist) -> None:
        """Map AniList relations to series_group/related_franchise fields."""
        if not anilist.relations:
            return
        
        # Check for prequels/sequels to determine franchise
        for rel in anilist.relations:
            if rel.relation_type in ("PREQUEL", "SEQUEL"):
                # Part of a franchise
                base_title = anilist.title_romaji.lower()
                # Simplify to snake_case for series_group
                import re
                output.series_group = re.sub(r'[^a-z0-9]+', '_', base_title).strip('_')
                break
        
        # Check for parent/side stories
        for rel in anilist.relations:
            if rel.relation_type == "PARENT":
                output.related_franchise = rel.title_romaji
                output.relation_type = "spinoff"
                break
            elif rel.relation_type == "ALTERNATIVE":
                output.related_franchise = rel.title_romaji
                output.relation_type = "alternate_timeline"
                break


async def research_anime_with_search(
    anime_name: str,
    progress_tracker: Optional["ProgressTracker"] = None,
    use_api: bool = True
) -> AnimeResearchOutput:
    """
    Convenience function for anime research.
    
    Creates an AnimeResearchAgent and runs research.
    Uses the API-first pipeline by default, falls back to web search.
    
    Args:
        anime_name: Name of anime to research
        progress_tracker: Optional tracker for streaming progress updates
        use_api: If True, use API-first pipeline (default). If False, use web search.
        
    Returns:
        AnimeResearchOutput with research results
    """
    agent = AnimeResearchAgent()
    
    if use_api:
        try:
            return await agent.research_anime_api(anime_name, progress_tracker=progress_tracker)
        except Exception as e:
            print(f"[AnimeResearch] API pipeline failed: {e}, falling back to web search")
            return await agent.research_anime(anime_name, progress_tracker=progress_tracker)
    else:
        return await agent.research_anime(anime_name, progress_tracker=progress_tracker)

