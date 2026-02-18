"""
Tests for gameplay tools (search_memory, search_lore, faction tools).
Tests the tool handler functions directly using mocked MemoryStore, 
StateManager, and ProfileLibrary instances.
"""

from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Fixtures: mock MemoryStore, StateManager, ProfileLibrary
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_memory():
    """Mock MemoryStore with search/search_hybrid methods."""
    mem = MagicMock()
    mem.search.return_value = [
        {
            "id": "core_1_111",
            "content": "Protagonist wields the Blade of Ashura",
            "metadata": {"type": "core", "heat": 100.0, "flags": "session_zero", "turn": 0},
            "heat": 100.0,
            "distance": 0.1,
            "score": 0.9,
            "base_score": 0.9,
            "boost": 0.0,
        }
    ]
    mem.search_hybrid.return_value = [
        {
            "id": "core_1_111",
            "content": "Protagonist wields the Blade of Ashura",
            "metadata": {"type": "core", "heat": 100.0, "flags": "session_zero", "turn": 0},
            "heat": 100.0,
            "distance": 0.1,
            "score": 1.0,
            "base_score": 0.9,
            "boost": 0.35,
        }
    ]
    # For get_critical_memories
    mem.collection = MagicMock()
    mem.collection.get.return_value = {
        "ids": ["core_1_111"],
        "documents": ["Protagonist wields the Blade of Ashura"],
        "metadatas": [{"type": "core", "flags": "session_zero,plot_critical", "turn": 0}],
    }
    return mem


@pytest.fixture
def mock_state():
    """Mock StateManager with faction methods."""
    state = MagicMock()

    # Mock faction
    faction = MagicMock()
    faction.name = "Shadow Organization"
    faction.description = "A mysterious cabal"
    faction.alignment = "chaotic_evil"
    faction.power_level = "national"
    faction.influence_score = 75
    faction.relationships = {"Hero Guild": "enemy"}
    faction.pc_is_member = False
    faction.pc_rank = None
    faction.pc_reputation = -30
    faction.pc_controls = False
    faction.subordinates = []
    faction.faction_goals = ["World domination"]
    faction.secrets = ["The leader is an ancient demon"]
    faction.current_events = ["Recruiting in the western provinces"]

    state.get_faction_by_name.return_value = faction
    state.get_all_factions.return_value = [faction]

    # Mock NPC for get_npc_by_name
    state.get_npc_by_name.return_value = None
    state.get_all_npcs.return_value = []

    return state


@pytest.fixture
def mock_profile_library():
    """Mock ProfileLibrary with search_lore."""
    lib = MagicMock()
    lib.search_lore.return_value = [
        "Ashura is the legendary blade forged in the fires of Mt. Fury.",
        "Only those with a pure heart can awaken its true power.",
    ]
    return lib


# ---------------------------------------------------------------------------
# Test: _search_memory (with hybrid search)
# ---------------------------------------------------------------------------

class TestSearchMemory:
    def test_basic_search_no_keyword(self, mock_memory):
        from src.agents.gameplay_tools import _search_memory
        results = _search_memory(mock_memory, "Blade of Ashura", limit=5)

        mock_memory.search.assert_called_once_with(
            query="Blade of Ashura", limit=5, boost_on_access=False,
            memory_type=None,
        )
        assert len(results) == 1
        assert results[0]["content"] == "Protagonist wields the Blade of Ashura"
        assert results[0]["type"] == "core"

    def test_keyword_triggers_hybrid(self, mock_memory):
        from src.agents.gameplay_tools import _search_memory
        results = _search_memory(
            mock_memory, "weapon details", limit=5,
            keyword="Ashura",
        )

        mock_memory.search_hybrid.assert_called_once_with(
            query="weapon details", keyword="Ashura", limit=5,
            boost_on_access=False, memory_type=None,
        )
        # Hybrid should NOT call plain search
        mock_memory.search.assert_not_called()
        assert results[0]["score"] == 1.0

    def test_memory_type_filter_forwarded(self, mock_memory):
        from src.agents.gameplay_tools import _search_memory
        _search_memory(mock_memory, "quest details", memory_type="quest")

        mock_memory.search.assert_called_once_with(
            query="quest details", limit=5, boost_on_access=False,
            memory_type="quest",
        )

    def test_keyword_and_type_together(self, mock_memory):
        from src.agents.gameplay_tools import _search_memory
        _search_memory(
            mock_memory, "details", limit=3,
            memory_type="relationship", keyword="Mentor",
        )

        mock_memory.search_hybrid.assert_called_once_with(
            query="details", keyword="Mentor", limit=3,
            boost_on_access=False, memory_type="relationship",
        )


# ---------------------------------------------------------------------------
# Test: _search_lore
# ---------------------------------------------------------------------------

