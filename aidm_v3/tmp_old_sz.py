"""
Session Zero Agent for AIDM v3.

Guides players through the character creation process using the
multi-phase protocol from V2's 06_session_zero.md.

Profile research functions are split into _session_zero_research.py.
"""

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from ..core.session import Session
from .base import BaseAgent

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    pass

# Re-export research functions for backward compatibility ΓÇö
# downstream code imports everything from session_zero.
from ._session_zero_research import (  # noqa: F401
    ensure_hybrid_prerequisites,
    generate_custom_profile,
    get_disambiguation_options,
    get_profile_context_for_agent,
    research_and_apply_profile,
    research_hybrid_profile,
    research_hybrid_profile_cached,
)


class SessionZeroOutput(BaseModel):
    """Structured output from the Session Zero agent."""
    response: str = Field(description="The narrative response to show the player")

    # Goal-oriented fields
    missing_requirements: list[str] = Field(
        default_factory=list,
        description="Hard requirements still needed: 'media_reference', 'name', 'concept'"
    )
    ready_for_gameplay: bool = Field(
        default=False,
        description="True when all hard requirements met AND player confirmed"
    )

    # Existing fields (phase_complete deprecated, use ready_for_gameplay)
    detected_info: dict[str, Any] = Field(default_factory=dict, description="Character data extracted from player input")
    phase_complete: bool = Field(default=False, description="DEPRECATED: Use ready_for_gameplay instead")
    suggested_next_phase: str | None = Field(default=None, description="Phase to skip to if player requests")


class SessionZeroAgent(BaseAgent):
    """
    Agent that drives Session Zero character creation.
    
    Takes the current session state and player input,
    returns a response and any detected character information.
    """

    agent_name = "session_zero"

    def __init__(self, model_override: str | None = None):
        super().__init__(model_override=model_override)
        self._prompt_path = Path(__file__).parent.parent / "prompts" / "session_zero.md"

    @property
    def system_prompt(self) -> str:
        """The system prompt for this agent."""
        return self._prompt_path.read_text(encoding="utf-8")

    @property
    def output_schema(self) -> type[BaseModel]:
        """Pydantic model for structured output."""
        return SessionZeroOutput

    async def process_turn(
        self,
        session: Session,
        player_input: str
    ) -> SessionZeroOutput:
        """
        Process a player's input during Session Zero.
        
        Args:
            session: The current session state
            player_input: What the player said
            
        Returns:
            SessionZeroOutput with response and any detected info
        """
        context = self._build_context(session, player_input)
        result = await self.run(context)
        return result

    def _build_context(self, session: Session, player_input: str) -> str:
        """Build the context string to send to the LLM."""
        parts = [
            f"## Current Phase: {session.current_phase.value}",
            f"## Turn: {session.turn_count}",
        ]

        # Include character draft if any info detected
        draft = session.character_draft
        if draft.name or draft.concept or draft.media_reference:
            parts.append(f"\n## Character Draft So Far:\n{self._format_draft(draft)}")

        # Include profile context if loaded
        profile_context = get_profile_context_for_agent(session)
        if profile_context != "(No profile loaded yet)":
            parts.append(f"\n{profile_context}")

        # Include available phase state
        if session.phase_state:
            parts.append(f"\n## Phase State:\n{session.phase_state}")

        # Player input
        parts.append(f"\n## Player Input:\n{player_input}")

        return "\n".join(parts)

    def _format_draft(self, draft) -> str:
        """Format the character draft as a readable summary."""
        lines = []
        if draft.name:
            lines.append(f"- Name: {draft.name}")
        if draft.concept:
            lines.append(f"- Concept: {draft.concept}")
        if draft.media_reference:
            lines.append(f"- Media Reference: {draft.media_reference}")
        if draft.narrative_profile:
            lines.append(f"- Narrative Profile: {draft.narrative_profile}")
        if draft.backstory:
            lines.append(f"- Backstory: {draft.backstory[:200]}...")
        if draft.personality_traits:
            lines.append(f"- Traits: {', '.join(draft.personality_traits)}")
        if draft.skills:
            lines.append(f"- Skills: {', '.join(draft.skills)}")
        if draft.appearance:
            lines.append(f"- Appearance: {draft.appearance}")
        if draft.starting_location:
            lines.append(f"- Starting Location: {draft.starting_location}")
        if draft.op_protagonist_enabled:
            lines.append(f"- OP Mode: ENABLED (preset: {draft.op_preset or 'custom'})")
        if draft.power_tier:
            lines.append(f"- Power Tier: {draft.power_tier}")
        return "\n".join(lines) if lines else "(empty)"

    #
    #     Generate the opening message for a new Session Zero.
    #     This is called when a session first starts.
    #
    async def get_opening_message(self, session: Session) -> str:
        """Generate the opening message for a new Session Zero."""
        context = (
            f"## Session Start\n"
            f"Phase: {session.current_phase.value}\n"
            f"Generate your opening greeting and begin the character creation process.\n"
            f"Ask about the player's anime/manga inspiration."
        )
        result = await self.run(context)
        return result.response


