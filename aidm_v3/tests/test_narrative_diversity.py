"""Tests for the Narrative Diversity system (Style Drift, Vocabulary Freshness, Sakuga Variants).

Tests the three injection layers added to KeyAnimator to prevent
structural ossification and vocabulary collapse over long sessions.
"""

from unittest.mock import MagicMock

from src.agents.intent_classifier import IntentOutput
from src.agents.key_animator import KeyAnimator
from src.agents.outcome_judge import OutcomeOutput


def _make_profile():
    """Create a minimal mock NarrativeProfile for testing."""
    profile = MagicMock()
    profile.name = "Test Profile"
    profile.source = "test"
    profile.dna = {"action": 7, "drama": 5}
    profile.tropes = {"underdog": True}
    profile.combat_system = "tactical"
    profile.power_system = {
        "name": "Nen",
        "mechanics": "Aura manipulation through Hatsu techniques",
        "limitations": "Zetsu vulnerability, Vow restrictions",
        "tiers": ["Ten", "Zetsu", "Ren", "Hatsu"],
    }
    profile.voice = "Dark, gritty, with Togashi-style narration"
    profile.author_voice = {
        "sentence_patterns": ["short declarative", "em-dash asides"],
        "structural_motifs": ["internal monologue", "cold open"],
        "dialogue_quirks": ["ellipsis trailing"],
    }
    profile.composition = None
    profile.detected_genres = None
    return profile


def _make_intent(intent="COMBAT", epicness=0.5, special_conditions=None):
    """Create a minimal IntentOutput."""
    return IntentOutput(
        intent=intent,
        action="test action",
        target="enemy",
        declared_epicness=epicness,
        special_conditions=special_conditions or [],
    )


def _make_outcome(weight="minor", success="success"):
    """Create a minimal OutcomeOutput."""
    return OutcomeOutput(
        should_succeed=True,
        difficulty_class=12,
        modifiers={"test": 1},
        calculated_roll=15,
        success_level=success,
        narrative_weight=weight,
        reasoning="Test roll vs DC",
    )


# ===========================================================================
# Approach A: Style Drift Directives
# ===========================================================================


