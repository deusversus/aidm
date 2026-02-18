# ---------- Build stage ----------
FROM python:3.13-slim AS builder

WORKDIR /app

# Install deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---------- Runtime stage ----------
FROM python:3.13-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY src/ src/
COPY api/ api/
COPY prompts/ prompts/
COPY rule_library/ rule_library/
COPY web/ web/
COPY pyproject.toml .
COPY requirements.txt .
COPY run_server.py .
COPY settings.json .
COPY .env.example .env.example

# Create data directory for SQLite + ChromaDB
RUN mkdir -p data

EXPOSE 8000

# Run with uvicorn directly (run_server.py wraps this for Windows)
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
