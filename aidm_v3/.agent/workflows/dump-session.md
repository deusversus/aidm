---
description: Dump session transcript from aidm_v3.db for debugging/review
---
# Session Transcript Dump

Use the script at `tools/dump_session.py` to dump the gameplay transcript.

## Common Usage

// turbo
1. **Summary of all turns** (quick overview):
```
venv313\Scripts\python.exe tools\dump_session.py --summary --all --out session_summary.txt
```

// turbo
2. **Last N turns** (detailed, for debugging a specific issue):
```
venv313\Scripts\python.exe tools\dump_session.py --last 5 --out session_recent.txt
```

// turbo
3. **Specific turn** (full detail):
```
venv313\Scripts\python.exe tools\dump_session.py --turn 12 --out session_turn12.txt
```

// turbo
4. **Full transcript dump**:
```
venv313\Scripts\python.exe tools\dump_session.py --all --out session_full.txt
```

After running, view the output file to read the transcript.