def apply_detected_info(session: Session, detected: dict[str, Any]) -> None:
    """
    Apply detected information from the agent's response to the character draft.
    
    This maps field names from the agent's output to the CharacterDraft.
    """
    draft = session.character_draft

    # Map common field names
    field_mapping = {
        "media_reference": "media_reference",
        "anime": "media_reference",
        "manga": "manga_reference",
        "narrative_profile": "narrative_profile",
        "profile": "narrative_profile",
        "narrative_calibrated": "narrative_calibrated",
        "calibration_confirmed": "narrative_calibrated",
        "tone_confirmed": "narrative_calibrated",
        # Canonicality
        "timeline_mode": "timeline_mode",
        "canon_cast_mode": "canon_cast_mode",
        "event_fidelity": "event_fidelity",
        # OP Mode
        "op_mode": "op_protagonist_enabled",
        "op_protagonist": "op_protagonist_enabled",
        "op_preset": "op_preset",
        "op_tension_source": "op_tension_source",
        "op_power_expression": "op_power_expression",
        "op_narrative_focus": "op_narrative_focus",
        # Character
        "concept": "concept",
        "name": "name",
        "character_name": "name",
        "age": "age",
        "backstory": "backstory",
        "starting_location": "starting_location",
        "location": "starting_location",
        # Power Tier
        "power_tier": "power_tier",
    }

    for key, value in detected.items():
        if key in field_mapping:
            target_field = field_mapping[key]
            setattr(draft, target_field, value)

        # Handle nested fields
        elif key == "appearance" and isinstance(value, dict):
            draft.appearance.update(value)
        elif key == "attributes" and isinstance(value, dict):
            draft.attributes.update(value)
        elif key == "traits" and isinstance(value, list):
            draft.personality_traits.extend(value)
        elif key == "values" and isinstance(value, list):
            draft.values.extend(value)
        elif key == "fears" and isinstance(value, list):
            draft.fears.extend(value)
        elif key == "visual_tags" and isinstance(value, list):
            draft.visual_tags.extend(value)
        elif key == "skills" and isinstance(value, list):
            draft.skills.extend(value)
        elif key == "goals" and isinstance(value, dict):
            draft.goals.update(value)


