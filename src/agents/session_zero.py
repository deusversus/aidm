"""
Session Zero Agent for AIDM v3.

Guides players through the character creation process using the
multi-phase protocol from V2's 06_session_zero.md.

Profile research functions are split into _session_zero_research.py.
"""

import logging
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from ..core.session import Session
from ..prompts import get_registry
from .base import BaseAgent

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    pass

# Re-export research functions for backward compatibility —
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

    # DEPRECATED (Phase 6): Use structured schemas (session_zero_schemas.py) instead.
    # detected_info is a freeform dict used by apply_detected_info() and
    # process_session_zero_state() to update CharacterDraft and create memories.
    # When SESSION_ZERO_ORCHESTRATOR_ENABLED is True, the pipeline's structured
    # extraction replaces this for entity/fact/relationship data. Remove this
    # field once the orchestrator is enabled by default and all callers are migrated.
    detected_info: dict[str, Any] = Field(default_factory=dict, description="DEPRECATED: Character data extracted from player input")
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

    @property
    def system_prompt(self) -> list[tuple[str, bool]]:
        """The system prompt for this agent, with caching enabled.
        
        Returns cache-aware format: [(text, should_cache), ...]
        The session_zero prompt is static and ~28KB — caching saves
        90% on Anthropic input tokens after the first turn.
        """
        return [(get_registry().get_content("session_zero"), True)]

    @property
    def output_schema(self) -> type[BaseModel]:
        """Pydantic model for structured output."""
        return SessionZeroOutput

    async def process_turn(
        self,
        session: Session,
        player_input: str,
        *,
        gap_context: str | None = None,
    ) -> SessionZeroOutput:
        """
        Process a player's input during Session Zero.
        
        Args:
            session: The current session state
            player_input: What the player said
            gap_context: Optional gap analysis context from the SZ pipeline
            
        Returns:
            SessionZeroOutput with response and any detected info
        """
        context = self._build_context(session, player_input, gap_context=gap_context)
        result = await self.call(context)
        return result

    def _build_context(
        self,
        session: Session,
        player_input: str,
        *,
        gap_context: str | None = None,
    ) -> str:
        """Build the context string to send to the LLM."""
        from ._session_zero_research import get_profile_context_for_agent

        # Format character draft as readable summary
        draft = session.character_draft
        draft_summary = self._format_draft(draft)

        # Inject profile data (world_tier, stat system, DNA, etc.)
        # This is CRITICAL for phases that reference the anime baseline —
        # especially NARRATIVE_CALIBRATION (power tier) and MECHANICAL_BUILD (stats).
        profile_context = get_profile_context_for_agent(session)

        # Format recent messages (last 30)
        recent_messages = session.messages[-30:] if session.messages else []
        messages_str = "\n".join([
            f"[{m['role'].upper()}]: {m['content']}"
            for m in recent_messages
        ])

        # Gap analysis context (when SZ pipeline is active)
        gap_section = ""
        if gap_context:
            gap_section = f"""
## Pipeline Analysis (extraction + entity resolution + gap analysis):
{gap_context}

Use the recommended follow-up questions above to guide your next question.
Prioritize questions that resolve blocking issues or high-priority gaps.
"""

        # Current player input
        context = f"""## Current Phase: {session.phase.value}

## Anime Profile (Research Output):
{profile_context}

## Character Draft So Far:
{draft_summary}

## Recent Conversation:
{messages_str}
{gap_section}
## Player's Current Input:
{player_input}

Based on the phase-specific instructions in the system prompt, generate an appropriate response.
"""
        return context

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
            lines.append(f"- Backstory: {str(draft.backstory)[:200]}...")
        if draft.personality_traits:
            lines.append(f"- Traits: {', '.join(draft.personality_traits)}")
        if draft.skills:
            lines.append(f"- Skills: {', '.join(draft.skills)}")
        if draft.appearance:
            lines.append(f"- Appearance: {draft.appearance}")
        if draft.starting_location:
            lines.append(f"- Starting Location: {draft.starting_location}")
        if draft.power_tier:
            lines.append(f"- Power Tier: {draft.power_tier}")
        # Show composition if set via profile or session zero
        if hasattr(draft, 'tension_source') and draft.tension_source:
            lines.append(f"- Composition: tension={draft.tension_source}, expression={draft.power_expression}, focus={draft.narrative_focus}")
        elif draft.op_protagonist_enabled:  # Legacy: show deprecated OP fields if present
            lines.append(f"- OP Mode (legacy): ENABLED (preset: {draft.op_preset or 'custom'})")
        return "\n".join(lines) if lines else "(empty)"

    async def get_opening_message(self, session: Session) -> str:
        """
        Generate the opening message for a new Session Zero.
        This is called when a session first starts.
        """
        # For the first message, we don't have player input yet
        # Just generate the Phase 0 opening
        context = f"""## Current Phase: {session.phase.value}

## Character Draft So Far:
(No information collected yet)

## Recent Conversation:
(This is the start of the conversation)

## Instructions:
Generate the OPENING message for Session Zero - Phase 0 (Media Detection).
Welcome the player warmly and ask if they have an anime/manga reference in mind.
"""
        result = await self.call(context)
        return result.response


