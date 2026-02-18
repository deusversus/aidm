"""
Test script for multi-pass profile generation.
Tests Cowboy Bebop (expected: STANDARD) and One Piece (expected: EPIC)
"""

import asyncio
from src.agents.anime_research import AnimeResearchAgent


async def test_profile_generation():
    agent = AnimeResearchAgent()
    
    print("\n" + "="*60)
    print("TEST 1: Cowboy Bebop (expected: STANDARD scope)")
    print("="*60)
    
    result1 = await agent.research_anime("Cowboy Bebop")
    
    print(f"\nResult for Cowboy Bebop:")
    print(f"  Title: {result1.title}")
    print(f"  Research Method: {result1.research_method}")
    print(f"  Research Passes: {result1.research_passes}")
    print(f"  Topics Covered: {result1.sources_consulted}")
    print(f"  Power System: {result1.power_system.get('name', 'N/A') if result1.power_system else 'N/A'}")
    print(f"  Combat Style: {result1.combat_style}")
    print(f"  Confidence: {result1.confidence}%")
    print(f"  Raw Content Length: {len(result1.raw_content or '')} chars")
    
    print("\n" + "="*60)
    print("TEST 2: One Piece (expected: EPIC scope)")
    print("="*60)
    
    result2 = await agent.research_anime("One Piece")
    
    print(f"\nResult for One Piece:")
    print(f"  Title: {result2.title}")
    print(f"  Research Method: {result2.research_method}")
    print(f"  Research Passes: {result2.research_passes}")
    print(f"  Topics Covered: {result2.sources_consulted}")
    print(f"  Power System: {result2.power_system.get('name', 'N/A') if result2.power_system else 'N/A'}")
    print(f"  Combat Style: {result2.combat_style}")
    print(f"  Confidence: {result2.confidence}%")
    print(f"  Raw Content Length: {len(result2.raw_content or '')} chars")
    
    print("\n" + "="*60)
    print("COMPARISON SUMMARY")
    print("="*60)
    print(f"Cowboy Bebop: {result1.research_passes} passes, {len(result1.raw_content or '')} chars")
    print(f"One Piece: {result2.research_passes} passes, {len(result2.raw_content or '')} chars")
    print(f"Ratio (One Piece / Cowboy Bebop): {len(result2.raw_content or '') / max(1, len(result1.raw_content or '')):.2f}x")


if __name__ == "__main__":
    asyncio.run(test_profile_generation())
