"""
Session Zero Agent for AIDM v3.

Guides players through the character creation process using the
multi-phase protocol from V2's 06_session_zero.md.
"""

from dataclasses import dataclass, asdict
from typing import Optional, Dict, Any, Type, List
from pathlib import Path
from pydantic import BaseModel, Field

from .base import BaseAgent
from ..core.session import Session, SessionPhase
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .progress import ProgressTracker


class SessionZeroOutput(BaseModel):
    """Structured output from the Session Zero agent."""
    response: str = Field(description="The narrative response to show the player")
    
    # Goal-oriented fields
    missing_requirements: List[str] = Field(
        default_factory=list,
        description="Hard requirements still needed: 'media_reference', 'name', 'concept'"
    )
    ready_for_gameplay: bool = Field(
        default=False,
        description="True when all hard requirements met AND player confirmed"
    )
    
    # Existing fields (phase_complete deprecated, use ready_for_gameplay)
    detected_info: Dict[str, Any] = Field(default_factory=dict, description="Character data extracted from player input")
    phase_complete: bool = Field(default=False, description="DEPRECATED: Use ready_for_gameplay instead")
    suggested_next_phase: Optional[str] = Field(default=None, description="Phase to skip to if player requests")


class SessionZeroAgent(BaseAgent):
    """
    Agent that drives Session Zero character creation.
    
    Takes the current session state and player input,
    returns a response and any detected character information.
    """
    
    agent_name = "session_zero"
    
    def __init__(self, model_override: Optional[str] = None):
        super().__init__(model_override=model_override)
        
        # Load the session zero prompt
        prompt_path = Path(__file__).parent.parent.parent / "prompts" / "session_zero.md"
        self._system_prompt = prompt_path.read_text(encoding="utf-8")
    
    @property
    def system_prompt(self) -> str:
        """The system prompt for this agent."""
        return self._system_prompt
    
    @property
    def output_schema(self) -> Type[BaseModel]:
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
        # Build context for the prompt
        context = self._build_context(session, player_input)
        
        # Call the LLM
        result = await self.call(context)
        
        return result
    
    def _build_context(self, session: Session, player_input: str) -> str:
        """Build the context string to send to the LLM."""
        # Format character draft as readable summary
        draft = session.character_draft
        draft_summary = self._format_draft(draft)
        
        # Format recent messages (last 10)
        recent_messages = session.messages[-10:] if session.messages else []
        messages_str = "\n".join([
            f"[{m['role'].upper()}]: {m['content']}" 
            for m in recent_messages
        ])
        
        # Current player input
        context = f"""## Current Phase: {session.phase.value}

## Character Draft So Far:
{draft_summary}

## Recent Conversation:
{messages_str}

## Player's Current Input:
{player_input}

Based on the phase-specific instructions in the system prompt, generate an appropriate response.
"""
        return context
    
    def _format_draft(self, draft) -> str:
        """Format the character draft as a readable summary."""
        parts = []
        
        if draft.media_reference:
            parts.append(f"- Media Reference: {draft.media_reference}")
        if draft.narrative_profile:
            parts.append(f"- Narrative Profile: {draft.narrative_profile}")
        if draft.op_protagonist_enabled:
            op_summary = draft.op_preset or f"{draft.op_tension_source}/{draft.op_power_expression}/{draft.op_narrative_focus}"
            parts.append(f"- OP Mode: {op_summary or 'enabled'}")
        if draft.concept:
            parts.append(f"- Concept: {draft.concept}")
        if draft.name:
            parts.append(f"- Name: {draft.name}")
        if draft.appearance:
            parts.append(f"- Appearance: {draft.appearance}")
        if draft.personality_traits:
            parts.append(f"- Traits: {', '.join(draft.personality_traits)}")
        if draft.attributes:
            attrs = ", ".join([f"{k}:{v}" for k, v in draft.attributes.items()])
            parts.append(f"- Attributes: {attrs}")
        
        return "\n".join(parts) if parts else "(No information collected yet)"
    
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


def apply_detected_info(session: Session, detected: Dict[str, Any]) -> None:
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
        elif key == "skills" and isinstance(value, list):
            draft.skills.extend(value)
        elif key == "goals" and isinstance(value, dict):
            draft.goals.update(value)


