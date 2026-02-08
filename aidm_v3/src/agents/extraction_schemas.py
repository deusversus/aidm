"""
Extraction schemas for parallel profile generation.

Defines focused Pydantic schemas for each research topic,
plus a dynamic schema builder for topic bundles.
"""

from typing import List, Dict, Any, Optional, Type
from pydantic import BaseModel, Field, create_model


# =============================================================================
# PER-TOPIC EXTRACTION SCHEMAS
# =============================================================================

class PowerSystemExtract(BaseModel):
    """Extracted power system data."""
    name: str = Field(default="", description="Name of the power system (e.g., Nen, Quirks, Breathing)")
    mechanics: str = Field(default="", description="How the power system works")
    limitations: str = Field(default="", description="Costs, restrictions, or drawbacks")
    tiers: List[str] = Field(default_factory=list, description="Power levels or ranks if applicable")


class ToneExtract(BaseModel):
    """Extracted tone/mood data."""
    comedy_level: int = Field(default=5, ge=0, le=10, description="0=serious, 10=comedy")
    darkness_level: int = Field(default=5, ge=0, le=10, description="0=light, 10=dark/grim")
    optimism: int = Field(default=5, ge=0, le=10, description="0=cynical, 10=hopeful")


class WorldTierExtract(BaseModel):
    """Extracted world power tier data."""
    world_tier: str = Field(
        default="T8", 
        description="Typical power tier for characters in this anime (T10=human, T8=street, T6=city, T4=planet, T2=multiverse)"
    )
    tier_reasoning: str = Field(
        default="", 
        description="Brief explanation of why this tier was chosen based on character feats"
    )


class DNAScalesExtract(BaseModel):
    """Extracted narrative DNA scales (0-10)."""
    introspection_vs_action: int = Field(default=5, ge=0, le=10, description="0=internal/thoughtful, 10=external/action")
    comedy_vs_drama: int = Field(default=5, ge=0, le=10, description="0=serious drama, 10=comedy")
    simple_vs_complex: int = Field(default=5, ge=0, le=10, description="0=simple plot, 10=layered narrative")
    power_fantasy_vs_struggle: int = Field(default=5, ge=0, le=10, description="0=overpowered protagonist, 10=underdog")
    explained_vs_mysterious: int = Field(default=5, ge=0, le=10, description="0=clear rules, 10=enigmatic")
    fast_paced_vs_slow_burn: int = Field(default=5, ge=0, le=10, description="0=rapid escalation, 10=gradual")
    episodic_vs_serialized: int = Field(default=5, ge=0, le=10, description="0=standalone episodes, 10=continuous arc")
    grounded_vs_absurd: int = Field(default=5, ge=0, le=10, description="0=realistic, 10=over-the-top")
    tactical_vs_instinctive: int = Field(default=5, ge=0, le=10, description="0=strategic combat, 10=instinct-driven")
    hopeful_vs_cynical: int = Field(default=5, ge=0, le=10, description="0=optimistic, 10=dark worldview")
    ensemble_vs_solo: int = Field(default=5, ge=0, le=10, description="0=team focus, 10=solo protagonist")


class CombatExtract(BaseModel):
    """Extracted combat style data."""
    style: str = Field(
        default="spectacle", 
        description="Combat style: tactical, spectacle, comedy, spirit, or narrative"
    )
    description: str = Field(default="", description="Brief description of combat approach")


class CharactersExtract(BaseModel):
    """Extracted character data."""
    protagonist: str = Field(default="", description="Main protagonist name and brief role")
    antagonist: str = Field(default="", description="Main antagonist name and brief role")
    key_characters: List[str] = Field(default_factory=list, description="Other important characters")


class CharacterVoiceCard(BaseModel):
    """Voice differentiation data for a single character."""
    name: str = Field(description="Character name")
    speech_patterns: str = Field(
        default="", 
        description="How they speak: formal/casual, archaic/modern, verbose/terse, accent notes"
    )
    humor_type: str = Field(
        default="", 
        description="How they express humor: sardonic, earnest, deadpan, none, slapstick"
    )
    signature_phrases: List[str] = Field(
        default_factory=list,
        description="Iconic lines or catchphrases they use"
    )
    dialogue_rhythm: str = Field(
        default="",
        description="Sentence structure: short questions, long monologues, fragments, commands"
    )
    emotional_expression: str = Field(
        default="",
        description="How they show emotion: restrained, explosive, deflecting, direct"
    )


