"""
Stress test for the AIDM gameplay loop.
Runs multiple turns through the API and checks for truncation.
"""

import asyncio
import httpx
import time
from typing import List, Dict, Any

# Config
BASE_URL = "http://localhost:8000/api/game"
NUM_TURNS = 5

# Test actions that should produce substantial narrative
TEST_ACTIONS = [
    "I look around the area, taking in my surroundings and searching for anything unusual.",
    "I approach the nearest NPC and try to strike up a conversation about the local area.",
    "I draw my weapon and take a defensive stance, preparing for potential combat.",
    "I cast a detection spell to sense any magical presence nearby.",
    "I recall a memory from my past training that might help in this situation.",
]

# Truncation indicators
TRUNCATION_INDICATORS = [
    # Obvious mid-word cuts
    lambda text: text.endswith("...") and len(text) < 200,
    # Mid-sentence cuts (ends without punctuation)
    lambda text: text and text[-1] not in ".!?\"')",
    # Very short responses
    lambda text: len(text) < 100,
    # Ends with incomplete patterns
    lambda text: any(text.rstrip().endswith(p) for p in ["—", "-", "–", "the", "a", "an", "to", "of"]),
]


def check_truncation(narrative: str) -> Dict[str, Any]:
    """Check for signs of truncation in the narrative."""
    issues = []
    
    if not narrative:
        return {"truncated": True, "issues": ["Empty narrative"]}
    
    # Check each indicator
    if narrative.endswith("...") and len(narrative) < 200:
        issues.append("Ends with '...' and very short")
    
    if narrative and narrative[-1] not in ".!?\"')":
        issues.append(f"Ends without proper punctuation: '{narrative[-20:]}'")
    
    if len(narrative) < 100:
        issues.append(f"Very short response ({len(narrative)} chars)")
    
    bad_endings = ["—", "-", "–", " the", " a", " an", " to", " of", " with"]
    for ending in bad_endings:
        if narrative.rstrip().endswith(ending):
            issues.append(f"Ends with incomplete word/phrase: '{ending}'")
            break
    
    return {
        "truncated": len(issues) > 0,
        "issues": issues,
        "length": len(narrative),
        "last_50": narrative[-50:] if len(narrative) >= 50 else narrative
    }


async def run_turn(client: httpx.AsyncClient, action: str, turn_num: int) -> Dict[str, Any]:
    """Run a single turn and return results."""
    print(f"\n{'='*60}")
    print(f"TURN {turn_num}: {action[:50]}...")
    print(f"{'='*60}")
    
    start = time.time()
    
    try:
        response = await client.post(
            f"{BASE_URL}/turn",
            json={"player_input": action},
            timeout=120.0  # Long timeout for LLM
        )
        
        elapsed = time.time() - start
        
        if response.status_code != 200:
            return {
                "turn": turn_num,
                "action": action,
                "success": False,
                "error": f"HTTP {response.status_code}: {response.text[:200]}",
                "elapsed_ms": int(elapsed * 1000)
            }
        
        data = response.json()
        narrative = data.get("narrative", "")
        
        truncation_check = check_truncation(narrative)
        
        # Print narrative preview
        print(f"\nNarrative ({len(narrative)} chars):")
        print("-" * 40)
        if len(narrative) > 300:
            print(f"{narrative[:150]}...")
            print(f"...{narrative[-150:]}")
        else:
            print(narrative)
        print("-" * 40)
        
        if truncation_check["truncated"]:
            print(f"⚠️  TRUNCATION DETECTED: {truncation_check['issues']}")
        else:
            print("✅ Narrative looks complete")
        
        return {
            "turn": turn_num,
            "action": action,
            "success": True,
            "narrative_length": len(narrative),
            "truncation": truncation_check,
            "intent": data.get("intent", {}).get("intent", "unknown"),
            "outcome": data.get("outcome", {}).get("success_level", "unknown"),
            "elapsed_ms": int(elapsed * 1000)
        }
        
    except httpx.TimeoutException:
        return {
            "turn": turn_num,
            "action": action,
            "success": False,
            "error": "Request timed out (120s)",
            "elapsed_ms": 120000
        }
    except Exception as e:
        return {
            "turn": turn_num,
            "action": action,
            "success": False,
            "error": str(e),
            "elapsed_ms": int((time.time() - start) * 1000)
        }


async def main():
    print("=" * 60)
    print("AIDM GAMEPLAY LOOP STRESS TEST")
    print("=" * 60)
    print(f"Target: {BASE_URL}")
    print(f"Turns: {NUM_TURNS}")
    print()
    
    results: List[Dict[str, Any]] = []
    
    async with httpx.AsyncClient() as client:
        # First, check if server is up
        try:
            health = await client.get(f"{BASE_URL}/context", timeout=5.0)
            print(f"Server status: {health.status_code}")
            if health.status_code != 200:
                print(f"Warning: Server returned {health.status_code}")
        except Exception as e:
            print(f"ERROR: Cannot reach server: {e}")
            return
        
        # Run turns
        for i, action in enumerate(TEST_ACTIONS[:NUM_TURNS], 1):
            result = await run_turn(client, action, i)
            results.append(result)
            
            # Brief pause between turns
            await asyncio.sleep(1)
    
    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    
    successful = [r for r in results if r["success"]]
    failed = [r for r in results if not r["success"]]
    truncated = [r for r in successful if r.get("truncation", {}).get("truncated")]
    
    print(f"Total turns: {len(results)}")
    print(f"Successful: {len(successful)}")
    print(f"Failed: {len(failed)}")
    print(f"Truncated: {len(truncated)}")
    
    if successful:
        avg_length = sum(r["narrative_length"] for r in successful) / len(successful)
        avg_time = sum(r["elapsed_ms"] for r in successful) / len(successful)
        print(f"Avg narrative length: {avg_length:.0f} chars")
        print(f"Avg response time: {avg_time:.0f}ms")
    
    if truncated:
        print("\n⚠️  TRUNCATION DETAILS:")
        for r in truncated:
            print(f"  Turn {r['turn']}: {r['truncation']['issues']}")
            print(f"    Last 50 chars: '{r['truncation']['last_50']}'")
    
    if failed:
        print("\n❌ FAILURES:")
        for r in failed:
            print(f"  Turn {r['turn']}: {r['error']}")
    
    print("\n" + "=" * 60)
    if truncated:
        print("RESULT: ⚠️  TRUNCATION DETECTED")
    elif failed:
        print("RESULT: ❌ FAILURES OCCURRED")
    else:
        print("RESULT: ✅ ALL PASSES COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
