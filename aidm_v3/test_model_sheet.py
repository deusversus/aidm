"""Quick test: generate a model sheet using one of the new static templates.

Run:  venv313\Scripts\python.exe test_model_sheet.py
"""

import asyncio
import os
import sys
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"

# Make sure src is importable
sys.path.insert(0, str(Path(__file__).parent))

from src.media.generator import MediaGenerator


async def main():
    gen = MediaGenerator()

    # ── Show available templates ─────────────────────────────────────
    print("=== Template check ===")
    status = await gen.ensure_templates()
    for bt, path in status.items():
        tag = "OK" if path else "MISSING"
        print(f"  {bt:20s} {tag}  {path or ''}")
    
    ready = sum(1 for v in status.values() if v is not None)
    print(f"\n  {ready}/{len(status)} templates present\n")

    # ── Pick a character to generate ─────────────────────────────────
    # Using sample character data (Arifureta style)
    entity_name = "Yue"
    campaign_id = 1  # existing campaign folder

    appearance = {
        "gender": "female",
        "age": "appears 12-14, actually 300+",
        "height": "short / petite",
        "build": "petite, slim",
        "hair": "long golden blonde hair, straight, reaches past waist",
        "eyes": "crimson red eyes, vampiric",
        "skin": "pale, porcelain complexion",
        "outfit": "white gothic-lolita dress with red accents, black stockings",
        "accessories": "none",
        "distinguishing_features": "vampire fangs, regal bearing despite small stature",
    }

    visual_tags = [
        "blonde_hair", "long_hair", "red_eyes", "petite", "vampire",
        "gothic_lolita", "pale_skin", "fantasy", "isekai",
    ]

    style_context = (
        "Anime light-novel illustration style, similar to Arifureta: From "
        "Commonplace to World's Strongest. Clean cel-shading, vivid colors, "
        "detailed clothing folds, soft lighting, high-quality character design."
    )

    # ── Auto-select template ─────────────────────────────────────────
    template = gen._auto_select_template(appearance, visual_tags)
    print(f"Auto-selected template: {template}")
    print(f"  (body type detected from: gender=female + build=petite → female_petite)")

    # ── Generate! ────────────────────────────────────────────────────
    print(f"\nGenerating model sheet for '{entity_name}'...")
    print(f"  Campaign: {campaign_id}")
    print(f"  Template: {template}\n")

    result = await gen.generate_model_sheet(
        visual_tags=visual_tags,
        appearance=appearance,
        style_context=style_context,
        campaign_id=campaign_id,
        entity_name=entity_name,
        template_path=template,
    )

    if result:
        print(f"\n[OK] SUCCESS! Model sheet saved to: {result}")
        print(f"  Size: {result.stat().st_size:,} bytes")
    else:
        print("\n[FAIL] No image generated. Check error above.")


if __name__ == "__main__":
    asyncio.run(main())
