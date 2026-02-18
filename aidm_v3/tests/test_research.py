"""Test Hellsing profile generation - save output to file."""
import asyncio
import json

from src.agents.anime_research import AnimeResearchAgent


async def test():
    agent = AnimeResearchAgent()

    with open("test_output.txt", "w", encoding="utf-8") as f:
        f.write("Testing Hellsing profile generation...\n")
        f.write(f"Provider: {agent.provider.__class__.__name__}\n")
        f.write(f"Model: {agent.model}\n")
        f.write("=" * 60 + "\n\n")

        result = await agent.research_anime("Hellsing")

        f.write("RESULTS\n")
        f.write("=" * 60 + "\n")
        f.write(f"Title: {result.title}\n")
        f.write(f"Research Method: {result.research_method}\n")
        f.write(f"Research Passes: {result.research_passes}\n")
        f.write(f"Topics Covered: {result.sources_consulted}\n")
        f.write(f"Confidence: {result.confidence}%\n")
        raw_len = len(result.raw_content) if result.raw_content else 0
        f.write(f"Raw Content Length: {raw_len} chars\n\n")

        f.write(f"Power System: {json.dumps(result.power_system, indent=2)}\n\n")
        f.write(f"Combat Style: {result.combat_style}\n\n")
        f.write(f"Tone: {json.dumps(result.tone, indent=2)}\n\n")
        f.write(f"DNA Scales: {json.dumps(result.dna_scales, indent=2)}\n\n")
        f.write(f"Storytelling Tropes: {json.dumps(result.storytelling_tropes, indent=2)}\n\n")

        if result.raw_content:
            f.write("\n\nRAW CONTENT PREVIEW (first 2000 chars):\n")
            f.write(result.raw_content[:2000])

    print("Output saved to test_output.txt")

if __name__ == "__main__":
    asyncio.run(test())
