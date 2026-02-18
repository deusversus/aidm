"""
Override Handler for AIDM v3.

Processes player feedback commands:
- /meta: Suggestions stored in memory (sanity-checked)
- /override: Hard constraints stored in override log (always enforced)
"""

from typing import List, Optional, Dict, Any
from datetime import datetime
from sqlalchemy.orm import Session as DBSession

from src.db.models import Override, Campaign
from src.context.memory import MemoryStore


class OverrideHandler:
    """
    Handles META and OVERRIDE player feedback.
    
    META: Suggestions that influence the system (stored in memory)
    OVERRIDE: Hard constraints that must be enforced (stored in override log)
    """
    
    # Category detection patterns
    CATEGORY_PATTERNS = {
        "NPC_PROTECTION": ["cannot die", "must survive", "protected", "immortal", "unkillable"],
        "CONTENT_CONSTRAINT": ["no torture", "no gore", "no sexual", "skip", "avoid", "don't include"],
        "NARRATIVE_DEMAND": ["must happen", "needs to", "I want", "story must", "plot needs"],
        "TONE_REQUIREMENT": ["more comedy", "less dark", "lighter", "darker", "more serious", "less grim"]
    }
    
    def __init__(self, db: DBSession, memory_store: MemoryStore):
        self.db = db
        self.memory_store = memory_store
    
    def process_meta(
        self, 
        content: str, 
        campaign_id: int,
        session_number: int = 0
    ) -> Dict[str, Any]:
        """
        Process /meta feedback as a memory (sanity-checked by natural retrieval).
        
        Args:
            content: Player's feedback text
            campaign_id: Campaign ID
            session_number: Current session number
            
        Returns:
            Dict with status and created memory
        """
        # Store feedback as high-heat memory (will be retrieved via RAG when relevant)
        self.memory_store.add_memory(
            content=f"Player feedback: {content}",
            memory_type="calibration",
            turn_number=0,  # Meta commands are session-level
            metadata={
                "feedback": content,
                "session_number": session_number,
                "type": "meta",
                "category": "STYLE_CALIBRATION"
            },
            flags=["player_feedback", "meta_command", "calibration"]
        )
        
        return {
            "status": "accepted",
            "type": "meta",
            "message": f"✓ Feedback noted: \"{content}\"\nThis will influence future narration.",
            "memory_created": True
        }
    
    def process_override(
        self,
        content: str,
        campaign_id: int,
        target: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Process /override command as a hard constraint.
        
        Args:
            content: Player's constraint description
            campaign_id: Campaign ID
            target: Optional specific target (NPC name, topic, etc.)
            
        Returns:
            Dict with status, warning, and created override
        """
        # Detect category from content
        category = self._detect_category(content)
        
        # Extract target if not provided
        if not target:
            target = self._extract_target(content, category)
        
        # Create override
        override = Override(
            campaign_id=campaign_id,
            category=category,
            description=content,
            target=target,
            active=True,
            created_at=datetime.utcnow()
        )
        
        self.db.add(override)
        self.db.commit()
        self.db.refresh(override)
        
        # Build warning message
        warning = self._get_warning_for_category(category, content)
        
        return {
            "status": "created",
            "type": "override",
            "id": override.id,
            "category": category,
            "warning": warning,
            "message": f"⚠️ Override active: {content}\n{warning}\nUse '/override remove {override.id}' to remove."
        }
    
    def get_active_overrides(self, campaign_id: int) -> List[Override]:
        """
        Get all active overrides for a campaign.
        
        These are injected directly into agent context (not via RAG).
        """
        return self.db.query(Override).filter(
            Override.campaign_id == campaign_id,
            Override.active == True
        ).all()
    
    def format_overrides_for_context(self, campaign_id: int) -> str:
        """
        Format active overrides for agent context injection.
        
        Returns:
            Formatted string for agent prompts
        """
        overrides = self.get_active_overrides(campaign_id)
        
        if not overrides:
            return ""
        
        lines = ["## PLAYER OVERRIDES (MUST BE ENFORCED)"]
        for o in overrides:
            lines.append(f"- [{o.category}] {o.description}")
            if o.target:
                lines.append(f"  Target: {o.target}")
        
        return "\n".join(lines)
    
    def remove_override(self, override_id: int, campaign_id: int) -> bool:
        """
        Deactivate an override.
        """
        override = self.db.query(Override).filter(
            Override.id == override_id,
            Override.campaign_id == campaign_id
        ).first()
        
        if override:
            override.active = False
            self.db.commit()
            return True
        return False
    
    def list_overrides(self, campaign_id: int) -> List[Dict[str, Any]]:
        """
        List all overrides for a campaign (active and inactive).
        """
        overrides = self.db.query(Override).filter(
            Override.campaign_id == campaign_id
        ).all()
        
        return [{
            "id": o.id,
            "category": o.category,
            "description": o.description,
            "target": o.target,
            "active": o.active,
            "created_at": o.created_at.isoformat()
        } for o in overrides]
    
    def _detect_category(self, content: str) -> str:
        """Detect override category from content."""
        content_lower = content.lower()
        
        for category, patterns in self.CATEGORY_PATTERNS.items():
            for pattern in patterns:
                if pattern in content_lower:
                    return category
        
        return "NARRATIVE_DEMAND"  # Default
    
    def _extract_target(self, content: str, category: str) -> Optional[str]:
        """Try to extract target from content."""
        # Simple heuristic: look for capitalized names
        words = content.split()
        for word in words:
            if word[0].isupper() and word not in ["I", "The", "My", "No"]:
                return word.strip(".,!?")
        return None
    
    def _get_warning_for_category(self, category: str, content: str) -> str:
        """Get appropriate warning for override category."""
        warnings = {
            "NPC_PROTECTION": "⚠️ This character cannot be meaningfully threatened. Narrative tension involving them will be limited.",
            "CONTENT_CONSTRAINT": "✓ Content constraint active. This topic will be avoided.",
            "NARRATIVE_DEMAND": "⚠️ Forcing narrative outcomes may reduce story coherence. Consider discussing with the DM via /meta first.",
            "TONE_REQUIREMENT": "⚠️ Tone override active. This may conflict with genre expectations."
        }
        return warnings.get(category, "Override active.")


def get_override_handler(db: DBSession, memory_store: MemoryStore) -> OverrideHandler:
    """Get an OverrideHandler instance."""
    return OverrideHandler(db=db, memory_store=memory_store)
