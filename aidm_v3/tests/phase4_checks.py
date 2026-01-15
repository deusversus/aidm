
import sys
import os
import asyncio
from datetime import datetime

# Add src to path
sys.path.append(os.path.join(os.getcwd(), "aidm_v3", "src"))
sys.path.append(os.path.join(os.getcwd(), "aidm_v3"))

try:
    from src.db.models import CampaignBible, Campaign
    from src.agents.director import DirectorAgent
    from src.core.orchestrator import Orchestrator
    from src.db.state_manager import StateManager
except ImportError:
    import traceback
    traceback.print_exc()
    sys.exit(1)

async def verify_director():
    print("Initializing DirectorAgent...")
    director = DirectorAgent()
    print(f"✅ Director initialized. Name: {director.agent_name}")
    
    if director.output_schema.__name__ != "DirectorOutput":
        print(f"❌ Schema mismatch: {director.output_schema.__name__}")
        sys.exit(1)
    else:
        print("✅ DirectorOutput schema verified")

    # Check StateManager methods
    print("Checking StateManager extensions...")
    if hasattr(StateManager, 'get_campaign_bible') and hasattr(StateManager, 'update_campaign_bible'):
        print("✅ StateManager has CampaignBible methods")
    else:
        print("❌ StateManager missing CampaignBible methods")
        sys.exit(1)

    print("✅ Verification Complete")

if __name__ == "__main__":
    asyncio.run(verify_director())
