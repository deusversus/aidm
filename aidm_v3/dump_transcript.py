"""Extract session transcript from sessions.db JSON blob format."""
import sqlite3, json

conn = sqlite3.connect('data/sessions.db')
cur = conn.cursor()

sessions = cur.execute("SELECT session_id, data, created_at FROM sessions ORDER BY created_at").fetchall()
print(f"Found {len(sessions)} sessions\n")

with open("transcript_dump.txt", "w", encoding="utf-8") as f:
    for session_id, data_blob, created_at in sessions:
        f.write(f"SESSION: {session_id} (created: {created_at})\n")
        f.write("=" * 80 + "\n\n")
        
        # Parse JSON blob
        try:
            data = json.loads(data_blob)
        except:
            f.write(f"[Could not parse data blob, type={type(data_blob)}]\n")
            # Maybe it's already a dict?
            if isinstance(data_blob, bytes):
                data = json.loads(data_blob.decode('utf-8'))
            else:
                f.write(f"Raw data: {str(data_blob)[:200]}\n\n")
                continue
        
        # Print top-level keys
        if isinstance(data, dict):
            f.write(f"Top-level keys: {list(data.keys())}\n\n")
            
            # Look for messages in common locations
            messages = data.get('messages', data.get('history', data.get('conversation', [])))
            if not messages and 'session_zero' in data:
                sz = data['session_zero']
                if isinstance(sz, dict):
                    messages = sz.get('messages', sz.get('history', []))
            
            # If data has a 'gameplay' key
            if not messages and 'gameplay' in data:
                gp = data['gameplay']
                if isinstance(gp, dict):
                    messages = gp.get('messages', gp.get('history', []))
            
            if messages:
                f.write(f"Messages: {len(messages)}\n\n")
                for i, msg in enumerate(messages):
                    if isinstance(msg, dict):
                        role = msg.get('role', 'unknown')
                        content = msg.get('content', '')
                        f.write(f"--- [{i+1}] {role.upper()} ---\n")
                        f.write(str(content) + "\n\n")
                    else:
                        f.write(f"--- [{i+1}] ---\n{str(msg)}\n\n")
            else:
                # Just dump all keys and their types/sizes
                for k, v in data.items():
                    if isinstance(v, list):
                        f.write(f"  {k}: list[{len(v)}]\n")
                    elif isinstance(v, dict):
                        f.write(f"  {k}: dict keys={list(v.keys())[:10]}\n")
                    elif isinstance(v, str):
                        f.write(f"  {k}: str len={len(v)}\n")
                    else:
                        f.write(f"  {k}: {type(v).__name__} = {str(v)[:100]}\n")
        elif isinstance(data, list):
            f.write(f"Data is list of {len(data)} items\n\n")
            for i, item in enumerate(data):
                if isinstance(item, dict):
                    role = item.get('role', 'unknown')
                    content = item.get('content', '')
                    f.write(f"--- [{i+1}] {role.upper()} ---\n")
                    f.write(str(content) + "\n\n")
        
        f.write("\n\n")

conn.close()
print("Transcript dumped to transcript_dump.txt")
