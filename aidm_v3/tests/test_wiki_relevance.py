"""Tests for wiki relevance validation in FandomClient.

Verifies that check_wiki_relevance correctly accepts relevant wikis
and rejects irrelevant ones that happen to share a URL slug word.
"""
import asyncio
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.scrapers.fandom import FandomClient, guess_wiki_url_candidates

# ─── Helper ──────────────────────────────────────────────────────────────────

def run_async(coro):
    """Run an async function synchronously for testing."""
    return asyncio.get_event_loop().run_until_complete(coro)


# ─── guess_wiki_url_candidates tests ────────────────────────────────────────

class TestGuessWikiUrlCandidates:
    """Verify URL candidate generation for difficult title patterns."""

    def test_long_isekai_title_english(self):
        """Long isekai titles should still produce candidates."""
        candidates = guess_wiki_url_candidates(
            "I Was Reincarnated as the 7th Prince so I Can Take My Time Perfecting My Magical Ability"
        )
        assert len(candidates) >= 1
        # Should NOT be empty — at least the full slug and first-word candidate
        urls_str = " ".join(candidates)
        assert "fandom.com" in urls_str

    def test_long_isekai_title_romaji(self):
        """Romaji title produces 'tensei.fandom.com' as a candidate."""
        candidates = guess_wiki_url_candidates(
            "Tensei Shitara Dai Nana Ouji Datta node, Kimamani Majutsu wo Kiwamemasu"
        )
        # 'tensei' is the first significant word → candidate
        assert "https://tensei.fandom.com" in candidates

    def test_simple_title(self):
        """Short, direct titles should produce clean candidates."""
        candidates = guess_wiki_url_candidates("Naruto")
        assert "https://naruto.fandom.com" in candidates

    def test_override_takes_priority(self):
        """Override table entries should be returned first."""
        candidates = guess_wiki_url_candidates("Attack on Titan")
        assert candidates[0] == "https://attackontitan.fandom.com"


# ─── check_wiki_relevance tests ─────────────────────────────────────────────

class TestCheckWikiRelevance:
    """Test the relevance validation logic with mocked API responses."""

    def _make_client_with_mocks(self, stats_response, general_response, search_response):
        """Create a FandomClient with mocked _api_query and _get_site_stats."""
        client = FandomClient()

        def mock_api_query(url, params):
            action = params.get("action", "")
            if action == "query":
                meta = params.get("meta", "")
                list_type = params.get("list", "")
                if meta == "siteinfo":
                    siprop = params.get("siprop", "")
                    if siprop == "general":
                        return general_response
                    elif siprop == "statistics":
                        return stats_response
                if list_type == "search":
                    return search_response
            return {}

        client._api_query = mock_api_query
        client._get_site_stats = lambda url: stats_response.get("query", {}).get("statistics", {})
        return client

    def test_relevant_wiki_passes_via_search(self):
        """Wiki where search returns hits should pass (primary gate)."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 500}}},
            general_response={"query": {"general": {"sitename": "Narutopedia"}}},
            search_response={"query": {"searchinfo": {"totalhits": 42}, "search": [
                {"title": "Naruto Uzumaki", "snippet": "Naruto is the main..."}
            ]}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://naruto.fandom.com", "Naruto Shippuden"
        ))
        assert result is True

    def test_relevant_wiki_passes_via_sitename_substring(self):
        """Wiki where sitename contains a title word should pass (secondary gate)."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 500}}},
            general_response={"query": {"general": {"sitename": "Narutopedia"}}},
            # Search returns nothing but sitename contains "naruto"
            search_response={"query": {"searchinfo": {"totalhits": 0}, "search": []}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://naruto.fandom.com", "Naruto Shippuden"
        ))
        assert result is True

    def test_tensei_wiki_rejected_for_7th_prince(self):
        """Tensei wiki should be rejected for 7th Prince — search finds nothing,
        and sitename matching only uses the primary (English) title, not romaji alt titles."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 200}}},
            general_response={"query": {"general": {"sitename": "Tensei Wiki"}}},
            search_response={"query": {"searchinfo": {"totalhits": 0}, "search": []}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://tensei.fandom.com",
            "I Was Reincarnated as the 7th Prince so I Can Take My Time Perfecting My Magical Ability",
            alt_titles=["Tensei Shitara Dai Nana Ouji Datta node, Kimamani Majutsu wo Kiwamemasu"],
        ))
        # "tensei" appears in the romaji alt title and the sitename, but
        # sitename matching only uses the PRIMARY title (English), not alt titles.
        # The English title has no word overlap with "tenseiwiki", and search
        # returned 0 hits — so it's correctly rejected.
        assert result is False

    def test_truly_irrelevant_wiki_rejected(self):
        """Wiki with completely unrelated sitename and no search hits should be rejected."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 200}}},
            general_response={"query": {"general": {"sitename": "Cooking Recipes Wiki"}}},
            search_response={"query": {"searchinfo": {"totalhits": 0}, "search": []}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://cooking.fandom.com",
            "I Was Reincarnated as the 7th Prince so I Can Take My Time Perfecting My Magical Ability",
            alt_titles=["Tensei Shitara Dai Nana Ouji Datta node, Kimamani Majutsu wo Kiwamemasu"],
        ))
        assert result is False

    def test_search_primary_gate_passes(self):
        """Search hits are the primary gate — should pass even with unrelated sitename."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 1000}}},
            general_response={"query": {"general": {"sitename": "Anime Database Wiki"}}},
            search_response={"query": {"searchinfo": {"totalhits": 15}, "search": [
                {"title": "Frieren", "snippet": "Frieren the Slayer..."}
            ]}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://frieren.fandom.com", "Frieren: Beyond Journey's End"
        ))
        assert result is True

    def test_empty_wiki_rejected(self):
        """Wiki with 0 articles should be rejected."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 0}}},
            general_response={"query": {"general": {"sitename": "Empty Wiki"}}},
            search_response={"query": {"searchinfo": {"totalhits": 0}, "search": []}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://empty.fandom.com", "Some Anime"
        ))
        assert result is False

    def test_stop_words_excluded_from_sitename(self):
        """Stop words like 'the', 'was', 'no' should not count as sitename matches."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 100}}},
            general_response={"query": {"general": {"sitename": "The Wiki"}}},
            search_response={"query": {"searchinfo": {"totalhits": 0}, "search": []}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://the.fandom.com",
            "The Rising of the Shield Hero",
        ))
        # "the" is a stop word, shouldn't match
        # "rising" (6 chars) is not in "thewiki", "shield" (6) is not, "hero" (4) is not
        assert result is False

    def test_short_words_excluded_from_sitename(self):
        """Words shorter than _MIN_SITENAME_WORD_LEN should not match sitename."""
        client = self._make_client_with_mocks(
            stats_response={"query": {"statistics": {"articles": 100}}},
            general_response={"query": {"general": {"sitename": "Ran Wiki"}}},
            search_response={"query": {"searchinfo": {"totalhits": 0}, "search": []}},
        )
        result = run_async(client.check_wiki_relevance(
            "https://ran.fandom.com",
            "Ran and the Gray World",
        ))
        # "ran" is only 3 chars, below _MIN_SITENAME_WORD_LEN=4
        assert result is False

    def test_api_error_returns_false(self):
        """API errors should be handled gracefully and return False."""
        client = FandomClient()
        client._api_query = MagicMock(side_effect=Exception("Network error"))
        client._get_site_stats = MagicMock(side_effect=Exception("Network error"))

        result = run_async(client.check_wiki_relevance(
            "https://broken.fandom.com", "Some Anime"
        ))
        assert result is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
