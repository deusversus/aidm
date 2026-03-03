#!/usr/bin/env python
"""
SESSION TRANSCRIPT DUMP TOOL
=============================
Dumps the gameplay transcript from aidm_v3.db in a readable format.

Usage:
    python tools/dump_session.py                  # Last 10 turns
    python tools/dump_session.py --all            # All turns
    python tools/dump_session.py --last 5         # Last 5 turns
    python tools/dump_session.py --turn 12        # Specific turn
    python tools/dump_session.py --summary        # One-line summaries only
    python tools/dump_session.py --out dump.txt   # Write to file

Output includes: turn number, player input, intent, outcome, narrative excerpt,
and timestamp for each turn.
"""

import argparse
import sqlite3
import sys
from pathlib import Path


def get_db_path():
    """Find aidm_v3.db relative to this script or cwd."""
    candidates = [
        Path(__file__).parent.parent / "aidm_v3.db",
        Path.cwd() / "aidm_v3.db",
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    print("ERROR: aidm_v3.db not found")
    sys.exit(1)


def dump_turns(db_path, last_n=None, turn_number=None, summary_only=False, show_all=False):
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    # Build query
    query = "SELECT * FROM turns ORDER BY turn_number ASC"
    rows = db.execute(query).fetchall()

    if turn_number is not None:
        rows = [r for r in rows if r["turn_number"] == turn_number]
    elif not show_all and last_n:
        rows = rows[-last_n:]

    output_lines = []
    output_lines.append(f"=== SESSION TRANSCRIPT ({len(rows)} turns) ===\n")

    for r in rows:
        tn = r["turn_number"]
        player = r["player_input"] or ""
        intent = r["intent"] or "?"
        outcome = r["outcome"] or "?"
        narrative = r["narrative"] or ""
        ts = r["created_at"] or "?"
        latency = r["latency_ms"]

        if summary_only:
            player_short = player[:80].replace("\n", " ")
            narr_short = narrative[:80].replace("\n", " ")
            output_lines.append(
                f"Turn {tn:>2} | {intent:<16} | {outcome:<10} | "
                f"P: {player_short}"
            )
        else:
            output_lines.append(f"{'='*72}")
            output_lines.append(f"TURN {tn}  |  Intent: {intent}  |  Outcome: {outcome}  |  {ts}")
            if latency:
                output_lines.append(f"Latency: {latency}ms")
            output_lines.append(f"{'─'*72}")
            output_lines.append("PLAYER INPUT:")
            output_lines.append(player[:500] + ("..." if len(player) > 500 else ""))
            output_lines.append(f"{'─'*72}")
            output_lines.append(f"NARRATIVE ({len(narrative)} chars):")
            output_lines.append(narrative[:1500] + ("..." if len(narrative) > 1500 else ""))
            output_lines.append("")

    db.close()
    return "\n".join(output_lines)


def main():
    parser = argparse.ArgumentParser(description="Dump AIDM session transcript")
    parser.add_argument("--all", action="store_true", help="Show all turns")
    parser.add_argument("--last", type=int, default=10, help="Show last N turns (default: 10)")
    parser.add_argument("--turn", type=int, help="Show specific turn number")
    parser.add_argument("--summary", action="store_true", help="One-line summary per turn")
    parser.add_argument("--out", type=str, help="Write output to file instead of stdout")
    parser.add_argument("--db", type=str, help="Path to aidm_v3.db")
    args = parser.parse_args()

    db_path = args.db or get_db_path()
    output = dump_turns(
        db_path,
        last_n=args.last,
        turn_number=args.turn,
        summary_only=args.summary,
        show_all=args.all,
    )

    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
        print(f"Written to {args.out}")
    else:
        # Force UTF-8 on Windows
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(output)


if __name__ == "__main__":
    main()
