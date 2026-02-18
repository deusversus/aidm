"""Test suite for DirectorAgent."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "aidm_v3"))

import asyncio

from dotenv import load_dotenv

from src.agents.director import DirectorAgent, DirectorOutput
from src.db.models import CampaignBible, Session, WorldState
from src.profiles.loader import load_profile

# Load environment variables
load_dotenv()


def test_director_initialization():
    """Test that Director can be initialized."""
    print("=== TEST: Director Initialization ===")
    director = DirectorAgent()
    print(f"✓ Director initialized: {director.agent_name}")
    assert director.agent_name == "director"
    print()


async def test_director_session_review():
    """Test that Director can review a session and update the bible."""
    print("=== TEST: Director Session Review ===")

    # 1. Load a profile
    try:
        profile = load_profile("naruto")
        print(f"✓ Loaded profile: {profile.name}")
    except FileNotFoundError:
        print("⚠ Naruto profile not found, skipping profile-specific test")
        return

    # 2. Mock a Session
    session = Session(
        id=1,
        campaign_id=1,
        turn_count=10,
        summary="The player completed their first mission to retrieve a stolen scroll. "
                "They demonstrated good teamwork with Sakura and cleverness in avoiding direct combat. "
                "Kakashi seemed impressed but said little."
    )
    print(f"✓ Created mock session (ID: {session.id})")

    # 3. Mock a CampaignBible
    bible = CampaignBible(
        id=1,
        campaign_id=1,
        planning_data={
            "current_arc": "Genin Training",
            "active_foreshadowing": []
        }
    )
    print("✓ Created mock CampaignBible")

    # 4. Mock WorldState
    world_state = WorldState(
        id=1,
        campaign_id=1,
        location="Training Ground 7",
        situation="Post-mission debriefing with Team 7"
    )
    print("✓ Created mock WorldState")

    # 5. Initialize Director
    director = DirectorAgent()
    print("✓ Director initialized")

    # 6. Run session review
    print("⏳ Running session review (this may take 5-10 seconds)...")
    try:
        result: DirectorOutput = await director.run_session_review(
            session=session,
            bible=bible,
            profile=profile,
            world_state=world_state
        )

        print("\n=== DIRECTOR OUTPUT ===")
        print(f"Current Arc: {result.current_arc}")
        print(f"Arc Phase: {result.arc_phase}")
        print(f"Tension Level: {result.tension_level:.2f}")
        print(f"Active Foreshadowing: {len(result.active_foreshadowing)} items")
        if result.active_foreshadowing:
            for item in result.active_foreshadowing:
                print(f"  - {item}")
        print(f"Spotlight Debt: {result.spotlight_debt}")
        print(f"\nDirector Notes:\n{result.director_notes}")
        print(f"\nAnalysis:\n{result.analysis}")

        # Assertions
        assert isinstance(result.current_arc, str)
        assert isinstance(result.arc_phase, str)
        assert 0.0 <= result.tension_level <= 1.0
        assert isinstance(result.director_notes, str)
        assert len(result.director_notes) > 20

        print("\n✓ Director session review completed successfully!")

    except Exception as e:
        print(f"✗ Director test failed: {e}")
        import traceback
        traceback.print_exc()
        raise

    print()


async def test_director_with_custom_personality():
    """Test that Director uses custom personality from profile."""
    print("=== TEST: Director with Custom Personality ===")

    # This test verifies the system_prompt_override works
    # We can't directly inspect the prompt, but we can verify it doesn't crash

    # 1. Load profile
    try:
        profile = load_profile("naruto")
        print(f"✓ Loaded profile: {profile.name}")

        if profile.director_personality:
            print("✓ Profile has custom director_personality:")
            print(f"  {profile.director_personality[:100]}...")
        else:
            print("⚠ Profile has no custom director_personality, using default")
    except FileNotFoundError:
        print("⚠ Naruto profile not found, skipping test")
        return

    # 2. Mock minimal data
    session = Session(id=1, campaign_id=1, turn_count=5, summary="Test session")
    bible = CampaignBible(id=1, campaign_id=1, planning_data={})

    # 3. Call Director
    director = DirectorAgent()
    print("⏳ Running Director with custom personality...")
    try:
        result = await director.run_session_review(session, bible, profile)
        print("✓ Director completed with custom personality")
        print(f"  Generated arc: {result.current_arc}")
    except Exception as e:
        print(f"✗ Director test failed: {e}")
        raise

    print()


def main():
    """Run all Director tests."""
    print("\n" + "="*50)
    print("TESTING: DirectorAgent")
    print("="*50 + "\n")

    try:
        # Test 1: Initialization
        test_director_initialization()

        # Test 2: Session Review (async)
        asyncio.run(test_director_session_review())

        # Test 3: Custom Personality (async)
        asyncio.run(test_director_with_custom_personality())

        print("\n" + "="*50)
        print("✓ ALL TESTS PASSED")
        print("="*50 + "\n")

    except Exception as e:
        print("\n" + "="*50)
        print("✗ TESTS FAILED")
        print("="*50 + "\n")
        raise


if __name__ == "__main__":
    main()