class TestSearchLore:
    def test_basic_lore_search(self, mock_profile_library):
        from src.agents.gameplay_tools import _search_lore
        results = _search_lore(mock_profile_library, "profile_123", "Blade of Ashura")

        mock_profile_library.search_lore.assert_called_once_with(
            profile_id="profile_123",
            query="Blade of Ashura",
            limit=3,
            page_type=None,
        )
        assert len(results) == 2
        assert "lore_passage" in results[0]

    def test_lore_with_page_type(self, mock_profile_library):
        from src.agents.gameplay_tools import _search_lore
        _search_lore(
            mock_profile_library, "profile_123", "Mt. Fury",
            page_type="locations", limit=2,
        )

        mock_profile_library.search_lore.assert_called_once_with(
            profile_id="profile_123",
            query="Mt. Fury",
            limit=2,
            page_type="locations",
        )

    def test_lore_no_results(self, mock_profile_library):
        mock_profile_library.search_lore.return_value = []
        from src.agents.gameplay_tools import _search_lore
        results = _search_lore(mock_profile_library, "profile_123", "nonexistent")

        assert len(results) == 1
        assert "info" in results[0]

    def test_lore_error_handling(self, mock_profile_library):
        mock_profile_library.search_lore.side_effect = RuntimeError("DB error")
        from src.agents.gameplay_tools import _search_lore
        results = _search_lore(mock_profile_library, "profile_123", "test")

        assert len(results) == 1
        assert "error" in results[0]


# ---------------------------------------------------------------------------
# Test: Faction tools
# ---------------------------------------------------------------------------

class TestFactionTools:
    def test_get_faction_details(self, mock_state):
        from src.agents.gameplay_tools import _get_faction_details
        result = _get_faction_details(mock_state, "Shadow Organization")

        mock_state.get_faction_by_name.assert_called_once_with("Shadow Organization")
        assert result["name"] == "Shadow Organization"
        assert result["alignment"] == "chaotic_evil"
        assert result["power_level"] == "national"
        assert result["relationships"] == {"Hero Guild": "enemy"}
        assert result["pc_is_member"] is False
        assert "World domination" in result["faction_goals"]

    def test_get_faction_not_found(self, mock_state):
        mock_state.get_faction_by_name.return_value = None
        from src.agents.gameplay_tools import _get_faction_details
        result = _get_faction_details(mock_state, "Nonexistent")

        assert "error" in result

    def test_list_factions(self, mock_state):
        from src.agents.gameplay_tools import _list_factions
        results = _list_factions(mock_state)

        mock_state.get_all_factions.assert_called_once()
        assert len(results) == 1
        assert results[0]["name"] == "Shadow Organization"
        assert results[0]["alignment"] == "chaotic_evil"

    def test_list_factions_empty(self, mock_state):
        mock_state.get_all_factions.return_value = []
        from src.agents.gameplay_tools import _list_factions
        results = _list_factions(mock_state)

        assert len(results) == 1
        assert "info" in results[0]


# ---------------------------------------------------------------------------
# Test: build_gameplay_tools registration
# ---------------------------------------------------------------------------

class TestBuildGameplayTools:
    def test_registry_has_new_tools(self, mock_memory, mock_state, mock_profile_library):
        from src.agents.gameplay_tools import build_gameplay_tools
        registry = build_gameplay_tools(
            memory=mock_memory,
            state=mock_state,
            profile_library=mock_profile_library,
            profile_id="test_profile",
        )

        tool_names = [t.name for t in registry.all_tools()]
        assert "search_memory" in tool_names
        assert "search_lore" in tool_names
        assert "get_faction_details" in tool_names
        assert "list_factions" in tool_names

    def test_no_lore_without_library(self, mock_memory, mock_state):
        from src.agents.gameplay_tools import build_gameplay_tools
        registry = build_gameplay_tools(
            memory=mock_memory,
            state=mock_state,
            # No profile_library / profile_id
        )

        tool_names = [t.name for t in registry.all_tools()]
        assert "search_lore" not in tool_names
        # But faction tools should still be there
        assert "get_faction_details" in tool_names


# ---------------------------------------------------------------------------
# Test: build_director_tools forwards params
# ---------------------------------------------------------------------------

class TestBuildDirectorTools:
    def test_director_includes_lore_tool(self, mock_memory, mock_state, mock_profile_library):
        from src.agents.director_tools import build_director_tools
        foreshadowing = MagicMock()

        registry = build_director_tools(
            memory=mock_memory,
            state=mock_state,
            foreshadowing=foreshadowing,
            current_turn=5,
            profile_library=mock_profile_library,
            profile_id="test_profile",
        )

        tool_names = [t.name for t in registry.all_tools()]
        assert "search_lore" in tool_names
        assert "get_faction_details" in tool_names
        # Director-specific tools should also be present
        assert "get_active_foreshadowing" in tool_names

    def test_search_memory_params_in_definition(self, mock_memory, mock_state):
        from src.agents.gameplay_tools import build_gameplay_tools
        registry = build_gameplay_tools(memory=mock_memory, state=mock_state)

        # Find search_memory definition
        defns = registry.all_tools()
        search_mem = next(d for d in defns if d.name == "search_memory")

        param_names = [p.name for p in search_mem.parameters]
        assert "memory_type" in param_names
        assert "keyword" in param_names

