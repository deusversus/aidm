"""Game API routes package.

Exposes a single ``router`` that aggregates the sub-module routers, and
re-exports key symbols so that existing imports like

    from api.routes.game import reset_orchestrator, get_orchestrator

continue to work unchanged.
"""

from fastapi import APIRouter

from .gameplay import router as _gameplay_router

# ---------------------------------------------------------------------------
# Sub-module routers
# ---------------------------------------------------------------------------
from .session_mgmt import router as _session_mgmt_router
from .session_zero import router as _session_zero_router
from .status import router as _status_router

# Merge everything under a single router for backward compatibility.
# ``api.main`` does ``from .routes import game`` and uses ``game.router``.
router = APIRouter()
router.include_router(_session_mgmt_router)
router.include_router(_session_zero_router)
router.include_router(_gameplay_router)
router.include_router(_status_router)

# ---------------------------------------------------------------------------
# Re-exports  (used by api/main.py, api/routes/settings.py, tests/*)
# ---------------------------------------------------------------------------
from .session_mgmt import (  # noqa: F401  — re-export
    get_orchestrator,
    get_session_zero_agent,
    reset_orchestrator,
    reset_session_zero_agent,
)
