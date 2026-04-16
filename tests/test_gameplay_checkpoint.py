"""Tests for the gameplay crash-recovery checkpoint and entity-graph snapshot.

Covers:
  - Enriched checkpoint payload (diagnostic fields for UI banner)
  - Checkpoint completion preserves diagnostic fields (not a thin stub)
  - Entity graph snapshot captures NPCs, locations, and factions
  - Content-hash dedup — unchanged world state does NOT create a new version
  - Changed state DOES create a new version (real audit trail)
"""

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

import pytest

from src.db.session import get_session
from src.db.session_zero_artifacts import (
    get_active_artifact,
    list_artifacts,
    load_artifact_content,
    save_artifact,
)


# ── Checkpoint dedup / completion preservation ───────────────────────────────

def test_checkpoint_completion_preserves_diagnostic_fields():
    """Saving a 'completed' checkpoint on top of a pre-background stub should
    preserve the diagnostic fields by merging the prior payload first."""
    campaign_id = "91001"

    # Simulate the pre-background checkpoint write
    with get_session() as db:
        save_artifact(
            db, campaign_id, "gameplay_turn_checkpoint",
            {
                "turn_number": 5,
                "background_completed": False,
                "intent": "COMBAT",
                "action": "attack the dragon",
                "narrative_preview": "Steel rings against scale...",
                "player_input_preview": "I swing my sword",
                "latency_ms": 1234,
            },
        )

    # Simulate the completion write (merging prior fields)
    with get_session() as db:
        prior = get_active_artifact(db, campaign_id, "gameplay_turn_checkpoint")
        prior_data = load_artifact_content(prior)
        save_artifact(
            db, campaign_id, "gameplay_turn_checkpoint",
            {**prior_data, "background_completed": True, "background_latency_ms": 567},
        )

    # Latest checkpoint should carry the diagnostic fields AND the completion flag
    with get_session() as db:
        latest = get_active_artifact(db, campaign_id, "gameplay_turn_checkpoint")
        data = load_artifact_content(latest)

    assert data["background_completed"] is True
    assert data["intent"] == "COMBAT"
    assert data["action"] == "attack the dragon"
    assert data["narrative_preview"].startswith("Steel")
    assert data["player_input_preview"] == "I swing my sword"
    assert data["background_latency_ms"] == 567


# ── Entity graph snapshot ─────────────────────────────────────────────────────

def test_entity_graph_dedup_when_state_unchanged():
    """Identical snapshot content should NOT create a new artifact version."""
    campaign_id = "91002"
    snapshot = {
        "turn_number": 5,
        "npcs": [{"id": 1, "name": "Alice", "disposition": 30}],
        "locations": [],
        "factions": [],
    }

    with get_session() as db:
        save_artifact(db, campaign_id, "gameplay_entity_graph", snapshot)
    with get_session() as db:
        # Same content — dedup should fire
        save_artifact(db, campaign_id, "gameplay_entity_graph", snapshot)

    with get_session() as db:
        versions = list_artifacts(db, campaign_id, artifact_type="gameplay_entity_graph")

    assert len(versions) == 1, (
        f"Expected 1 artifact after dedup, got {len(versions)} versions"
    )


def test_entity_graph_new_version_when_state_changes():
    """Real state drift should produce a new versioned artifact."""
    campaign_id = "91003"
    base = {
        "turn_number": 5,
        "npcs": [{"id": 1, "name": "Alice", "disposition": 30}],
        "locations": [],
        "factions": [],
    }
    updated = {
        "turn_number": 10,
        "npcs": [{"id": 1, "name": "Alice", "disposition": 75}],  # affinity rose
        "locations": [],
        "factions": [],
    }

    with get_session() as db:
        save_artifact(db, campaign_id, "gameplay_entity_graph", base)
    with get_session() as db:
        save_artifact(db, campaign_id, "gameplay_entity_graph", updated)

    # Read everything we need while the session is open — the ORM instances
    # would detach and refuse to lazy-load statuses otherwise.
    with get_session() as db:
        versions = list_artifacts(db, campaign_id, artifact_type="gameplay_entity_graph")
        statuses = [v.status for v in versions]
        active_payload = next(
            (load_artifact_content(v) for v in versions if v.status == "active"),
            None,
        )

    assert len(versions) >= 2
    assert statuses.count("active") == 1
    assert active_payload is not None
    assert active_payload["npcs"][0]["disposition"] == 75


def test_entity_graph_captures_all_three_sections():
    """Snapshot must include NPCs, locations, AND factions — not just NPCs."""
    campaign_id = "91004"
    snapshot = {
        "turn_number": 1,
        "npcs": [{"id": 1, "name": "Alice"}],
        "locations": [{"id": 1, "name": "Tavern", "current_state": "intact"}],
        "factions": [{"id": 1, "name": "Thieves Guild", "pc_reputation": 150}],
    }

    with get_session() as db:
        save_artifact(db, campaign_id, "gameplay_entity_graph", snapshot)

    with get_session() as db:
        active = get_active_artifact(db, campaign_id, "gameplay_entity_graph")
        data = load_artifact_content(active)

    assert len(data["npcs"]) == 1
    assert len(data["locations"]) == 1
    assert len(data["factions"]) == 1
    assert data["factions"][0]["pc_reputation"] == 150
    assert data["locations"][0]["current_state"] == "intact"