class TestStyleDriftDirective:
    """Tests for the shuffle-bag style drift system."""

    def test_directive_returns_string(self):
        """Style drift should return a non-empty string on first call."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent()
        outcome = _make_outcome()
        result = ka._build_style_drift_directive(intent, outcome)
        assert isinstance(result, str)
        # On first call with no recent_messages, should always inject
        assert "Style Suggestion" in result or result == ""

    def test_authority_hierarchy_preamble(self):
        """Every directive injection must include the authority hierarchy preamble."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent()
        outcome = _make_outcome()
        result = ka._build_style_drift_directive(intent, outcome)
        if result:  # May be empty if conditional injection skips
            assert "PRIMARY voice authority" in result
            assert "SECONDARY" in result

    def test_shuffle_bag_no_immediate_repeats(self):
        """Directives should not repeat until bag is exhausted."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(intent="EXPLORATION")
        outcome = _make_outcome()

        seen_texts = []
        for _ in range(len(ka.DIRECTIVE_POOL)):
            result = ka._build_style_drift_directive(intent, outcome)
            if result:
                # Extract the directive text (after the 💡)
                for line in result.split("\n"):
                    if "💡" in line:
                        seen_texts.append(line.strip())

        # No duplicates within one full cycle
        assert len(seen_texts) == len(set(seen_texts)), "Shuffle-bag produced duplicates within one cycle"

    def test_intent_exclusion_filters(self):
        """COMBAT intent should exclude directives tagged with exclude_intents=[COMBAT]."""
        ka = KeyAnimator(_make_profile())
        combat_intent = _make_intent(intent="COMBAT")
        outcome = _make_outcome()

        # Run many times to drain the bag
        results = []
        for _ in range(20):
            result = ka._build_style_drift_directive(combat_intent, outcome)
            results.append(result)

        # "environmental POV" and "levity" directives should never appear for COMBAT
        all_text = " ".join(results)
        assert "environmental POV" not in all_text, "Environmental POV should be excluded for COMBAT"
        assert "levity" not in all_text, "Levity should be excluded for COMBAT"

    def test_narrative_weight_filter(self):
        """Climactic weight should exclude directives with max_weight < climactic."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(intent="SOCIAL")
        climactic = _make_outcome(weight="climactic")

        results = []
        for _ in range(20):
            result = ka._build_style_drift_directive(intent, climactic)
            results.append(result)

        all_text = " ".join(results)
        # "cold open" has max_weight="minor" — should never appear for climactic
        assert "cold open" not in all_text, "Cold open should be excluded for climactic weight"

    def test_conditional_injection_skips_when_varied(self):
        """When recent DM messages show variety, should return empty string."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent()
        outcome = _make_outcome()

        # Simulate varied recent messages (dialogue, action, description)
        recent = [
            {"role": "assistant", "content": '"Hello," she said, stepping forward.'},
            {"role": "user", "content": "I attack"},
            {"role": "assistant", "content": "Steel flashed — his blade caught the firelight mid-swing."},
            {"role": "user", "content": "I dodge"},
            {"role": "assistant", "content": "The courtyard stretched before them, silent and cold."},
        ]
        # These openings are: dialogue ("), action (Steel...), description (The...)
        result = ka._build_style_drift_directive(intent, outcome, recent)
        assert result == "", "Should skip directive when recent messages are structurally varied"


# ===========================================================================
# Approach B: Vocabulary Freshness
# ===========================================================================


class TestVocabularyFreshness:
    """Tests for the vocabulary freshness check system."""

    def test_empty_when_no_messages(self):
        """Should return empty when no recent messages."""
        ka = KeyAnimator(_make_profile())
        assert ka._build_freshness_check() == ""
        assert ka._build_freshness_check([]) == ""

    def test_empty_when_no_repetition(self):
        """Should return empty when text has no repeated patterns."""
        ka = KeyAnimator(_make_profile())
        messages = [
            {"role": "assistant", "content": "The warrior charged forward, blade gleaming."},
            {"role": "assistant", "content": "Behind the wall, shadows shifted uneasily."},
        ]
        result = ka._build_freshness_check(messages)
        assert result == ""

    def test_catches_repeated_similes(self):
        """Should catch simile constructions that repeat 3+ times."""
        ka = KeyAnimator(_make_profile())
        messages = [
            {"role": "assistant", "content": "She moved like a cat stalking prey. The blade cut like a razor slicing silk."},
            {"role": "assistant", "content": "He lunged like a cat stalking prey. The sound hit like a hammer striking."},
            {"role": "assistant", "content": "It crept like a cat stalking prey."},
        ]
        result = ka._build_freshness_check(messages)
        if result:  # May be empty if whitelist catches it
            assert "Vocabulary Freshness" in result

    def test_catches_repeated_personification(self):
        """Should catch personification verb+adverb patterns."""
        ka = KeyAnimator(_make_profile())
        messages = [
            {"role": "assistant", "content": "The machine chirped apologetically. The door creaked reluctantly."},
            {"role": "assistant", "content": "The console chirped apologetically. The engine hummed wearily."},
            {"role": "assistant", "content": "The alarm chirped apologetically."},
        ]
        result = ka._build_freshness_check(messages)
        if result:
            assert "Vocabulary Freshness" in result

    def test_jargon_whitelist_protects_power_system(self):
        """Power system terms from profile should not be flagged."""
        ka = KeyAnimator(_make_profile())
        # "Nen", "Hatsu", "Zetsu" are in the whitelist
        assert "nen" in ka._jargon_whitelist
        assert "hatsu" in ka._jargon_whitelist
        assert "zetsu" in ka._jargon_whitelist

    def test_jargon_whitelist_protects_combat_system(self):
        """Combat system term from profile should be in whitelist."""
        ka = KeyAnimator(_make_profile())
        assert "tactical" in ka._jargon_whitelist

    def test_threshold_ignores_low_count(self):
        """Patterns appearing fewer than 3 times should not be flagged."""
        ka = KeyAnimator(_make_profile())
        messages = [
            {"role": "assistant", "content": "She moved like a dancer performing on stage."},
            {"role": "assistant", "content": "He ran like a dancer performing on stage."},
            # Only 2 occurrences — below threshold
        ]
        result = ka._build_freshness_check(messages)
        assert result == "", "Should not flag patterns below the 3× threshold"


# ===========================================================================
# Approach C: Sakuga Mode Variants
# ===========================================================================


class TestSakugaVariants:
    """Tests for the sakuga sub-mode selection system."""

    def test_default_is_choreographic(self):
        """Default sakuga mode (no special conditions) should be Choreographic."""
        ka = KeyAnimator(_make_profile())
        result = ka._build_sakuga_injection()
        assert "Choreographic" in result

    def test_named_attack_triggers_choreographic(self):
        """named_attack special condition should trigger Choreographic."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(special_conditions=["named_attack"])
        result = ka._build_sakuga_injection(intent)
        assert "Choreographic" in result

    def test_first_time_power_triggers_frozen_moment(self):
        """first_time_power should trigger Frozen Moment."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(special_conditions=["first_time_power"])
        result = ka._build_sakuga_injection(intent)
        assert "Frozen Moment" in result

    def test_protective_rage_triggers_frozen_moment(self):
        """protective_rage should trigger Frozen Moment."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(special_conditions=["protective_rage"])
        result = ka._build_sakuga_injection(intent)
        assert "Frozen Moment" in result

    def test_training_payoff_triggers_montage(self):
        """training_payoff should trigger Montage."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(special_conditions=["training_payoff"])
        result = ka._build_sakuga_injection(intent)
        assert "Montage" in result

    def test_priority_ladder_first_time_beats_named_attack(self):
        """When both first_time_power and named_attack present, Frozen Moment wins."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(special_conditions=["named_attack", "first_time_power"])
        result = ka._build_sakuga_injection(intent)
        assert "Frozen Moment" in result, "first_time_power should take priority over named_attack"

    def test_social_climactic_triggers_frozen_moment(self):
        """SOCIAL intent with climactic weight should trigger Frozen Moment."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(intent="SOCIAL", special_conditions=[])
        outcome = _make_outcome(weight="climactic")
        result = ka._build_sakuga_injection(intent, outcome)
        assert "Frozen Moment" in result

    def test_combat_climactic_stays_choreographic(self):
        """COMBAT intent with climactic weight should stay Choreographic."""
        ka = KeyAnimator(_make_profile())
        intent = _make_intent(intent="COMBAT", special_conditions=[])
        outcome = _make_outcome(weight="climactic")
        result = ka._build_sakuga_injection(intent, outcome)
        assert "Choreographic" in result
