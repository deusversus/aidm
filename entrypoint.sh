#!/bin/sh
# AIDM v3 Docker entrypoint
# Runs database migrations then starts the application server.
set -e

echo "==> Running database migrations..."
alembic upgrade head
echo "==> Migrations complete."

echo "==> Starting AIDM v3..."
exec uvicorn api.main:app --host 0.0.0.0 --port 8000
