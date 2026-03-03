"""
Extended handoff test - simulates full Session Zero handoff and tests orchestrator responses.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.getcwd())

from src.db.session import init_db
from src.settings import get_settings_store, reset_settings_store


def setup_spoofed_profile():
    """Set up a spoofed Demon Slayer profile in settings."""
    print("=" * 60)
    print("HANDOFF TEST - Extended with Orchestrator Response Testing")
    print("=" * 60)

    profile_to_use = "demon_slayer"

    # Step 1: Update settings with spoofed profile
    print("\n1. Setting up spoofed profile in settings...")
    settings_store = get_settings_store()
    current_settings = settings_store.load()
    current_settings.active_profile_id = profile_to_use
    current_settings.active_campaign_id = profile_to_use
    settings_store.save(current_settings)
    reset_settings_store()

    # Verify
    new_store = get_settings_store()
    reloaded = new_store.reload()
    print(f"   Profile set to: {reloaded.active_profile_id}")

    return profile_to_use

def setup_character_data():
    """Setup character data in the campaign to simulate Session Zero handoff."""
    print("\n2. Setting up character data (simulating Session Zero handoff)...")

    from api.routes.game import get_orchestrator, reset_orchestrator

    # Reset orchestrator to pick up new settings
    reset_orchestrator()

    # Initialize DB and get orchestrator
    init_db()
    orchestrator = get_orchestrator()

    # Update character with Session Zero data
    orchestrator.state.update_character(
        name="Deus Versus",
        level=1,
        hp_current=100,
        hp_max=100,
        power_tier="T7",
        abilities=["Hellsing Blood Arts", "Shadow Step", "Demon Sense"]
    )

    # Update world state with starting location
    orchestrator.state.update_world_state(
        location="A small farming village on the outskirts of Japan",
        situation="Spring has broken. After spending the winter helping rebuild the village's defensive wall against demons, you've said your goodbyes and are ready to continue your journey."
    )

    print(f"   Character: {orchestrator.state.get_character().name}")
    print(f"   Location: {orchestrator.state.get_context().location}")
    print(f"   Profile: {orchestrator.profile.name}")

    return orchestrator

async def test_orchestrator_responses(orchestrator):
    """Test orchestrator responses for 2-3 turns."""
    print("\n3. Testing Orchestrator Responses...")
    print("-" * 60)

    test_inputs = [
        "I look around the village one last time before setting off on my journey.",
        "I head down the road toward the nearest town. What do I see along the way?",
        "I stop and observe my surroundings carefully, looking for any signs of demons."
    ]

    for i, player_input in enumerate(test_inputs, 1):
        print(f"\n--- TURN {i} ---")
        print(f"Player: {player_input}")

        try:
            result = await orchestrator.process_turn(player_input)

            # Show narrative (truncated)
            narrative = result.narrative or "[No narrative]"
            if len(narrative) > 500:
                narrative = narrative[:500] + "..."
            print(f"\nNarrative:\n{narrative}")

            # Check for Demon Slayer context in response
            ds_keywords = ["demon", "slayer", "breath", "nichirin", "corps", "hashira", "wisteria", "japan"]
            found_keywords = [kw for kw in ds_keywords if kw.lower() in narrative.lower()]

            if found_keywords:
                print(f"\n✅ Demon Slayer context detected: {found_keywords}")
            else:
                print("\n⚠️ No Demon Slayer keywords found in response")

            # Check for inappropriate isekai/reincarnation content
            bad_keywords = ["isekai", "reincarnation", "another world", "summoned", "transported", "void", "prismatic eye"]
            bad_found = [kw for kw in bad_keywords if kw.lower() in narrative.lower()]

            if bad_found:
                print(f"❌ BAD: Generic isekai content detected: {bad_found}")
            else:
                print("✅ No generic isekai content")

        except Exception as e:
            print(f"❌ ERROR: {e}")
            import traceback
            traceback.print_exc()
            break

    print("\n" + "=" * 60)
    print("TEST COMPLETE")
    print("=" * 60)

async def main():
    setup_spoofed_profile()
    orchestrator = setup_character_data()
    await test_orchestrator_responses(orchestrator)

if __name__ == "__main__":
    asyncio.run(main())