async def process_session_zero_state(
    session: Session,
    detected_info: Dict[str, Any],
    session_id: str
) -> Dict[str, int]:
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
        print(f"[SessionZero→State] Indexed character name: {detected_info['name']}")
    
    if "concept" in detected_info:
        memory.add_memory(
            content=f"Character concept: {detected_info['concept']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        print(f"[SessionZero→State] Indexed character concept")
    
    if "backstory" in detected_info:
        memory.add_memory(
            content=f"Character backstory: {detected_info['backstory']}",
            memory_type="core",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        print(f"[SessionZero→State] Indexed character backstory")
    
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
        print(f"[SessionZero→State] Indexed abilities")
    
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
            # Initialize StateManager for DB writes
            state = StateManager(game_id=session_id)
            
            for npc in npcs:
                if isinstance(npc, dict) and "name" in npc:
                    # Create relationship memory
                    npc_name = npc["name"]
                    role = npc.get("role", "unknown")
                    disposition = npc.get("disposition", "neutral")
                    background = npc.get("background", "")
                    
                    # 1. Create NPC in SQLite database
                    try:
                        state.create_npc(
                            name=npc_name,
                            role=role,
                            relationship_notes=f"{disposition}. {background}"
                        )
                        print(f"[SessionZero→State] Created NPC in DB: {npc_name}")
                    except Exception as e:
                        print(f"[SessionZero→State] NPC DB creation failed: {e}")
                    
                    # 2. Create NPC memory in ChromaDB
                    memory.add_memory(
                        content=f"NPC: {npc_name} - Role: {role}, Disposition: {disposition}. {background}",
                        memory_type="relationship",
                        turn_number=0,
                        metadata={"npc_name": npc_name, "role": role},
                        flags=["session_zero"]
                    )
                    stats["memories_added"] += 1
                    stats["npcs_created"] += 1
                    print(f"[SessionZero→State] Created NPC: {npc_name} ({role})")
    
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
        print(f"[SessionZero→State] Timeline mode: {mode}")
    
    if "canon_cast_mode" in detected_info:
        mode = detected_info["canon_cast_mode"]
        memory.add_memory(
            content=f"Canon cast mode: {mode}",
            memory_type="fact",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        print(f"[SessionZero→State] Canon cast mode: {mode}")
    
    if "event_fidelity" in detected_info:
        mode = detected_info["event_fidelity"]
        memory.add_memory(
            content=f"Canon event fidelity: {mode}",
            memory_type="fact",
            turn_number=0,
            flags=["plot_critical", "session_zero"]
        )
        stats["memories_added"] += 1
        print(f"[SessionZero→State] Event fidelity: {mode}")
    
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
            print(f"[SessionZero→State] OP Mode enabled: {preset}")
    
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
        print(f"[SessionZero→State] Starting location: {location}")
    
    memory.close()
    
    if stats["memories_added"] > 0 or stats["npcs_created"] > 0:
        print(f"[SessionZero→State] Turn processed: {stats['memories_added']} memories, {stats['npcs_created']} NPCs")
    
    return stats

async def get_disambiguation_options(anime_name: str) -> Dict[str, Any]:
    """
    Check if an anime name needs disambiguation before loading/generating.
    
    Always uses web search to get the FULL franchise list, ensuring consistent
    UX regardless of what profiles we have cached.
    
    Args:
        anime_name: What the user typed (e.g., "dbz", "naruto")
        
    Returns:
        Dict with:
        - 'needs_disambiguation': bool
        - 'options': List[Dict] with name for each option
        - 'source': 'web_search'
    """
    result = {
        'needs_disambiguation': False,
        'options': [],
        'source': None
    }
    
    # Always use web search for full franchise discovery
    print(f"[Disambiguation] Searching for '{anime_name}' franchise...")
    franchise_entries = await _search_franchise_entries(anime_name)
    
    if franchise_entries and len(franchise_entries) > 1:
        result['needs_disambiguation'] = True
        result['options'] = [
            {'name': entry, 'id': None, 'relation_type': 'unknown'}
            for entry in franchise_entries
        ]
        result['source'] = 'web_search'
        print(f"[Disambiguation] Found {len(franchise_entries)} entries: {franchise_entries[:5]}...")
        return result
    else:
        print(f"[Disambiguation] Single entry or standalone series, no disambiguation needed")
    
    return result


async def _search_franchise_entries(anime_name: str) -> List[str]:
    """
    Use web search to find all entries in an anime franchise.
    
    Works across all 3 providers that support search (Google, OpenAI, Anthropic).
    
    Args:
        anime_name: Name of the anime to search for
        
    Returns:
        List of franchise entries (e.g., ["Fate/stay night", "Fate/Zero", "Fate/Grand Order"])
    """
    from ..llm import get_llm_manager
    from pydantic import BaseModel
    import json
    
    manager = get_llm_manager()
    # Use research agent's provider since it's configured for search
    provider, model = manager.get_provider_for_agent("research")
    print(f"[Disambiguation] Using provider: {provider.name}, model: {model}")
    
    # Very explicit prompt - LLM tends to add prose with web search
    query = f'''List all anime series in the same franchise as "{anime_name}".

OUTPUT FORMAT: JSON array ONLY. Example:
["Naruto", "Naruto: Shippuden", "Boruto: Naruto Next Generations"]

RULES:
- Official English titles only
- Main series + major sequels/spinoffs
- NO explanations, NO prose, JUST the JSON array

Start your response with [ and end with ]'''

    print(f"[Disambiguation] Web search for '{anime_name}' franchise...")
    
    # Filter out generic labels
    GENERIC_LABELS = {'original series', 'sequel', 'prequel', 'spinoff', 'movie', 
                      'original', 'part 2', 'part 1', 'season 1', 'season 2',
                      'main series', 'side story', 'ova', 'special', 'the movie'}
    
    try:
        if hasattr(provider, 'complete_with_search'):
            response = await provider.complete_with_search(
                messages=[{"role": "user", "content": query}],
                system="Return only a JSON array of anime titles. No explanation.",
                model=model,
                max_tokens=4096,  # Increased to prevent truncation
                temperature=0.2
            )
            
            content = response.content.strip()
            print(f"[Disambiguation] RAW RESPONSE LENGTH: {len(content)} chars")
            print(f"[Disambiguation] RAW RESPONSE: {content[:300]}...")
            
            
            # Try to find and parse JSON array
            start_idx = content.find('[')
            end_idx = content.rfind(']')
            
            # Handle truncated responses - if we have [ but no ], add it
            if start_idx != -1 and end_idx == -1:
                print(f"[Disambiguation] Response truncated, attempting fix...")
                content = content + ']'
                end_idx = len(content) - 1
            
            if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
                json_str = content[start_idx:end_idx + 1]
                # Normalize newlines
                json_str = json_str.replace('\n', ' ').replace('\r', ' ')
                print(f"[Disambiguation] Attempting to parse: {json_str[:100]}...")
                
                try:
                    entries = json.loads(json_str)
                    if isinstance(entries, list):
                        valid_entries = [
                            entry.strip() for entry in entries
                            if isinstance(entry, str) 
                            and entry.strip()
                            and entry.lower().strip() not in GENERIC_LABELS
                        ]
                        print(f"[Disambiguation] Web search returned: {valid_entries[:10]}...")
                        return valid_entries  # Return all entries, don't limit
                    else:
                        print(f"[Disambiguation] Parsed but not a list: {type(entries)}")
                except json.JSONDecodeError as e:
                    print(f"[Disambiguation] JSON parse error: {e}")
                    
                    # Fallback: Use ValidatorAgent to repair
                    try:
                        from .validator import ValidatorAgent
                        
                        # Define a simple schema for the array
                        class FranchiseList(BaseModel):
                            titles: List[str]
                        
                        validator = ValidatorAgent()
                        # Wrap in object for schema compliance
                        repaired = await validator.repair_json(
                            broken_json=f'{{"titles": {json_str}}}',
                            target_schema=FranchiseList,
                            error_msg=str(e)
                        )
                        if repaired and repaired.titles:
                            valid_entries = [
                                t.strip() for t in repaired.titles
                                if t.strip() and t.lower().strip() not in GENERIC_LABELS
                            ]
                            print(f"[Disambiguation] Validator repair returned: {valid_entries[:10]}...")
                            return valid_entries  # Return all, don't limit
                    except Exception as repair_error:
                        print(f"[Disambiguation] Validator repair failed: {repair_error}")
            
            print(f"[Disambiguation] Could not parse JSON from response: {content[:200]}")
            return [anime_name]
        else:
            print(f"[Disambiguation] Provider {provider.name} doesn't support search")
            return [anime_name]
            
    except Exception as e:
        print(f"[Disambiguation] Web search failed: {e}")
        return [anime_name]


async def research_and_apply_profile(
    session: Session, 
    anime_name: str,
    progress_tracker: Optional["ProgressTracker"] = None
) -> Dict[str, Any]:
    """
    Research an anime and apply the profile to the session.
    
    This is triggered during Phase 0 (Media Detection) when the player
    mentions an anime/manga they want to use as inspiration.
    
    Priority:
    1. Web search (mandatory if available)
    2. Existing V2 profile (enhancement)
    3. Training data (fallback only)
    
    Args:
        session: Current session state
        anime_name: Name of the anime mentioned
        progress_tracker: Optional tracker for streaming progress updates
        
    Returns:
        Research summary dict with key info
    """
    from .profile_generator import generate_and_save_profile, load_existing_profile
    
    # First check if profile already exists
    existing = load_existing_profile(anime_name)
    if existing:
        # We have a v3 compact profile - use it directly
        session.character_draft.narrative_profile = existing.get("id")
        session.character_draft.media_reference = anime_name
        session.phase_state["profile_data"] = existing
        return {
            "status": "existing_profile",
            "profile_id": existing.get("id"),
            "confidence": existing.get("confidence", 100),
            "dna_scales": existing.get("dna_scales", {}),
            "combat_style": existing.get("combat_system", "tactical")
        }
    
    # Research the anime AND save to disk + index to RAG
    print(f"[SessionZero] Researching and saving profile for: {anime_name}")
    profile = await generate_and_save_profile(anime_name, progress_tracker=progress_tracker)
    
    # Apply to session
    session.character_draft.media_reference = anime_name
    session.character_draft.narrative_profile = profile.get("id")
    session.phase_state["profile_data"] = profile
    session.phase_state["research_output"] = {
        "title": profile.get("name"),
        "confidence": profile.get("confidence"),
        "research_method": profile.get("research_method"),
        "sources_consulted": profile.get("sources_consulted", [])
    }
    
    # EARLY SETTINGS SYNC: Update settings immediately after research completes
    # Prevents wrong profile loading if server restarts before handoff
    try:
        from src.settings import get_settings_store
        settings_store = get_settings_store()
        current_settings = settings_store.load()
        profile_id = profile.get("id")
        if current_settings.active_profile_id != profile_id:
            print(f"[SessionZero] Early sync after research: {current_settings.active_profile_id} -> {profile_id}")
            current_settings.active_profile_id = profile_id
            current_settings.active_session_id = session.session_id
            settings_store.save(current_settings)
    except Exception as sync_err:
        print(f"[SessionZero] Early sync failed (non-fatal): {sync_err}")
    
    return {
        "status": "researched",
        "profile_id": profile.get("id"),
        "confidence": profile.get("confidence"),
        "research_method": profile.get("research_method"),
        "dna_scales": profile.get("dna_scales", {}),
        "combat_style": profile.get("combat_system", "tactical"),
        "power_system": profile.get("power_system"),
        "sources": profile.get("sources_consulted", [])
    }


def get_profile_context_for_agent(session: Session) -> str:
    """
    Get profile context to inject into agent prompts.
    
    Extracts key information from the researched/loaded profile
    for use in subsequent Session Zero phases.
    """
    profile_data = session.phase_state.get("profile_data", {})
    
    if not profile_data:
        return "(No profile loaded yet)"
    
    parts = [f"# Loaded Profile: {profile_data.get('name', 'Unknown')}"]
    
    # DNA scales
    if dna := profile_data.get("dna_scales", {}):
        parts.append("\n## Narrative DNA:")
        for scale, value in dna.items():
            parts.append(f"  - {scale}: {value}/10")
    
    # Combat style
    if combat := profile_data.get("combat_system"):
        parts.append(f"\n## Combat Style: {combat}")
    
    # Power system
    if power := profile_data.get("power_system"):
        if isinstance(power, dict):
            parts.append(f"\n## Power System: {power.get('name', 'Unknown')}")
            if mechanics := power.get("mechanics"):
                parts.append(f"   Mechanics: {mechanics}")
    
    # Director personality
    if personality := profile_data.get("director_personality"):
        parts.append(f"\n## Director Voice:\n{personality}")
    
    return "\n".join(parts)


async def generate_custom_profile(session: Session) -> Dict[str, Any]:
    """
    Generate a custom (original) world profile for the session.
    
    Called when player says "Original" instead of an anime reference.
    Creates a basic fantasy world profile, saves it to session-scoped storage,
    and indexes it for RAG retrieval.
    
    Args:
        session: Current session state
        
    Returns:
        Dict with creation status
    """
    from datetime import datetime
    from ..context.custom_profile_library import (
        get_custom_profile_library,
        save_custom_profile
    )
    
    session_id = session.session_id
    
    # Create a default custom world profile
    # In a future enhancement, we could use an AI agent to generate this
    world_data = {
        "id": f"custom_{session_id[:8]}",
        "name": "Original Fantasy World",
        "profile_type": "custom",
        "session_id": session_id,
        "generated_at": datetime.now().isoformat(),
        
        # Default DNA scales for balanced fantasy
        "dna_scales": {
            "introspection_vs_action": 5,
            "comedy_vs_drama": 5,
            "tactical_vs_instinctive": 5,
            "grounded_vs_absurd": 4,
            "power_fantasy_vs_struggle": 5,
            "fast_vs_slow": 5,
            "episodic_vs_serial": 6,
            "ensemble_vs_solo": 5,
            "mystery_vs_transparent": 5,
            "dark_vs_hopeful": 5,
            "romance_weight": 3
        },
        
        "combat_system": "tactical_fantasy",
        "power_system": {
            "name": "Flexible Magic & Skills",
            "mechanics": "Character-defined abilities with creative freedom"
        },
        "tone": "Balanced fantasy adventure with room for exploration"
    }
    
    # Generate some starter lore for RAG
    lore_content = f"""
# Custom Fantasy World

This is an original fantasy world created for this campaign.

## World Foundation
A realm where magic and adventure await. The world is malleable, 
shaped by the player's choices and the unfolding narrative.

## Magic System
Magic is flexible and character-driven. Each protagonist discovers 
their own unique abilities through the story.

## Tone
Balanced between light and dark moments. Adventure is the core theme,
with room for humor, drama, and personal growth.

## Campaign Notes
- Created: {datetime.now().strftime('%Y-%m-%d')}
- Session: {session_id[:8]}
- Type: Original/Custom World

The world will be developed collaboratively during play.
"""
    
    # Save to disk
    save_custom_profile(session_id, world_data, lore_content)
    
    # Index lore into custom ChromaDB
    custom_lib = get_custom_profile_library()
    chunks_indexed = custom_lib.add_custom_lore(session_id, lore_content, source="generated")
    
    # Apply to session
    session.character_draft.media_reference = "Original"
    session.character_draft.narrative_profile = world_data["id"]
    session.phase_state["profile_data"] = world_data
    session.phase_state["profile_type"] = "custom"
    
    print(f"[SessionZero] Created custom profile for session {session_id[:8]}, indexed {chunks_indexed} lore chunks")
    
    return {
        "status": "custom_profile_created",
        "profile_id": world_data["id"],
        "session_id": session_id,
        "chunks_indexed": chunks_indexed
    }


async def research_hybrid_profile(
    session: Session,
    primary_anime: str,
    secondary_anime: str,
    blend_ratio: float = 0.6,
    progress_tracker: Optional["ProgressTracker"] = None
) -> Dict[str, Any]:
    """
    Research two anime series and merge them into a hybrid profile.
    
    This is triggered when a player mentions blending two anime
    (e.g., "I want Death Note meets Code Geass").
    
    Flow:
    1. Research both anime in parallel
    2. Merge using ProfileMergeAgent
    3. Save to session-scoped storage
    
    Args:
        session: Current session state
        primary_anime: Primary anime to research (gets blend_ratio weight)
        secondary_anime: Secondary anime to blend in
        blend_ratio: Weight for primary (0.6 = 60% primary, 40% secondary)
        progress_tracker: Optional tracker for streaming progress updates
        
    Returns:
        Dict with hybrid profile info
    """
    import asyncio
    from .anime_research import research_anime_with_search
    from .profile_merge import ProfileMergeAgent
    from .progress import ProgressPhase
    from ..context.custom_profile_library import (
        get_custom_profile_library,
        save_custom_profile
    )
    
    session_id = session.session_id
    
    # Emit start
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.SCOPE,
            f"Starting hybrid research: {primary_anime} × {secondary_anime}",
            5
        )
    
    # ========== STEP 1: Parallel Research ==========
    print(f"[SessionZero] Hybrid research: {primary_anime} + {secondary_anime}")
    
    # Research both in parallel (no individual progress trackers to avoid conflicts)
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.RESEARCH,
            f"Researching {primary_anime}...",
            10
        )
    
    try:
        # Use asyncio.gather for parallel execution
        research_a, research_b = await asyncio.gather(
            research_anime_with_search(primary_anime),
            research_anime_with_search(secondary_anime)
        )
    except Exception as e:
        print(f"[SessionZero] Hybrid research failed: {e}")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.ERROR,
                f"Research failed: {str(e)}",
                100
            )
        raise
    
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.RESEARCH,
            f"Research complete. Blending profiles...",
            80
        )
    
    # ========== STEP 2: Merge Profiles ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            f"Merging {primary_anime} with {secondary_anime}...",
            85
        )
    
    merge_agent = ProfileMergeAgent()
    merged = await merge_agent.merge(
        profile_a=research_a,
        profile_b=research_b,
        blend_ratio=blend_ratio,
        primary_name=primary_anime,
        secondary_name=secondary_anime
    )
    
    # ========== STEP 3: Save to Session Storage ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            "Saving hybrid profile...",
            92
        )
    
    # Build profile data from merged output
    hybrid_id = f"hybrid_{session_id[:8]}"
    from datetime import datetime
    
    profile_data = {
        "id": hybrid_id,
        "name": merged.title,
        "profile_type": "hybrid",
        "session_id": session_id,
        "generated_at": datetime.now().isoformat(),
        "primary_source": primary_anime,
        "secondary_source": secondary_anime,
        "blend_ratio": blend_ratio,
        
        "dna_scales": merged.dna_scales,
        "combat_system": merged.combat_style,
        "power_system": merged.power_system,
        "tone": merged.tone,
        "storytelling_tropes": merged.storytelling_tropes,
        "world_setting": merged.world_setting,
        
        "confidence": merged.confidence,
        "research_method": "hybrid_merge"
    }
    
    # Build lore content for RAG
    lore_content = merged.raw_content or f"""
# Hybrid Profile: {merged.title}

This is a hybrid world blending {primary_anime} ({blend_ratio*100:.0f}%) with {secondary_anime} ({(1-blend_ratio)*100:.0f}%).

## Power System
{merged.power_system}

## Combat Style
{merged.combat_style}

## Tone
{merged.tone}
"""
    
    # Save to disk
    save_custom_profile(session_id, profile_data, lore_content)
    
    # Store in LoreStore SQL
    from ..scrapers.lore_store import get_lore_store
    lore_store = get_lore_store()
    hybrid_profile_id = f"hybrid_{session_id[:12]}"
    lore_store.store_pages(hybrid_profile_id, [{
        "title": merged.title or f"{primary_anime} × {secondary_anime}",
        "page_type": "hybrid",
        "content": lore_content,
    }])
    
    # Index into RAG
    custom_lib = get_custom_profile_library()
    chunks_indexed = custom_lib.add_custom_lore(session_id, lore_content, source="hybrid_research")
    
    # Apply to session
    session.character_draft.media_reference = f"{primary_anime} × {secondary_anime}"
    session.character_draft.narrative_profile = hybrid_id
    session.phase_state["profile_data"] = profile_data
    session.phase_state["profile_type"] = "hybrid"
    session.phase_state["blend_sources"] = [primary_anime, secondary_anime]
    
    # Emit completion
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.COMPLETE,
            f"Hybrid profile complete! Confidence: {merged.confidence}%",
            100,
            {"confidence": merged.confidence, "title": merged.title}
        )
    
    print(f"[SessionZero] Hybrid profile created: {merged.title} (confidence: {merged.confidence}%)")
    
    return {
        "status": "hybrid_profile_created",
        "profile_id": hybrid_id,
        "title": merged.title,
        "primary": primary_anime,
        "secondary": secondary_anime,
        "blend_ratio": blend_ratio,
        "confidence": merged.confidence,
        "chunks_indexed": chunks_indexed
    }


