"""
Quick test script to test the orchestrator directly without going through Session Zero UI.
Run: python test_orchestrator.py "your action here"
"""
import asyncio
import sys
import time

async def test_turn(action: str):
    """Test a single turn through the orchestrator."""
    from src.core.orchestrator import Orchestrator
    from src.profiles.loader import load_profile
    from src.settings import get_settings_store
    
    # Load settings and profile
    settings = get_settings_store().load()
    profile_id = settings.active_profile_id or "hellsing"
    
    print(f"[Test] Loading profile: {profile_id}")
    try:
        profile = load_profile(profile_id)
    except FileNotFoundError:
        # Fall back to any available profile
        from src.profiles.loader import list_profiles
        available = list_profiles()
        if available:
            profile_id = available[0]
            print(f"[Test] Profile not found, using: {profile_id}")
            profile = load_profile(profile_id)
        else:
            print("[Test] ERROR: No profiles available!")
            return
    
    print(f"[Test] Profile loaded: {profile.name}")
    print(f"[Test] Processing action: '{action}'")
    print("-" * 60)
    
    # Create orchestrator (uses profile_id, not profile object)
    orchestrator = Orchestrator(campaign_id=1, profile_id=profile_id)
    
    # Process turn
    start = time.time()
    try:
        result = await orchestrator.process_turn(action)
        elapsed = time.time() - start
        
        print(f"\n[RESULT] Latency: {elapsed:.1f}s ({result.latency_ms}ms internal)")
        print(f"[RESULT] Intent: {result.intent.intent} - {result.intent.action}")
        print(f"[RESULT] Outcome: {result.outcome.success_level} ({result.outcome.narrative_weight})")
        print(f"[RESULT] Narrative length: {len(result.narrative)} chars")
        print("-" * 60)
        print("NARRATIVE:")
        print(result.narrative if result.narrative else "[EMPTY NARRATIVE!]")
        print("-" * 60)
        
        if not result.narrative:
            print("\n⚠️  EMPTY NARRATIVE DETECTED!")
            print("This is the bug we're tracking.")
            
    except Exception as e:
        import traceback
        print(f"\n[ERROR] {e}")
        traceback.print_exc()

if __name__ == "__main__":
    action = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "I look around carefully"
    asyncio.run(test_turn(action))
