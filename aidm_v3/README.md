# AIDM v3 — Anime Interactive Dungeon Master

> A solo TTRPG engine where an AI plays the role of a dedicated, genre-aware Dungeon Master — one fluent in anime, manga, and light novel storytelling conventions.

---

## What Is AIDM?

You tell it *"I want to play in the world of Hunter x Hunter"* — or Naruto, or a mashup of Berserk and Jujutsu Kaisen — and it:

1. **Researches the IP deeply.** Scrapes Fandom wikis, pulls from AniList, builds a lore database — so it actually *knows* the world instead of hallucinating it.

2. **Runs a Session Zero** that feels like sitting down with a good GM. Collaborative character creation where it asks about your vibe, your goals, your power fantasy, and builds a character that *fits* the IP while being yours.

3. **Then plays the game with you**, turn by turn, with a full narrative engine underneath — not just "ChatGPT pretending to be a DM," but a system with actual mechanical bones: HP/MP/SP tracking, JRPG combat resolution, XP curves, faction politics, NPC relationships that evolve cognitively over time.

### Agent Architecture

What makes AIDM architecturally ambitious is the **agent separation**. It's not one prompt doing everything.

There's a **Director** planning multi-session arcs and planting foreshadowing seeds. A **Pacing Agent** preventing the story from stalling. A **Scale Selector** deciding whether this moment should be narrated as a tense tactical exchange or a world-shattering spectacle. A **Key Animator** (the narrator) that receives *directives* from all of these systems and weaves them into anime-authentic prose. A **Validator** that catches mechanical nonsense before it reaches the player — and can invoke "push beyond limits" moments, where the system *knows* you're out of MP but recognizes this is a dramatically perfect moment for a shonen power-up, so it lets it happen with consequences.

### Design Philosophy

> **"Narrative defines the rules, not the other way around."**

The combat system exists. The stats exist. But they serve the story rather than constraining it. The **OP Mode** system — with its 3-axis configuration (tension source × power expression × narrative focus) — asks *"what kind of power fantasy do you want?"* and tunes the entire engine to deliver it. Are you a Bored God (Saitama)? A Hidden Ruler (Ainz)? The system adapts.

The memory architecture reinforces this — a **three-tier system** (working memory, episodic, long-term) with heat decay, so the AI naturally forgets minor details while retaining plot-critical moments, just like a real GM would. Foreshadowing seeds get planted, tracked, and paid off across sessions. NPCs evolve from reactive to autonomous over repeated interactions.

**In short:** AIDM is the experience of having a brilliant, infinitely patient anime nerd as your personal GM — one who's actually read the source material, remembers your character's backstory, plans story arcs ahead of time, and knows when to follow the rules and when to break them for a great moment.

---

## Quick Start

```bash
# 1. Create virtual environment (Python 3.13+)
python -m venv venv313
.\venv313\Scripts\activate      # Windows
# source venv313/bin/activate   # Linux/Mac

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure API keys
# Create a .env file with your provider keys:
#   GOOGLE_API_KEY=...
#   ANTHROPIC_API_KEY=...
#   OPENAI_API_KEY=...

# 4. Run the server
python run_server.py
```

Open **http://localhost:8000** for the web interface. Server logs are written to `server.log`.

> `run_server.py` auto-detects the venv, kills stale processes, and launches uvicorn with hot-reload and UTF-8 encoding.

---

## Architecture

### Turn Loop

```
                          ┌─────────────────────┐
                          │    Player Input      │
                          └─────────┬───────────┘
                                    ▼
                          ┌─────────────────────┐
                          │  Intent Classifier   │  What does the player want?
                          └─────────┬───────────┘
                                    ▼
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
 ┌──────────────┐        ┌──────────────────┐       ┌──────────────┐
 │ Outcome Judge│        │  Pacing Agent    │       │ Memory Ranker│
 │ (pass/fail)  │        │  (arc guidance)  │       │ (context)    │
 └──────┬───────┘        └────────┬─────────┘       └──────┬───────┘
          └─────────────────────────┼─────────────────────────┘
                                    ▼
                    ┌─── Combat? ───┤─── No ───┐
                    ▼               │           ▼
          ┌──────────────┐         │  ┌──────────────────┐
          │ Combat Agent │         │  │  Key Animator     │  Narrative generation
          │ (JRPG rules) │         │  │  (anime prose)    │  with Director notes,
          └──────┬───────┘         │  │                   │  pacing, scale, lore
                 │                 │  └────────┬─────────┘
                 └─────────────────┘           │
                                    ▼
                          ┌─────────────────────┐
                          │   Validator          │  Bounds check, error recovery
                          └─────────┬───────────┘
                                    ▼
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
     ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐
     │ State Update    │  │ Progression      │  │ Relationship │
     │ (DB persist)    │  │ (XP/level-up)    │  │ Analyzer     │
     └────────────────┘  └──────────────────┘  └──────────────┘
                                    ▼
                          ┌─────────────────────┐
                          │  Response to Player  │
                          └─────────────────────┘

  Background (fire-and-forget):
    Director ─── Arc planning, foreshadowing, campaign bible updates
    World Builder ─── Entity extraction (NPCs, items, locations)
    Memory ─── Heat decay, episode writing, compression
```

### Agent Roster (16+ agents)

