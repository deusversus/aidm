# AIDM v3 — AI Dungeon Master

> Multi-agent AI orchestration for anime interactive storytelling

A FastAPI + PostgreSQL application that runs a full TTRPG dungeon master pipeline using coordinated LLM agents. Supports Google Gemini, Anthropic Claude, OpenAI, and GitHub Copilot as interchangeable providers, with per-agent model configuration.

---

## Quick Start

### Prerequisites

- Python 3.11+ (3.13 recommended)
- Docker (for PostgreSQL)

### Setup

```bash
# 1. Clone and enter repo
git clone https://github.com/deusversus/aidm.git
cd aidm

# 2. Create virtual environment
python3 -m venv venv
source venv/bin/activate        # Linux/Mac
# venv\Scripts\activate         # Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 5. Start the database
docker compose up -d db

# 6. Run migrations
alembic upgrade head

# 7. Start the server
python run_server.py
```

Open **http://localhost:8000** for the web interface.

### Docker (full stack)

```bash
docker compose up
```

Runs PostgreSQL + the application together. Migrations run automatically on startup.

---

## LLM Providers

Mix and match providers per agent — use a fast cheap model for classification, a creative model for narrative.

| Provider | Fast Model | Creative Model |
|----------|-----------|----------------|
| **Google** | `gemini-3-flash-preview` | `gemini-3-pro-preview` |
| **Anthropic** | `claude-haiku-4-5` | `claude-sonnet-4-5` / `claude-opus-4-5` |
| **OpenAI** | `gpt-5.2-chat-latest` | `gpt-5.2-pro` |
| **GitHub Copilot** | `gpt-4.1` | `claude-sonnet-4-5` (Pro+) |

Provider is auto-detected from available API keys, or set explicitly with `LLM_PROVIDER` in `.env`.

**Copilot:** Use the in-app OAuth flow (Settings → Connect GitHub Copilot) — no API key needed, just a Copilot subscription. Alternatively, run a local proxy with `npx copilot-api@latest start`.

---

## Architecture

### Turn Pipeline

```
Player Input
    ↓
Intent Classifier     → Parse action into structured intent
    ↓
Outcome Judge         → Determine success/failure + narrative weight
    ↓
Key Animator          → Generate narrative prose
    ↓
State Update          → Persist to PostgreSQL
    ↓
Background Pipeline   → Director, foreshadowing, media generation (async)
    ↓
Response to Player
```

### Agent Roster

21 specialized agents, each independently configurable:

| Tier | Agent | Purpose |
|------|-------|---------|
| **Core** | Intent Classifier | Parse player actions |
| | Outcome Judge | Success/failure determination |
| | Key Animator | Narrative prose generation |
| | Validator | Narrative coherence checks |
| **Director** | Director | Long-term campaign planning |
| | Scope | Series complexity detection |
| | Pacing | Arc tension management |
| | Recap | Session summaries |
| **World** | World Builder | Location/world generation |
| | Relationship Analyzer | NPC relationship tracking |
| | Research | Anime wiki research |
| | Wiki Scout | Wiki category classification |
| **Combat** | Combat | Tactical combat resolution |
| | Progression | XP/leveling decisions |
| | Scale Selector | Encounter difficulty |
| | Override Handler | META/OVERRIDE commands |
| **Memory** | Memory Ranker | Memory relevance scoring |
| | Compactor | Narrative history compression |
| | Context Selector | Retrieve relevant context |
| **Production** | Production | Post-narrative scene production + media |
| **Character** | Session Zero | Character creation dialogue |
| | Profile Generator | Character composition |
| | Profile Merge | Multi-source profile reconciliation |

---

## Features

### Session Zero
8-phase character creation protocol before gameplay begins. Interviews the player, builds a canonical character profile, and seeds the world with lore and NPCs drawn from the selected anime series.

### Foreshadowing System
A narrative seed ledger that tracks planted story hooks through their lifecycle: `planted → growing → callback → resolved`. The Director agent plants seeds; the Key Animator calls them back at dramatically appropriate moments.

### Media Generation
Optional AI-generated character portraits, location visuals, and animated cutscenes via Google Gemini image/video models. Toggled per-session with optional spend budget cap. Requires a Google API key.

### Per-Agent Model Configuration
Each of the 21 agents can be assigned a specific provider and model independently through the Settings UI. Agents fall back to base tier defaults (fast/thinking/creative) when not explicitly configured.

### Extended Thinking
Enable deeper reasoning for complex agents (Director, Research, Key Animator) at the cost of higher latency and token usage.

### Session Export / Import
Full campaign save/load as ZIP archives (v1.1 format). Includes character state, session history, memory store, and world state.

### D20 System
Standard dice engine with advantage/disadvantage, critical hit/fumble effects, and degree-of-success scaling.

---

## Project Structure

```
aidm/
├── api/                    # FastAPI backend
│   └── routes/
│       ├── game/           # Gameplay, session, media, status endpoints
│       ├── settings.py     # Config + API key management + Copilot OAuth
│       └── research.py     # Anime research endpoints
├── src/
│   ├── agents/             # 21 LLM agents
│   ├── core/               # Orchestration, turn pipeline, session management
│   ├── db/                 # SQLAlchemy models + state manager
│   ├── llm/                # Multi-provider abstraction layer
│   ├── context/            # ChromaDB memory store, rule library
│   ├── media/              # Image/video generation
│   ├── profiles/           # Character profile loading
│   ├── scrapers/           # AniList + wiki scrapers
│   ├── settings/           # User settings + encrypted key storage
│   └── utils/
├── web/                    # Static frontend (HTML/CSS/JS)
├── prompts/                # Agent prompt templates (Markdown)
├── rule_library/           # Game rules (YAML)
├── alembic/                # Database migrations
├── tests/                  # Test suite
├── dev/                    # Design assets
├── docker-compose.yml
├── Dockerfile
├── run_server.py           # Development server launcher
└── .env.example
```

---

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Primary provider (auto-detected if not set)
LLM_PROVIDER=google

# API Keys — configure at least one
GOOGLE_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Database
DATABASE_URL=postgresql://aidm:aidm@localhost:5432/aidm

# Optional model overrides
# FAST_MODEL=gemini-3-flash-preview
# CREATIVE_MODEL=gemini-3-pro-preview

# Debug
DEBUG=true
LOG_AGENT_DECISIONS=true
```

API keys can also be configured at runtime through the Settings UI and are stored encrypted.

---

## Database

PostgreSQL via Docker:

```bash
docker compose up -d db      # start
alembic upgrade head         # apply migrations
```

Connection defaults: `postgresql://aidm:aidm@localhost:5432/aidm`

**Migrations:**
- `001_baseline` — core schema (campaigns, sessions, turns, NPCs, quests, wiki cache)
- `002_stat_presentation` — stat display fields
- `003_card_catalog` — card catalog support

---

## Testing

```bash
pytest -m "not live" -v          # run offline tests only
pytest                           # run all (requires API keys for live tests)
```

Test markers: `live` (needs API keys), `slow` (>5s).

---

## CLI

```bash
python -m src.main
```

Commands: `debug`, `context`, `help`, `quit`