class CharacterVoiceCardsExtract(BaseModel):
    """Extracted voice cards for main cast (5-7 characters max)."""
    voice_cards: List[CharacterVoiceCard] = Field(
        default_factory=list,
        description="Voice differentiation data for main cast characters"
    )


class FactionsExtract(BaseModel):
    """Extracted faction/organization data."""
    factions: List[Dict[str, str]] = Field(
        default_factory=list, 
        description="List of {name, description, role} for major factions"
    )


class LocationsExtract(BaseModel):
    """Extracted world/location data."""
    setting: str = Field(default="", description="General setting description")
    key_locations: List[str] = Field(default_factory=list, description="Important places")
    time_period: str = Field(default="", description="Era or time period if relevant")


class ArcsExtract(BaseModel):
    """Extracted story arc data."""
    arcs: List[Dict[str, str]] = Field(
        default_factory=list,
        description="List of {name, summary} for major story arcs"
    )


class SequelsExtract(BaseModel):
    """Extracted sequel/spinoff data."""
    sequels: List[str] = Field(default_factory=list, description="Sequel series")
    spinoffs: List[str] = Field(default_factory=list, description="Spinoff series")
    prequels: List[str] = Field(default_factory=list, description="Prequel series")


class AdaptationsExtract(BaseModel):
    """Extracted adaptation difference data."""
    differences: str = Field(default="", description="Key differences between manga/anime/etc")
    recommended_version: str = Field(default="", description="Which version is considered definitive")


class RecentExtract(BaseModel):
    """Extracted recent updates for ongoing series."""
    latest_arc: str = Field(default="", description="Current or most recent story arc")
    recent_events: str = Field(default="", description="Notable recent developments")
    status: str = Field(default="", description="ongoing, hiatus, or completed")


class StorytellingTropesExtract(BaseModel):
    """Extracted storytelling tropes (derived from tone/characters/arcs)."""
    tournament_arc: bool = Field(default=False)
    training_montage: bool = Field(default=False)
    power_of_friendship: bool = Field(default=False)
    mentor_death: bool = Field(default=False)
    chosen_one: bool = Field(default=False)
    tragic_backstory: bool = Field(default=False)
    redemption_arc: bool = Field(default=False)
    betrayal: bool = Field(default=False)
    sacrifice: bool = Field(default=False)
    transformation: bool = Field(default=False)
    forbidden_technique: bool = Field(default=False)
    time_loop: bool = Field(default=False)
    false_identity: bool = Field(default=False)
    ensemble_focus: bool = Field(default=False)
    slow_burn_romance: bool = Field(default=False)


class SeriesAliasesExtract(BaseModel):
    """Extracted series relationship and alias data."""
    series_group: str = Field(default="", description="Main franchise identifier in snake_case (canonical sequels share this)")
    series_position: int = Field(default=1, description="Position in canonical series (1=first, 2=sequel, etc)")
    related_franchise: Optional[str] = Field(default=None, description="Parent franchise if spinoff/alternate (null for canonical)")
    relation_type: str = Field(default="canonical", description="canonical, spinoff, or alternate_timeline")
    native_title: str = Field(default="", description="Title in original script (Japanese/Korean/Chinese)")
    romanized_title: str = Field(default="", description="Romanized version of native title")
    abbreviations: List[str] = Field(default_factory=list, description="Common abbreviations (DBZ, AOT, etc)")
    alternate_titles: List[str] = Field(default_factory=list, description="Other known titles")


