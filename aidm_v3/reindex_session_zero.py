"""
One-time migration script: Re-index Session Zero transcript into ChromaDB.

Reads the full Session Zero messages from sessions.db and indexes them
using the fixed logic (all chunks → plot_critical + session_zero + none decay).

Usage:
    python reindex_session_zero.py
"""

import sys
import os
import io
import sqlite3
import json

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def get_session_data(session_id: str) -> dict:
    """Load session data from sessions.db."""
    db_path = os.path.join("data", "sessions.db")
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Sessions DB not found: {db_path}")
    
    conn = sqlite3.connect(db_path)
    cursor = conn.execute(
        "SELECT data FROM sessions WHERE session_id = ?", (session_id,)
    )
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise ValueError(f"Session {session_id} not found in sessions.db")
    
    return json.loads(row[0])


def get_session_messages(session_data: dict) -> list:
    """Extract messages from session data, trying multiple known locations."""
    # Try direct messages field
    if "messages" in session_data and session_data["messages"]:
        return session_data["messages"]
    
    # Try nested under character_draft or other fields
    for key in ["character_draft", "session_zero_data", "dialogue"]:
        if key in session_data and isinstance(session_data[key], dict):
            if "messages" in session_data[key]:
                return session_data[key]["messages"]
    
    # Try conversation_history
    if "conversation_history" in session_data:
        return session_data["conversation_history"]
    
    return []


def main():
    SESSION_ID = "ddb5a17e-41dc-419d-8603-b57e964c3b83"
    
    print("=" * 70)
    print("Session Zero Re-Index Script")
    print("=" * 70)
    
    # --- Step 1: Load session messages ---
    print(f"\n[1/4] Loading session data for {SESSION_ID}...")
    session_data = get_session_data(SESSION_ID)
    
    messages = get_session_messages(session_data)
    print(f"  Found {len(messages)} messages in session data")
    
    if not messages:
        # Dump the top-level keys so we can debug
        print(f"  Session data keys: {list(session_data.keys())}")
        for key, val in session_data.items():
            if isinstance(val, (list, dict)):
                print(f"    {key}: {type(val).__name__} len={len(val)}")
            elif isinstance(val, str) and len(val) > 100:
                print(f"    {key}: str len={len(val)} preview={val[:80]}...")
            else:
                print(f"    {key}: {val}")
        print("\n  ERROR: No messages found. Cannot proceed.")
        return
    
    # Show a preview
    for i, msg in enumerate(messages[:3]):
        role = msg.get("role", "?")
        content = msg.get("content", "")[:80]
        print(f"  [{i}] {role}: {content}...")
    if len(messages) > 3:
        print(f"  ... and {len(messages) - 3} more")
    
    # --- Step 2: Check current ChromaDB state ---
    print(f"\n[2/4] Checking current ChromaDB state...")
    from src.context.memory import MemoryStore
    memory = MemoryStore(campaign_id=SESSION_ID)
    
    before_count = memory.count()
    print(f"  Current memory count: {before_count}")
    
    # Count existing session_zero-sourced memories
    all_mems = memory.collection.get(include=["metadatas", "documents"])
    s0_sourced = []
    for i, meta in enumerate(all_mems["metadatas"]):
        if meta.get("source") == "session_zero":
            s0_sourced.append({
                "id": all_mems["ids"][i],
                "preview": all_mems["documents"][i][:80]
            })
    
    print(f"  Session Zero sourced memories: {len(s0_sourced)}")
    for m in s0_sourced:
        print(f"    - {m['id']}: {m['preview']}...")
    
    # --- Step 3: Remove old session_zero-sourced raw chunks ---
    if s0_sourced:
        print(f"\n[3/4] Removing {len(s0_sourced)} old session_zero-sourced chunks...")
        ids_to_remove = [m["id"] for m in s0_sourced]
        memory.collection.delete(ids=ids_to_remove)
        print(f"  Removed {len(ids_to_remove)} old chunks")
    else:
        print(f"\n[3/4] No old session_zero-sourced chunks to remove")
    
    # --- Step 4: Re-chunk and re-index ---
    print(f"\n[4/4] Re-indexing full transcript...")
    
    from src.agents.session_zero import _chunk_session_zero_messages, _classify_chunk
    
    chunks = _chunk_session_zero_messages(messages)
    print(f"  Created {len(chunks)} chunks from {len(messages)} messages")
    
    indexed = 0
    for chunk in chunks:
        category = _classify_chunk(chunk)
        
        # ALL Session Zero content is sacred
        flags = ["plot_critical", "session_zero"]
        
        mem_id = memory.add_memory(
            content=chunk["content"],
            memory_type="session_zero",
            turn_number=0,
            metadata={
                "source": "session_zero",
                "chunk_index": chunk.get("index", 0),
                "message_count": chunk.get("message_count", 0),
                "sub_category": category
            },
            flags=flags
        )
        
        # Check if dedup blocked it
        if mem_id.startswith("session_zero_"):
            indexed += 1
            print(f"  ✅ Chunk {chunk['index']}: {category} ({chunk['message_count']} msgs) → {mem_id}")
        else:
            print(f"  ⏭️  Chunk {chunk['index']}: dedup detected (existing: {mem_id})")
    
    after_count = memory.count()
    memory.close()
    
    # --- Summary ---
    print(f"\n{'=' * 70}")
    print(f"RESULTS")
    print(f"{'=' * 70}")
    print(f"  Messages in transcript: {len(messages)}")
    print(f"  Chunks created:         {len(chunks)}")
    print(f"  New chunks indexed:     {indexed}")
    print(f"  Dedup skipped:          {len(chunks) - indexed}")
    print(f"  Before memory count:    {before_count}")
    print(f"  After memory count:     {after_count}")
    print(f"  Net change:             +{after_count - before_count}")
    print(f"\nDone! ✅")


if __name__ == "__main__":
    main()