async def research_hybrid_profile_cached(
    session: Session,
    primary_anime: str,
    secondary_anime: str,
    user_preferences: Optional[Dict[str, Any]] = None,
    blend_ratio: float = 0.6,
    progress_tracker: Optional["ProgressTracker"] = None
) -> Dict[str, Any]:
    """
    Token-efficient hybrid: loads existing profiles, only researches missing ones.
    
    Flow:
    1. Check if each base profile exists on disk
    2. Research only missing profiles (saved permanently as base profiles)
    3. Synthesize hybrid (session-scoped only)
    
    This is much more token-efficient for repeated hybrids:
    - First "A × B" researches both, saves both permanently
    - Second "A × C" only researches C (A is cached)
    - Third "B × C" costs almost nothing (both cached)
    
    Args:
        session: Current session state
        primary_anime: Primary anime
        secondary_anime: Secondary anime  
        user_preferences: Dict with "power_system" choice ("primary", "secondary", "synthesized", "coexist")
        blend_ratio: Weight for primary (0.6 = 60% primary)
        progress_tracker: Optional tracker for SSE streaming
        
    Returns:
        Dict with hybrid profile info
    """
    from .profile_generator import load_existing_profile, generate_and_save_profile
    from .profile_merge import ProfileMergeAgent
    from .progress import ProgressPhase
    from .anime_research import AnimeResearchOutput
    from ..context.custom_profile_library import (
        get_custom_profile_library,
        save_custom_profile
    )
    
    session_id = session.session_id
    user_preferences = user_preferences or {}
    
    # Emit start
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.SCOPE,
            f"Hybrid research: {primary_anime} × {secondary_anime}",
            5
        )
    
    # ========== STEP 1: Load/Research Primary Profile ==========
    profile_a = load_existing_profile(primary_anime)
    research_a = None
    
    if profile_a:
        print(f"[HybridCached] Loaded cached profile for '{primary_anime}'")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {primary_anime} (cached)",
                20
            )
    else:
        print(f"[HybridCached] Researching '{primary_anime}' (not cached)")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"Researching {primary_anime}...",
                10
            )
        # Research and save permanently
        profile_a = await generate_and_save_profile(primary_anime, progress_tracker=None)
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {primary_anime} (researched & cached)",
                40
            )
    
    # ========== STEP 2: Load/Research Secondary Profile ==========
    profile_b = load_existing_profile(secondary_anime)
    
    if profile_b:
        print(f"[HybridCached] Loaded cached profile for '{secondary_anime}'")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {secondary_anime} (cached)",
                60
            )
    else:
        print(f"[HybridCached] Researching '{secondary_anime}' (not cached)")
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"Researching {secondary_anime}...",
                45
            )
        profile_b = await generate_and_save_profile(secondary_anime, progress_tracker=None)
        if progress_tracker:
            await progress_tracker.emit(
                ProgressPhase.RESEARCH,
                f"✓ {secondary_anime} (researched & cached)",
                70
            )
    
    # ========== STEP 3: Convert profiles to AnimeResearchOutput for merge ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            "Synthesizing hybrid world...",
            80
        )
    
    # Build research outputs from loaded profiles
    def profile_to_research(profile: Dict) -> AnimeResearchOutput:
        """Convert stored profile dict to AnimeResearchOutput for merge."""
        return AnimeResearchOutput(
            title=profile.get("name", profile.get("id", "Unknown")),
            media_type=profile.get("media_type", "anime"),
            dna_scales=profile.get("dna_scales", {}),
            power_system=profile.get("power_system", {}),
            combat_style=profile.get("combat_system", profile.get("combat_style", "spectacle")),
            tone=profile.get("tone", {}),
            storytelling_tropes=profile.get("tropes", profile.get("storytelling_tropes", {})),
            world_setting=profile.get("world_setting", {}),
            confidence=profile.get("confidence", 90),
            research_method="cached_profile"
        )
    
    research_a = profile_to_research(profile_a)
    research_b = profile_to_research(profile_b)
    
    # ========== STEP 4: Merge with user preferences ==========
    merge_agent = ProfileMergeAgent()
    merged = await merge_agent.merge(
        profile_a=research_a,
        profile_b=research_b,
        blend_ratio=blend_ratio,
        primary_name=primary_anime,
        secondary_name=secondary_anime
    )
    
    # ========== STEP 5: Save to Session Storage (NOT permanent) ==========
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.PARSING,
            "Saving hybrid profile...",
            92
        )
    
    hybrid_id = f"hybrid_{session_id[:8]}"
    from datetime import datetime
    
    profile_data = {
        "id": hybrid_id,
        "name": merged.title,
        "profile_type": "hybrid",
        "session_id": session_id,
        "generated_at": datetime.now().isoformat(),
        "primary_source": primary_anime,
        "secondary_source": secondary_anime,
        "blend_ratio": blend_ratio,
        "user_preferences": user_preferences,
        
        "dna_scales": merged.dna_scales,
        "combat_system": merged.combat_style,
        "power_system": merged.power_system,
        "tone": merged.tone,
        "storytelling_tropes": merged.storytelling_tropes,
        "world_setting": merged.world_setting,
        
        "confidence": merged.confidence,
        "research_method": "cached_hybrid_merge"
    }
    
    lore_content = merged.raw_content or f"""
# Hybrid Profile: {merged.title}

Blending {primary_anime} ({blend_ratio*100:.0f}%) with {secondary_anime} ({(1-blend_ratio)*100:.0f}%).
Power system preference: {user_preferences.get('power_system', 'coexist')}

## Power System
{merged.power_system}

## Combat Style
{merged.combat_style}
"""
    
    # Save to session storage
    save_custom_profile(session_id, profile_data, lore_content)
    
    # Store in LoreStore SQL
    from ..scrapers.lore_store import get_lore_store
    lore_store = get_lore_store()
    hybrid_profile_id = f"hybrid_{session_id[:12]}"
    lore_store.store_pages(hybrid_profile_id, [{
        "title": merged.title or f"{primary_anime} × {secondary_anime}",
        "page_type": "hybrid",
        "content": lore_content,
    }])
    
    # Index into RAG
    custom_lib = get_custom_profile_library()
    chunks_indexed = custom_lib.add_custom_lore(session_id, lore_content, source="cached_hybrid")
    
    # Apply to session
    session.character_draft.media_reference = f"{primary_anime} × {secondary_anime}"
    session.character_draft.narrative_profile = hybrid_id
    session.phase_state["profile_data"] = profile_data
    session.phase_state["profile_type"] = "hybrid"
    session.phase_state["blend_sources"] = [primary_anime, secondary_anime]
    
    # Emit completion
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.COMPLETE,
            f"Hybrid complete! {merged.title}",
            100,
            {"confidence": merged.confidence, "title": merged.title}
        )
    
    print(f"[HybridCached] Created: {merged.title} (confidence: {merged.confidence}%)")
    
    return {
        "status": "hybrid_profile_created",
        "profile_id": hybrid_id,
        "title": merged.title,
        "primary": primary_anime,
        "secondary": secondary_anime,
        "blend_ratio": blend_ratio,
        "confidence": merged.confidence,
        "chunks_indexed": chunks_indexed,
        "cached_primary": profile_a is not None,
        "cached_secondary": profile_b is not None
    }