class GenreDetectionExtract(BaseModel):
    """Extracted genre classification for arc templates and narrative conventions.
    
    Valid genres (match rule_library/genres/ files):
    - shonen, seinen, shoujo_romance, slice_of_life
    - isekai, supernatural, mystery_thriller, horror
    - mecha, scifi, sports, music, historical
    - comedy, magical_girl
    """
    primary_genre: str = Field(
        default="shonen", 
        description="Main genre: shonen, seinen, shoujo_romance, isekai, supernatural, mystery_thriller, horror, mecha, scifi, sports, music, historical, comedy, magical_girl, slice_of_life"
    )
    secondary_genres: List[str] = Field(
        default_factory=list,
        description="1-2 secondary genres that blend with primary (e.g., supernatural + mystery_thriller)"
    )
    genre_reasoning: str = Field(
        default="",
        description="Brief explanation of genre classification"
    )


class AuthorVoiceExtract(BaseModel):
    """Extracted author's distinctive writing voice for IP authenticity.
    
    This captures the unique stylistic fingerprint of the original creator:
    - Sentence patterns: How they structure prose (punchy vs flowing, etc.)
    - Structural motifs: Narrative techniques they repeatedly use
    - Dialogue quirks: Distinctive ways characters speak
    - Emotional rhythm: How they pace emotional beats
    """
    sentence_patterns: List[str] = Field(
        default_factory=list,
        description="Characteristic sentence structures: 'Short declaratives during action', 'Compound sentences during introspection'"
    )
    structural_motifs: List[str] = Field(
        default_factory=list,
        description="Narrative techniques: 'Cold open before title', 'Parallel callbacks', 'In media res'"
    )
    dialogue_quirks: List[str] = Field(
        default_factory=list,
        description="How characters speak: 'Finish each other's sentences', 'Dramatic irony', 'Midsentence interruptions'"
    )
    emotional_rhythm: List[str] = Field(
        default_factory=list,
        description="How emotions are paced: 'Slow build to catharsis', 'Joy undercut by tragedy', 'Silence before violence'"
    )
    example_voice: str = Field(
        default="",
        description="A brief sample sentence that exemplifies this author's voice"
    )


class NarrativeSynthesisExtract(BaseModel):
    """Synthesized narrative direction from full profile context.
    
    This is the final synthesis step — after DNA scales, tone, tropes,
    power system, and voice cards are all computed, this call produces
    the high-level narrative prompts that steer the Director agent
    and define the IP's writing fingerprint.
    """
    director_personality: str = Field(
        default="",
        description=(
            "3-5 sentence directing style prompt. Capture this IP's emotional core, "
            "pacing philosophy, what matters most in this world, and how to frame scenes. "
            "Write in second person ('You...'). Be specific to this anime — generic prompts are useless."
        )
    )
    author_voice: AuthorVoiceExtract = Field(
        default_factory=AuthorVoiceExtract,
        description="The distinctive writing voice and stylistic fingerprint of this IP"
    )
    pacing_style: str = Field(
        default="moderate",
        description="Scene pacing: 'rapid' (action-heavy, short scenes), 'moderate' (balanced), or 'deliberate' (slow-burn, scenes breathe)"
    )


# =============================================================================
# TOPIC-TO-SCHEMA MAPPING
# =============================================================================

TOPIC_SCHEMAS: Dict[str, Type[BaseModel]] = {
    "power_system": PowerSystemExtract,
    "tone": ToneExtract,
    "combat": CombatExtract,
    "characters": CharactersExtract,
    "factions": FactionsExtract,
    "locations": LocationsExtract,
    "arcs": ArcsExtract,
    "sequels": SequelsExtract,
    "adaptations": AdaptationsExtract,
    "recent": RecentExtract,
    "series_aliases": SeriesAliasesExtract,
}

# DNA scales, tropes, genres, and voice are extracted from research
DERIVED_SCHEMAS = {
    "dna_scales": DNAScalesExtract,
    "tropes": StorytellingTropesExtract,
    "genres": GenreDetectionExtract,
    "voice_cards": CharacterVoiceCardsExtract,
    "author_voice": AuthorVoiceExtract,
}


# =============================================================================
# DYNAMIC BUNDLE SCHEMA BUILDER
# =============================================================================