def apply_detected_info(session: Session, detected: dict[str, Any]) -> None:
    """Apply detected information from the agent's response to the character draft.

    DEPRECATED (Phase 6): When SESSION_ZERO_ORCHESTRATOR_ENABLED is True, the
    pipeline's SZExtractorAgent produces structured ExtractionPassOutput that
    replaces this freeform dict mapping. Remove this function once the
    orchestrator is enabled by default.
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
        # OP Mode (legacy — still accepted for backward compat)
        "op_mode": "op_protagonist_enabled",
        "op_protagonist": "op_protagonist_enabled",
        "op_preset": "op_preset",
        "op_tension_source": "op_tension_source",
        "op_power_expression": "op_power_expression",
        "op_narrative_focus": "op_narrative_focus",
        # New composition fields (preferred)
        "tension_source": "tension_source",
        "power_expression": "power_expression",
        "narrative_focus": "narrative_focus",
        "composition_name": "composition_name",
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

    # Fields that must store plain strings — LLMs sometimes return dicts/lists for these.
    # Python 3.13 raises TypeError(slice_object) (not a string message) when you slice a dict,
    # so type-coercion here prevents cryptic "slice(None, 200, None)" 500 errors downstream.
    _STRING_FIELDS = {
        "media_reference", "manga_reference", "narrative_profile",
        "timeline_mode", "canon_cast_mode", "event_fidelity",
        "op_preset", "op_tension_source", "op_power_expression", "op_narrative_focus",
        "tension_source", "power_expression", "narrative_focus", "composition_name",
        "concept", "name", "backstory", "starting_location", "power_tier",
    }
    # Fields that must be booleans
    _BOOL_FIELDS = {"narrative_calibrated", "op_protagonist_enabled", "media_researched"}
    # Fields that must be integers
    _INT_FIELDS = {"age"}

    for key, value in detected.items():
        if key in field_mapping:
            target_field = field_mapping[key]
            # Coerce to the expected type so downstream slicing / logic is safe
            if value is not None:
                if target_field in _STRING_FIELDS and not isinstance(value, str):
                    # LLM returned a dict or list for a string field — flatten it
                    if isinstance(value, dict):
                        value = "; ".join(f"{k}: {v}" for k, v in value.items())
                    elif isinstance(value, list):
                        value = "; ".join(str(item) for item in value)
                    else:
                        value = str(value)
                elif target_field in _BOOL_FIELDS and not isinstance(value, bool):
                    value = bool(value)
                elif target_field in _INT_FIELDS:
                    try:
                        value = int(value)
                    except (ValueError, TypeError):
                        logger.warning(f"[apply_detected_info] Could not coerce {key!r}={value!r} to int — skipping")
                        continue
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
    """Process Session Zero detected_info using the same systems as gameplay.

    DEPRECATED (Phase 6): When SESSION_ZERO_ORCHESTRATOR_ENABLED is True, the
    pipeline handles entity extraction (SZExtractorAgent), entity resolution
    (SZEntityResolverAgent), and provisional memory writes (write_provisional()
    in session_zero_memory.py) per turn. At handoff, write_authoritative()
    replaces this bulk memory creation.
    Remove this function once the orchestrator is enabled by default.

    Called each turn after apply_detected_info() to:
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

    if not campaign_id:
        return stats
    memory = MemoryStore(campaign_id=campaign_id)

    # === CHARACTER IDENTITY MEMORIES ===

    if "name" in detected_info:
        memory.add_memory(
            content=f"Character name: {detected_info['name']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZero→State] Indexed character name: {detected_info['name']}")

    if "concept" in detected_info:
        memory.add_memory(
            content=f"Character concept: {detected_info['concept']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info("[SessionZero→State] Indexed character concept")

    if "backstory" in detected_info:
        memory.add_memory(
            content=f"Character backstory: {detected_info['backstory']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info("[SessionZero→State] Indexed character backstory")

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
        logger.info("[SessionZero→State] Indexed abilities")

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
                # No campaign yet (normal during Session Zero — campaign is created at handoff).
                # Stash full NPC dicts in phase_state so _handle_gameplay_handoff can replay them
                # against the real campaign_id once it exists.
                state = None
                pending = session.phase_state.setdefault("pending_npcs", [])
                existing_names = {p.get("name", "").lower() for p in pending}
                for npc in npcs:
                    if isinstance(npc, dict) and "name" in npc:
                        if npc["name"].lower() not in existing_names:
                            pending.append(npc)
                            existing_names.add(npc["name"].lower())
                logger.info(
                    f"[SessionZero→State] No campaign_id — stashed {len(npcs)} NPC(s) in pending_npcs "
                    f"(total queued: {len(pending)})"
                )

            for npc in npcs:
                if isinstance(npc, dict) and "name" in npc:
                    # Create relationship memory
                    npc_name = npc["name"]
                    role = npc.get("role", "unknown")
                    disposition = npc.get("disposition", "neutral")
                    background = npc.get("background", "")
                    npc_appearance = npc.get("appearance", {})
                    npc_visual_tags = npc.get("visual_tags", [])

                    # 1. Create NPC in database (if StateManager available)
                    # Map SZ disposition strings to initial affinity so NPCs
                    # start gameplay with the relationship established during SZ.
                    _affinity_map = {
                        "ally": 40, "friend": 40, "mentor": 50, "companion": 40,
                        "rival": -20, "enemy": -50, "antagonist": -50,
                        "neutral": 0, "acquaintance": 10, "unknown": 0,
                    }
                    _init_affinity = _affinity_map.get(disposition.lower(), 0)

                    if state is not None:
                        try:
                            state.create_npc(
                                name=npc_name,
                                role=role,
                                relationship_notes=f"{disposition}. {background}",
                                appearance=npc_appearance,
                                visual_tags=npc_visual_tags,
                                affinity=_init_affinity,
                                disposition=_init_affinity,
                            )
                            logger.info(f"[SessionZero→State] Created NPC in DB: {npc_name} (affinity={_init_affinity}, visual_tags={npc_visual_tags})")
                        except Exception as e:
                            logger.error(f"[SessionZero→State] NPC DB creation failed: {e}")

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
                            logger.info(f"[SessionZero→Media] Queued portrait gen for NPC: {npc_name}")
                        except Exception as media_err:
                            logger.error(f"[SessionZero→Media] Portrait queue failed (non-fatal): {media_err}")

                    stats["memories_added"] += 1
                    stats["npcs_created"] += 1
                    logger.info(f"[SessionZero→State] Created NPC: {npc_name} ({role})")

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
        logger.info(f"[SessionZero→State] Timeline mode: {mode}")

    if "canon_cast_mode" in detected_info:
        mode = detected_info["canon_cast_mode"]
        memory.add_memory(
            content=f"Canon cast mode: {mode}",
            memory_type="fact",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZero→State] Canon cast mode: {mode}")

    if "event_fidelity" in detected_info:
        mode = detected_info["event_fidelity"]
        memory.add_memory(
            content=f"Canon event fidelity: {mode}",
            memory_type="fact",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZero→State] Event fidelity: {mode}")

    # === COMPOSITION / POWER TIER ===

    if "tension_source" in detected_info or "power_expression" in detected_info:
        parts = []
        if "tension_source" in detected_info:
            parts.append(f"tension={detected_info['tension_source']}")
        if "power_expression" in detected_info:
            parts.append(f"expression={detected_info['power_expression']}")
        if "narrative_focus" in detected_info:
            parts.append(f"focus={detected_info['narrative_focus']}")
        memory.add_memory(
            content=f"Narrative composition: {', '.join(parts)}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        logger.info(f"[SessionZero→State] Composition: {', '.join(parts)}")

    # Legacy OP mode — still index if received from older prompts
    elif "op_mode" in detected_info or "op_protagonist" in detected_info:
        op_enabled = detected_info.get("op_mode") or detected_info.get("op_protagonist")
        if op_enabled:
            preset = detected_info.get("op_preset", "custom")
            memory.add_memory(
                content=f"OP Protagonist mode enabled (legacy). Preset: {preset}",
                memory_type="core",
                turn_number=0,
                flags=["plot_critical", "session_zero"]
            )
            stats["memories_added"] += 1
            logger.info(f"[SessionZero→State] OP Mode (legacy): {preset}")

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
        logger.info(f"[SessionZero→State] Starting location: {location}")

    memory.close()

    if stats["memories_added"] > 0 or stats["npcs_created"] > 0:
        logger.info(f"[SessionZero→State] Turn processed: {stats['memories_added']} memories, {stats['npcs_created']} NPCs")

    return stats


# ============================================================================
# SESSION ZERO → MEMORY INDEXING
# ============================================================================


async def index_session_zero_to_memory(session: Session, campaign_id: int | None = None) -> int:
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
        campaign_id: Integer campaign ID (must be resolved before calling)

    Returns:
        Number of memory chunks indexed
    """
    from ..context.memory import MemoryStore

    if not campaign_id:
        logger.warning("[SessionZero→Memory] No campaign_id provided — skipping memory indexing")
        return 0

    logger.info(f"[SessionZero→Memory] Indexing character creation to memory for campaign: {campaign_id}")

    # Create memory store keyed by campaign_id
    memory = MemoryStore(campaign_id=campaign_id)

    # Get all Session Zero messages
    messages = session.messages
    if not messages:
        logger.info("[SessionZero→Memory] No messages to index")
        return 0

    # Chunk into logical segments
    chunks = _chunk_session_zero_messages(messages)

    indexed = 0
    for chunk in chunks:
        # Classify for metadata enrichment (core/relationship/fact)
        category = _classify_chunk(chunk)

        # ALL Session Zero content is sacred — never decay.
        # Session Zero is the campaign's DNA: character identity, GM voice,
        # tonal rapport, creative intent. Every exchange matters.
        flags = ["plot_critical", "session_zero"]

        memory.add_memory(
            content=chunk["content"],
            memory_type="session_zero",  # Consistent type → CATEGORY_DECAY["session_zero"] = "none"
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

    logger.info(f"[SessionZero→Memory] Indexed {indexed} chunks ({memory.count()} total memories)")
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

    # Character identity keywords → "core" (no decay)
    core_keywords = [
        "backstory", "name", "concept", "ability", "power", "appearance",
        "personality", "trait", "archetype", "origin", "identity",
        "who you are", "your character", "protagonist", "op mode",
        "age", "look like", "what do you want"
    ]
    if any(kw in content for kw in core_keywords):
        return "core"

    # Relationship keywords → "relationship" (slow decay)
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
    
    Non-blocking — called via asyncio.create_task so it doesn't slow
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
            logger.warning(f"[SessionZero→Media] Media disabled, skipping portrait for {npc_name}")
            return

        # Get style context from profile — prefer rich visual_style dict
        profile_id = settings.active_profile_id or "anime"
        style_context = profile_id  # fallback
        try:
            from ..context.profile_library import get_profile_library
            import yaml
            from pathlib import Path
            # Load profile YAML to get visual_style
            profile_path = Path(__file__).parent.parent / "profiles" / f"{profile_id}.yaml"
            if profile_path.exists():
                with open(profile_path, 'r', encoding='utf-8') as f:
                    profile_data = yaml.safe_load(f)
                vs = profile_data.get('visual_style')
                if isinstance(vs, dict) and vs:
                    style_context = vs
        except Exception as e:
            logger.debug(f"Could not load visual_style for {profile_id}: {e}")

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
                    npc.portrait_url = gen.get_media_url(campaign_id, "portraits", result['portrait'].name)
                    logger.info(f"[SessionZero→Media] Portrait saved for {npc_name}: {npc.portrait_url}")
                if result.get("model_sheet"):
                    npc.model_sheet_url = gen.get_media_url(campaign_id, "models", result['model_sheet'].name)
                db.commit()
            db.close()

    except Exception as e:
        logger.error(f"[SessionZero→Media] NPC portrait gen failed for {npc_name}: {e}")
