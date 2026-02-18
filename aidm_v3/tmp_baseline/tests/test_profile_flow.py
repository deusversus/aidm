# -*- coding: utf-8 -*-
"""
Profile Generation Flow Test Script

Tests the complete profile generation pipeline:
1. Generates a profile for a test anime
2. Verifies YAML file creation
3. Verifies lore text file creation
4. Verifies ChromaDB chunk ingestion

Usage:
    cd c:\\Users\\admin\\Downloads\\animerpg\\aidm_v3
    .\\venv313\\Scripts\\python tests\\test_profile_flow.py [anime_name]
    
Examples:
    .\\venv313\\Scripts\\python tests\\test_profile_flow.py "Princess Mononoke"
    .\\venv313\\Scripts\\python tests\\test_profile_flow.py "Cowboy Bebop"
"""

import asyncio
import sys
from pathlib import Path
from datetime import datetime

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))


def print_header(title: str):
    """Print a formatted header."""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


def print_result(label: str, success: bool, detail: str = ""):
    """Print a test result with color indication."""
    status = "✓ PASS" if success else "✗ FAIL"
    color = "\033[92m" if success else "\033[91m"
    reset = "\033[0m"
    print(f"  {color}{status}{reset} | {label}")
    if detail:
        print(f"         {detail}")


async def test_profile_generation(anime_name: str) -> dict:
    """
    Test the complete profile generation flow.
    
    Returns dict with test results.
    """
    from src.agents.profile_generator import generate_and_save_profile, _sanitize_profile_id
    from src.context.profile_library import get_profile_library
    
    results = {
        "anime": anime_name,
        "profile_id": None,
        "yaml_created": False,
        "lore_created": False,
        "lore_length": 0,
        "chroma_chunks": 0,
        "errors": []
    }
    
    profiles_dir = Path(__file__).parent.parent / "src" / "profiles"
    profile_id = _sanitize_profile_id(anime_name)
    results["profile_id"] = profile_id
    
    yaml_path = profiles_dir / f"{profile_id}.yaml"
    lore_path = profiles_dir / f"{profile_id}_lore.txt"
    
    # Clean up any existing files first
    if yaml_path.exists():
        yaml_path.unlink()
        print(f"  [Cleanup] Removed existing {yaml_path.name}")
    if lore_path.exists():
        lore_path.unlink()
        print(f"  [Cleanup] Removed existing {lore_path.name}")
    
    # Run profile generation
    print_header(f"Generating Profile: {anime_name}")
    print(f"  Profile ID: {profile_id}")
    print(f"  Started: {datetime.now().strftime('%H:%M:%S')}")
    print()
    
    try:
        profile = await generate_and_save_profile(anime_name)
        print(f"\n  Completed: {datetime.now().strftime('%H:%M:%S')}")
        print(f"  Confidence: {profile.get('confidence', 'N/A')}%")
    except Exception as e:
        results["errors"].append(f"Generation failed: {e}")
        print(f"\n  ERROR: {e}")
        return results
    
    # Test 1: YAML file exists
    print_header("Verification Results")
    
    yaml_exists = yaml_path.exists()
    results["yaml_created"] = yaml_exists
    if yaml_exists:
        yaml_size = yaml_path.stat().st_size
        print_result("YAML Profile", True, f"{yaml_path.name} ({yaml_size} bytes)")
    else:
        print_result("YAML Profile", False, f"Expected: {yaml_path}")
    
    # Test 2: Lore file exists and has content
    lore_exists = lore_path.exists()
    if lore_exists:
        lore_content = lore_path.read_text(encoding='utf-8')
        lore_len = len(lore_content)
        results["lore_created"] = True
        results["lore_length"] = lore_len
        
        # Check minimum length
        if lore_len >= 200:
            print_result("Lore Text File", True, f"{lore_path.name} ({lore_len} chars)")
        else:
            print_result("Lore Text File", False, f"Too short: {lore_len} chars (min 200)")
    else:
        print_result("Lore Text File", False, f"Expected: {lore_path}")
    
    # Test 3: ChromaDB chunks
    try:
        library = get_profile_library()
        # Query for chunks with this profile_id
        chunk_results = library.collection.get(
            where={"profile_id": profile_id},
            limit=100
        )
        chunk_count = len(chunk_results.get('ids', []))
        results["chroma_chunks"] = chunk_count
        
        if chunk_count > 0:
            print_result("ChromaDB Chunks", True, f"{chunk_count} chunks indexed")
        else:
            print_result("ChromaDB Chunks", False, "No chunks found in collection")
    except Exception as e:
        print_result("ChromaDB Chunks", False, f"Error: {e}")
        results["errors"].append(f"ChromaDB check failed: {e}")
    
    # Summary
    print_header("Summary")
    all_passed = (
        results["yaml_created"] and 
        results["lore_created"] and 
        results["lore_length"] >= 200 and
        results["chroma_chunks"] > 0
    )
    
    if all_passed:
        print("  \033[92m✓ ALL TESTS PASSED\033[0m")
    else:
        print("  \033[91m✗ SOME TESTS FAILED\033[0m")
        if results["errors"]:
            print("\n  Errors:")
            for err in results["errors"]:
                print(f"    - {err}")
    
    return results


async def main():
    # Default test anime if none provided
    anime_name = sys.argv[1] if len(sys.argv) > 1 else "Princess Mononoke"
    
    print(f"\n{'#'*60}")
    print(f"#  PROFILE GENERATION FLOW TEST")
    print(f"#  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'#'*60}")
    
    results = await test_profile_generation(anime_name)
    
    # Return exit code based on results
    all_passed = (
        results["yaml_created"] and 
        results["lore_created"] and 
        results["lore_length"] >= 200 and
        results["chroma_chunks"] > 0
    )
    
    print()
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    asyncio.run(main())
