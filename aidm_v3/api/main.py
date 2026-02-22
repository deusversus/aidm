"""FastAPI main application for AIDM v3."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from src.logging_config import setup_logging

from .routes import game, research, settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle."""
    setup_logging()
    logger.info("AIDM v3 starting up")
    yield
    # Shutdown: release orchestrator resources
    from .routes.game import reset_orchestrator
    reset_orchestrator()
    logger.info("AIDM v3 shut down cleanly")


# Create FastAPI app
app = FastAPI(
    title="AIDM v3 API",
    description="Anime Interactive Dungeon Master - AI Orchestration API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware for web frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(settings.router, prefix="/api/settings", tags=["Settings"])
app.include_router(game.router, prefix="/api/game", tags=["Game"])
app.include_router(research.router, prefix="/api", tags=["Research"])


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": "0.1.0"}


@app.get("/api/providers")
async def list_providers():
    """List available LLM providers."""
    from src.llm import get_llm_manager

    manager = get_llm_manager()
    return {
        "available": manager.list_available_providers(),
        "primary": manager.primary_provider
    }


# ── Admin: Prompt Registry ──────────────────────────────────────────

@app.get("/api/admin/prompts", tags=["Admin"])
async def list_prompts():
    """List all registered prompts with fingerprints."""
    from src.prompts import get_registry

    registry = get_registry()
    prompts = []
    for name in registry.list_names():
        pv = registry.get(name)
        prompts.append({
            "name": name,
            "hash": pv.content_hash,
            "words": len(pv),
            "source": pv.source,
            "metadata": pv.metadata,
        })
    return {"count": len(prompts), "prompts": prompts}


@app.get("/api/admin/prompts/{name}", tags=["Admin"])
async def get_prompt_detail(name: str):
    """Get a specific prompt's content and metadata."""
    from src.prompts import get_registry

    registry = get_registry()
    pv = registry.get(name)
    if pv is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Prompt '{name}' not found")
    return {
        "name": name,
        "hash": pv.content_hash,
        "words": len(pv),
        "content": pv.content,
        "metadata": pv.metadata,
        "source": pv.source,
    }


# Serve static web files if they exist (MUST be last - catch-all route)
web_dir = Path(__file__).parent.parent / "web"
if web_dir.exists():
    app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
