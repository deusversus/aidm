# -*- coding: utf-8 -*-
"""Audit script v3 - UTF-8 safe."""
import sqlite3
import json
import os
import sys

# Force UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')

print("=" * 80)
print("AIDM Session Memory Audit v3")
print("=" * 80)

# === 1. World state remainder ===
print("\n--- SQLite: aidm_v3.db (remaining tables) ---")
conn = sqlite3.connect("aidm_v3.db")
c = conn.cursor()

# World state
c.execute("PRAGMA table_info(world_state)")
ws_cols = [r[1] for r in c.fetchall()]
c.execute("SELECT * FROM world_state")
for row in c.fetchall():
    print("\nWorld State:")
    for i, col in enumerate(ws_cols):
        if row[i] is not None:
            print(f"  {col}: {str(row[i])[:300]}")

# Campaign bible
c.execute("PRAGMA table_info(campaign_bible)")
cb_cols = [r[1] for r in c.fetchall()]
c.execute("SELECT * FROM campaign_bible")
for row in c.fetchall():
    print("\nCampaign Bible:")
    for i, col in enumerate(cb_cols):
        if row[i] is not None:
            val = str(row[i])
            if len(val) > 500:
                val = val[:500] + "..."
            print(f"  {col}: {val}")

# Turns
c.execute("PRAGMA table_info(turns)")
turn_cols = [r[1] for r in c.fetchall()]
c.execute("SELECT COUNT(*) FROM turns")
turn_count = c.fetchone()[0]
print(f"\nTurns: {turn_count} total")
c.execute("SELECT * FROM turns ORDER BY id DESC LIMIT 5")
for row in c.fetchall():
    print("\n  Turn:")
    for i, col in enumerate(turn_cols):
        if row[i] is not None:
            val = str(row[i])
            if len(val) > 400:
                val = val[:400] + "..."
            print(f"    {col}: {val}")

# Overrides
c.execute("SELECT COUNT(*) FROM overrides")
print(f"\nOverrides: {c.fetchone()[0]} total")

conn.close()

# === 2. sessions.db - full dump ===
print("\n\n--- SQLite: data/sessions.db ---")
if os.path.exists("data/sessions.db"):
    conn2 = sqlite3.connect("data/sessions.db")
    c2 = conn2.cursor()
    
    c2.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables2 = [r[0] for r in c2.fetchall()]
    print(f"Tables: {tables2}")
    
    for table in tables2:
        c2.execute(f"PRAGMA table_info({table})")
        cols = [r[1] for r in c2.fetchall()]
        c2.execute(f"SELECT COUNT(*) FROM {table}")
        count = c2.fetchone()[0]
        print(f"\n  {table}: {count} rows, columns={cols}")
        
        if table == "sessions":
            c2.execute("SELECT * FROM sessions ORDER BY rowid DESC LIMIT 5")
            for row in c2.fetchall():
                print(f"    Session: ", end="")
                for i, col in enumerate(cols):
                    if row[i] is not None:
                        val = str(row[i])[:100]
                        print(f"{col}={val}", end=" | ")
                print()
        
        if table == "messages":
            # Get message counts by session
            c2.execute("SELECT session_id, COUNT(*) as cnt FROM messages GROUP BY session_id")
            for row in c2.fetchall():
                print(f"    Session {row[0]}: {row[1]} messages")
            
            # Get the most recent session's messages
            c2.execute("SELECT session_id FROM sessions ORDER BY rowid DESC LIMIT 1")
            latest_session = c2.fetchone()
            if latest_session:
                sid = latest_session[0]
                c2.execute(f"SELECT * FROM messages WHERE session_id=? ORDER BY rowid", (sid,))
                msgs = c2.fetchall()
                print(f"\n    Latest session ({sid}) - {len(msgs)} messages:")
                for msg in msgs:
                    role = "?"
                    content = "?"
                    for i, col in enumerate(cols):
                        if col == "role":
                            role = msg[i]
                        elif col == "content":
                            content = str(msg[i])[:200]
                    print(f"      [{role}]: {content}")
                    print()
    
    conn2.close()

# === 3. ChromaDB full dump ===
print("\n\n--- ChromaDB Collections ---")
try:
    import chromadb
    client = chromadb.PersistentClient(path="./data/chroma")
    collections = client.list_collections()
    print(f"Collections: {len(collections)}")
    
    for col in collections:
        count = col.count()
        print(f"\n{'='*60}")
        print(f"COLLECTION: {col.name} ({count} memories)")
        print(f"{'='*60}")
        
        if count > 0:
            results = col.get(include=["documents", "metadatas"])
            
            # Stats
            type_counts = {}
            flag_counts = {}
            decay_counts = {}
            
            for meta in results["metadatas"]:
                mtype = meta.get("type", "unknown")
                type_counts[mtype] = type_counts.get(mtype, 0) + 1
                flags = meta.get("flags", "")
                for flag in flags.split(","):
                    if flag.strip():
                        flag_counts[flag.strip()] = flag_counts.get(flag.strip(), 0) + 1
                decay = meta.get("decay_rate", "unknown")
                decay_counts[decay] = decay_counts.get(decay, 0) + 1
            
            print(f"  By type: {json.dumps(type_counts)}")
            print(f"  By flags: {json.dumps(flag_counts)}")
            print(f"  By decay: {json.dumps(decay_counts)}")
            
            # All memories
            for i in range(count):
                doc = results["documents"][i]
                meta = results["metadatas"][i]
                heat = meta.get("heat", "?")
                mtype = meta.get("type", "?")
                flags = meta.get("flags", "")
                decay = meta.get("decay_rate", "?")
                source = meta.get("source", "")
                preview = doc[:400].replace("\n", " | ").replace("\r", "")
                print(f"\n  [{i+1}] type={mtype} | heat={heat} | decay={decay}")
                print(f"      flags={flags} | source={source}")
                print(f"      {preview}")

except Exception as e:
    print(f"ChromaDB error: {e}")
    import traceback
    traceback.print_exc()

# === 4. Custom ChromaDB ===
print("\n\n--- ChromaDB Custom (Lore) ---")
try:
    client2 = chromadb.PersistentClient(path="./data/chroma_custom")
    cols2 = client2.list_collections()
    print(f"Collections: {len(cols2)}")
    for col in cols2:
        count = col.count()
        print(f"  {col.name}: {count} chunks")
except Exception as e:
    print(f"Custom ChromaDB: {e}")

print("\n" + "=" * 80)
print("AUDIT COMPLETE")
