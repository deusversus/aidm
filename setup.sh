#!/usr/bin/env bash
# AIDM setup script — gets everything running on a fresh machine.
# Usage: ./setup.sh

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
die()   { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════╗"
echo -e "║         AIDM Setup               ║"
echo -e "╚══════════════════════════════════╝${NC}"
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────────────
info "Checking prerequisites..."
command -v docker   >/dev/null 2>&1 || die "Docker not found. Install Docker: https://docs.docker.com/get-docker/"
command -v git      >/dev/null 2>&1 || die "Git not found."
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin not found (need docker compose v2)."
ok "Docker and Compose found."

# ── .env setup ─────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    info "Creating .env from .env.example..."
    cp .env.example .env
    ok ".env created — edit it to add your API keys before starting."
else
    ok ".env already exists."
fi

# ── Langfuse choice ────────────────────────────────────────────────────────────
echo ""
echo "Observability via Langfuse:"
echo "  1) Self-hosted  — runs locally in Docker on port 3000 (no account needed)"
echo "  2) Cloud        — you already have / will add Langfuse Cloud keys in .env"
echo "  3) Skip         — disable tracing entirely"
echo ""
read -rp "Choice [1/2/3] (default: 1): " LF_CHOICE
LF_CHOICE="${LF_CHOICE:-1}"

COMPOSE_PROFILES=""
case "$LF_CHOICE" in
  1)
    COMPOSE_PROFILES="langfuse"
    # Inject self-hosted defaults into .env if Langfuse keys are not already set
    if ! grep -q "^LANGFUSE_SECRET_KEY=" .env 2>/dev/null; then
        cat >> .env <<'ENVBLOCK'

# Self-hosted Langfuse (injected by setup.sh)
LANGFUSE_SECRET_KEY=local-secret-key
LANGFUSE_PUBLIC_KEY=local-public-key
LANGFUSE_HOST=http://localhost:3000
ENVBLOCK
        ok "Self-hosted Langfuse keys added to .env."
    else
        ok "Langfuse keys already in .env — using those."
    fi
    info "Langfuse UI will be available at http://localhost:3000 after startup."
    info "Default login: create an account on first visit (self-hosted, local only)."
    ;;
  2)
    ok "Using Langfuse Cloud — make sure LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are set in .env."
    ;;
  3)
    ok "Tracing disabled."
    ;;
  *)
    warn "Unrecognized choice, skipping Langfuse."
    ;;
esac

# ── Pull images ────────────────────────────────────────────────────────────────
echo ""
info "Pulling Docker images..."
if [ -n "$COMPOSE_PROFILES" ]; then
    DOCKER_PROFILES="--profile $COMPOSE_PROFILES"
else
    DOCKER_PROFILES=""
fi
# shellcheck disable=SC2086
docker compose $DOCKER_PROFILES pull --quiet || warn "Some images couldn't be pulled (will try build)."

# ── Build AIDM image ───────────────────────────────────────────────────────────
info "Building AIDM image..."
docker compose build --quiet aidm
ok "AIDM image built."

# ── Start everything ───────────────────────────────────────────────────────────
echo ""
info "Starting services..."
# shellcheck disable=SC2086
docker compose $DOCKER_PROFILES up -d
ok "All services started."

# ── Wait for AIDM to be ready ──────────────────────────────────────────────────
info "Waiting for AIDM to be ready..."
for i in {1..30}; do
    if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
        ok "AIDM is up."
        break
    fi
    if [ "$i" -eq 30 ]; then
        warn "AIDM didn't respond within 30s — check logs: docker compose logs aidm"
    fi
    sleep 2
done

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════${NC}"
echo -e "${GREEN}  AIDM is running!${NC}"
echo -e "${GREEN}════════════════════════════════════${NC}"
echo ""
echo "  App:       http://localhost:8000"
if [ "$LF_CHOICE" = "1" ]; then
echo "  Langfuse:  http://localhost:3000"
fi
echo "  Logs:      docker compose logs -f"
echo "  Stop:      docker compose down"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Open http://localhost:8000 → Settings → add your LLM API keys"
if [ "$LF_CHOICE" = "1" ]; then
echo "  2. Open http://localhost:3000 → create a Langfuse account (local, one-time)"
fi
echo ""
