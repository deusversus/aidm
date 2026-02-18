"""Quick test for Death Note."""
import asyncio
from src.agents.anime_research import AnimeResearchAgent

async def test_deathnote():
    print("Starting Death Note research...\n")
    
    agent = AnimeResearchAgent()
    result = await agent.research_anime("Death Note")
    
    print(f"\n{'='*60}")
    print(f"DEATH NOTE TEST RESULTS")
    print(f"{'='*60}")
    print(f"Title: {result.title}")
    print(f"Confidence: {result.confidence}%")
    print(f"Research Method: {result.research_method}")
    
    print(f"\n--- DNA Scales (focus on explained/ensemble) ---")
    for k, v in result.dna_scales.items():
        marker = ""
        if k == "explained_vs_mysterious":
            marker = " <-- FOCUS"
        elif k == "ensemble_vs_solo":
            marker = " <-- FOCUS (should be HIGH, Light-centric)"
        elif v == 5:
            marker = " (default)"
        print(f"  {k}: {v}{marker}")
    
    print(f"\n--- Tone ---")
    for k, v in result.tone.items():
        print(f"  {k}: {v}")
    
    print(f"\n--- Tropes (TRUE only) ---")
    true_tropes = [k for k, v in result.storytelling_tropes.items() if v]
    if true_tropes:
        for t in true_tropes:
            print(f"  - {t}")
    else:
        print(f"  NONE")
    
    print(f"\n--- Combat Style ---")
    print(f"  {result.combat_style}")
    print(f"{'='*60}")

if __name__ == "__main__":
    asyncio.run(test_deathnote())
