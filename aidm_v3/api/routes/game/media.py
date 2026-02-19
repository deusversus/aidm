"""Media file serving routes.

Serves generated images and videos from data/media/{campaign_id}/.
Template routes are registered FIRST to prevent FastAPI from matching
'/media/templates' as '/media/{campaign_id}/...' (int parse failure).
"""

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Base media directory
MEDIA_BASE_DIR = Path(__file__).parent.parent.parent.parent / "data" / "media"
TEMPLATES_DIR = MEDIA_BASE_DIR / "templates"

# Allowed subdirectories (prevent path traversal)
ALLOWED_CATEGORIES = {"portraits", "models", "cutscenes", "locations"}

# MIME types by extension
MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}


# =====================================================================
# Template management — MUST be registered before parameterized routes
# =====================================================================

@router.get("/media/templates")
async def list_templates():
    """List existing body reference templates and their status.
    
    Returns which templates exist and which are missing.
    """
    from src.media.generator import MediaGenerator

    gen = MediaGenerator()
    body_types = list(MediaGenerator.TEMPLATE_BODY_TYPES.keys())
    templates = []
    for bt in body_types:
        path = gen.get_template_path(bt)
        templates.append({
            "body_type": bt,
            "exists": path is not None,
            "size_bytes": path.stat().st_size if path else 0,
            "filename": path.name if path else None,
            "url": f"/api/game/media/templates/{path.name}" if path else None,
        })

    ready = sum(1 for t in templates if t["exists"])
    return {"templates": templates, "ready": ready, "total": len(templates)}


@router.post("/media/templates/generate")
async def generate_templates(force: bool = False):
    """Check (and optionally regenerate) body reference templates.
    
    Templates are pre-supplied static assets (anime turnaround sheets).
    Without force=True, this only verifies which templates are present.
    With force=True, attempts AI generation for any missing templates.
    """
    from src.media.generator import MediaGenerator

    gen = MediaGenerator()
    results = await gen.ensure_templates(force=force)

    output = {}
    for body_type, path in results.items():
        output[body_type] = {
            "success": path is not None,
            "path": str(path) if path else None,
            "size_bytes": path.stat().st_size if path else 0,
        }

    generated = sum(1 for v in output.values() if v["success"])
    return {
        "results": output,
        "generated": generated,
        "total": len(output),
        "status": "complete" if generated == len(output) else "partial",
    }


@router.get("/media/templates/{filename}")
async def serve_template(filename: str):
    """Serve a template file from the templates directory."""
    file_path = TEMPLATES_DIR / filename

    # Prevent path traversal
    try:
        resolved = file_path.resolve()
        if not str(resolved).startswith(str(TEMPLATES_DIR.resolve())):
            raise HTTPException(status_code=403, detail="Access denied")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Template not found")

    suffix = file_path.suffix.lower()
    media_type = MIME_MAP.get(suffix, "application/octet-stream")

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=604800"},  # 7 days — templates are stable
    )


# =====================================================================
# Campaign media serving — parameterized routes AFTER static routes
# =====================================================================

@router.get("/media/{campaign_id}/{category}/{filename}")
async def serve_media(campaign_id: int, category: str, filename: str):
    """Serve a media file from the campaign's media directory.
    
    URL pattern matches what MediaGenerator.get_media_url() produces:
        /api/game/media/{campaign_id}/{category}/{filename}
    """
    # Validate category
    if category not in ALLOWED_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Invalid category: {category}")

    # Build path and prevent traversal
    file_path = MEDIA_BASE_DIR / str(campaign_id) / category / filename
    
    # Resolve to catch ../ tricks
    try:
        resolved = file_path.resolve()
        if not str(resolved).startswith(str(MEDIA_BASE_DIR.resolve())):
            raise HTTPException(status_code=403, detail="Access denied")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Media not found")

    # Determine content type
    suffix = file_path.suffix.lower()
    media_type = MIME_MAP.get(suffix, "application/octet-stream")

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        headers={
            "Cache-Control": "public, max-age=86400",  # Cache for 24h — media is immutable
        }
    )


@router.get("/media/{campaign_id}/gallery")
async def get_gallery(campaign_id: int):
    """List all media assets for a campaign.
    
    Returns a structured list of all generated media files,
    organized by category.
    """
    campaign_dir = MEDIA_BASE_DIR / str(campaign_id)
    
    if not campaign_dir.exists():
        return {"assets": [], "total": 0}

    assets = []
    for category in ALLOWED_CATEGORIES:
        cat_dir = campaign_dir / category
        if not cat_dir.exists():
            continue
        for file_path in sorted(cat_dir.iterdir()):
            if file_path.is_file() and file_path.suffix.lower() in MIME_MAP:
                assets.append({
                    "category": category,
                    "filename": file_path.name,
                    "url": f"/api/game/media/{campaign_id}/{category}/{file_path.name}",
                    "size_bytes": file_path.stat().st_size,
                    "type": "video" if file_path.suffix.lower() in (".mp4", ".webm") else "image",
                })

    return {"assets": assets, "total": len(assets)}


@router.get("/turn/{campaign_id}/{turn_number}/media")
async def get_turn_media(campaign_id: int, turn_number: int):
    """Get media assets generated during a specific turn.
    
    Scans the filesystem for cutscene/location files matching the turn.
    Used by the frontend's pollForTurnMedia() to display background-generated media.
    """
    campaign_dir = MEDIA_BASE_DIR / str(campaign_id)
    if not campaign_dir.exists():
        return {"assets": []}

    assets = []
    asset_id = 0

    # Check cutscenes for turn-prefixed files (e.g. turn15_power_awakening_*.png)
    cutscenes_dir = campaign_dir / "cutscenes"
    if cutscenes_dir.exists():
        for fp in sorted(cutscenes_dir.iterdir()):
            if fp.is_file() and fp.name.startswith(f"turn{turn_number}_"):
                suffix = fp.suffix.lower()
                if suffix in MIME_MAP:
                    asset_id += 1
                    is_video = suffix in (".mp4", ".webm")
                    # Extract cutscene type from filename: turn15_power_awakening_timestamp.png
                    parts = fp.stem.split("_")
                    cutscene_type = "_".join(parts[1:-2]) if len(parts) > 2 else "scene"
                    assets.append({
                        "id": asset_id,
                        "asset_type": "video" if is_video else "image",
                        "cutscene_type": cutscene_type,
                        "file_url": f"/api/game/media/{campaign_id}/cutscenes/{fp.name}",
                        "status": "complete",
                    })

    return {"assets": assets}
