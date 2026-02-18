"""Tests for PromptBuilderMixin (the extracted prompt logic from key_animator).

Tests the template loading, profile DNA rendering, scene context
construction, and outcome formatting — all with mock profile data.
"""

from dataclasses import dataclass
from unittest.mock import MagicMock

from src.agents._key_animator_prompt import PromptBuilderMixin

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class ConcretePromptBuilder(PromptBuilderMixin):
    """Concrete subclass so we can instantiate the mixin for testing.
    
    The mixin methods read from self.profile — so we set it up here.
    """

    def __init__(self, profile=None):
        self._vibe_keeper_template = None
        self._npc_context = None
        self._static_rule_guidance = ""
        self.profile = profile


@dataclass
class FakeContext:
    """Lightweight context that supports format strings (unlike MagicMock)."""
    location: str = "Dark Forest"
    time_of_day: str = "night"
    situation: str = "A shadowy figure approaches"
    arc_phase: str = "rising_action"
    tension_level: float = 0.5
    session_number: int = 3
    turn_number: int = 15
    protagonist_name: str = "Spike"
    profile_id: str = "cowboy_bebop"
    character_summary: str = "Bounty hunter, laid-back, skilled fighter"
    recent_summary: str = ""
    present_npcs: list = None
    op_protagonist_enabled: bool = False
    director_notes: str = ""

    def __post_init__(self):
        if self.present_npcs is None:
            self.present_npcs = []


def _make_profile(
    name="Cowboy Bebop",
    source="cowboy_bebop",
    dna=None,
    tropes=None,
    combat_system="gun_kata",
    power_system=None,
    tone=None,
    composition=None,
    voice_cards=None,
    voice="Write in a jazzy, melancholic style.",
    detected_genres=None,
    author_voice=None,
):
    """Build a mock profile with real attrs (not MagicMock) for PromptBuilderMixin.
    
    IMPORTANT: We use spec=[] to prevent MagicMock from auto-creating
    truthy attributes for fields the mixin accesses via getattr().
    """
    profile = MagicMock(spec=[])
    profile.name = name
    profile.source = source
    profile.dna = dna or {"realism_fantasy": 4, "comedy_drama": 5, "action_intrigue": 7}
    profile.tropes = tropes or {"cowboy_brotherhood": True, "hot_spring_episode": False}
    profile.combat_system = combat_system
    profile.power_system = power_system
    profile.tone = tone
    profile.composition = composition
    profile.voice_cards = voice_cards
    profile.voice = voice
    profile.detected_genres = detected_genres
    profile.author_voice = author_voice
    return profile


# ---------------------------------------------------------------------------
# Tests: Template Loading
# ---------------------------------------------------------------------------

class TestTemplateLoading:
    def test_default_template_is_method(self):
        builder = ConcretePromptBuilder()
        template = builder._default_template()
        assert isinstance(template, str)
        assert len(template) > 100
        assert "##" in template  # Contains markdown headers

    def test_vibe_keeper_template_returns_string(self):
        builder = ConcretePromptBuilder()
        template = builder.vibe_keeper_template
        assert isinstance(template, str)
        assert len(template) > 0


# ---------------------------------------------------------------------------
# Tests: Profile DNA
# ---------------------------------------------------------------------------

class TestBuildProfileDNA:
    def test_renders_dna_scales(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        dna = builder._build_profile_dna()
        assert "DNA Scales" in dna or "dna" in dna.lower()

    def test_renders_tropes(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        dna = builder._build_profile_dna()
        assert "Cowboy Brotherhood" in dna  # Title-cased from key

    def test_renders_combat_system(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        dna = builder._build_profile_dna()
        assert "Gun_Kata" in dna or "Gun Kata" in dna

    def test_renders_source(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        dna = builder._build_profile_dna()
        assert "cowboy_bebop" in dna

    def test_handles_missing_power_system(self):
        profile = _make_profile(power_system=None)
        builder = ConcretePromptBuilder(profile=profile)
        dna = builder._build_profile_dna()
        assert isinstance(dna, str)  # Should not crash

    def test_handles_empty_tropes(self):
        profile = _make_profile(tropes={})
        builder = ConcretePromptBuilder(profile=profile)
        dna = builder._build_profile_dna()
        assert isinstance(dna, str)


# ---------------------------------------------------------------------------
# Tests: Scene Context
# ---------------------------------------------------------------------------

class TestBuildSceneContext:
    def test_includes_location(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        ctx = FakeContext(location="Mystic Tower")
        scene = builder._build_scene_context(ctx)
        assert "Mystic Tower" in scene

    def test_includes_arc_phase(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        ctx = FakeContext(arc_phase="climax", tension_level=0.9)
        scene = builder._build_scene_context(ctx)
        assert "climax" in scene.lower()

    def test_includes_tension_level(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        ctx = FakeContext(tension_level=0.7)
        scene = builder._build_scene_context(ctx)
        assert "0.7" in scene

    def test_no_npc_section_when_empty(self):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        ctx = FakeContext(present_npcs=[])
        scene = builder._build_scene_context(ctx)
        assert isinstance(scene, str)


# ---------------------------------------------------------------------------
# Tests: Outcome Section
# ---------------------------------------------------------------------------

class TestBuildOutcomeSection:
    def test_includes_success_level(self, sample_intent, sample_outcome):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        section = builder._build_outcome_section(sample_intent, sample_outcome)
        assert "success" in section.lower()

    def test_includes_intent(self, sample_intent, sample_outcome):
        profile = _make_profile()
        builder = ConcretePromptBuilder(profile=profile)
        section = builder._build_outcome_section(sample_intent, sample_outcome)
        assert "COMBAT" in section


# ---------------------------------------------------------------------------
# Tests: Static Rule Guidance
# ---------------------------------------------------------------------------

class TestSetStaticRuleGuidance:
    def test_sets_guidance(self):
        builder = ConcretePromptBuilder()
        builder.set_static_rule_guidance("Override: Kai cannot die.")
        assert "Kai" in builder._static_rule_guidance
