import asyncio
import sys
import os
import time

# Add src to path
sys.path.append(os.getcwd())

# Clean artifacts first
print("Cleaning old artifacts...", flush=True)
for f in ["src/profiles/princess_mononoke.yaml", "src/profiles/princess_mononoke_lore.txt"]:
    if os.path.exists(f):
        try:
            os.remove(f)
            print(f"Removed {f}", flush=True)
        except Exception as e:
            print(f"Failed to remove {f}: {e}", flush=True)

from src.agents.profile_generator import generate_and_save_profile
from src.agents.progress import ProgressTracker

async def test_generation():
    print("Starting test generation for 'Princess Mononoke'...", flush=True)
    tracker = ProgressTracker()
    
    try:
        # Use a dummy tracker that just prints
        result = await generate_and_save_profile(
            "Princess Mononoke",
            progress_tracker=tracker
        )
        print("\nAPI Returned Result.", flush=True)
        
        # Verify artifacts
        base = "src/profiles/princess_mononoke"
        yaml_exists = os.path.exists(f"{base}.yaml")
        lore_exists = os.path.exists(f"{base}_lore.txt")
        
        print(f"Artifact Check:\nYAML: {yaml_exists}\nLore: {lore_exists}", flush=True)
        
        if yaml_exists and lore_exists:
            print("SUCCESS! All artifacts generated.", flush=True)
        else:
            print("FAILURE! Missing artifacts.", flush=True)
            
    except Exception as e:
        print(f"\nFAILED with Exception: {e}", flush=True)
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(test_generation())
