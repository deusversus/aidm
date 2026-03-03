"""
Debug script - calls through FULL ORCHESTRATOR to capture exact response path.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.core.orchestrator import Orchestrator
from src.settings import get_settings_store


async def debug_orchestrator():
    """Call through the full orchestrator and capture output."""

    print("=" * 80)
    print("AIDM ORCHESTRATOR DEBUG")
    print("=" * 80)

    settings = get_settings_store().load()
    profile_id = settings.active_profile_id or "default"
    print(f"Profile: {profile_id}")

    # Create orchestrator (same as API does)
    orchestrator = Orchestrator(profile_id)

    test_input = "I look around carefully, taking in every detail of my surroundings."
    print(f"\nInput: {test_input}")
    print("\n[CALLING orchestrator.process_turn()...]")

    # Call the full orchestrator
    result = await orchestrator.process_turn(test_input)

    # Save the narrative
    narrative = result.narrative

    with open("debug_orchestrator_narrative.txt", "w", encoding="utf-8") as f:
        f.write(narrative)

    print("\n" + "=" * 80)
    print("ORCHESTRATOR RESULT")
    print("=" * 80)
    print(f"Narrative length: {len(narrative)} chars")
    print(f"Intent: {result.intent.intent}")
    print(f"Outcome: {result.outcome.success_level if result.outcome else 'None'}")
    print("-" * 80)

    # Encode safely for console
    safe_narrative = narrative.encode('ascii', 'replace').decode('ascii')
    print(safe_narrative)

    print("-" * 80)
    print("\nSaved to: debug_orchestrator_narrative.txt")

    # Check for truncation
    issues = []
    if narrative and narrative[-1] not in ".!?\"')":
        issues.append(f"Ends without punctuation: '{narrative[-30:]}'")
    if len(narrative) < 200:
        issues.append(f"Very short ({len(narrative)} chars)")

    if issues:
        print("\n⚠️ POTENTIAL TRUNCATION:")
        for issue in issues:
            print(f"  {issue}")
    else:
        print("\n✅ Narrative appears complete")


async def main():
    await debug_orchestrator()


if __name__ == "__main__":
    asyncio.run(main())