async def ensure_hybrid_prerequisites(
    session: Session,
    primary_anime: str,
    secondary_anime: str,
    progress_tracker: Optional["ProgressTracker"] = None
) -> None:
    """
    Ensure base profiles for hybrid synthesis are researched and cached.
    Triggered during Phase 1 (Calibration) to front-load the research latency.
    """
    from .profile_generator import load_existing_profile, generate_and_save_profile
    from .progress import ProgressPhase
    import asyncio
    from typing import Optional
    from ..agents.progress import ProgressTracker
    
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.SCOPE,
            f"Pre-researching sources: {primary_anime} & {secondary_anime}",
            5
        )

    # 1. Check Cache
    profile_a = load_existing_profile(primary_anime)
    profile_b = load_existing_profile(secondary_anime)
    
    # 2. Queue missing researches
    tasks = []
    
    if not profile_a:
        print(f"[HybridPreload] {primary_anime} missing, queuing research...")
        tasks.append(primary_anime)
    else:
        if progress_tracker:
            await progress_tracker.emit(ProgressPhase.RESEARCH, f"✓ {primary_anime} already cached", 20)

    if not profile_b:
        print(f"[HybridPreload] {secondary_anime} missing, queuing research...")
        tasks.append(secondary_anime)
    else:
        if progress_tracker:
             await progress_tracker.emit(ProgressPhase.RESEARCH, f"✓ {secondary_anime} already cached", 40)
             
    # 3. Execute Parallel Research
    if tasks:
        from .progress import WeightedProgressGroup
        
        # Weighted Group: Each profile is 50% of the research phase
        active_tasks_count = len(tasks)
        
        if progress_tracker:
            group = WeightedProgressGroup(progress_tracker)
            names = []
            if not profile_a: names.append(primary_anime)
            if not profile_b: names.append(secondary_anime)
            await progress_tracker.emit(ProgressPhase.RESEARCH, f"Researching sources: {', '.join(names)}...", 0)

        # Prepare coroutines
        coroutines = []
        
        # LOGIC:
        # We always treat this as a 50/50 split of the *Progress Bar*.
        # If a profile is missing -> Attach a new tracker (weight 0.5)
        # If a profile is cached -> It effectively contributed 50% instantly.
        # However, to avoid "Instant 50% jump" then "Slow 50->" behavior if only 1 is missing,
        # we should just give the missing one full weight if it's the only one running.
        
        if active_tasks_count == 2:
            # Both running: 50/50 split
            tracker_a = group.create_sub_tracker(weight=0.5, name=primary_anime) if progress_tracker else None
            coroutines.append(generate_and_save_profile(primary_anime, progress_tracker=tracker_a))
            
            tracker_b = group.create_sub_tracker(weight=0.5, name=secondary_anime) if progress_tracker else None
            coroutines.append(generate_and_save_profile(secondary_anime, progress_tracker=tracker_b))
            
        elif active_tasks_count == 1:
            # One running: Give it 100% of the *remaining* focus
            # The cached one is already "done" in user's mind
            missing_name = primary_anime if not profile_a else secondary_anime
            tracker = group.create_sub_tracker(weight=1.0, name=missing_name) if progress_tracker else None
            coroutines.append(generate_and_save_profile(missing_name, progress_tracker=tracker))

        # Run in parallel with exception safety
        results = await asyncio.gather(*coroutines, return_exceptions=True)
        
        # Check for failures
        failed_tasks = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                print(f"[HybridPreload] Task {i} failed: {result}")
                failed_tasks.append(str(result))

        if failed_tasks and progress_tracker:
            error_msg = f"Research failed: {'; '.join(failed_tasks)}"
            await progress_tracker.emit(ProgressPhase.ERROR, error_msg, 100)
            return

    # 5. Complete
    print(f"[HybridPreload] Base profiles ready for {primary_anime} x {secondary_anime}")
    if progress_tracker:
        await progress_tracker.emit(
            ProgressPhase.COMPLETE,
            "Sources ready. Please confirm blend preferences.",
            100
        )


