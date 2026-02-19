"""Media generation service for character model sheets, portraits, and future cutscenes.

Uses Google's Gemini Image Generation API (gemini-3-pro-image-preview) for images
and Veo API for future video cutscenes.

Architecture:
- Model sheets are the SOURCE OF TRUTH for character visual identity
- Portraits are DERIVED from model sheets (crop or re-generate with reference)
- All media is stored under data/media/{campaign_id}/
- Templates (blank body references) ship with the project
"""

import asyncio
import logging
import os
import random
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Base paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
TEMPLATES_DIR = PROJECT_ROOT / "data" / "media" / "templates"
MEDIA_BASE_DIR = PROJECT_ROOT / "data" / "media"


class MediaGenerator:
    """Image/video generation using Google's Gemini Image + Veo APIs.
    
    All generated media is stored under data/media/{campaign_id}/ with
    the following structure:
        models/    - Full-body character model sheets (source of truth)
        portraits/ - Head-and-shoulders portraits (derived)
        cutscenes/ - Video cutscenes (future)
    """

    IMAGE_MODEL = "gemini-3-pro-image-preview"
    VIDEO_MODEL = "veo-3.1-generate-preview"

    def __init__(self, api_key: str | None = None):
        """Initialize MediaGenerator.
        
        Args:
            api_key: Google API key. Falls back to GOOGLE_API_KEY env var.
        """
        self._api_key = api_key
        if not self._api_key:
            try:
                from src.settings import get_settings_store
                self._api_key = get_settings_store().get_api_key("google")
            except Exception:
                pass
        if not self._api_key:
            self._api_key = os.environ.get("GOOGLE_API_KEY")
        self._client = None

    def _ensure_client(self):
        """Lazy-init the Google GenAI client."""
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self._api_key)

    # ── Retry with exponential back-off ──────────────────────────────
    _RETRYABLE_STATUS_CODES = {503, 429}

    async def _retry_generate(
        self,
        fn: Callable[[], Any],
        label: str,
        *,
        max_retries: int = 3,
        base_delay: float = 2.0,
    ) -> Any:
        """Run *fn* in a thread executor with exponential back-off retry.

        Retries on HTTP 503 (overloaded) and 429 (rate-limit) responses
        from the Gemini / Veo APIs.  Other exceptions propagate immediately.

        Delay schedule (default):  ~2 s → ~4 s → ~8 s  (+ random jitter).
        """
        loop = asyncio.get_running_loop()
        last_exc: Exception | None = None

        for attempt in range(max_retries + 1):  # 0 … max_retries
            try:
                return await loop.run_in_executor(None, fn)
            except Exception as exc:
                # Check if the error is retryable
                exc_str = str(exc)
                is_retryable = any(
                    str(code) in exc_str
                    for code in self._RETRYABLE_STATUS_CODES
                )
                if not is_retryable or attempt == max_retries:
                    raise  # non-retryable or exhausted retries

                last_exc = exc
                delay = base_delay * (2 ** attempt) + random.uniform(0, 1)
                logger.warning(
                    "%s: attempt %d/%d failed (%s). "
                    "Retrying in %.1f s…",
                    label, attempt + 1, max_retries + 1,
                    exc_str[:120], delay,
                )
                await asyncio.sleep(delay)

        # Should never reach here, but just in case
        raise last_exc  # type: ignore[misc]

    def _campaign_media_dir(self, campaign_id: int) -> Path:
        """Get the media directory for a campaign, creating it if needed."""
        base = MEDIA_BASE_DIR / str(campaign_id)
        base.mkdir(parents=True, exist_ok=True)
        return base

    def _models_dir(self, campaign_id: int) -> Path:
        d = self._campaign_media_dir(campaign_id) / "models"
        d.mkdir(exist_ok=True)
        return d

    def _portraits_dir(self, campaign_id: int) -> Path:
        d = self._campaign_media_dir(campaign_id) / "portraits"
        d.mkdir(exist_ok=True)
        return d

    def _cutscenes_dir(self, campaign_id: int) -> Path:
        d = self._campaign_media_dir(campaign_id) / "cutscenes"
        d.mkdir(exist_ok=True)
        return d

    def _sanitize_name(self, name: str) -> str:
        """Sanitize entity name for use as filename."""
        return name.lower().replace(" ", "_").replace("'", "").replace('"', '')[:50]

    def _build_style_prompt(self, style_context: str | dict) -> str:
        """Build a rich art direction block from style_context.
        
        Args:
            style_context: Either a visual_style dict (from profile YAML) or
                          a fallback string like 'hellsing' or 'anime'.
        Returns:
            Multi-line art direction string for image prompts.
        """
        if isinstance(style_context, dict):
            lines = []
            if style_context.get('art_style'):
                lines.append(f"Style: {style_context['art_style']}")
            if style_context.get('color_palette'):
                lines.append(f"Color Palette: {style_context['color_palette']}")
            if style_context.get('line_work'):
                lines.append(f"Line Work: {style_context['line_work']}")
            if style_context.get('shading'):
                lines.append(f"Shading: {style_context['shading']}")
            if style_context.get('composition'):
                lines.append(f"Composition: {style_context['composition']}")
            if style_context.get('atmosphere'):
                lines.append(f"Atmosphere: {style_context['atmosphere']}")
            if style_context.get('character_rendering'):
                lines.append(f"Character Rendering: {style_context['character_rendering']}")
            refs = style_context.get('reference_descriptors', [])
            if refs:
                lines.append(f"Visual References: {', '.join(refs)}")
            if lines:
                return "\n".join(lines)
        # Fallback: bare string
        if style_context:
            return f"Style: {style_context} anime art style"
        return "Style: detailed anime art style"

    async def generate_model_sheet(
        self,
        visual_tags: list[str],
        appearance: dict,
        style_context: str,
        campaign_id: int,
        entity_name: str,
        template_path: Path | None = None,
    ) -> Path | None:
        """Generate full-body character model sheet from description + optional template.
        
        Uses gemini-3-pro-image-preview with the template as reference image
        (if provided). Saves to data/media/{campaign_id}/models/{entity_name}_model.png
        
        Args:
            visual_tags: Visual descriptors e.g. ["blue_hair", "scar_left_eye", "tall"]
            appearance: Full appearance dict from character record
            style_context: IP-specific art style guidance (e.g. "Naruto anime style")
            campaign_id: Campaign ID for file organization
            entity_name: Character/NPC name
            template_path: Optional blank body template image
            
        Returns:
            Path to the generated model sheet, or None on failure.
        """
        self._ensure_client()

        safe_name = self._sanitize_name(entity_name)
        output_path = self._models_dir(campaign_id) / f"{safe_name}_model.png"

        # Build the prompt
        tags_str = ", ".join(visual_tags) if visual_tags else "no specific tags"
        appearance_desc = self._format_appearance(appearance)

        style_block = self._build_style_prompt(style_context)

        prompt = f"""Create a full-body character model sheet.

CHARACTER: {entity_name}
VISUAL TAGS: {tags_str}
APPEARANCE: {appearance_desc}

ART DIRECTION:
{style_block}

Requirements:
- Full-body front view and upper-body close-up side by side
- Clean white/light background for reference use
- High detail on face, hair, outfit, accessories
- Art style MUST match the art direction above — this is critical
- Character model sheet format suitable as canonical visual reference
- No text labels or annotations on the image"""

        try:
            loop = asyncio.get_running_loop()

            # Build parts list
            parts = []

            # If template provided, include it as reference with enhanced orthographic instructions
            if template_path and template_path.exists():
                from google.genai import types
                template_bytes = template_path.read_bytes()
                mime = "image/jpeg" if template_path.suffix.lower() in (".jpg", ".jpeg") else "image/png"
                parts.append(types.Part.from_bytes(
                    data=template_bytes,
                    mime_type=mime,
                ))
                parts.append(types.Part.from_text(
                    text=(
                        f"Using the attached blank body reference as a STRUCTURAL template, "
                        f"create a character model sheet. CRITICAL RULES:\n"
                        f"- Match the template's EXACT pose, proportions, and camera angle\n"
                        f"- Overlay character details (hair, face, clothing, accessories) onto the body form\n"
                        f"- Maintain strict orthographic projection — NO perspective distortion\n"
                        f"- Produce FRONT VIEW and THREE-QUARTER VIEW side by side\n"
                        f"- Keep the same clean white/light-grey background as the template\n"
                        f"- The template is a blank mannequin — dress and detail it as the character\n\n"
                        f"{prompt}"
                    )
                ))
            else:
                parts.append(prompt)

            def _generate():
                from google.genai import types
                response = self._client.models.generate_content(
                    model=self.IMAGE_MODEL,
                    contents=parts,
                    config=types.GenerateContentConfig(
                        response_modalities=["image", "text"],
                    ),
                )
                return response

            response = await self._retry_generate(_generate, f"model_sheet:{entity_name}")

            # Extract image from response
            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        image_bytes = part.inline_data.data
                        output_path.write_bytes(image_bytes)
                        logger.info(f"Model sheet saved: {output_path}")
                        return output_path

            logger.info(f"No image in response for {entity_name}")
            return None

        except Exception as e:
            logger.error(f"Model sheet generation failed for {entity_name}: {e}")
            return None

    async def derive_portrait(
        self,
        model_sheet_path: Path,
        campaign_id: int,
        entity_name: str,
    ) -> Path | None:
        """Derive a head-and-shoulders portrait from the model sheet.
        
        Uses the model sheet as reference to generate a focused portrait,
        or crops the front view if generation fails.
        
        Args:
            model_sheet_path: Path to the full-body model sheet
            campaign_id: Campaign ID
            entity_name: Character/NPC name
            
        Returns:
            Path to the portrait image, or None on failure.
        """
        self._ensure_client()

        safe_name = self._sanitize_name(entity_name)
        output_path = self._portraits_dir(campaign_id) / f"{safe_name}_portrait.png"

        if not model_sheet_path.exists():
            logger.warning(f"Model sheet not found: {model_sheet_path}")
            return None

        try:
            loop = asyncio.get_running_loop()
            model_bytes = model_sheet_path.read_bytes()

            def _generate():
                from google.genai import types
                response = self._client.models.generate_content(
                    model=self.IMAGE_MODEL,
                    contents=[
                        types.Part.from_bytes(data=model_bytes, mime_type="image/png"),
                        "Based on this character model sheet, create a close-up head-and-shoulders portrait. "
                        "Same character, same art style, same details. Focus on the face and upper body. "
                        "Maintain the exact same art style and color palette as the reference. "
                        "Clean dark or neutral background suitable for a character profile card. "
                        "Dramatic lighting that matches the tone of the source material.",
                    ],
                    config=types.GenerateContentConfig(
                        response_modalities=["image", "text"],
                    ),
                )
                return response

            response = await self._retry_generate(_generate, f"portrait:{entity_name}")

            # Extract image from response
            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        image_bytes = part.inline_data.data
                        output_path.write_bytes(image_bytes)
                        logger.info(f"Portrait saved: {output_path}")
                        return output_path

            logger.info(f"No portrait image in response for {entity_name}")
            return None

        except Exception as e:
            logger.error(f"Portrait generation failed for {entity_name}: {e}")
            return None

    async def generate_location_visual(
        self,
        location_name: str,
        location_type: str,
        description: str,
        atmosphere: str,
        style_context: str,
        campaign_id: int,
    ) -> Path | None:
        """Generate a location visual for the map/locations page.
        
        Uses gemini-3-pro-image-preview to create an establishing shot.
        """
        self._ensure_client()

        safe_name = self._sanitize_name(location_name)
        # Store location visuals alongside cutscene stills
        output_dir = self._campaign_media_dir(campaign_id) / "locations"
        output_dir.mkdir(exist_ok=True)
        output_path = output_dir / f"{safe_name}.png"

        style_block = self._build_style_prompt(style_context)

        prompt = f"""Create a wide establishing shot of a location.

LOCATION: {location_name}
TYPE: {location_type}
DESCRIPTION: {description}
ATMOSPHERE: {atmosphere}

ART DIRECTION:
{style_block}

Requirements:
- Wide angle establishing shot suitable for a location card
- Rich atmospheric detail (lighting, weather, mood)
- Art style MUST match the art direction above — this is critical
- No characters in the scene
- Cinematic composition, 16:9 aspect ratio feel
- Location name displayed as a title card in the bottom-left corner"""

        try:
            loop = asyncio.get_running_loop()

            def _generate():
                from google.genai import types
                response = self._client.models.generate_content(
                    model=self.IMAGE_MODEL,
                    contents=[prompt],
                    config=types.GenerateContentConfig(
                        response_modalities=["image", "text"],
                    ),
                )
                return response

            response = await self._retry_generate(_generate, f"location:{location_name}")

            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        output_path.write_bytes(part.inline_data.data)
                        logger.info(f"Location visual saved: {output_path}")
                        return output_path

            logger.info(f"No image in response for location {location_name}")
            return None

        except Exception as e:
            logger.error(f"Location visual failed for {location_name}: {e}")
            return None

    async def generate_full_character_media(
        self,
        visual_tags: list[str],
        appearance: dict,
        style_context: str,
        campaign_id: int,
        entity_name: str,
        template_path: Path | None = None,
    ) -> dict[str, Path | None]:
        """Convenience method: generate model sheet + derive portrait in sequence.
        
        If no template_path is provided, auto-selects from data/media/templates/
        based on gender/body type inferred from appearance and visual tags.
        
        Returns:
            Dict with 'model_sheet' and 'portrait' paths (either may be None on failure)
        """
        # Auto-select template if not explicitly provided
        if template_path is None:
            template_path = self._auto_select_template(appearance, visual_tags)
            if template_path:
                logger.info(f"Auto-selected template: {template_path.name}")

        model_sheet = await self.generate_model_sheet(
            visual_tags=visual_tags,
            appearance=appearance,
            style_context=style_context,
            campaign_id=campaign_id,
            entity_name=entity_name,
            template_path=template_path,
        )

        portrait = None
        if model_sheet:
            portrait = await self.derive_portrait(
                model_sheet_path=model_sheet,
                campaign_id=campaign_id,
                entity_name=entity_name,
            )

        return {
            "model_sheet": model_sheet,
            "portrait": portrait,
        }

    def _auto_select_template(self, appearance: dict, visual_tags: list[str]) -> Path | None:
        """Infer the best body template from appearance data and visual tags.
        
        Checks for gender/body type keywords in appearance dict and visual tags,
        then looks for the matching template file in TEMPLATES_DIR.
        
        Available templates (static turnaround sheets):
          male_average, male_muscle, male_petite,
          female_average, female_busty, female_muscle, female_petite
        
        Returns:
            Path to template image, or None if no suitable template found.
        """
        # Build a searchable string from all appearance data
        search_str = " ".join([
            str(v).lower() for v in appearance.values() if v
        ] + [t.lower() for t in visual_tags])
        
        # Also check appearance dict for explicit gender field
        gender = str(appearance.get("gender", "")).lower()
        
        # --- Determine gender ---
        female_keywords = ["female", "woman", "girl", "feminine", "she", "her"]
        male_keywords = ["male", "man", "boy", "masculine", "he", "him"]
        
        is_female = (
            gender in ("female", "f", "woman", "girl")
            or any(kw in search_str for kw in female_keywords)
        )
        is_male = (
            gender in ("male", "m", "man", "boy")
            or any(kw in search_str for kw in male_keywords)
        )
        
        # --- Determine build ---
        muscle_keywords = ["muscular", "buff", "athletic", "bulky", "strong", "brawny", "jacked", "fighter"]
        petite_keywords = ["petite", "slim", "slender", "thin", "small", "lean", "lithe", "young", "child"]
        busty_keywords = ["busty", "voluptuous", "curvy", "hourglass"]
        
        is_muscle = any(kw in search_str for kw in muscle_keywords)
        is_petite = any(kw in search_str for kw in petite_keywords)
        is_busty = any(kw in search_str for kw in busty_keywords)
        
        # --- Resolve body type ---
        if is_female:
            if is_busty:
                body_type = "female_busty"
            elif is_muscle:
                body_type = "female_muscle"
            elif is_petite:
                body_type = "female_petite"
            else:
                body_type = "female_average"
        elif is_male:
            if is_muscle:
                body_type = "male_muscle"
            elif is_petite:
                body_type = "male_petite"
            else:
                body_type = "male_average"
        else:
            # Gender-ambiguous: default to male_average
            body_type = "male_average"
        
        logger.debug(f"Template auto-select: '{body_type}' from gender={gender}, build cues in tags")
        
        # Try exact match first, then fallback chain
        template = self.get_template_path(body_type)
        if template:
            return template
        
        # Fallback: try gender-average, then any template that exists
        gender_prefix = "female" if is_female else "male"
        for fallback in [f"{gender_prefix}_average", "male_average", "female_average"]:
            template = self.get_template_path(fallback)
            if template:
                return template
        
        return None

    # =====================================================================
    # Template generation — blank orthographic body references
    # =====================================================================

    # All 7 available static turnaround sheet templates (anime cel-shaded,
    # 6-view rotation with proportion guide lines).  These are pre-supplied
    # assets — NOT AI-generated at runtime.
    TEMPLATE_BODY_TYPES: dict[str, str] = {
        "male_average":   "adult male, average athletic build",
        "male_muscle":    "adult male, muscular / fighter build",
        "male_petite":    "male, slim / lean / youthful build",
        "female_average": "adult female, average build",
        "female_busty":   "adult female, voluptuous / curvy build",
        "female_muscle":  "adult female, muscular / athletic build",
        "female_petite":  "female, slim / petite / youthful build",
    }

    async def generate_template(
        self,
        body_type: str = "male_average",
        force: bool = False,
    ) -> Path | None:
        """Generate a blank orthographic body reference template.
        
        Creates an anime-style character turnaround sheet with 6 rotation
        views (front, ¾ front, side, ¾ back, back, rear ¾) as a structural
        reference for character model sheet generation. Uses horizontal
        proportion guide lines and clean cel-shaded linework.
        
        Args:
            body_type: One of 'male_average', 'female_average', 'neutral'
            force: If True, regenerate even if the template already exists
            
        Returns:
            Path to the generated template PNG, or None on failure.
        """
        self._ensure_client()

        TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
        output_path = TEMPLATES_DIR / f"{body_type}.png"

        # Skip if already exists and not forcing
        if output_path.exists() and not force:
            logger.info(f"Template already exists: {output_path}")
            return output_path

        body_desc = self.TEMPLATE_BODY_TYPES.get(
            body_type,
            self.TEMPLATE_BODY_TYPES["neutral"]
        )

        prompt = f"""Create an ANIME CHARACTER TURNAROUND REFERENCE SHEET — a blank body template used in anime/game production.

BODY TYPE: {body_desc}

LAYOUT — 6 views arranged in a single horizontal row, evenly spaced:
1. FRONT view (facing viewer directly)
2. FRONT THREE-QUARTER view (turned ~45° to the right)
3. SIDE/PROFILE view (facing right)
4. BACK THREE-QUARTER view (turned ~135°, showing mostly the back)
5. FULL BACK view (facing away from viewer)
6. REAR THREE-QUARTER view (turned ~225°, the opposite ¾ angle)

FIGURE REQUIREMENTS:
- Featureless anime-style mannequin — bald head, no face details, no hair, no clothing
- Relaxed standing pose: arms hanging naturally at the sides, legs together, weight evenly distributed
- Filled with a uniform MEDIUM GREY flat colour
- Clean dark outlines (anime cel-style line art) defining the silhouette and body contours
- Subtle shading using slightly darker grey to indicate form (chest, shoulders, limbs) — NOT 3D rendered, keep it flat/cel-shaded
- Head proportions should follow anime conventions (~7-8 heads tall)
- All 6 views must show the SAME figure at the EXACT SAME scale and height

BACKGROUND AND GUIDES:
- Off-white or very light grey background
- HORIZONTAL PROPORTION GUIDE LINES spanning the full width behind all 6 figures
- Guide lines at key anatomical landmarks: top of head, chin, shoulders, chest, waist, hips, mid-thigh, knees, mid-calf, floor
- Guide lines should be thin, light grey, evenly spaced

STYLE:
- Clean, professional anime production art style (like a studio model sheet)
- Flat 2D rendering — NOT photorealistic, NOT 3D mannequin
- NO text, NO labels, NO annotations, NO watermarks
- NO perspective distortion — strict orthographic projection for all views"""

        try:
            loop = asyncio.get_running_loop()

            def _generate():
                from google.genai import types

                parts = []

                # Load reference image if available to guide style
                ref_path = self.TEMPLATE_REFERENCE_DIR / f"{body_type}_ref.png"
                if not ref_path.exists():
                    # Try generic reference
                    ref_path = self.TEMPLATE_REFERENCE_DIR / "turnaround_ref.png"

                if ref_path.exists():
                    ref_bytes = ref_path.read_bytes()
                    parts.append(types.Part.from_bytes(
                        data=ref_bytes,
                        mime_type="image/png",
                    ))
                    parts.append(types.Part.from_text(
                        text=(
                            "Use the attached image as a STYLE REFERENCE for the overall look, "
                            "layout, and line quality. Match the anime cel-shaded turnaround sheet "
                            "format, proportion guide lines, and flat grey fill style. "
                            "Generate a NEW original template following these instructions:\n\n"
                            + prompt
                        )
                    ))
                else:
                    parts.append(prompt)

                response = self._client.models.generate_content(
                    model=self.IMAGE_MODEL,
                    contents=parts,
                    config=types.GenerateContentConfig(
                        response_modalities=["image", "text"],
                    ),
                )
                return response

            logger.info(f"Generating template: {body_type}...")
            response = await self._retry_generate(_generate, f"template:{body_type}")

            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        image_bytes = part.inline_data.data
                        output_path.write_bytes(image_bytes)
                        logger.info(f"Template saved: {output_path} ({len(image_bytes)} bytes)")
                        return output_path

            logger.warning(f"No image in template response for {body_type}")
            return None

        except Exception as e:
            logger.error(f"Template generation failed for {body_type}: {e}")
            return None

    async def ensure_templates(self, force: bool = False) -> dict[str, Path | None]:
        """Check that all body type template images are present on disk.
        
        Templates are pre-supplied static assets (anime cel-shaded turnaround
        sheets).  This method only *verifies* their existence — it does NOT
        generate them.  If ``force`` is True the method will still attempt to
        regenerate missing templates via ``generate_template()``, but this
        is a fallback and quality will not match the hand-curated originals.
        
        Returns:
            Dict mapping body_type -> Path (or None if missing)
        """
        results: dict[str, Path | None] = {}
        for body_type in self.TEMPLATE_BODY_TYPES:
            path = self.get_template_path(body_type)
            if path:
                results[body_type] = path
            elif force:
                # Fallback: try AI generation (lower quality)
                results[body_type] = await self.generate_template(
                    body_type=body_type, force=True,
                )
            else:
                results[body_type] = None
        
        ready = sum(1 for v in results.values() if v is not None)
        logger.info(f"Template check: {ready}/{len(results)} templates present")
        return results

    # =====================================================================
    # General-purpose image + video generation (cutscene pipeline)
    # =====================================================================

    async def generate_image(
        self,
        prompt: str,
        campaign_id: int,
        filename: str = "cutscene",
        aspect_ratio: str = "16:9",
    ) -> Path | None:
        """Generate a still image via gemini-3-pro-image-preview.
        
        General-purpose image generation for cutscene stills, scene
        illustrations, etc. (Not character-specific like generate_model_sheet.)
        
        Args:
            prompt: Image generation prompt
            campaign_id: Campaign ID for file organization
            filename: Base filename (sanitized, no extension)
            aspect_ratio: Desired aspect ratio hint
            
        Returns:
            Path to saved PNG, or None on failure.
        """
        self._ensure_client()

        safe_name = self._sanitize_name(filename)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = self._cutscenes_dir(campaign_id) / f"{safe_name}_{timestamp}.png"

        # Add aspect ratio hint to prompt
        full_prompt = f"{prompt}\n\nAspect ratio: {aspect_ratio}. Cinematic framing. Ensure the art style is consistent with the series aesthetic."

        try:
            loop = asyncio.get_running_loop()

            def _generate():
                from google.genai import types
                response = self._client.models.generate_content(
                    model=self.IMAGE_MODEL,
                    contents=[full_prompt],
                    config=types.GenerateContentConfig(
                        response_modalities=["image", "text"],
                    ),
                )
                return response

            response = await self._retry_generate(_generate, f"image:{filename}")

            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        output_path.write_bytes(part.inline_data.data)
                        logger.info(f"Cutscene still saved: {output_path}")
                        return output_path

            logger.info(f"No image in response for cutscene {filename}")
            return None

        except Exception as e:
            logger.error(f"Image generation failed: {e}")
            return None

    async def generate_video(
        self,
        image_path: Path,
        prompt: str,
        campaign_id: int,
        duration: int = 6,
    ) -> Path | None:
        """Generate a video from an image via veo-3.1-generate-preview.
        
        Uses image-to-video generation. Polls for completion since
        Veo generation is asynchronous (~15-60 seconds).
        
        Args:
            image_path: Path to source image (PNG)
            prompt: Motion/animation prompt describing desired movement
            campaign_id: Campaign ID for file organization
            duration: Desired video duration in seconds (5-8)
            
        Returns:
            Path to saved MP4, or None on failure.
        """
        self._ensure_client()

        if not image_path.exists():
            logger.warning(f"Source image not found: {image_path}")
            return None

        output_path = image_path.with_suffix(".mp4")

        try:
            from google.genai import types
            loop = asyncio.get_running_loop()
            image_bytes = image_path.read_bytes()

            def _start_generation():
                """Start the Veo generation job (returns an operation to poll)."""
                image = types.Part.from_bytes(data=image_bytes, mime_type="image/png")
                operation = self._client.models.generate_videos(
                    model=self.VIDEO_MODEL,
                    prompt=prompt,
                    image=image,
                    config=types.GenerateVideosConfig(
                        aspect_ratio="16:9",
                        number_of_videos=1,
                    ),
                )
                return operation

            logger.info(f"Starting Veo generation ({self.VIDEO_MODEL})...")
            operation = await self._retry_generate(_start_generation, "veo_start")

            # Poll for completion (Veo is async, typically 15-60 seconds)
            def _poll():
                """Poll until the operation completes."""
                import time
                while not operation.done:
                    time.sleep(5)
                    operation.reload()
                return operation.result

            logger.info("Polling for Veo completion...")
            result = await loop.run_in_executor(None, _poll)

            # Extract video from result
            if result and result.generated_videos:
                video = result.generated_videos[0]
                if hasattr(video, 'video') and video.video:
                    # Download the video data
                    video_data = video.video
                    if hasattr(video_data, 'data'):
                        output_path.write_bytes(video_data.data)
                    elif hasattr(video_data, 'uri'):
                        # If we get a URI, download it
                        import urllib.request
                        urllib.request.urlretrieve(video_data.uri, str(output_path))
                    logger.info(f"Video saved: {output_path}")
                    return output_path

            logger.info("No video in Veo response")
            return None

        except Exception as e:
            logger.error(f"Video generation failed: {e}")
            return None

    async def generate_cutscene(
        self,
        image_prompt: str,
        motion_prompt: str,
        campaign_id: int,
        cutscene_type: str = "action_climax",
        filename: str = "cutscene",
    ) -> dict[str, Any]:
        """Full cutscene pipeline: prompt → image → video.
        
        Orchestrates both generation steps. Returns result dict with
        paths and status.
        
        Args:
            image_prompt: Prompt for the still image
            motion_prompt: Prompt for the video animation
            campaign_id: Campaign ID
            cutscene_type: Type classification
            filename: Base filename
            
        Returns:
            {
                "image_path": Optional[Path],
                "video_path": Optional[Path],
                "cutscene_type": str,
                "cost_usd": float,   # estimated
                "status": "complete" | "partial" | "failed"
            }
        """
        result = {
            "image_path": None,
            "video_path": None,
            "cutscene_type": cutscene_type,
            "cost_usd": 0.0,
            "status": "failed",
        }

        # Step 1: Generate still image
        image_path = await self.generate_image(
            prompt=image_prompt,
            campaign_id=campaign_id,
            filename=filename,
        )

        if not image_path:
            return result

        result["image_path"] = image_path
        result["cost_usd"] = 0.03  # Estimated image cost
        result["status"] = "partial"

        # Step 2: Animate the image into video
        video_path = await self.generate_video(
            image_path=image_path,
            prompt=motion_prompt,
            campaign_id=campaign_id,
        )

        if video_path:
            result["video_path"] = video_path
            result["cost_usd"] += 0.08  # Estimated video cost
            result["status"] = "complete"

        logger.info(f"Cutscene {cutscene_type}: status={result['status']}, cost=${result['cost_usd']:.2f}")
        return result

    def _format_appearance(self, appearance: dict) -> str:
        """Format appearance dict into readable description."""
        if not appearance:
            return "No specific appearance details"

        parts = []
        for key, value in appearance.items():
            if value:
                parts.append(f"{key}: {value}")
        return "; ".join(parts) if parts else "No specific appearance details"

    def get_template_path(self, body_type: str = "male_average") -> Path | None:
        """Get path to a body template image.
        
        Checks for .jpg then .png extensions.
        
        Args:
            body_type: Template name (e.g. 'male_average', 'female_busty')
            
        Returns:
            Path to template image, or None if not found.
        """
        for ext in (".jpg", ".png"):
            path = TEMPLATES_DIR / f"{body_type}{ext}"
            if path.exists():
                return path
        return None

    def get_media_url(self, campaign_id: int, category: str, filename: str) -> str:
        """Build a relative URL for serving media via the API.
        
        Args:
            campaign_id: Campaign ID
            category: 'models', 'portraits', 'cutscenes', 'locations'
            filename: Image filename
            
        Returns:
            Relative URL path for the media endpoint
        """
        return f"/api/game/media/{campaign_id}/{category}/{filename}"
