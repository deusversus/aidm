# AIDM v3 - AI Dungeon Master

> AI Orchestration Application for Anime Interactive Storytelling

## Quick Start

```bash
# 1. Setup virtual environment
python -m venv venv
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Linux/Mac

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
copy .env.example .env
# Edit .env with your API keys

# 4. Run Web UI
uvicorn api.main:app --reload

# OR run CLI
python -m src.main
```

Open http://localhost:8000 for the web interface.

## Features

### ⚙️ Per-Agent Model Selection

Configure different models for each agent based on your preferences:

| Agent | Purpose | Recommended |
|-------|---------|-------------|
| **Intent Classifier** | Parse player actions | Fast model |
| **Outcome Judge** | Determine success/failure | Fast model |
| **Key Animator** | Generate narrative | Creative model |
| **Director** | Campaign planning | High-end model |

Mix providers! Use Gemini Flash for structured calls and Claude Opus for narrative.

### 🎮 Supported LLM Providers (December 2025)

| Provider | Fast Model | Creative Model |
|----------|------------|----------------|
| **Google** | gemini-3-flash-preview | gemini-3-pro-preview |
| **Anthropic** | claude-haiku-4-5 | claude-sonnet-4-5 / opus-4-5 |
| **OpenAI** | gpt-5.2-chat-latest | gpt-5.2-pro |

## Architecture

```
Player Input
    ↓
Intent Classifier → Parse what player wants
    ↓
Outcome Judge → Should this succeed? How dramatically?
    ↓
Key Animator → Generate narrative prose
    ↓
State Update → Persist to database
    ↓
Response to Player
```

## Project Structure

```
aidm_v3/
├── api/                # FastAPI backend
│   ├── routes/         # API endpoints
│   └── main.py         # FastAPI app
├── web/                # Static web frontend
│   ├── css/            # Styles
│   └── js/             # JavaScript
├── src/
│   ├── agents/         # LLM agents
│   ├── llm/            # Multi-provider abstraction
│   ├── settings/       # User settings management
│   ├── db/             # Database models
│   └── core/           # Orchestration
├── prompts/            # Agent prompt templates
└── tests/              # Test suite
```

## CLI Commands

- `quit` - Exit the game
- `debug` - Toggle debug mode
- `context` - Show current game context
- `help` - Show available commands
