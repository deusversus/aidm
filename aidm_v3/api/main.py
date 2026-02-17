"""FastAPI main application for AIDM v3."""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import logging

from .routes import settings, game, research
from src.logging_config import setup_logging

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


# Serve static web files if they exist (MUST be last - catch-all route)
web_dir = Path(__file__).parent.parent / "web"
if web_dir.exists():
    app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