| Agent | Role | Model Tier |
|-------|------|------------|
| **Session Zero** | Multi-phase character creation & profile research | Creative |
| **Intent Classifier** | Parse player action type (combat, dialogue, explore…) | Fast |
| **Outcome Judge** | Determine success/failure and dramatic intensity | Fast |
| **Key Animator** | Agentic narrative generation with tool use | Creative |
| **Combat Agent** | JRPG combat resolution (initiative, damage, status effects) | Fast |
| **Progression** | XP awards, level-ups, tier ceremonies | Fast |
| **Director** | Agentic arc planning, foreshadowing, campaign bible | Thinking |
| **Pacing Agent** | Pre-turn micro-check with arc stall gates | Fast |
| **Scale Selector** | Picks narrative scale (tactical → spectacle → existential) | Fast |
| **World Builder** | Extracts & validates entities from narrative | Fast |
| **Relationship Analyzer** | NPC affinity drift per-turn | Fast |
| **Validator** | Error recovery, state integrity, narrative overrides | Fast |
| **Context Selector** | Smart context window assembly | Fast |
| **Memory Ranker** | LLM-ranked memory retrieval | Fast |
| **Compactor** | Working memory summarization | Fast |
| **Recap Agent** | Session recap generation | Creative |
| **Override Handler** | META/OVERRIDE command processing | Fast |
| **Profile Generator** | YAML profile generation from research data | Creative |
| **Anime Research** | API-first IP research (AniList + Fandom wikis) | Creative |

### 3-Tier Model Configuration

Instead of configuring each agent individually, AIDM uses a **tier-based fallback** system:

| Tier | Purpose | Default |
|------|---------|---------|
| **Fast** | Structured extraction, classification, quick judgments | `gemini-3-flash-preview` |
| **Thinking** | Complex reasoning, planning, analysis | `gemini-3-pro-preview` |
| **Creative** | Prose generation, narrative, research | `gemini-3-pro-preview` |

Each agent has a designated tier and falls back to the corresponding base model. Override any individual agent in the Settings UI.

---

## Supported LLM Providers

| Provider | Fast | Creative / Thinking | Premium |
|----------|------|---------------------|---------|
| **Google** | `gemini-3-flash-preview` | `gemini-3-pro-preview` | — |
| **Anthropic** | `claude-haiku-4-5` | `claude-sonnet-4-5` / `claude-sonnet-4-6` | `claude-opus-4-6` |
| **OpenAI** | `gpt-5.2-chat-latest` | `gpt-5.2` | `gpt-5.2-pro` |

Mix providers freely — use Gemini Flash for structured calls, Claude for narrative, OpenAI for planning.

---

## Core Systems

| System | Description |
|--------|-------------|
| **ChromaDB Memory** | Three-tier memory (working, episodic, long-term) with heat decay and hybrid search |
| **Foreshadowing Ledger** | DB-backed seed lifecycle with causal chains, auto-detection, convergence tracking |
| **Campaign Bible** | Director's private planning document — arcs, NPC trajectories, spotlight debt |
| **Consequence System** | Structured, categorized, expirable consequences (political, environmental, relational…) |
| **Faction System** | Inter-faction politics, PC membership/rank, controlled factions (Overlord/Rimuru mode) |
| **NPC Intelligence** | Cognitive evolution: reactive → contextual → anticipatory → autonomous |
| **OP Mode** | 3-axis power fantasy tuning (tension × expression × focus) with 10+ presets |
| **State Transaction** | Atomic state mutations with rollback for combat actions |
| **Session Export/Import** | Full session save/restore via `.aidm` ZIP files |
| **Rule Library** | 18 genre configs, power tiers, scales, ceremonies, OP presets (YAML) |

---

## Project Structure

```
aidm_v3/
├── api/                    # FastAPI backend
│   ├── routes/game.py      #   45+ API endpoints (91KB)
│   └── main.py             #   App factory
├── web/                    # Static web frontend
│   ├── css/main.css        #   Styling (dark theme, cyberpunk accents)
│   ├── js/app.js           #   Main application logic (1270 lines)
│   └── index.html          #   Single-page app shell
├── src/
│   ├── agents/             # 16+ specialized LLM agents
│   ├── core/               # Orchestrator (1741 lines), foreshadowing, dice, sessions
│   ├── context/            # ChromaDB memory store with heat decay
│   ├── db/                 # SQLAlchemy models (11 tables) & state manager (98KB)
│   ├── llm/                # Multi-provider abstraction (Google, Anthropic, OpenAI)
│   └── settings/           # 3-tier model configuration & user preferences
├── prompts/                # Agent system prompts (markdown)
├── rule_library/           # Genre configs, power tiers, OP presets (YAML)
├── data/                   # Runtime data (ChromaDB, profiles, lore)
│   ├── chroma/             #   Vector embeddings
│   ├── profiles/           #   Generated narrative profiles (.yaml)
│   └── lore/               #   Scraped wiki content (.txt)
├── run_server.py           # Server launcher (auto-venv, process cleanup, UTF-8)
└── requirements.txt        # Python dependencies
```

---

## Session Export

AIDM supports full session save/restore:

- **Export**: Downloads a `.aidm` file (ZIP) containing all campaign data
- **Import**: Upload a `.aidm` file to restore the exact session state
- Available from the Settings page in the web UI

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_API_KEY` | At least one provider | Google Gemini API key |
| `ANTHROPIC_API_KEY` | At least one provider | Anthropic Claude API key |
| `OPENAI_API_KEY` | At least one provider | OpenAI GPT API key |

Configure in a `.env` file at the project root. Only one provider key is required — AIDM defaults to Google Gemini but works with any.