async def process_session_zero_state(
    session: Session,
    detected_info: dict[str, Any],
    session_id: str,
    campaign_id: int = None
) -> dict[str, int]:
    """
    Process Session Zero detected_info using the same systems as gameplay.
    
    This is called each turn after apply_detected_info() to:
    - Add memories for character facts, backstory, abilities
    - Create NPC records when NPCs are mentioned
    - Store canonicality choices as plot-critical memories
    
    Args:
        session: The current session
        detected_info: Info extracted by the Session Zero agent
        session_id: The unique session ID for memory isolation
        
    Returns:
        Dict with counts: {"memories_added": N, "npcs_created": N}
    """
    from ..context.memory import MemoryStore
    from ..db.state_manager import StateManager

    stats = {"memories_added": 0, "npcs_created": 0}

    # Skip if no detected_info
    if not detected_info:
        return stats

    # Initialize stores - use session_id for memory isolation
    memory = MemoryStore(campaign_id=session_id)

    # === CHARACTER IDENTITY MEMORIES ===

    if "name" in detected_info:
        memory.add_memory(
            content=f"Character name: {detected_info['name']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZeroΓåÆState] Indexed character name: {detected_info['name']}")

    if "concept" in detected_info:
        memory.add_memory(
            content=f"Character concept: {detected_info['concept']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info("[SessionZeroΓåÆState] Indexed character concept")

    if "backstory" in detected_info:
        memory.add_memory(
            content=f"Character backstory: {detected_info['backstory']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info("[SessionZeroΓåÆState] Indexed character backstory")

    # === ABILITIES/POWERS ===

    if "abilities" in detected_info:
        abilities = detected_info["abilities"]
        if isinstance(abilities, list):
            for ability in abilities:
                memory.add_memory(
                    content=f"Character ability: {ability}",
                    memory_type="core",
                    turn_number=0,
                    flags=["plot_critical", "session_zero"]
                )
                stats["memories_added"] += 1
        elif isinstance(abilities, str):
            memory.add_memory(
                content=f"Character abilities: {abilities}",
                memory_type="core",
                turn_number=0,
                flags=["plot_critical", "session_zero"]
            )
            stats["memories_added"] += 1
        logger.info("[SessionZeroΓåÆState] Indexed abilities")

    # === PERSONALITY ===

    if "personality" in detected_info:
        memory.add_memory(
            content=f"Character personality: {detected_info['personality']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1

    if "traits" in detected_info:
        traits = detected_info["traits"]
        if isinstance(traits, list):
            traits_str = ", ".join(traits)
        else:
            traits_str = str(traits)
        memory.add_memory(
            content=f"Character traits: {traits_str}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1

    # === NPC CREATION ===

    if "npcs" in detected_info:
        npcs = detected_info["npcs"]
        if isinstance(npcs, list):
            # Initialize StateManager for DB writes (needs integer campaign_id)
            if campaign_id is not None:
                state = StateManager(campaign_id)
            else:
                logger.warning("[SessionZeroΓåÆState] No campaign_id provided, skipping NPC DB creation")
                state = None

            for npc in npcs:
                if isinstance(npc, dict) and "name" in npc:
                    # Create relationship memory
                    npc_name = npc["name"]
                    role = npc.get("role", "unknown")
                    disposition = npc.get("disposition", "neutral")
                    background = npc.get("background", "")
                    npc_appearance = npc.get("appearance", {})
                    npc_visual_tags = npc.get("visual_tags", [])

                    # 1. Create NPC in SQLite database (if StateManager available)
                    if state is not None:
                        try:
                            state.create_npc(
                                name=npc_name,
                                role=role,
                                relationship_notes=f"{disposition}. {background}",
                                appearance=npc_appearance,
                                visual_tags=npc_visual_tags,
                            )
                            logger.info(f"[SessionZeroΓåÆState] Created NPC in DB: {npc_name} (visual_tags={npc_visual_tags})")
                        except Exception as e:
                            logger.error(f"[SessionZeroΓåÆState] NPC DB creation failed: {e}")

                    # 2. Create NPC memory in ChromaDB
                    memory.add_memory(
                        content=f"NPC: {npc_name} - Role: {role}, Disposition: {disposition}. {background}",
                        memory_type="relationship",
                        turn_number=0,
                        metadata={"npc_name": npc_name, "role": role},
                        flags=["session_zero"]
                    )

                    # 3. Fire-and-forget: generate NPC portrait (if campaign exists and appearance known)
                    if campaign_id and (npc_appearance or npc_visual_tags):
                        try:
                            from ..utils.tasks import safe_create_task
                            safe_create_task(
                                _generate_session_zero_npc_portrait(
                                    campaign_id, npc_name, npc_appearance, npc_visual_tags
                                ),
                                name=f"npc_portrait_{npc_name}",
                            )
                            logger.info(f"[SessionZeroΓåÆMedia] Queued portrait gen for NPC: {npc_name}")
                        except Exception as media_err:
                            logger.error(f"[SessionZeroΓåÆMedia] Portrait queue failed (non-fatal): {media_err}")

                    stats["memories_added"] += 1
                    stats["npcs_created"] += 1
                    logger.info(f"[SessionZeroΓåÆState] Created NPC: {npc_name} ({role})")

    # === CANONICALITY CHOICES ===

    if "timeline_mode" in detected_info:
        mode = detected_info["timeline_mode"]
        memory.add_memory(
            content=f"Story timeline mode: {mode}",
            memory_type="fact",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZeroΓåÆState] Timeline mode: {mode}")

    if "canon_cast_mode" in detected_info:
        mode = detected_info["canon_cast_mode"]
        memory.add_memory(
            content=f"Canon cast mode: {mode}",
            memory_type="fact",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZeroΓåÆState] Canon cast mode: {mode}")

    if "event_fidelity" in detected_info:
        mode = detected_info["event_fidelity"]
        memory.add_memory(
            content=f"Canon event fidelity: {mode}",
            memory_type="fact",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZeroΓåÆState] Event fidelity: {mode}")

    # === OP MODE ===

    if "op_mode" in detected_info or "op_protagonist" in detected_info:
        op_enabled = detected_info.get("op_mode") or detected_info.get("op_protagonist")
        if op_enabled:
            preset = detected_info.get("op_preset", "custom")
            memory.add_memory(
                content=f"OP Protagonist mode enabled. Preset: {preset}",
                memory_type="core",
                turn_number=0,
                flags=["plot_critical", "session_zero"]
            )
            stats["memories_added"] += 1
            logger.info(f"[SessionZeroΓåÆState] OP Mode enabled: {preset}")

    # === WORLD INTEGRATION ===

    if "starting_location" in detected_info:
        location = detected_info["starting_location"]
        memory.add_memory(
            content=f"Starting location: {location}",
            memory_type="location",
            turn_number=0,
            flags=["session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZeroΓåÆState] Starting location: {location}")

    memory.close()

    if stats["memories_added"] > 0 or stats["npcs_created"] > 0:
        logger.info(f"[SessionZeroΓåÆState] Turn processed: {stats['memories_added']} memories, {stats['npcs_created']} NPCs")

    return stats


# ============================================================================
# SESSION ZERO ΓåÆ MEMORY INDEXING
# ============================================================================


async def index_session_zero_to_memory(session: Session) -> int:
    """
    Index Session Zero dialogue into memory system for gameplay retrieval.
    
    Called once at handoff. Uses existing MemoryStore to store character
    creation content so gameplay can retrieve it via RAG.
    
    Chunks and categorizes the character creation content:
    - core: Character identity, backstory, abilities (no decay)
    - relationship: Handler/mentor relationships (slow decay)
    - fact: World-building decisions (slow decay)
    
    Args:
        session: The completed Session Zero session
        
    Returns:
        Number of memory chunks indexed
    """
    from ..context.memory import MemoryStore

    # Use session_id for memory isolation (not profile_id)
    session_id = session.session_id

    logger.info(f"[SessionZeroΓåÆMemory] Indexing character creation to memory for session: {session_id}")

    # Create memory store for this session
    memory = MemoryStore(campaign_id=session_id)

    # Get all Session Zero messages
    messages = session.messages
    if not messages:
        logger.info("[SessionZeroΓåÆMemory] No messages to index")
        return 0

    # Chunk into logical segments
    chunks = _chunk_session_zero_messages(messages)

    indexed = 0
    for chunk in chunks:
        # Classify for metadata enrichment (core/relationship/fact)
        category = _classify_chunk(chunk)

        # ALL Session Zero content is sacred ΓÇö never decay.
        # Session Zero is the campaign's DNA: character identity, GM voice,
        # tonal rapport, creative intent. Every exchange matters.
        flags = ["plot_critical", "session_zero"]

        memory.add_memory(
            content=chunk["content"],
            memory_type="session_zero",  # Consistent type ΓåÆ CATEGORY_DECAY["session_zero"] = "none"
            turn_number=0,  # Pre-gameplay turn
            metadata={
                "source": "session_zero",
                "chunk_index": chunk.get("index", 0),
                "message_count": chunk.get("message_count", 0),
                "sub_category": category  # Preserve classification for downstream use
            },
            flags=flags
        )
        indexed += 1

    logger.info(f"[SessionZeroΓåÆMemory] Indexed {indexed} chunks ({memory.count()} total memories)")
    memory.close()
    return indexed


def _chunk_session_zero_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Chunk Session Zero messages into logical segments for memory indexing.
    
    Groups ~10 messages per chunk to balance context vs. retrieval precision.
    
    Args:
        messages: List of message dicts with 'role' and 'content'
        
    Returns:
        List of chunks with 'content', 'index', and 'message_count'
    """
    chunks = []
    current_chunk_messages = []
    chunk_index = 0

    MESSAGES_PER_CHUNK = 10  # ~5 exchanges (user + assistant)

    for msg in messages:
        role = msg.get("role", "user").upper()
        content = msg.get("content", "")

        # Skip empty messages
        if not content.strip():
            continue

        current_chunk_messages.append(f"[{role}]: {content}")

        # Chunk when we hit the limit
        if len(current_chunk_messages) >= MESSAGES_PER_CHUNK:
            chunks.append({
                "content": "\n\n".join(current_chunk_messages),
                "index": chunk_index,
                "message_count": len(current_chunk_messages)
            })
            current_chunk_messages = []
            chunk_index += 1

    # Don't forget the remainder
    if current_chunk_messages:
        chunks.append({
            "content": "\n\n".join(current_chunk_messages),
            "index": chunk_index,
            "message_count": len(current_chunk_messages)
        })

    return chunks


def _classify_chunk(chunk: dict[str, Any]) -> str:
    """
    Classify a chunk into a memory category based on content.
    
    Categories:
    - core: Character identity, backstory, abilities (no decay)
    - relationship: Handler/mentor relationships (slow decay)  
    - fact: World-building, setting decisions (slow decay)
    
    Args:
        chunk: Dict with 'content' key
        
    Returns:
        Memory category string
    """
    content = chunk.get("content", "").lower()

    # Character identity keywords ΓåÆ "core" (no decay)
    core_keywords = [
        "backstory", "name", "concept", "ability", "power", "appearance",
        "personality", "trait", "archetype", "origin", "identity",
        "who you are", "your character", "protagonist", "op mode",
        "age", "look like", "what do you want"
    ]
    if any(kw in content for kw in core_keywords):
        return "core"

    # Relationship keywords ΓåÆ "relationship" (slow decay)
    relationship_keywords = [
        "handler", "mentor", "friend", "trust", "partner", "ally",
        "companion", "teacher", "relationship", "bond", "assigned to"
    ]
    if any(kw in content for kw in relationship_keywords):
        return "relationship"

    # Default to "fact" (slow decay) for world-building decisions
    return "fact"


async def _generate_session_zero_npc_portrait(
    campaign_id: int,
    npc_name: str,
    appearance: dict,
    visual_tags: list,
) -> None:
    """Fire-and-forget: generate an NPC portrait during Session Zero.
    
    Non-blocking ΓÇö called via asyncio.create_task so it doesn't slow
    down the Session Zero response. Results are persisted to the NPC
    record so the portrait resolver can find them during gameplay.
    """
    try:
        # Check if media generation is enabled in settings
        from src.settings import get_settings_store

        from ..db.models import NPC
        from ..db.session import create_session
        from ..media.generator import MediaGenerator
        settings = get_settings_store().load()
        if not settings.media_enabled:
            logger.warning(f"[SessionZeroΓåÆMedia] Media disabled, skipping portrait for {npc_name}")
            return

        # Get style context from profile
        style_context = settings.active_profile_id or "anime"

        gen = MediaGenerator()
        result = await gen.generate_full_character_media(
            visual_tags=visual_tags or [],
            appearance=appearance or {},
            style_context=style_context,
            campaign_id=campaign_id,
            entity_name=npc_name,
        )

        # Update NPC record with generated URLs
        if result.get("portrait") or result.get("model_sheet"):
            db = create_session()
            npc = (
                db.query(NPC)
                .filter(NPC.campaign_id == campaign_id)
                .filter(NPC.name.ilike(f"%{npc_name}%"))
                .first()
            )
            if npc:
                if result.get("portrait"):
                    npc.portrait_url = f"/api/game/media/{campaign_id}/{result['portrait'].name}"
                    logger.info(f"[SessionZeroΓåÆMedia] Portrait saved for {npc_name}: {npc.portrait_url}")
                if result.get("model_sheet"):
                    npc.model_sheet_url = f"/api/game/media/{campaign_id}/{result['model_sheet'].name}"
                db.commit()
            db.close()

    except Exception as e:
        logger.error(f"[SessionZeroΓåÆMedia] NPC portrait gen failed for {npc_name}: {e}")
