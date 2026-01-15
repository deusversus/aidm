import asyncio
import yaml
import os
import sys
from dotenv import load_dotenv

# Add aidm_v3 to path so 'src' imports work
project_root = os.path.join(os.path.dirname(__file__), '..')
aidm_dir = os.path.join(project_root, 'aidm_v3')
sys.path.append(aidm_dir)

from src.agents.calibration import CalibrationAgent

load_dotenv()

async def load_profile(name: str):
    path = os.path.join(os.path.dirname(__file__), f'../aidm_v3/src/profiles/{name}.yaml')
    with open(path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)

async def test_calibration():
    print("==================================================")
    print("Testing Phase 5: Calibration & System Mapping")
    print("==================================================")

    agent = CalibrationAgent()
    
    # Load Profiles
    try:
        naruto_profile = await load_profile("naruto")
        death_note_profile = await load_profile("death_note")
        print(f"✅ Profiles loaded. Type: {type(naruto_profile)}")
        print(f"Content Start: {str(naruto_profile)[:50]}")
    except Exception as e:
        print(f"❌ Failed to load profiles: {e}")
        return

    # TEST 1: Valid Naruto Character
    print("\n--- Test 1: Valid Naruto Character (Bug Ninja) ---")
    concept_1 = "I want to be a Shino-style ninja who uses insects for spying and combat. I'm quiet but loyal."
    result_1 = await agent.calibrate_character(concept_1, naruto_profile)
    print(f"Approved: {result_1.approved}")
    print(f"Archetype: {result_1.suggested_archetype}")
    print(f"Stats: {result_1.generated_stats}")
    if result_1.approved and "chakra" in str(result_1.generated_stats).lower():
        print("✅ Test 1 Passed (Stats reflect Power System)")
    else:
        print("❌ Test 1 Failed")

    # TEST 2: Invalid Death Note Character (Barbarian)
    print("\n--- Test 2: Invalid Death Note Character (Barbarian) ---")
    concept_2 = "I am a raging barbarian named Grog who uses a greataxe to smash criminals."
    result_2 = await agent.calibrate_character(concept_2, death_note_profile)
    print(f"Approved: {result_2.approved}")
    print(f"Reason: {result_2.rejection_reason}")
    if not result_2.approved:
        print("✅ Test 2 Passed (Rejection successful)")
    else:
        print("❌ Test 2 Failed (Should have rejected Barbarian)")

    # TEST 3: Valid Death Note Character (Detective)
    print("\n--- Test 3: Valid Death Note Character (FBI Agent) ---")
    concept_3 = "I'm a former FBI profiler who tracks patterns. I don't use magic, just logic."
    result_3 = await agent.calibrate_character(concept_3, death_note_profile)
    print(f"Approved: {result_3.approved}")
    print(f"Stats: {result_3.generated_stats}")
    if result_3.approved and "int" in str(result_3.generated_stats).lower():
        print("✅ Test 3 Passed")
    else:
        print("❌ Test 3 Failed")

    # TEST 4: Style Guide Generation
    print("\n--- Test 4: Style Guide Generation (Naruto) ---")
    guide = await agent.generate_style_guide(naruto_profile)
    print(f"Snippet: {guide.system_prompt_snippet[:100]}...")
    print(f"Mechanics: {guide.key_mechanics}")
    if len(guide.key_mechanics) > 0:
        print("✅ Test 4 Passed")
    else:
        print("❌ Test 4 Failed")

if __name__ == "__main__":
    asyncio.run(test_calibration())
