#!/usr/bin/env python3
"""Dump the current (or specified) session transcript to a markdown file."""

import sys
import json
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.db.session import get_session
from src.db.models import SessionZeroState
from src.settings.store import get_settings_store

SKIP = {"[BEGIN]", "[opening scene — the story begins]"}


def dump_transcript(session_id: str | None = None, out_path: Path | None = None) -> Path:
    # Resolve session ID
    if not session_id:
        settings = get_settings_store().reload()
        session_id = settings.active_session_id
    if not session_id:
        raise SystemExit("No session ID provided and none active in settings.json")

    # Load session data
    with get_session() as db:
        row = db.query(SessionZeroState).filter(
            SessionZeroState.session_id == session_id
        ).first()
        if not row:
            raise SystemExit(f"Session not found: {session_id}")
        data = json.loads(row.data)
    messages = data.get("messages", [])
    draft = data.get("character_draft", {})
    phase = data.get("phase", "unknown")

    # Build output path
    if not out_path:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_dir = Path(__file__).parent.parent / "data" / "transcripts"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"transcript_{ts}.md"

    # Write markdown
    with open(out_path, "w") as f:
        f.write(f"# Session Transcript\n\n")
        f.write(f"**Session ID:** `{session_id}`  \n")
        f.write(f"**Phase:** {phase}  \n")
        if draft.get("media_reference"):
            f.write(f"**Media:** {draft['media_reference']}  \n")
        if draft.get("name"):
            f.write(f"**Character:** {draft['name']}  \n")
        f.write(f"**Exported:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  \n")
        f.write("\n---\n\n")

        for msg in messages:
            content = msg.get("content", "").strip()
            if not content or content in SKIP:
                continue

            role = msg.get("role", "unknown")
            ts = msg.get("timestamp", "")[:16].replace("T", " ")
            phase_tag = msg.get("phase", "")

            if role == "user":
                f.write(f"### 🧑 Player `[{ts}]`\n\n{content}\n\n")
            else:
                f.write(f"### 🎲 DM `[{ts}]`\n\n{content}\n\n")

            f.write("---\n\n")

    print(f"Transcript written to: {out_path}")
    return out_path


if __name__ == "__main__":
    session_id = sys.argv[1] if len(sys.argv) > 1 else None
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    dump_transcript(session_id, out_path)
