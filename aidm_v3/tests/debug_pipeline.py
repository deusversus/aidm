"""
Debug script - outputs FULL content at each stage to find truncation point.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.agents.intent_classifier import IntentClassifier
from src.agents.key_animator import KeyAnimator
from src.agents.outcome_judge import OutcomeJudge
from src.db.state_manager import StateManager
from src.profiles.loader import load_profile
from src.settings import get_settings_store


async def debug_single_turn(player_input: str):
    """Run a single turn and capture FULL output at each stage."""

    print("=" * 80)
    print("AIDM PIPELINE DEBUG - FULL OUTPUT")
    print("=" * 80)

    # Load settings and profile
    settings = get_settings_store().load()
    profile_id = settings.active_profile_id or "default"
    profile = load_profile(profile_id)

    # Get state manager and context
    state = StateManager(profile_id)
    db_context = state.get_context()

    # Intent
    intent_classifier = IntentClassifier()
    intent = await intent_classifier.call(
        player_input,
        character_context=db_context.character_summary,
        scene_context=f"{db_context.location}: {db_context.situation}"
    )
    print(f"\n[INTENT] {intent.intent}: {intent.action}")

    # Outcome
    outcome_judge = OutcomeJudge()
    outcome = await outcome_judge.call(
        player_input,
        intent_summary=f"{intent.intent}: {intent.action}",
        character_context=db_context.character_summary,
        scene_context=f"{db_context.location}: {db_context.situation}"
    )
    print(f"[OUTCOME] {outcome.success_level}")

    # KeyAnimator - call generate() and capture the response object
    key_animator = KeyAnimator(profile)

    # Build prompt exactly as generate() does
    prompt = key_animator.vibe_keeper_template
    prompt = prompt.replace("{{PROFILE_DNA_INJECTION}}", key_animator._build_profile_dna())
    scene_context = key_animator._build_scene_context(db_context)
    scene_context += "\n\n" + key_animator._build_outcome_section(intent, outcome)
    prompt = prompt.replace("{{SCENE_CONTEXT_INJECTION}}", scene_context)
    prompt = prompt.replace("{{DIRECTOR_NOTES_INJECTION}}", "(No specific guidance)")
    prompt = prompt.replace("{{MEMORIES_INJECTION}}", "(No memories)")
    prompt = prompt.replace("{{RETRIEVED_CHUNKS_INJECTION}}", "(No chunks)")

    user_message = f"## Player Action\n\n{player_input}\n\n## Write the scene."
    messages = [{"role": "user", "content": user_message}]

    # Single LLM call
    print("\n[CALLING LLM...]")
    response = await key_animator.provider.complete(
        messages=messages,
        system=prompt,
        model=key_animator.model,
        max_tokens=8192,
        temperature=0.7,
        extended_thinking=False
    )

    # Stage A: Raw response.content
    raw_content = response.content

    # Stage B: After .strip()
    stripped_content = raw_content.strip()

    # Stage C: After escaped newline replacement
    final_content = stripped_content.replace('\\n', '\n')

    # Write all three to files for comparison
    with open("debug_stage_A_raw.txt", "w", encoding="utf-8") as f:
        f.write(raw_content)

    with open("debug_stage_B_stripped.txt", "w", encoding="utf-8") as f:
        f.write(stripped_content)

    with open("debug_stage_C_final.txt", "w", encoding="utf-8") as f:
        f.write(final_content)

    # Print full outputs
    print("\n" + "=" * 80)
    print("STAGE A: RAW response.content")
    print("=" * 80)
    print(f"Length: {len(raw_content)} chars")
    print("-" * 80)
    print(raw_content)
    print("-" * 80)

    print("\n" + "=" * 80)
    print("STAGE B: After .strip()")
    print("=" * 80)
    print(f"Length: {len(stripped_content)} chars (diff: {len(raw_content) - len(stripped_content)})")
    print("-" * 80)
    print(stripped_content)
    print("-" * 80)

    print("\n" + "=" * 80)
    print("STAGE C: After escaped newline replacement")
    print("=" * 80)
    print(f"Length: {len(final_content)} chars (diff: {len(stripped_content) - len(final_content)})")
    print("-" * 80)
    print(final_content)
    print("-" * 80)

    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"Stage A (raw):      {len(raw_content)} chars")
    print(f"Stage B (stripped): {len(stripped_content)} chars")
    print(f"Stage C (final):    {len(final_content)} chars")
    print("\nFiles saved: debug_stage_A_raw.txt, debug_stage_B_stripped.txt, debug_stage_C_final.txt")

    if len(raw_content) != len(final_content):
        diff = len(raw_content) - len(final_content)
        print(f"\n⚠️ TOTAL DIFFERENCE: {diff} chars lost between raw and final")


async def main():
    test_input = "I look around carefully, taking in every detail of my surroundings."
    await debug_single_turn(test_input)


if __name__ == "__main__":
    asyncio.run(main())
