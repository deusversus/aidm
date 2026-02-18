"""Quick test of profile generation for Arifureta."""
import asyncio

from src.agents.profile_generator import generate_and_save_profile


async def main():
    print("Testing profile generation for Arifureta...")
    try:
        result = await generate_and_save_profile("Arifureta")
        print(f"SUCCESS: Generated profile '{result.get('id')}'")
        print(f"  Name: {result.get('name')}")
        print(f"  Confidence: {result.get('confidence')}")
    except Exception as e:
        print(f"FAILED: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
