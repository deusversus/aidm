"""
One-time backfill: Migrate existing NPC/Faction ChromaDB memories → SQLite.

Parses "NPC {name}: {description}" and "Faction: {name} - {description}" format
memories from the campaign collection and creates structured SQLite records.

Run with server STOPPED:
  venv313\Scripts\python.exe backfill_npcs.py
"""
import sys, os, re, json, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SESSION_ID = "ddb5a17e-41dc-419d-8603-b57e964c3b83"

def main():
    import chromadb
    from src.db.session import init_db, get_session
    from src.db.models import NPC, Faction, Campaign
    from sqlalchemy import func
    
    init_db()
    
    # 1. Get campaign_id from profile mapping
    print("=" * 60)
    print("NPC/Faction Backfill from ChromaDB → SQLite")
    print("=" * 60)
    
    db = get_session().__enter__()
    campaign = db.query(Campaign).filter(Campaign.profile_id.isnot(None)).first()
    if not campaign:
        print("ERROR: No campaign found in database")
        return
    
    campaign_id = campaign.id
    print(f"Campaign: id={campaign_id}, name={campaign.name}")
    
    # 2. Read ChromaDB campaign memories
    client = chromadb.PersistentClient(path="./data/chroma")
    coll = client.get_or_create_collection(name=f"campaign_{SESSION_ID}")
    all_data = coll.get(include=["documents", "metadatas"])
    
    print(f"Total campaign memories: {len(all_data['ids'])}")
    
    # 3. Extract NPC and Faction memories
    npc_memories = {}  # name -> {description, role, turns}
    faction_memories = {}  # name -> {description, turns}
    
    for i, meta in enumerate(all_data["metadatas"]):
        doc = all_data["documents"][i]
        flags = meta.get("flags", "")
        turn = meta.get("turn", 0)
        
        if "npc" in flags and doc.startswith("NPC "):
            # Parse "NPC {name}: {description}"
            match = re.match(r"^NPC ([^:]+):\s*(.*)", doc, re.DOTALL)
            if match:
                name = match.group(1).strip()
                desc = match.group(2).strip()
                
                if name not in npc_memories or len(desc) > len(npc_memories[name].get("description", "")):
                    npc_memories[name] = {
                        "description": desc,
                        "turns": [turn],
                    }
                else:
                    npc_memories[name]["turns"].append(turn)
        
        elif "faction" in flags and ("Faction:" in doc or "Faction " in doc):
            # Parse "Faction: {name} - {description}" or "Faction {name} - ..."
            match = re.match(r"^Faction:?\s*([^-]+)\s*-\s*(.*)", doc, re.DOTALL)
            if match:
                name = match.group(1).strip()
                desc = match.group(2).strip()
                
                if name not in faction_memories or len(desc) > len(faction_memories[name].get("description", "")):
                    faction_memories[name] = {
                        "description": desc,
                        "turns": [turn],
                    }
                else:
                    faction_memories[name]["turns"].append(turn)
    
    print(f"\nFound {len(npc_memories)} unique NPCs: {list(npc_memories.keys())}")
    print(f"Found {len(faction_memories)} unique factions: {list(faction_memories.keys())}")
    
    # 4. Check existing SQLite records
    existing_npcs = {npc.name.lower(): npc for npc in db.query(NPC).filter(NPC.campaign_id == campaign_id).all()}
    existing_factions = {f.name.lower(): f for f in db.query(Faction).filter(Faction.campaign_id == campaign_id).all()}
    
    print(f"\nExisting SQLite NPCs: {len(existing_npcs)}")
    print(f"Existing SQLite Factions: {len(existing_factions)}")
    
    # 5. Create NPC records
    created_npcs = 0
    skipped_npcs = 0
    for name, data in npc_memories.items():
        # Skip non-character "NPCs" (like creature types)
        if name.lower() in ("chitin crawlers",):
            print(f"  Skipping creature type: {name}")
            skipped_npcs += 1
            continue
            
        if name.lower() in existing_npcs:
            print(f"  NPC already exists: {name}")
            skipped_npcs += 1
            continue
        
        # Determine role from description
        desc_lower = data["description"].lower()
        if any(kw in desc_lower for kw in ("ally", "party", "squad", "companion", "team")):
            role = "ally"
        elif any(kw in desc_lower for kw in ("enemy", "hostile", "antagonist")):
            role = "enemy"
        elif any(kw in desc_lower for kw in ("mentor", "handler", "monitoring")):
            role = "mentor"
        else:
            role = "acquaintance"
        
        npc = NPC(
            campaign_id=campaign_id,
            name=name,
            role=role,
            relationship_notes=data["description"][:500],
            affinity=0,
            disposition=0,
            power_tier="T10",
            personality="",
            goals=[],
            ensemble_archetype=None,
            growth_stage="introduction",
            intelligence_stage="reactive",
            scene_count=len(data["turns"]),
            interaction_count=0,
            last_appeared=max(data["turns"]) if data["turns"] else None,
        )
        db.add(npc)
        created_npcs += 1
        print(f"  Created NPC: {name} (role={role}, scenes={len(data['turns'])})")
    
    # 6. Create Faction records
    created_factions = 0
    skipped_factions = 0
    for name, data in faction_memories.items():
        if name.lower() in existing_factions:
            print(f"  Faction already exists: {name}")
            skipped_factions += 1
            continue
        
        faction = Faction(
            campaign_id=campaign_id,
            name=name,
            description=data["description"][:500],
            power_level="regional",
            pc_controls=False,
            relationships={},
            subordinates=[],
            faction_goals=[],
            secrets=[],
            current_events=[],
        )
        db.add(faction)
        created_factions += 1
        print(f"  Created Faction: {name}")
    
    db.commit()
    
    # 7. Summary
    print(f"\n{'=' * 60}")
    print(f"BACKFILL COMPLETE")
    print(f"  NPCs created: {created_npcs}, skipped: {skipped_npcs}")
    print(f"  Factions created: {created_factions}, skipped: {skipped_factions}")
    print(f"{'=' * 60}")
    
    # 8. Verify
    total_npcs = db.query(NPC).filter(NPC.campaign_id == campaign_id).count()
    total_factions = db.query(Faction).filter(Faction.campaign_id == campaign_id).count()
    print(f"\nFinal count: {total_npcs} NPCs, {total_factions} Factions in SQLite")


if __name__ == "__main__":
    main()