def build_bundle_schema(topics: List[str]) -> Type[BaseModel]:
    """
    Dynamically create a Pydantic schema for a topic bundle.
    
    Args:
        topics: List of topic names to include in the bundle
        
    Returns:
        A dynamically created Pydantic model with fields for each topic
        
    Example:
        schema = build_bundle_schema(["power_system", "combat"])
        # Creates a model with power_system and combat fields
    """
    fields = {}
    
    for topic in topics:
        if topic in TOPIC_SCHEMAS:
            schema_class = TOPIC_SCHEMAS[topic]
            # Use required fields with default instances for LLM compatibility
            # This avoids anyOf/null patterns that confuse some providers
            fields[topic] = (schema_class, Field(default_factory=schema_class))
        else:
            print(f"[ExtractionSchemas] Warning: Unknown topic '{topic}'")
    
    # Also include DNA scales, tropes, and world_tier when tone is in the bundle
    if "tone" in topics:
        fields["dna_scales"] = (DNAScalesExtract, Field(default_factory=DNAScalesExtract))
        fields["tropes"] = (StorytellingTropesExtract, Field(default_factory=StorytellingTropesExtract))
        fields["world_tier"] = (WorldTierExtract, Field(default_factory=WorldTierExtract))
    
    return create_model("BundleExtract", **fields)


