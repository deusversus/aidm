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
import os
import base64
from pathlib import Path
from typing import Optional, Dict, Any
from datetime import datetime


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
    
    def __init__(self, api_key: Optional[str] = None):
        """Initialize MediaGenerator.
        
        Args:
            api_key: Google API key. Falls back to GOOGLE_API_KEY env var.
        """
        self._api_key = api_key or os.environ.get("GOOGLE_API_KEY")
        self._client = None
    
    def _ensure_client(self):
        """Lazy-init the Google GenAI client."""
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self._api_key)
    
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
    
    async def generate_model_sheet(
        self,
        visual_tags: list[str],
        appearance: dict,
        style_context: str,
        campaign_id: int,
        entity_name: str,
        template_path: Optional[Path] = None,
    ) -> Optional[Path]:
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
        
        prompt = f"""Create a full-body character model sheet in detailed anime style.

CHARACTER: {entity_name}
VISUAL TAGS: {tags_str}
APPEARANCE: {appearance_desc}
ART STYLE: {style_context}

Requirements:
- Full-body front view, standing pose
- Clean white/light background for reference use
- High detail on face, hair, outfit, accessories
- Anime art style consistent with the specified IP
- Character model sheet format suitable as canonical visual reference
- No text labels or annotations on the image"""

        try:
            loop = asyncio.get_running_loop()
            
            # Build parts list
            parts = []
            
            # If template provided, include it as reference
            if template_path and template_path.exists():
                from google.genai import types
                template_bytes = template_path.read_bytes()
                parts.append(types.Part.from_bytes(
                    data=template_bytes,
                    mime_type="image/png"
                ))
                parts.append(types.Part.from_text(
                    text=f"Using the attached body reference as a structural template, "
                         f"create a character model sheet with the following details:\n\n{prompt}"
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
            
            response = await loop.run_in_executor(None, _generate)
            
            # Extract image from response
            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        image_bytes = part.inline_data.data
                        output_path.write_bytes(image_bytes)
                        print(f"[MediaGen] Model sheet saved: {output_path}")
                        return output_path
            
            print(f"[MediaGen] No image in response for {entity_name}")
            return None
            
        except Exception as e:
            print(f"[MediaGen] Model sheet generation failed for {entity_name}: {e}")
            return None
    
    async def derive_portrait(
        self,
        model_sheet_path: Path,
        campaign_id: int,
        entity_name: str,
    ) -> Optional[Path]:
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
            print(f"[MediaGen] Model sheet not found: {model_sheet_path}")
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
                        "Same character, same style, same details. Focus on the face and upper body. "
                        "Clean background suitable for a character profile card.",
                    ],
                    config=types.GenerateContentConfig(
                        response_modalities=["image", "text"],
                    ),
                )
                return response
            
            response = await loop.run_in_executor(None, _generate)
            
            # Extract image from response
            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        image_bytes = part.inline_data.data
                        output_path.write_bytes(image_bytes)
                        print(f"[MediaGen] Portrait saved: {output_path}")
                        return output_path
            
            print(f"[MediaGen] No portrait image in response for {entity_name}")
            return None
            
        except Exception as e:
            print(f"[MediaGen] Portrait generation failed for {entity_name}: {e}")
            return None
    
    async def generate_location_visual(
        self,
        location_name: str,
        location_type: str,
        description: str,
        atmosphere: str,
        style_context: str,
        campaign_id: int,
    ) -> Optional[Path]:
        """Generate a location visual for the map/locations page.
        
        Future enhancement — currently scaffolded.
        """
        # Scaffolded for future implementation
        print(f"[MediaGen] Location visual generation not yet implemented for {location_name}")
        return None
    
    async def generate_full_character_media(
        self,
        visual_tags: list[str],
        appearance: dict,
        style_context: str,
        campaign_id: int,
        entity_name: str,
        template_path: Optional[Path] = None,
    ) -> Dict[str, Optional[Path]]:
        """Convenience method: generate model sheet + derive portrait in sequence.
        
        Returns:
            Dict with 'model_sheet' and 'portrait' paths (either may be None on failure)
        """
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
    
    def _format_appearance(self, appearance: dict) -> str:
        """Format appearance dict into readable description."""
        if not appearance:
            return "No specific appearance details"
        
        parts = []
        for key, value in appearance.items():
            if value:
                parts.append(f"{key}: {value}")
        return "; ".join(parts) if parts else "No specific appearance details"
    
    def get_template_path(self, body_type: str = "male_average") -> Optional[Path]:
        """Get path to a body template image.
        
        Args:
            body_type: Template name (e.g. 'male_average', 'female_average')
            
        Returns:
            Path to template image, or None if not found.
        """
        path = TEMPLATES_DIR / f"{body_type}.png"
        return path if path.exists() else None
    
    def get_media_url(self, campaign_id: int, category: str, filename: str) -> str:
        """Build a relative URL for serving media via the API.
        
        Args:
            campaign_id: Campaign ID
            category: 'models', 'portraits', 'cutscenes'
            filename: Image filename
            
        Returns:
            Relative URL path for the media endpoint
        """
        return f"/api/game/media/{campaign_id}/{category}/{filename}"
