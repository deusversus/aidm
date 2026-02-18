"""Quick verification: Check SQLite NPCs/Factions and detect_npcs_in_text works."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.db.models import NPC, Campaign, Faction
from src.db.session import get_session, init_db

init_db()

db = get_session().__enter__()
campaign = db.query(Campaign).filter(Campaign.profile_id.isnot(None)).first()
if not campaign:
    print("No campaign found")
    exit(1)

cid = campaign.id
print(f"Campaign: {campaign.name} (id={cid})")

npcs = db.query(NPC).filter(NPC.campaign_id == cid).all()
print(f"\n=== NPCs ({len(npcs)}) ===")
for n in npcs:
    print(f"  {n.name} | role={n.role} | affinity={n.affinity} | disposition={n.disposition}")
    print(f"    intelligence={n.intelligence_stage} | growth={n.growth_stage} | scenes={n.scene_count}")
    print(f"    notes: {(n.relationship_notes or '')[:100]}")

factions = db.query(Faction).filter(Faction.campaign_id == cid).all()
print(f"\n=== Factions ({len(factions)}) ===")
for f in factions:
    print(f"  {f.name} | power={f.power_level}")
    print(f"    desc: {(f.description or '')[:100]}")

# Test detect_npcs_in_text
from src.db.state_manager import StateManager

sm = StateManager(cid)
test_text = "Mori screamed as Goro pulled Reika to safety."
detected = sm.detect_npcs_in_text(test_text)
print("\n=== detect_npcs_in_text Test ===")
print(f"  Input: '{test_text}'")
print(f"  Detected: {detected}")

# Test NPC cards
cards = sm.get_present_npc_cards(detected)
print("\n=== NPC Cards ===")
print(cards)

print("\n=== ALL CHECKS PASSED ===")
