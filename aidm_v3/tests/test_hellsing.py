"""Quick test for Hellsing with detailed output."""
import asyncio
import sys


# Suppress most print output during research
class QuietPrint:
    def __init__(self):
        self.original = sys.stdout
    def write(self, text):
        # Only print our formatted output
        if text.startswith('=') or text.startswith('-') or text.startswith('  '):
            self.original.write(text)
    def flush(self):
        self.original.flush()

from src.agents.anime_research import AnimeResearchAgent


async def test_hellsing():
    print("Starting Hellsing research (this takes ~2 minutes)...\n")

    agent = AnimeResearchAgent()
    result = await agent.research_anime("Hellsing")

    print(f"\n{'='*60}")
    print("HELLSING TEST RESULTS")
    print(f"{'='*60}")
    print(f"Title: {result.title}")
    print(f"Confidence: {result.confidence}%")
    print(f"Research Method: {result.research_method}")
    print(f"Research Passes: {result.research_passes}")

    print("\n--- Power System ---")
    if result.power_system:
        print(f"  Name: {result.power_system.get('name', 'N/A')}")

    print("\n--- DNA Scales ---")
    non_default_count = 0
    for k, v in result.dna_scales.items():
        indicator = ""
        if v == 5:
            indicator = " (default)"
        else:
            non_default_count += 1
        print(f"  {k}: {v}{indicator}")
    print(f"  --> {non_default_count}/11 non-default values")

    print("\n--- Tone ---")
    for k, v in result.tone.items():
        indicator = "" if v != 5 else " (default)"
        print(f"  {k}: {v}{indicator}")

    print("\n--- Tropes (TRUE only) ---")
    true_tropes = [k for k, v in result.storytelling_tropes.items() if v]
    if true_tropes:
        for t in true_tropes:
            print(f"  - {t}")
    else:
        print("  NONE - all defaulted to False")

    print("\n--- Combat Style ---")
    print(f"  {result.combat_style}")

    print(f"\n--- Raw Content: {len(result.raw_content or '')} chars ---")
    print(f"{'='*60}")

if __name__ == "__main__":
    asyncio.run(test_hellsing())
