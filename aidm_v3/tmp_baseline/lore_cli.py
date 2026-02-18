"""
CLI viewer for the LoreStore SQL database.

Usage:
    python lore_cli.py                     # Show all profiles + stats
    python lore_cli.py <profile_id>        # Show pages for a profile
    python lore_cli.py <profile_id> <type> # Show pages of a specific type
    python lore_cli.py --search <term>     # Search page content
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.scrapers.lore_store import get_lore_store


def fmt_words(n: int) -> str:
    if n >= 1000:
        return f"{n/1000:.1f}k"
    return str(n)


def show_overview(store):
    stats = store.get_stats()
    print(f"\n{'='*60}")
    print(f"  LoreStore: {store._db_path}")
    print(f"  {stats['total_pages']} pages across {stats['profile_count']} profiles")
    print(f"{'='*60}\n")

    if not stats['profiles']:
        print("  (empty — no profiles stored yet)")
        return

    # Table header
    print(f"  {'Profile':<35} {'Pages':>6} {'Words':>8} {'Types'}")
    print(f"  {'─'*35} {'─'*6} {'─'*8} {'─'*30}")

    for pid in stats['profiles']:
        ps = store.get_stats(pid)
        types_str = ", ".join(f"{t}:{c}" for t, c in sorted(ps['by_type'].items()))
        print(f"  {pid:<35} {ps['total_pages']:>6} {fmt_words(ps['total_words']):>8} {types_str}")

    print()


def show_profile(store, profile_id: str, page_type: str = None):
    pages = store.get_pages(profile_id, page_type=page_type)

    if not pages:
        print(f"\n  No pages found for '{profile_id}'" + (f" type='{page_type}'" if page_type else ""))
        return

    stats = store.get_stats(profile_id)
    filter_label = f" (type={page_type})" if page_type else ""
    print(f"\n{'='*60}")
    print(f"  {profile_id}{filter_label}")
    print(f"  {len(pages)} pages, {fmt_words(stats['total_words'])} words total")
    print(f"{'='*60}\n")

    for i, page in enumerate(pages, 1):
        content = page['content']
        preview = content[:200].replace('\n', ' ')
        if len(content) > 200:
            preview += "..."

        print(f"  [{page['page_type']:>12}] {page['page_title']}")
        print(f"               {page['word_count']} words | scraped {page.get('scraped_at', '?')}")
        print(f"               {preview}")
        print()


def search_content(store, term: str):
    """Search across all page content."""
    import sqlite3

    with sqlite3.connect(store._db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT profile_id, page_title, page_type, content, word_count "
            "FROM wiki_pages WHERE content LIKE ? ORDER BY profile_id, page_type",
            (f"%{term}%",)
        ).fetchall()

    if not rows:
        print(f"\n  No results for '{term}'")
        return

    print(f"\n  Found {len(rows)} pages containing '{term}':\n")
    for row in rows:
        # Find the term in context
        idx = row['content'].lower().find(term.lower())
        start = max(0, idx - 60)
        end = min(len(row['content']), idx + len(term) + 60)
        snippet = row['content'][start:end].replace('\n', ' ')
        if start > 0:
            snippet = "..." + snippet
        if end < len(row['content']):
            snippet += "..."

        print(f"  [{row['profile_id']}] {row['page_title']} ({row['page_type']}, {row['word_count']}w)")
        print(f"    {snippet}")
        print()


def main():
    store = get_lore_store()
    args = sys.argv[1:]

    if not args:
        show_overview(store)
    elif args[0] == "--search" and len(args) > 1:
        search_content(store, " ".join(args[1:]))
    elif len(args) == 1:
        show_profile(store, args[0])
    elif len(args) == 2:
        show_profile(store, args[0], page_type=args[1])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
