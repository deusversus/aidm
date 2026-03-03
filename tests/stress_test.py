"""
Stress test for AIDM v3 gameplay pipeline.
Tests the full input -> orchestrator -> output flow.
"""

import asyncio
import os
import sys

# Add src to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.core.orchestrator import Orchestrator


async def test_gameplay_loop():
    """Run through several test turns to verify the pipeline."""

    print("=" * 60)
    print("AIDM v3 Gameplay Pipeline Stress Test")
    print("=" * 60)
    print()

    # Test with HunterxHunter profile (the default)
    profile_id = "hunterxhunter"
    campaign_id = 999  # Test campaign

    print(f"Profile: {profile_id}")
    print(f"Campaign: {campaign_id}")
    print()

    # Initialize orchestrator
    print("[1] Initializing Orchestrator...")
    try:
        orchestrator = Orchestrator(campaign_id=campaign_id, profile_id=profile_id)
        print("    ✅ Orchestrator initialized")
        print(f"    Profile: {orchestrator.profile.name}")
        print("    Agents loaded: intent_classifier, outcome_judge, key_animator, sakuga, validator, combat, progression")
        print()
    except Exception as e:
        print(f"    ❌ Failed: {e}")
        return False

    # Test inputs - variety of action types
    test_inputs = [
        ("EXPLORATION", "I look around the Dark Continent entrance, trying to spot any danger."),
        ("SOCIAL", "I greet the mysterious Hunter examiner and ask about the next phase."),
        ("COMBAT", "I launch a Nen-enhanced punch at the chimera ant soldier!"),
        ("CREATIVE", "I try to develop a new Nen technique by focusing my aura into my fingertips."),
    ]

    results = []

    for i, (expected_type, player_input) in enumerate(test_inputs, 1):
        print(f"[{i+1}] Testing {expected_type} action...")
        print(f"    Input: \"{player_input[:50]}...\"")

        try:
            result = await orchestrator.process_turn(player_input)

            print(f"    ✅ Turn processed in {result.latency_ms}ms")
            print(f"    Intent: {result.intent.intent}")
            print(f"    Outcome: {result.outcome.success_level}")
            print(f"    Narrative: {result.narrative[:100]}...")
            print()

            results.append({
                "type": expected_type,
                "success": True,
                "latency": result.latency_ms,
                "intent": result.intent.intent,
                "outcome": result.outcome.success_level
            })

        except Exception as e:
            print(f"    ❌ Failed: {e}")
            results.append({
                "type": expected_type,
                "success": False,
                "error": str(e)
            })
            print()

    # Summary
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)

    successful = sum(1 for r in results if r.get("success"))
    print(f"Turns completed: {successful}/{len(results)}")

    if successful > 0:
        avg_latency = sum(r.get("latency", 0) for r in results if r.get("success")) / successful
        print(f"Average latency: {avg_latency:.0f}ms")

    # Check memory store
    print()
    print("[Memory Store Check]")
    print(f"    Memories added this session: {orchestrator.memory.count()}")

    # Cleanup
    orchestrator.close()

    if successful == len(results):
        print()
        print("✅ ALL TESTS PASSED!")
        return True
    else:
        print()
        print(f"⚠️ {len(results) - successful} tests failed")
        return False


if __name__ == "__main__":
    success = asyncio.run(test_gameplay_loop())
    sys.exit(0 if success else 1)
