import asyncio
import os
import sys
import yaml
from pathlib import Path
from dotenv import load_dotenv

# Add project root to path
# The script is in tests/, so parent is root, then aidm_v3 contains src
project_root = Path(__file__).parent.parent
aidm_v3_root = project_root / "aidm_v3"
sys.path.append(str(aidm_v3_root))

# Load .env from aidm_v3
load_dotenv(aidm_v3_root / ".env")

from src.agents.profile_generator import generate_and_save_profile, load_existing_profile
from src.settings import get_settings_store

# Ensure we have a settings store (needed for LLM provider config)
# But profile_generator mostly uses environment variables or default providers if not configured?
# Actually, let's make sure we set up the environment if needed.
# For now, we assume the environment is already set up (UVicorn is running).

async def compare_anime(anime_name: str):
    print(f"\n{'='*50}")
    print(f"Testing Profile Generation for: {anime_name}")
    print(f"{'='*50}\n")
    
    # 1. Locate V2 Profile manually
    v2_dir = project_root / "aidm" / "libraries" / "narrative_profiles"
    normalized = anime_name.lower().replace(" ", "_")
    v2_path = v2_dir / f"{normalized}_profile.md"
    
    if v2_path.exists():
        print(f"✅ Found V2 Profile: {v2_path}")
        v2_content = v2_path.read_text(encoding="utf-8")
        print(f"   V2 Size: {len(v2_content)} characters")
        print(f"   V2 Preview: {v2_content[:200].replace(chr(10), ' ')}...")
    else:
        print(f"❌ V2 Profile NOT found for {anime_name} at {v2_path}")
        v2_content = None

    # 2. Generate V3 Profile
    print(f"\n🔄 Generating V3 Profile (using Extended Thinking)...")
    
    # Enable extended thinking for this test
    store = get_settings_store()
    settings = store.load()
    settings.extended_thinking = True
    store.save(settings)
    
    try:
        # This calls the agent, does web search, builds YAML, and saves it
        v3_profile = await generate_and_save_profile(anime_name)
        print("✅ V3 Profile Generated Successfully!")
    except Exception as e:
        print(f"❌ Generation Failed: {e}")
        import traceback
        traceback.print_exc()
        return

    # 3. Verify V3 File on Disk
    v3_path = Path(f"src/profiles/{v3_profile['id']}.yaml")
    if v3_path.exists():
        print(f"✅ V3 Profile Saved to Disk: {v3_path}")
        with open(v3_path, 'r', encoding='utf-8') as f:
            v3_content = f.read()
            print(f"   V3 Size: {len(v3_content)} characters")
            print(f"   V3 Content (First 10 lines):")
            for line in v3_content.splitlines()[:10]:
                print(f"     {line}")
    else:
        print(f"❌ V3 Profile File NOT found at expected path: {v3_path}")

    # 4. Verify Loader Precedence
    print(f"\n🔍 Testing Loader Precedence...")
    loaded = load_existing_profile(anime_name)
    if loaded:
        source = loaded.get("source_anime") # v3 has this
        if "dna_scales" in loaded:
             print("✅ `load_existing_profile` loaded the V3 profile (found 'dna_scales')")
        elif "profile_content_preview" in loaded:
             print("⚠️ `load_existing_profile` loaded the V2 profile (unexpected if V3 exists)")
        else:
             print("❓ Loaded unknown profile format")
    else:
        print("❌ `load_existing_profile` returned None")

    print(f"\n--- Comparison Summary [{anime_name}] ---")
    print(f"V2 (Manual MD) vs V3 (Auto YAML)")
    if v2_content:
        print(f"V2 Length: {len(v2_content)}")
    print(f"V3 Length: {len(str(v3_profile))}")
    print(f"V3 DNA Scales: {v3_profile.get('dna_scales')}")

async def main():
    await compare_anime("Naruto")
    await compare_anime("Death Note")

if __name__ == "__main__":
    asyncio.run(main())