def get_extraction_prompt(topics: List[str], anime_name: str) -> str:
    """
    Generate an extraction prompt for a topic bundle.
    
    Args:
        topics: List of topics to extract
        anime_name: Name of the anime for context
        
    Returns:
        Prompt string for extraction
    """
    topic_instructions = []
    
    for topic in topics:
        if topic == "power_system":
            topic_instructions.append("""- **power_system**: Extract:
  - name: The formal name of the power system (e.g., "Nen", "Quirks", "Devil Fruits", "Breathing Techniques")
  - mechanics: How powers work in this world
  - limitations: Costs, restrictions, or drawbacks of using powers
  - tiers: List of power levels or ranks if they exist""")
        
        elif topic == "tone":
            topic_instructions.append("""- **tone**: Assess the overall mood (0=minimum, 10=maximum):
  - comedy_level: How comedic is the series? (0=dead serious like Monster, 10=pure comedy like Gintama)
  - darkness_level: How dark/grim is the content? (0=lighthearted like K-On, 10=grimdark like Berserk)
  - optimism: How hopeful is the worldview? (0=cynical/nihilistic, 10=idealistic/uplifting)

- **world_tier**: The BASELINE power tier for this anime world.
  
  CRITICAL: Rate the power of a TYPICAL MID-ARC VILLAIN or COMPETENT ALLY.
  Think: "What tier is an Episode 10-15 opponent?" NOT the final boss or protagonist peak.
  
  EXCLUDE: Protagonist's final form, main antagonist at full power, god-tier beings, endgame power levels.
  INCLUDE: Mid-arc villains, starting protagonist power, allies, average soldiers.
  
  VS Battles tiers: T10=human, T9=street, T8=building, T7=city block, T6=city, T5=island, T4=planet, T3=stellar, T2=universal
  
  Examples:
  - Death Note: T10 (normal humans)
  - Akira: T8 (espers, military) - NOT T2 (Tetsuo is an outlier)
  - Demon Slayer: T8 (mid-tier demon slayers)
  - JoJo: T8 (most Stand users) - NOT T2 (GER is an outlier)
  - Jujutsu Kaisen: T7 (Grade 1 sorcerers)
  - Naruto: T6 (Jonin-level) - NOT T4 (Six Paths endgame)
  - Dragon Ball Z: T4 (Saiyan Saga) - NOT T2 (Buu Saga peaks)

- **dna_scales**: Rate each narrative dimension 0-10 based on the research:
  - introspection_vs_action: 0=internal monologue focus, 10=pure action sequences
  - comedy_vs_drama: 0=serious drama, 10=comedy-focused
  - simple_vs_complex: 0=straightforward plot, 10=layered mystery/intrigue
  - power_fantasy_vs_struggle: 0=overpowered protagonist wins easily, 10=underdog constantly struggling
  - explained_vs_mysterious: 0=rules clearly explained, 10=magic/powers remain enigmatic
  - fast_paced_vs_slow_burn: 0=rapid escalation/short arcs, 10=slow character development
  - episodic_vs_serialized: 0=standalone episodes, 10=one continuous story
  - grounded_vs_absurd: 0=realistic/grounded, 10=over-the-top/ridiculous
  - tactical_vs_instinctive: 0=strategic/planned combat, 10=instinct/emotion-driven fights
  - hopeful_vs_cynical: 0=optimistic world, 10=dark/cynical worldview
  - ensemble_vs_solo: 0=team-focused narrative, 10=single protagonist focus

- **tropes**: Set to TRUE if this trope appears in the series:
  - tournament_arc: Organized competition arc
  - training_montage: Dedicated training sequences
  - power_of_friendship: Bonds strengthen characters literally
  - mentor_death: Important mentor figure dies
  - chosen_one: Protagonist has special destiny
  - tragic_backstory: Characters have dark pasts
  - redemption_arc: Villain becomes ally
  - betrayal: Ally turns against heroes
  - sacrifice: Character gives life for others
  - transformation: Power-up transformations
  - forbidden_technique: Dangerous secret moves
  - time_loop: Time manipulation plot
  - false_identity: Hidden identity reveals
  - ensemble_focus: Large cast shares spotlight
  - slow_burn_romance: Gradual romantic development""")
        
        elif topic == "combat":
            topic_instructions.append("""- **combat**: Identify the primary combat style:
  - "tactical": Strategy and planning dominate (Death Note, Code Geass)
  - "spectacle": Flashy action and choreography (Demon Slayer, Dragon Ball)
  - "comedy": Combat primarily for laughs (One Punch Man, Konosuba)
  - "spirit": Willpower/emotions determine outcomes (Gurren Lagann, Fairy Tail)
  - "narrative": Combat serves story over mechanics (Monster, Steins;Gate)""")
        
        elif topic == "characters":
            topic_instructions.append("- **characters**: Extract protagonist name/role, antagonist name/role, and list of key supporting characters")
        elif topic == "factions":
            topic_instructions.append("- **factions**: List major organizations/groups with their name, description, and narrative role")
        elif topic == "locations":
            topic_instructions.append("- **locations**: Extract setting description, key locations, and time period/era")
        elif topic == "arcs":
            topic_instructions.append("- **arcs**: List major story arcs with name and brief summary")
        elif topic == "sequels":
            topic_instructions.append("- **sequels**: List any sequel series, spinoffs, or prequels")
        elif topic == "adaptations":
            topic_instructions.append("- **adaptations**: Note key differences between manga/anime/etc versions")
        elif topic == "recent":
            topic_instructions.append("- **recent**: Current story arc and recent developments for ongoing series")
        elif topic == "series_aliases":
            topic_instructions.append("""- **series_aliases**: Extract series relationship and naming info:
  - series_group: Unique identifier in snake_case for THIS specific series:
    * CANONICAL sequels share parent's group: DBZ uses "dragon_ball", Shippuden uses "naruto"
    * SPINOFFS/ALTERNATES get UNIQUE group: GT uses "dragon_ball_gt", Fumoffu uses "full_metal_panic_fumoffu"
  - series_position: Position in canonical timeline (1=original, 2=first sequel, etc). Only for canonical series.
  - related_franchise: Parent franchise ONLY if spinoff/alternate (e.g., "dragon_ball" for GT, null for DBZ)
  - relation_type: "canonical" | "spinoff" | "alternate_timeline" | "parody"
    * canonical = direct sequel/prequel in main timeline (DBZ, Shippuden)
    * spinoff = related but separate story (DB Heroes, Fumoffu)
    * alternate_timeline = different continuity (GT, FMA Brotherhood, Hellsing Ultimate)
    * parody = comedy/parody version
  - native_title: Japanese/Korean/Chinese title in original script
  - romanized_title: Romanized version
  - abbreviations: Common abbreviations (DBZ, AOT, HxH)""")
    
    instructions = "\n".join(topic_instructions)
    
    return f"""# Extract Structured Data for {anime_name}

Analyze the research text and extract structured data. DO NOT use default values - assess each field based on the actual content.

## Fields to Extract:

{instructions}

## Important:
- For 0-10 scales, choose values that reflect the ACTUAL series, not defaults
- For tropes, set TRUE only if the trope genuinely appears
- Base all assessments on the research text provided

## Research Text:
"""

