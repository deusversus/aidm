"""
Session Composition Layer for AIDM v3.

Replaces the monolithic hybrid profile system with a thin, composable
session layer that links N base profiles with user-specified overrides.

Architecture:
    Session Profile = Base[0..N] + Session Layer
    
    - Base profiles are canonical NarrativeProfiles loaded by ID
    - Session layer carries user customizations (tone overrides, era, rules)
    - Resolved NarrativeProfile is computed by blend + override at load time
    - SessionProfileStore persists compositions in SQLite

Composition types:
    - "single":          One base profile, no blending
    - "franchise_link":  Multiple profiles from same franchise (DBZ + DBS)
    - "cross_ip_blend":  Profiles from different IPs (Naruto × Fate)
    - "custom":          Original world, session-scoped profile only
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


# ─── Data Classes ────────────────────────────────────────────────────────────


@dataclass
class ProfileBase:
    """A single base profile reference within a session composition."""

    profile_id: str              # Local profile ID (e.g., "dragon_ball_z")
    anilist_id: int | None       # Canonical AniList ID (e.g., 21)
    mal_id: int | None = None    # MyAnimeList cross-reference
    canonical_title: str = ""    # Display name (e.g., "Dragon Ball Z")
    role: str = "primary"        # "primary" | "supplementary" | "flavor"
    weight: float = 1.0          # Influence weight for DNA/tone blending

    def to_dict(self) -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "anilist_id": self.anilist_id,
            "mal_id": self.mal_id,
            "canonical_title": self.canonical_title,
            "role": self.role,
            "weight": self.weight,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProfileBase":
        return cls(
            profile_id=data["profile_id"],
            anilist_id=data.get("anilist_id"),
            mal_id=data.get("mal_id"),
            canonical_title=data.get("canonical_title", data["profile_id"]),
            role=data.get("role", "primary"),
            weight=data.get("weight", 1.0),
        )


@dataclass
class SessionLayer:
    """User customizations applied on top of base profiles.

    These overrides are applied LAST during resolution, so user preferences
    always win over profile defaults or blend results.
    """

    tone_overrides: dict[str, int] | None = None       # e.g., {"comedy": 3, "drama": 8}
    power_ceiling: str | None = None                    # e.g., "T4" (user picks scale)
    starting_era: str | None = None                     # e.g., "post-Cell Games"
    custom_rules: list[str] | None = None               # Free-form user preferences
    blend_notes: str | None = None                      # LLM-generated blend guidance

    def to_dict(self) -> dict[str, Any]:
        return {
            "tone_overrides": self.tone_overrides,
            "power_ceiling": self.power_ceiling,
            "starting_era": self.starting_era,
            "custom_rules": self.custom_rules,
            "blend_notes": self.blend_notes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionLayer":
        return cls(
            tone_overrides=data.get("tone_overrides"),
            power_ceiling=data.get("power_ceiling"),
            starting_era=data.get("starting_era"),
            custom_rules=data.get("custom_rules"),
            blend_notes=data.get("blend_notes"),
        )


@dataclass
class SessionProfile:
    """A session-locked composite profile composed from N base profiles + overrides.

    This is the primary interface between the Intent Resolution Agent
    (which determines WHAT profiles to use) and the gameplay engine
    (which consumes a resolved NarrativeProfile).
    """

    session_id: str
    composition_type: str                    # "single" | "franchise_link" | "cross_ip_blend" | "custom"

    # Base profile references (N+1 architecture)
    bases: list[ProfileBase] = field(default_factory=list)

    # Session-specific overrides
    session_layer: SessionLayer = field(default_factory=SessionLayer)

    # Metadata
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def get_all_profile_ids(self) -> list[str]:
        """Get all base profile IDs for multi-profile lore search."""
        return [b.profile_id for b in self.bases]

    def get_all_lore_profile_ids(self) -> list[str]:
        """Get profile IDs that should contribute to RAG search.

        Includes base profiles AND any profiles they inherit from via series_parent.
        """
        ids = set()
        for b in self.bases:
            ids.add(b.profile_id)
            # Check for series_parent inheritance
            try:
                from .loader import get_series_parent_profile
                parent_data = get_series_parent_profile(b.profile_id)
                if parent_data and parent_data.get("id"):
                    ids.add(parent_data["id"])
            except Exception:
                pass
        return list(ids)

    def get_primary_base(self) -> ProfileBase | None:
        """Get the primary (highest-weight) base profile."""
        primaries = [b for b in self.bases if b.role == "primary"]
        if primaries:
            return max(primaries, key=lambda b: b.weight)
        return self.bases[0] if self.bases else None

    def get_primary_profile_id(self) -> str | None:
        """Get the primary profile ID (for contexts that need a single ID)."""
        primary = self.get_primary_base()
        return primary.profile_id if primary else None

    def resolve(self) -> "NarrativeProfile":
        """Compose all bases + session layer into a single NarrativeProfile.

        Resolution rules:
        - DNA scales: Weighted average across bases (using role weights)
        - Tropes: Union of all base tropes
        - Power system: Primary base's system (with supplementary additions)
        - Combat system: Primary base's system
        - Tone: Weighted blend
        - Voice cards: Collected from all bases
        - Author voice: Primary base only
        - Session layer overrides applied LAST (user preferences win)

        Returns:
            Merged NarrativeProfile ready for gameplay
        """
        from .loader import load_profile

        if not self.bases:
            # Custom profile with no bases — return default
            from .loader import NarrativeProfile
            return NarrativeProfile(
                id=f"session_{self.session_id[:12]}",
                name="Custom World",
                source="Session Custom",
                dna={},
                tropes={},
                combat_system="tactical",
            )

        # Load all base profiles
        loaded: list[tuple[ProfileBase, "NarrativeProfile"]] = []
        for base in self.bases:
            try:
                profile = load_profile(base.profile_id, fallback=False)
                loaded.append((base, profile))
            except FileNotFoundError:
                logger.warning(f"Base profile '{base.profile_id}' not found, skipping")

        if not loaded:
            from .loader import NarrativeProfile
            return NarrativeProfile(
                id=f"session_{self.session_id[:12]}",
                name="Fallback",
                source="Session Fallback",
                dna={},
                tropes={},
                combat_system="tactical",
            )

        # Single profile — just return it (with session layer applied)
        if len(loaded) == 1:
            _, profile = loaded[0]
            return self._apply_session_layer(profile)

        # Multi-profile blend
        return self._blend_profiles(loaded)

    def _blend_profiles(
        self,
        loaded: list[tuple[ProfileBase, "NarrativeProfile"]],
    ) -> "NarrativeProfile":
        """Blend multiple loaded profiles using weighted composition."""
        from .loader import NarrativeProfile, derive_composition_from_dna

        # Calculate total weight
        total_weight = sum(b.weight for b, _ in loaded)
        if total_weight == 0:
            total_weight = 1.0

        # Weighted DNA blend
        blended_dna: dict[str, float] = {}
        all_keys = set()
        for _, p in loaded:
            all_keys.update(p.dna.keys())

        for key in all_keys:
            weighted_sum = 0.0
            for base, profile in loaded:
                scale_val = profile.dna.get(key, 5)  # Default to midpoint
                weighted_sum += scale_val * (base.weight / total_weight)
            blended_dna[key] = round(weighted_sum)

        # Union of tropes (any IP contributing a trope activates it)
        blended_tropes: dict[str, bool] = {}
        for _, p in loaded:
            if p.tropes:
                for trope, active in p.tropes.items():
                    if active:
                        blended_tropes[trope] = True

        # Primary's power system and combat
        primary_base, primary_profile = loaded[0]
        for base, profile in loaded:
            if base.role == "primary":
                primary_base = base
                primary_profile = profile
                break

        # Collect voice cards from all profiles
        all_voice_cards = []
        for _, p in loaded:
            if p.voice_cards:
                all_voice_cards.extend(p.voice_cards)

        # Weighted tone blend
        blended_tone: dict[str, int] | None = None
        tone_profiles = [(b, p) for b, p in loaded if p.tone]
        if tone_profiles:
            blended_tone = {}
            tone_keys = set()
            for _, p in tone_profiles:
                tone_keys.update(p.tone.keys())
            for key in tone_keys:
                weighted_sum = 0.0
                for base, profile in tone_profiles:
                    tone_val = profile.tone.get(key, 5)
                    weighted_sum += tone_val * (base.weight / total_weight)
                blended_tone[key] = round(weighted_sum)

        # Build composite name
        titles = [b.canonical_title for b in self.bases]
        composite_name = " × ".join(titles)

        # Integer DNA for NarrativeProfile
        int_dna = {k: int(v) for k, v in blended_dna.items()}

        # Derive composition from blended DNA
        composition = derive_composition_from_dna(int_dna, blended_tropes)

        blended = NarrativeProfile(
            id=f"session_{self.session_id[:12]}",
            name=composite_name,
            source=f"Session Blend ({self.composition_type})",
            dna=int_dna,
            tropes=blended_tropes,
            combat_system=primary_profile.combat_system,
            power_system=primary_profile.power_system,
            progression=primary_profile.progression,
            voice=primary_profile.voice,
            director_personality=primary_profile.director_personality,
            tone=blended_tone,
            composition=composition,
            detected_genres=primary_profile.detected_genres,
            voice_cards=all_voice_cards or None,
            author_voice=primary_profile.author_voice,
            world_tier=primary_profile.world_tier,
        )

        return self._apply_session_layer(blended)

    def _apply_session_layer(self, profile: "NarrativeProfile") -> "NarrativeProfile":
        """Apply session layer overrides to a profile."""
        layer = self.session_layer

        # Tone overrides
        if layer.tone_overrides and profile.tone:
            for key, val in layer.tone_overrides.items():
                profile.tone[key] = val
        elif layer.tone_overrides and not profile.tone:
            profile.tone = dict(layer.tone_overrides)

        # Power ceiling override
        if layer.power_ceiling:
            profile.world_tier = layer.power_ceiling

        return profile

    # ─── Serialization ───────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for persistence."""
        return {
            "session_id": self.session_id,
            "composition_type": self.composition_type,
            "bases": [b.to_dict() for b in self.bases],
            "session_layer": self.session_layer.to_dict(),
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionProfile":
        """Deserialize from dictionary."""
        return cls(
            session_id=data["session_id"],
            composition_type=data.get("composition_type", "single"),
            bases=[ProfileBase.from_dict(b) for b in data.get("bases", [])],
            session_layer=SessionLayer.from_dict(data.get("session_layer", {})),
            created_at=data.get("created_at", datetime.now().isoformat()),
        )


# ─── Session Profile Store ────────────────────────────────────────────────


class SessionProfileStore:
    """SQLAlchemy-backed storage for session profile compositions.

    Stores composition metadata (what profiles are linked, with what
    roles/weights) separately from the base profiles themselves.
    Uses the shared PostgreSQL database via SQLAlchemy.
    """

    def save_composition(self, session_profile: SessionProfile) -> None:
        """Save or update a session composition."""
        from ..db.models import SessionProfileComposition
        from ..db.session import create_session as create_db_session

        data = json.dumps(session_profile.to_dict())

        db = create_db_session()
        try:
            existing = db.query(SessionProfileComposition).filter(
                SessionProfileComposition.session_id == session_profile.session_id
            ).first()

            if existing:
                existing.composition_type = session_profile.composition_type
                existing.data = data
                existing.created_at = session_profile.created_at
            else:
                entry = SessionProfileComposition(
                    session_id=session_profile.session_id,
                    composition_type=session_profile.composition_type,
                    data=data,
                    created_at=session_profile.created_at,
                )
                db.add(entry)

            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

        logger.info(
            f"Saved session composition: {session_profile.session_id} "
            f"({session_profile.composition_type}, "
            f"{len(session_profile.bases)} bases)"
        )

    def load_composition(self, session_id: str) -> SessionProfile | None:
        """Load a session composition by session ID."""
        from ..db.models import SessionProfileComposition
        from ..db.session import create_session as create_db_session

        db = create_db_session()
        try:
            entry = db.query(SessionProfileComposition).filter(
                SessionProfileComposition.session_id == session_id
            ).first()

            if entry:
                data = json.loads(entry.data)
                return SessionProfile.from_dict(data)

            return None
        finally:
            db.close()

    def delete_composition(self, session_id: str) -> bool:
        """Delete a session composition."""
        from ..db.models import SessionProfileComposition
        from ..db.session import create_session as create_db_session

        db = create_db_session()
        try:
            count = db.query(SessionProfileComposition).filter(
                SessionProfileComposition.session_id == session_id
            ).delete()
            db.commit()
            return count > 0
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def list_compositions(self) -> list[dict[str, Any]]:
        """List all session compositions with basic info."""
        from ..db.models import SessionProfileComposition
        from ..db.session import create_session as create_db_session

        db = create_db_session()
        try:
            entries = (
                db.query(SessionProfileComposition)
                .order_by(SessionProfileComposition.created_at.desc())
                .all()
            )
            return [
                {
                    "session_id": e.session_id,
                    "composition_type": e.composition_type,
                    "created_at": e.created_at,
                }
                for e in entries
            ]
        finally:
            db.close()


# ─── Singleton ───────────────────────────────────────────────────────────


_session_profile_store: SessionProfileStore | None = None


def get_session_profile_store() -> SessionProfileStore:
    """Get the global SessionProfileStore instance."""
    global _session_profile_store
    if _session_profile_store is None:
        _session_profile_store = SessionProfileStore()
    return _session_profile_store

