"""FastAPI main application for AIDM v3."""

import json
import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from src.config import Config
from src.logging_config import setup_logging

from .routes import game, research, settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle."""
    setup_logging()
    logger.info("AIDM v3 starting up")
    from src.observability import init_langfuse
    init_langfuse()

    # Ensure audit log directory exists
    _log_dir = Path(__file__).parent.parent / "logs"
    _log_dir.mkdir(exist_ok=True)

    yield
    # Shutdown: release orchestrator resources
    from .routes.game import get_orchestrator_optional, reset_orchestrator
    orch = get_orchestrator_optional()
    if orch:
        try:
            await orch.async_close()
        except Exception as e:
            logger.warning("async_close failed: %s", e)
            orch.close()
    reset_orchestrator()
    logger.info("AIDM v3 shut down cleanly")


# Create FastAPI app
app = FastAPI(
    title="AIDM v3 API",
    description="Anime Interactive Dungeon Master - AI Orchestration API",
    version="0.1.0",
    lifespan=lifespan,
)


# ── CORS ──────────────────────────────────────────────────────────────────────
# Restrict to localhost by default. Override with CORS_ORIGINS env var
# (comma-separated) to allow other origins.
_cors_origins = (
    [o.strip() for o in Config.CORS_ORIGINS.split(",") if o.strip()]
    if Config.CORS_ORIGINS
    else ["http://localhost:8000", "http://127.0.0.1:8000"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Middleware Registration ────────────────────────────────────────────────────
# IMPORTANT: FastAPI middleware runs in REVERSE registration order.
# Last registered = outermost (runs first on request, last on response).
# Registration order below: admin → api_key → rate_limit → audit
# Execution order: audit(outermost) → rate_limit → api_key → admin(innermost)

# ── 1. Admin endpoint protection (innermost) ────────────────────────────────

@app.middleware("http")
async def admin_localhost_middleware(request: Request, call_next):
    """Restrict /api/admin/* to localhost regardless of API key."""
    if request.url.path.startswith("/api/admin"):
        client_ip = request.client.host if request.client else ""
        if client_ip not in ("127.0.0.1", "::1", "localhost"):
            return JSONResponse(
                status_code=403,
                content={"detail": "Admin endpoints are localhost-only."},
            )
    return await call_next(request)


# ── 2. API Key Gate ──────────────────────────────────────────────────────────
# Optional: set AIDM_API_KEY in .env to require auth on all /api/* routes.
# When unset (default), no auth is enforced — intended for local development.

# Paths that bypass auth (health check, static assets)
_AUTH_EXEMPT = {"/api/health"}
_AUTH_EXEMPT_PREFIXES = ("/css/", "/js/", "/img/", "/favicon")


@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    """Enforce API key auth when AIDM_API_KEY is configured."""
    required_key = Config.AIDM_API_KEY
    if not required_key:
        return await call_next(request)

    path = request.url.path

    # Exempt: health check, static files, root page
    if path in _AUTH_EXEMPT or path == "/" or any(
        path.startswith(p) for p in _AUTH_EXEMPT_PREFIXES
    ):
        return await call_next(request)

    # Only gate /api/* routes
    if not path.startswith("/api"):
        return await call_next(request)

    # Check Authorization header or X-API-Key header
    auth_header = request.headers.get("authorization", "")
    api_key_header = request.headers.get("x-api-key", "")

    provided_key = ""
    if auth_header.lower().startswith("bearer "):
        provided_key = auth_header[7:]
    elif api_key_header:
        provided_key = api_key_header

    if provided_key != required_key:
        return JSONResponse(
            status_code=401,
            content={"detail": "Invalid or missing API key. Set X-API-Key header."},
        )

    return await call_next(request)


# ── 3. Rate Limiter ──────────────────────────────────────────────────────────
# Simple in-memory sliding window. No external deps.
_rate_windows: dict[str, list[float]] = defaultdict(list)

# Endpoints that consume LLM tokens and need rate limiting
_EXPENSIVE_PATHS = {"/api/game/turn", "/api/game/session"}


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Rate-limit expensive endpoints per client IP."""
    path = request.url.path

    # Only rate-limit POST to expensive endpoints
    is_expensive = request.method == "POST" and any(
        path.startswith(p) for p in _EXPENSIVE_PATHS
    )
    if not is_expensive:
        return await call_next(request)

    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    window = _rate_windows[client_ip]

    # Prune entries older than 60 seconds
    cutoff = now - 60
    _rate_windows[client_ip] = [t for t in window if t > cutoff]
    window = _rate_windows[client_ip]

    if len(window) >= Config.get_rate_limit():
        logger.warning("Rate limit exceeded for %s on %s", client_ip, path)
        return JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded. Try again in a minute."},
        )

    window.append(now)
    return await call_next(request)


# ── 4. Request Audit Log (outermost — sees ALL requests, even rejected) ──────
_audit_log_path = Path(__file__).parent.parent / "logs" / "api_access.log"


@app.middleware("http")
async def audit_log_middleware(request: Request, call_next):
    """Log every request for forensic visibility."""
    start = time.time()
    response = await call_next(request)
    latency_ms = int((time.time() - start) * 1000)

    # Only log API requests (skip static files)
    if request.url.path.startswith("/api"):
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "ip": request.client.host if request.client else "unknown",
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "ms": latency_ms,
        }
        try:
            with open(_audit_log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception:
            pass  # Never block a request for logging

    return response


# Include routers
app.include_router(settings.router, prefix="/api/settings", tags=["Settings"])
app.include_router(game.router, prefix="/api/game", tags=["Game"])
app.include_router(research.router, prefix="/api", tags=["Research"])


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "version": "0.1.0",
        "auth_required": bool(Config.AIDM_API_KEY),
    }


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