# ============================================================================
# SESSION ZERO → MEMORY INDEXING
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
    
    print(f"[SessionZero→Memory] Indexing character creation to memory for session: {session_id}")
    
    # Create memory store for this session
    memory = MemoryStore(campaign_id=session_id)
    
    # Get all Session Zero messages
    messages = session.messages
    if not messages:
        print("[SessionZero→Memory] No messages to index")
        return 0
    
    # Chunk into logical segments
    chunks = _chunk_session_zero_messages(messages)
    
    indexed = 0
    for chunk in chunks:
        # Determine category based on content
        category = _classify_chunk(chunk)
        
        # Core memories are plot-critical (no decay)
        flags = ["plot_critical", "session_zero"] if category == "core" else ["session_zero"]
        
        memory.add_memory(
            content=chunk["content"],
            memory_type=category,
            turn_number=0,  # Pre-gameplay turn
            metadata={
                "source": "session_zero",
                "chunk_index": chunk.get("index", 0),
                "message_count": chunk.get("message_count", 0)
            },
            flags=flags
        )
        indexed += 1
    
    print(f"[SessionZero→Memory] Indexed {indexed} chunks ({memory.count()} total memories)")
    memory.close()
    return indexed


def _chunk_session_zero_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
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


def _classify_chunk(chunk: Dict[str, Any]) -> str:
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
