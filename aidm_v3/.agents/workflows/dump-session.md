---
description: Dump the current gameplay session transcript from aidm_v3.db for debugging/review
---

# Dump Session Transcript

Run this script to dump the latest session transcript from the database.

// turbo-all

1. Run the dump script:
```
cd c:\Users\admin\Downloads\animerpg\aidm_v3
.\venv313\Scripts\python -X utf8 -c "
import sys, os
sys.path.insert(0, '.')
os.environ.setdefault('PYTHONDONTWRITEBYTECODE', '1')
import logging; logging.disable(logging.CRITICAL)
from src.db.session import create_session as create_db_session
from src.db.models import Session, Turn, Campaign
db = create_db_session()
campaign = db.query(Campaign).order_by(Campaign.id.desc()).first()
if not campaign:
    print('No campaigns found'); sys.exit(1)
print(f'Campaign: {campaign.name} (id={campaign.id}, profile={campaign.profile_id})')
print(f'Media UUID: {campaign.media_uuid}')
print('=' * 80)
sessions = db.query(Session).filter(Session.campaign_id == campaign.id).all()
for sess in sessions:
    turns = db.query(Turn).filter(Turn.session_id == sess.id).order_by(Turn.turn_number).all()
    print(f'Session #{sess.id} | Turns: {len(turns)}')
    for t in turns:
        print(f'\n{\"=\" * 60}')
        print(f'TURN {t.turn_number}')
        print(f'{\"=\" * 60}')
        if t.player_input:
            print(f'\nPLAYER: {t.player_input}')
        if t.narrative:
            print(f'\nNARRATIVE:\n{t.narrative}')
db.close()
"
```

2. The output will show all turns with player input and narrative text for the latest campaign.

**Notes:**
- Uses `-X utf8` flag to handle emoji/Unicode in narratives
- Queries the most recent campaign by ID
- Shows all sessions and turns for that campaign
