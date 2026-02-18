"""NPC mixin: NPC CRUD, relationships, disposition, intelligence, behavior, ensemble.

Split from state_manager.py for maintainability.
"""

import logging
from typing import Any

from ..enums import NPCIntelligenceStage
from .models import NPC

logger = logging.getLogger(__name__)


class NPCMixin:
    """NPC CRUD, relationships, intelligence, behavior, milestones."""

    # ==== NPC Intelligence (Module 04) ====

    DISPOSITION_THRESHOLDS = {
        "hostile": (-100, -61),
        "unfriendly": (-60, -21),
        "neutral": (-20, 29),
        "friendly": (30, 59),
        "trusted": (60, 89),
        "devoted": (90, 100)
    }

    # Valid emotional milestone types (Module 04 P5-16)
    EMOTIONAL_MILESTONE_TYPES = [
        "first_humor",      # Laughed together
        "first_concern",    # Showed genuine worry for PC
        "first_disagreement",  # Had a real argument
        "first_initiative", # Acted independently to help
        "first_sacrifice",  # Took a hit for PC
        "first_vulnerability",  # Shared deep fear/secret
        "first_trust_test", # PC could have betrayed but didn't
    ]

    def create_npc(
        self,
        name: str,
        role: str = "acquaintance",
        relationship_notes: str | None = None,
        **kwargs
    ) -> NPC:
        """Create an NPC from world-building assertion.
        
        Args:
            name: NPC name
            role: Role/relationship to player (ally, rival, mentor, etc.)
            relationship_notes: Backstory/notes about the relationship
            **kwargs: Additional NPC fields
            
        Returns:
            Created NPC instance
        """
        db = self._get_db()

        # Check if NPC already exists
        existing = (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{name}%"))
            .first()
        )
        if existing:
            # Update existing NPC
            if relationship_notes:
                existing.relationship_notes = relationship_notes
            if role:
                existing.role = role
            db.commit()
            return existing

        # Create new NPC
        npc = NPC(
            campaign_id=self.campaign_id,
            name=name,
            role=role,
            relationship_notes=relationship_notes or "",
            affinity=kwargs.get("affinity", 0),
            disposition=kwargs.get("disposition", 0),
            power_tier=kwargs.get("power_tier", "T10"),
            personality=kwargs.get("personality", ""),
            goals=kwargs.get("goals", []),
            ensemble_archetype=kwargs.get("ensemble_archetype"),
            appearance=kwargs.get("appearance", {}),
            visual_tags=kwargs.get("visual_tags", []),
            growth_stage="introduction",
            intelligence_stage=NPCIntelligenceStage.REACTIVE,
            scene_count=0,
            interaction_count=0,
        )
        db.add(npc)
        db.commit()
        return npc

    def upsert_npc(
        self,
        name: str,
        role: str = "acquaintance",
        relationship_notes: str | None = None,
        personality: str | None = None,
        goals: list[str] | None = None,
        secrets: list[str] | None = None,
        faction: str | None = None,
        visual_tags: list[str] | None = None,
        knowledge_topics: dict[str, str] | None = None,
        power_tier: str | None = None,
        ensemble_archetype: str | None = None,
        appearance: dict | None = None,
    ) -> NPC:
        """Create or enrich an NPC.

        - If NPC doesn't exist: creates with all provided fields.
        - If NPC exists: merges non-empty fields without overwriting
          existing populated data (enrichment, not replacement).

        Mirrors the ``upsert_location()`` pattern.

        Args:
            name: NPC name (fuzzy matched for dedup)
            role: Relationship to player
            relationship_notes: Backstory/notes
            personality: 1-2 sentence personality description
            goals: Known/implied goals
            secrets: Concealed info hinted at
            faction: Organization affiliation
            visual_tags: Visual descriptors for portrait generation
            knowledge_topics: Topics the NPC knows about
            power_tier: Estimated power tier
            ensemble_archetype: Ensemble role
            appearance: Visual appearance dict

        Returns:
            Created or enriched NPC instance
        """
        db = self._get_db()

        # Check for existing NPC (fuzzy)
        existing = (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{name}%"))
            .first()
        )

        if existing:
            # --- ENRICH existing NPC (never overwrite populated fields) ---
            changed = []

            if role and role != "acquaintance" and (not existing.role or existing.role == "acquaintance"):
                existing.role = role
                changed.append("role")

            if relationship_notes and not existing.relationship_notes:
                existing.relationship_notes = relationship_notes
                changed.append("relationship_notes")

            if personality and not existing.personality:
                existing.personality = personality
                changed.append("personality")

            if goals:
                existing_goals = existing.goals or []
                new_goals = [g for g in goals if g not in existing_goals]
                if new_goals:
                    existing.goals = existing_goals + new_goals
                    changed.append("goals")

            if secrets:
                existing_secrets = existing.secrets or []
                new_secrets = [s for s in secrets if s not in existing_secrets]
                if new_secrets:
                    existing.secrets = existing_secrets + new_secrets
                    changed.append("secrets")

            if faction and not existing.faction:
                existing.faction = faction
                changed.append("faction")

            if visual_tags:
                existing_tags = existing.visual_tags or []
                new_tags = [t for t in visual_tags if t not in existing_tags]
                if new_tags:
                    existing.visual_tags = existing_tags + new_tags
                    changed.append("visual_tags")

            if knowledge_topics:
                existing_topics = existing.knowledge_topics or {}
                merged = {**existing_topics, **knowledge_topics}
                if merged != existing_topics:
                    existing.knowledge_topics = merged
                    changed.append("knowledge_topics")

            if power_tier and power_tier != "T10" and (not existing.power_tier or existing.power_tier == "T10"):
                existing.power_tier = power_tier
                changed.append("power_tier")

            if ensemble_archetype and not existing.ensemble_archetype:
                existing.ensemble_archetype = ensemble_archetype
                changed.append("ensemble_archetype")

            if appearance:
                existing_appearance = existing.appearance or {}
                merged = {**existing_appearance, **appearance}
                if merged != existing_appearance:
                    existing.appearance = merged
                    changed.append("appearance")

            if changed:
                db.commit()
                logger.info(f"Enriched NPC {existing.name}: {', '.join(changed)}")
            return existing

        # --- CREATE new NPC with all available fields ---
        npc = NPC(
            campaign_id=self.campaign_id,
            name=name,
            role=role,
            relationship_notes=relationship_notes or "",
            personality=personality or "",
            goals=goals or [],
            secrets=secrets or [],
            faction=faction,
            visual_tags=visual_tags or [],
            knowledge_topics=knowledge_topics or {},
            power_tier=power_tier or "T10",
            ensemble_archetype=ensemble_archetype,
            appearance=appearance or {},
            affinity=0,
            disposition=0,
            growth_stage="introduction",
            intelligence_stage=NPCIntelligenceStage.REACTIVE,
            scene_count=0,
            interaction_count=0,
        )
        db.add(npc)
        db.commit()
        logger.info(f"Created NPC: {name} (role={role}, personality={'yes' if personality else 'no'})")
        return npc

    def get_npc(self, npc_id: int) -> NPC | None:
        """Get an NPC by ID."""
        db = self._get_db()
        return db.query(NPC).filter(NPC.id == npc_id).first()

    def get_npc_by_name(self, name: str) -> NPC | None:
        """Get an NPC by name (fuzzy match)."""
        db = self._get_db()
        return (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{name}%"))
            .first()
        )

    def get_all_npcs(self) -> list[NPC]:
        """Get all NPCs in the campaign."""
        db = self._get_db()
        return db.query(NPC).filter(NPC.campaign_id == self.campaign_id).all()

    def update_npc_relationship(
        self,
        npc_name: str,
        affinity_delta: int,
        turn_number: int,
        emotional_milestone: str | None = None,
        milestone_context: str | None = None
    ) -> NPC | None:
        """Apply a relationship update to an NPC.
        
        Updates affinity, tracks emotional milestones, increments counters,
        recalculates disposition, and evolves intelligence stage.
        
        Args:
            npc_name: Name of the NPC
            affinity_delta: Change in affinity (-10 to +10)
            turn_number: Current turn number
            emotional_milestone: Optional milestone key (e.g., 'first_humor')
            milestone_context: Reasoning for milestone
            
        Returns:
            Updated NPC or None if not found
        """
        npc = self.get_npc_by_name(npc_name)
        if not npc:
            return None

        db = self._get_db()

        # Update affinity (clamp to -100/+100)
        npc.affinity = max(-100, min(100, (npc.affinity or 0) + affinity_delta))
        npc.interaction_count = (npc.interaction_count or 0) + 1
        npc.last_appeared = turn_number

        # Track emotional milestone (only firsts count)
        if emotional_milestone:
            milestones = npc.emotional_milestones or {}
            if emotional_milestone not in milestones:
                milestones[emotional_milestone] = {
                    "turn": turn_number,
                    "context": milestone_context or ""
                }
                npc.emotional_milestones = milestones
                logger.info(f"{npc.name}: Emotional milestone '{emotional_milestone}' at turn {turn_number}")

        # Recalculate disposition
        npc.disposition = self.get_npc_disposition(npc.id)

        # Evolve intelligence stage based on interaction count
        interaction_count = self.get_npc_interaction_count(npc.id)
        self.evolve_npc_intelligence(npc.id, interaction_count)

        self._maybe_commit()

        if affinity_delta != 0:
            logger.info(f"{npc.name}: affinity {affinity_delta:+d} → {npc.affinity} (disposition: {npc.disposition})")

        return npc

    def evolve_npc_intelligence(self, npc_id: int, interaction_count: int, trust_milestone: bool = False):
        """
        Progress NPC cognitive evolution based on interactions.
        
        Stages (Module 04):
        - REACTIVE (default): Responds to direct stimuli
        - CONTEXTUAL (5+ interactions): Remembers patterns
        - ANTICIPATORY (trust + shared challenge): Proactively prepares
        - AUTONOMOUS (major quest + high affinity): Acts independently
        
        Args:
            npc_id: NPC ID
            interaction_count: Number of meaningful interactions
            trust_milestone: Whether trust threshold was just crossed
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return

        current_stage = npc.intelligence_stage or NPCIntelligenceStage.REACTIVE
        new_stage = current_stage
        disposition = self.get_npc_disposition(npc_id)

        # Progression logic
        if current_stage == "reactive" and interaction_count >= 5:
            new_stage = "contextual"
        elif current_stage == "contextual" and trust_milestone and disposition >= 60:
            new_stage = "anticipatory"
        elif current_stage == "anticipatory" and disposition >= 80:
            # Requires major quest completion together (tracked elsewhere)
            new_stage = "autonomous"

        if new_stage != current_stage:
            db = self._get_db()
            npc.intelligence_stage = new_stage
            self._maybe_commit()
            logger.info(f"{npc.name}: {current_stage} → {new_stage}")

    def get_present_npc_cards(self, npc_names: list[str]) -> str:
        """Build formatted NPC context cards for narrative agents.
        
        Provides relationship-aware context so KeyAnimator can write
        disposition-appropriate dialogue (hostile NPCs sound hostile, etc.).
        
        Args:
            npc_names: List of NPC names present in the scene
            
        Returns:
            Formatted string of NPC cards, or empty string
        """
        cards = []
        for name in npc_names:
            npc = self.get_npc_by_name(name)
            if not npc:
                continue

            # Determine disposition label
            disp = npc.disposition or 0
            if disp >= 90:
                disp_label = "devoted"
            elif disp >= 60:
                disp_label = "trusted"
            elif disp >= 30:
                disp_label = "friendly"
            elif disp >= -20:
                disp_label = "neutral"
            elif disp >= -60:
                disp_label = "unfriendly"
            else:
                disp_label = "hostile"

            # Build milestone summary
            milestones = npc.emotional_milestones or {}
            milestone_str = ", ".join(milestones.keys()) if milestones else "none yet"

            # Intelligence stage hint
            intel = npc.intelligence_stage or NPCIntelligenceStage.REACTIVE

            card = (
                f"**{npc.name}** ({npc.role or 'unknown'}, {disp_label})\n"
                f"  Affinity: {npc.affinity or 0}/100 | Scenes: {npc.scene_count or 0} | Intelligence: {intel}\n"
                f"  Personality: {npc.personality or 'Unknown'}\n"
                f"  Milestones: {milestone_str}"
            )
            cards.append(card)

        return "\n\n".join(cards)

    def get_npc_disposition(self, npc_id: int) -> int:
        """
        Calculate NPC disposition using Module 04 formula:
        Disposition = (Affinity × 0.6) + (FactionRep × 0.4) + Modifier
        
        Returns:
            Disposition score (-100 to +100)
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return 0

        character = self.get_character()
        if not character:
            return npc.affinity or 0

        # Base affinity (personal relationship)
        affinity = npc.affinity or 0

        # Faction reputation
        faction_rep = 0
        if npc.faction and character.faction_reputations:
            raw_rep = character.faction_reputations.get(npc.faction, 0)
            faction_rep = raw_rep / 10  # Normalize -1000/+1000 → -100/+100

        # Faction relationship modifier
        modifier = self._get_faction_modifier(npc.faction, character.faction)

        # Calculate
        disposition = int((affinity * 0.6) + (faction_rep * 0.4) + modifier)
        return max(-100, min(100, disposition))  # Clamp

    def _get_faction_modifier(self, npc_faction: str | None, pc_faction: str | None) -> int:
        """
        Get faction relationship modifier based on inter-faction politics.
        Allied factions: +20, Enemy factions: -35, At war: -50
        """
        if not npc_faction or not pc_faction:
            return 0

        if npc_faction == pc_faction:
            return 20  # Same faction = allied bonus

        # Look up faction relationship
        relationship = self.get_faction_relationship(npc_faction, pc_faction)

        modifiers = {
            "allied": 20,
            "friendly": 10,
            "neutral": 0,
            "unfriendly": -15,
            "enemy": -35,
            "at_war": -50
        }

        return modifiers.get(relationship, 0)

    # ==== Spotlight Tracking (Phase 4: Director Layer) ====

    def compute_spotlight_debt(self) -> dict[str, int]:
        """
        Compute which NPCs need more screen time.
        
        Returns:
            Dict mapping NPC names to spotlight debt 
            (positive = needs more scenes, negative = over-exposed)
        """
        db = self._get_db()
        npcs = db.query(NPC).filter(NPC.campaign_id == self.campaign_id).all()

        if not npcs:
            return {}

        avg_scene_count = sum(n.scene_count for n in npcs) / len(npcs)
        return {n.name: int(avg_scene_count - n.scene_count) for n in npcs}

    def increment_npc_scene_count(self, npc_name: str, turn_number: int):
        """
        Track that an NPC appeared in a scene.
        
        Args:
            npc_name: Name of the NPC
            turn_number: Current turn number for last_appeared tracking
        """
        db = self._get_db()
        npc = (
            db.query(NPC)
            .filter(NPC.campaign_id == self.campaign_id)
            .filter(NPC.name.ilike(f"%{npc_name}%"))
            .first()
        )

        if npc:
            npc.scene_count = (npc.scene_count or 0) + 1
            npc.last_appeared = turn_number
            self._maybe_commit()

    def check_npc_knowledge(self, npc_id: int, topic: str) -> dict[str, Any]:
        """
        Check if NPC knows about a topic and at what depth.
        
        Args:
            npc_id: NPC ID
            topic: Topic to check
            
        Returns:
            {"knows": bool, "depth": str|None, "can_share": bool, "reason": str}
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return {"knows": False, "depth": None, "can_share": False, "reason": "npc_not_found"}

        # Check prohibited
        boundaries = npc.knowledge_boundaries or []
        if topic.lower() in [t.lower() for t in boundaries]:
            return {"knows": False, "depth": None, "can_share": False, "reason": "prohibited"}

        # Check known topics
        topics = npc.knowledge_topics or {}
        depth = topics.get(topic.lower())
        if not depth:
            return {"knows": False, "depth": None, "can_share": False, "reason": "unknown"}

        # Check if willing to share (affinity based)
        disposition = self.get_npc_disposition(npc_id)
        can_share = disposition >= 30 or depth == "basic"  # Friendly+, or common knowledge

        return {"knows": True, "depth": depth, "can_share": can_share, "reason": "known"}

    def get_npc_behavior_context(self, npc_id: int, situation: str = "",
                                  narrative_scale: str = "strategic") -> str:
        """
        Generate NPC behavior guidance combining:
        - Personality (40%)
        - Situation (30%)
        - Affinity (20%)
        - Goals (10%)
        
        PLUS OP mode adjustments based on narrative scale.
        
        Args:
            npc_id: NPC ID
            situation: Current situation description
            narrative_scale: Active narrative scale (tactical, ensemble, spectacle, etc.)
            
        Returns:
            Formatted behavior guidance string for Key Animator
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return ""

        disposition = self.get_npc_disposition(npc_id)
        label = self.get_disposition_label(disposition)

        lines = [
            f"## NPC: {npc.name}",
            f"**Disposition**: {disposition} ({label.upper()})",
            f"**Role**: {npc.role or 'neutral'} | **Power**: {npc.power_tier}",
        ]

        if npc.personality:
            lines.append(f"**Personality**: {npc.personality}")

        if npc.goals:
            lines.append(f"**Goals**: {', '.join(npc.goals) if isinstance(npc.goals, list) else npc.goals}")

        # OP Mode behavior adjustment
        if npc.ensemble_archetype:
            lines.append(f"\n**Ensemble Archetype**: {npc.ensemble_archetype.upper()}")
            op_behavior = self._get_npc_op_behavior(
                npc.ensemble_archetype,
                narrative_scale,
                disposition
            )
            lines.append(f"**OP Mode Guidance**: {op_behavior}")

        return "\n".join(lines)

    def _get_npc_op_behavior(self, archetype: str, scale: str, disposition: int) -> str:
        """
        How should this NPC behave given archetype + active narrative scale?
        """
        behaviors = {
            # Ensemble archetypes in different scales
            ("struggler", "ensemble"): "Tries to keep up with PC, measures against PC's strength, drives own growth",
            ("struggler", "spectacle"): "Watches in awe, then trains harder after",
            ("heart", "ensemble"): "Emotional anchor, reminds PC of what matters beyond power",
            ("heart", "conceptual"): "Asks about feelings, not power. Grounds PC in normalcy.",
            ("skeptic", "ensemble"): "Questions PC's methods, provides narrative tension",
            ("skeptic", "faction"): "Challenges decisions in council, keeps PC accountable",
            ("dependent", "ensemble"): "Needs protection, creates stakes through vulnerability",
            ("equal", "faction"): "Has power PC lacks (social, political), can't be solved with strength",
            ("observer", "spectacle"): "Documents PC's legend, provides narration, creates mythos",
            ("observer", "mythology"): "Spreads tales, each episode adds to PC's legendarium",
            ("rival", "ensemble"): "Refuses to accept gap, pushes own parallel growth",
            ("witness", "spectacle"): "Reacts with appropriate awe/terror to power displays",
            ("subordinate", "faction"): "Reports, requests orders, respects hierarchy",
            ("subordinate", "reverse_ensemble"): "Views PC as obstacle to their own story",
            ("grounding", "conceptual"): "Creates social stakes power can't solve (romance, friendship)",
        }

        key = (archetype.lower(), scale.lower())
        if key in behaviors:
            return behaviors[key]

        # Default by scale
        scale_defaults = {
            "ensemble": "Support PC's allies, let them have moments",
            "spectacle": "React dramatically to PC's power",
            "conceptual": "Focus on emotional/social, not combat",
            "faction": "Interact within organizational hierarchy",
            "reverse_ensemble": "This NPC has their own protagonist journey",
            "mythology": "Part of episodic legend, may not recur",
            "tactical": "Act strategically, stakes are real",
            "strategic": "Balance combat tactics with character moments",
        }
        return scale_defaults.get(scale.lower(), "Behave naturally based on personality")

    def assign_ensemble_archetype(self, npc_id: int) -> str | None:
        """
        Analyze NPC and assign appropriate ensemble archetype.
        Called by Director during session review for recurring NPCs.
        
        Returns:
            Assigned archetype or None
        """
        npc = self.get_npc(npc_id)
        if not npc or not npc.personality:
            return None

        personality = npc.personality.lower()
        disposition = self.get_npc_disposition(npc_id)

        # Archetype selection logic
        if "protective" in personality or "compassionate" in personality or "caring" in personality:
            archetype = "heart"
        elif "competitive" in personality or "ambitious" in personality or "driven" in personality:
            archetype = "struggler"
        elif "skeptical" in personality or "questioning" in personality or "analytical" in personality:
            archetype = "skeptic"
        elif npc.power_tier in ["T10", "T11"] and disposition >= 60:
            archetype = "dependent"
        elif npc.role == "rival":
            archetype = "rival"
        elif "observant" in personality or "chronicler" in personality:
            archetype = "observer"
        else:
            archetype = "witness"  # Default

        # Update NPC
        db = self._get_db()
        npc.ensemble_archetype = archetype
        db.commit()

        return archetype

    def update_npc_affinity(self, npc_id: int, change: int, reason: str = ""):
        """
        Update NPC affinity and recalculate disposition.
        
        Args:
            npc_id: NPC ID
            change: Amount to change affinity (-50 to +50 typically)
            reason: Reason for change (for logging)
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return None

        db = self._get_db()
        old_affinity = npc.affinity or 0
        new_affinity = max(-100, min(100, old_affinity + change))
        npc.affinity = new_affinity

        # Calculate old and new disposition
        old_disposition = npc.disposition or 0
        new_disposition = self.get_npc_disposition(npc_id)
        npc.disposition = new_disposition

        # Check for threshold crossing
        milestone = self._check_disposition_milestone(old_disposition, new_disposition, npc.name)

        self._maybe_commit()
        logger.info(f"{npc.name} affinity: {old_affinity} → {new_affinity} ({reason})")

        return milestone  # Returns event dict or None

    def _check_disposition_milestone(self, old_disp: int, new_disp: int, npc_name: str) -> dict[str, Any] | None:
        """
        Check if disposition crossed a threshold and return milestone event.
        
        Thresholds (Module 04):
        - HOSTILE (-100 to -61): Active obstruction
        - UNFRIENDLY (-60 to -21): Dismissive
        - NEUTRAL (-20 to 29): Indifferent
        - FRIENDLY (30 to 59): Helpful
        - TRUSTED (60 to 89): Confides secrets
        - DEVOTED (90 to 100): Takes personal risks
        """
        old_label = self.get_disposition_label(old_disp)
        new_label = self.get_disposition_label(new_disp)

        if old_label == new_label:
            return None  # No threshold crossed

        # Milestone events for threshold crossings
        milestone_events = {
            # Positive transitions
            ("neutral", "friendly"): {
                "type": "threshold_up",
                "event": "trust_gained",
                "description": f"{npc_name}'s wall is coming down. They're starting to warm up to you.",
                "dialogue_hint": "More open, willing to share opinions and gossip"
            },
            ("friendly", "trusted"): {
                "type": "threshold_up",
                "event": "trust_deepened",
                "description": f"{npc_name} truly trusts you now. They'll confide secrets and offer significant aid.",
                "dialogue_hint": "Shares personal information, offers keys/access, defends you to others"
            },
            ("trusted", "devoted"): {
                "type": "threshold_up",
                "event": "devotion_earned",
                "description": f"{npc_name} is completely devoted. They would take personal risks for you.",
                "dialogue_hint": "Fierce loyalty, protective, may sacrifice for you"
            },
            # Negative transitions
            ("neutral", "unfriendly"): {
                "type": "threshold_down",
                "event": "trust_lost",
                "description": f"{npc_name} is cooling toward you. They've become dismissive.",
                "dialogue_hint": "Short answers, reluctant to engage, provides no useful info"
            },
            ("unfriendly", "hostile"): {
                "type": "threshold_down",
                "event": "hostility_triggered",
                "description": f"{npc_name} is now actively hostile. They may obstruct or attack.",
                "dialogue_hint": "Aggressive, threatening, may attack on sight"
            },
            ("friendly", "neutral"): {
                "type": "threshold_down",
                "event": "warmth_faded",
                "description": f"{npc_name} has become distant. Something changed.",
                "dialogue_hint": "Transactional only, no personal warmth"
            },
        }

        key = (old_label, new_label)
        if key in milestone_events:
            event = milestone_events[key].copy()
            event["npc_name"] = npc_name
            event["old_threshold"] = old_label
            event["new_threshold"] = new_label
            logger.info(f"{npc_name}: {old_label} → {new_label}")
            return event

        return None

    def detect_npcs_in_text(self, text: str) -> list[str]:
        """
        Detect known NPC names mentioned in narrative text.
        Used to populate present_npcs for context.
        
        Args:
            text: Narrative or situation text
            
        Returns:
            List of NPC names found
        """
        db = self._get_db()
        npcs = db.query(NPC).filter(NPC.campaign_id == self.campaign_id).all()

        found = []
        text_lower = text.lower()
        for npc in npcs:
            if npc.name.lower() in text_lower:
                found.append(npc.name)

        return found

    def get_disposition_label(self, disposition: int) -> str:
        """Get the threshold label for a disposition score."""
        for label, (low, high) in self.DISPOSITION_THRESHOLDS.items():
            if low <= disposition <= high:
                return label
        return "neutral"

    def record_emotional_milestone(
        self,
        npc_id: int,
        milestone_type: str,
        context: str,
        session_id: int | None = None
    ) -> dict[str, Any] | None:
        """
        Record an emotional milestone for an NPC relationship.
        Only records if this is the FIRST time (milestones are "firsts").
        
        Args:
            npc_id: NPC ID
            milestone_type: One of EMOTIONAL_MILESTONE_TYPES
            context: Description of what happened
            session_id: Session when it occurred
            
        Returns:
            Milestone event if new, None if already recorded
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return None

        if milestone_type not in self.EMOTIONAL_MILESTONE_TYPES:
            logger.warning(f"Invalid milestone type: {milestone_type}")
            return None

        # Get existing milestones
        milestones = npc.emotional_milestones or {}

        # Check if already recorded
        if milestone_type in milestones and milestones[milestone_type]:
            return None  # Already happened, not a first

        # Record the milestone
        db = self._get_db()
        milestones[milestone_type] = {
            "session": session_id,
            "context": context,
            "turn": self._turn_number
        }
        npc.emotional_milestones = milestones
        self._maybe_commit()

        logger.info(f"{npc.name}: {milestone_type} - {context[:50]}...")

        # Return event for potential narrative use
        return {
            "type": "emotional_milestone",
            "milestone": milestone_type,
            "npc_name": npc.name,
            "context": context,
            "narrative_hint": self._get_milestone_narrative_hint(milestone_type)
        }

    def _get_milestone_narrative_hint(self, milestone_type: str) -> str:
        """Get narrative guidance for a milestone type."""
        hints = {
            "first_humor": "This shared laughter deepens the bond. Reference this moment in future banter.",
            "first_concern": "NPC now worries about PC's wellbeing. May ask 'Are you okay?' proactively.",
            "first_disagreement": "Relationship survived conflict. NPC respects PC's conviction even if disagrees.",
            "first_initiative": "NPC now acts independently to help. May prepare supplies, scout ahead.",
            "first_sacrifice": "Profound bond. NPC becomes protective, may mention 'I'd do it again.'",
            "first_vulnerability": "Deep trust. NPC confides fears/secrets. Betraying this = catastrophic.",
            "first_trust_test": "PC proved trustworthy. NPC's skepticism fades, offers true loyalty.",
        }
        return hints.get(milestone_type, "This moment matters to the relationship.")

    def get_emotional_milestones(self, npc_id: int) -> dict[str, Any]:
        """
        Get all emotional milestones for an NPC, including which haven't happened yet.
        
        Returns:
            Dict with all milestone types, recorded ones have data, others are None
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return {}

        milestones = npc.emotional_milestones or {}

        # Return all types, marking unfulfilled as None
        result = {}
        for m_type in self.EMOTIONAL_MILESTONE_TYPES:
            result[m_type] = milestones.get(m_type)

        return result

    def increment_npc_interaction(self, npc_id: int) -> int:
        """
        Increment interaction count for cognitive evolution tracking.
        
        Returns:
            New interaction count
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return 0

        db = self._get_db()
        npc.interaction_count = (npc.interaction_count or 0) + 1
        self._maybe_commit()

        return npc.interaction_count

    def get_npc_interaction_count(self, npc_id: int) -> int:
        """Get the current interaction count for an NPC.
        
        Returns:
            Interaction count, or 0 if NPC not found
        """
        npc = self.get_npc(npc_id)
        if not npc:
            return 0
        return npc.interaction_count or 0
