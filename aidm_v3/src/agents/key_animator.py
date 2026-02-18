"""Key Animator Agent - Generate narrative prose.

Supports an optional agentic RESEARCH phase before the narrative WRITE phase.
When tools are provided, the research phase uses tool-calling (on the fast model)
to gather targeted context from memory, NPCs, and world state. The findings are
injected into the Vibe Keeper template alongside the existing RAG context.

Prompt-building helpers live in _key_animator_prompt.py (PromptBuilderMixin).
"""

import random
import re
from collections import Counter
from typing import Optional, Tuple, List, Dict, Any
from pathlib import Path

from ..llm import get_llm_manager, LLMProvider
from ..llm.tools import ToolRegistry
from ..settings import get_settings_store
from .intent_classifier import IntentOutput
from .outcome_judge import OutcomeOutput
from ..db.state_manager import GameContext
from ..profiles.loader import NarrativeProfile
from ..enums import NarrativeWeight
from ._key_animator_prompt import PromptBuilderMixin


import logging

logger = logging.getLogger(__name__)

class KeyAnimator(PromptBuilderMixin):
    """Generates narrative prose using the Vibe Keeper prompt.
    
    Unlike other agents, Key Animator uses a rich, templated prompt
    with multiple injection points. It does NOT use structured output
    since its job is to generate creative prose.
    
    Uses 'key_animator' settings from the settings store.
    """
    
    agent_name = "key_animator"
    
    def _get_provider_and_model(self) -> Tuple[LLMProvider, str]:
        """Get the provider and model from settings."""
        if self._model_override:
            manager = get_llm_manager()
            return manager.get_provider(), self._model_override
        
        if self._cached_provider is None:
            manager = get_llm_manager()
            self._cached_provider, self._cached_model = manager.get_provider_for_agent(self.agent_name)
        
        return self._cached_provider, self._cached_model
    
    @property
    def provider(self) -> LLMProvider:
        """Get the LLM provider for this agent."""
        provider, _ = self._get_provider_and_model()
        return provider
    
    @property
    def model(self) -> str:
        """Get the model to use."""
        _, model = self._get_provider_and_model()
        return model
    
    # ===================================================================
    # NARRATIVE DIVERSITY SYSTEM
    #
    # Three injection layers to prevent structural ossification and
    # vocabulary collapse over long sessions:
    #   A. Style Drift Directives — per-turn structural variation nudges
    #   B. Vocabulary Freshness — anti-repetition advisory from working memory
    #   C. Sakuga Variants — 4 cinematic sub-modes instead of binary on/off
    #
    # All inject into Block 4 (dynamic, uncached). Profile DNA (Block 1)
    # and Director Notes remain PRIMARY voice authority.
    # ===================================================================

    # --- Approach A: Style Drift Directives ---

    DIRECTIVE_POOL = [
        {"text": "Consider opening with dialogue — let a character's voice set the scene before the narration fills in the environment.",
         "exclude_intents": [], "max_weight": "climactic"},
        {"text": "Try an environmental POV — describe this scene through objects, architecture, weather, or light rather than character interiority.",
         "exclude_intents": ["COMBAT"], "max_weight": "significant"},
        {"text": "Include at least one long sentence (40+ words) that builds momentum without a period, letting the rhythm carry the reader forward.",
         "exclude_intents": [], "max_weight": "climactic"},
        {"text": "Try a cold open — drop the reader mid-action or mid-thought without setup. Let them piece together the context from the scene itself.",
         "exclude_intents": ["SOCIAL"], "max_weight": "minor"},
        {"text": "Narrow to ONE dominant sense (smell, sound, or touch). Let that sense carry the scene while others recede into the background.",
         "exclude_intents": [], "max_weight": "climactic"},
        {"text": "Lean into subtext — the characters feel something they don't say. Let the reader infer emotion from behavior and environment, not narration.",
         "exclude_intents": [], "max_weight": "climactic"},
        {"text": "Shift your sentence rhythm — if recent scenes used short punchy sentences, try long flowing ones. If flowing, try staccato.",
         "exclude_intents": [], "max_weight": "climactic"},
        {"text": "Find one moment of levity, absurdity, or dry humor — even serious scenes have room for a beat of comic relief.",
         "exclude_intents": ["COMBAT"], "max_weight": "significant"},
    ]

    WEIGHT_HIERARCHY = {"minor": 0, "significant": 1, "climactic": 2}

    # --- Approach B: Vocabulary Freshness Patterns ---

    SIMILE_PATTERNS = [
        re.compile(r'(?:like|as)\s+a\s+\w+\s+\w+', re.IGNORECASE),
        re.compile(r'the way (?:a|an|the)\s+\w+\s+\w+', re.IGNORECASE),
        re.compile(r'as (?:if|though)\s+[^.,]{10,40}', re.IGNORECASE),
        re.compile(r'(?:like|as)\s+\w+\s+(?:among|between)', re.IGNORECASE),
    ]

    PERSONIFICATION_PATTERNS = [
        re.compile(r'\b\w+(?:s|ed)\s+(?:apologetically|reluctantly|cheerfully|wearily|patiently|hungrily|angrily|nervously|stubbornly|desperately)', re.IGNORECASE),
        re.compile(r'\b\w+(?:s|ed)\s+(?:with|in)\s+the\s+\w+\s+of', re.IGNORECASE),
    ]

    NEGATION_PATTERN = re.compile(r'Not [^.]{3,40}\. Not [^.]{3,40}\.', re.IGNORECASE)

    FRESHNESS_THRESHOLD = 3  # Only flag constructions appearing 3+ times

    # --- Approach C: Sakuga Priority Ladder ---

    SAKUGA_PRIORITY = [
        ("first_time_power",    "frozen_moment"),
        ("protective_rage",     "frozen_moment"),
        ("named_attack",        "choreographic"),
        ("underdog_moment",     "choreographic"),
        ("power_of_friendship", "choreographic"),
        ("training_payoff",     "montage"),
    ]

    def __init__(self, profile: NarrativeProfile, model_override: Optional[str] = None):
        """Initialize the Key Animator.
        
        Args:
            profile: The narrative profile for this campaign
            model_override: Specific model to use (overrides settings)
        """
        self.profile = profile
        self._model_override = model_override
        self._cached_provider: Optional[LLMProvider] = None
        self._cached_model: Optional[str] = None
        self._vibe_keeper_template: Optional[str] = None
        self._npc_context = None
        self._static_rule_guidance: Optional[str] = None
        # Shuffle-bag for style drift directives
        self._directive_bag: List[Dict[str, Any]] = []
        self._last_directive_text: str = ""
        # Jargon whitelist built from profile
        self._jargon_whitelist = self._build_jargon_whitelist()

    def _build_jargon_whitelist(self) -> set:
        """Build protected vocabulary whitelist from profile YAML fields.
        
        Layer 1: Hard-coded from structured profile fields.
        Layer 2: Dynamic extraction from free-text profile sections.
        """
        whitelist = set()

        # Layer 1: Structured fields
        ps = self.profile.power_system
        if ps and isinstance(ps, dict):
            name = ps.get('name', '')
            if name:
                whitelist.update(name.lower().split())
            tiers = ps.get('tiers', [])
            if isinstance(tiers, list):
                for tier in tiers:
                    whitelist.add(str(tier).lower())
            mechanics = ps.get('mechanics', '')
            if mechanics:
                # Extract capitalized terms from mechanics description
                whitelist.update(w.lower() for w in re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', mechanics))
            limitations = ps.get('limitations', '')
            if limitations:
                whitelist.update(w.lower() for w in re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', limitations))

        # Combat system term
        combat = getattr(self.profile, 'combat_system', '')
        if combat:
            whitelist.add(combat.lower())

        # Layer 2: Author's voice signature phrases
        author_voice = getattr(self.profile, 'author_voice', None)
        if author_voice and isinstance(author_voice, dict):
            for key in ('sentence_patterns', 'structural_motifs', 'dialogue_quirks'):
                items = author_voice.get(key, [])
                if isinstance(items, list):
                    for item in items:
                        whitelist.add(item.lower())

        # Voice field
        voice = getattr(self.profile, 'voice', '')
        if voice:
            whitelist.update(w.lower() for w in re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', voice))

        return whitelist

    def _build_style_drift_directive(self, intent: IntentOutput, outcome: OutcomeOutput, recent_messages: list = None) -> str:
        """Build a per-turn style variation suggestion (Approach A).
        
        Uses a shuffle-bag algorithm for selection, filtered by intent
        and narrative weight. Only injects when working memory shows
        structural repetition.
        
        Returns:
            Style suggestion block, or empty string if variety is sufficient.
        """
        # --- CONDITIONAL INJECTION ---
        # Check if working memory already shows structural variety
        if recent_messages:
            dm_openings = []
            for msg in recent_messages[-6:]:  # Check last 6 messages (3 turns)
                if msg.get("role") == "assistant":
                    content = msg.get("content", "").strip()
                    if content:
                        # Classify opening: dialogue, description, or action
                        first_line = content.split('\n')[0].strip()
                        if first_line.startswith('"') or first_line.startswith('\u201c') or first_line.startswith("'"):
                            dm_openings.append("dialogue")
                        elif any(first_line.startswith(w) for w in ("The ", "A ", "An ", "In ", "Above ", "Below ", "Through ")):
                            dm_openings.append("description")
                        else:
                            dm_openings.append("action")
            
            # If last 3 DM messages show variety (no 2+ of same type), skip directive
            if len(dm_openings) >= 2:
                opening_counts = Counter(dm_openings[-3:])
                if opening_counts.most_common(1)[0][1] < 2:
                    return ""  # Already varied — no directive needed

        # --- NARRATIVE WEIGHT FILTER ---
        current_weight = getattr(outcome, 'narrative_weight', NarrativeWeight.MINOR)
        current_weight_level = self.WEIGHT_HIERARCHY.get(current_weight, 0)

        # --- SHUFFLE-BAG SELECTION ---
        if not self._directive_bag:
            # Refill and shuffle
            self._directive_bag = list(self.DIRECTIVE_POOL)
            random.shuffle(self._directive_bag)

        # Find a compatible directive from the bag
        selected = None
        skipped = []
        while self._directive_bag:
            candidate = self._directive_bag.pop(0)
            
            # Filter: intent exclusion
            if intent.intent in candidate.get("exclude_intents", []):
                skipped.append(candidate)
                continue
            
            # Filter: narrative weight
            max_weight = candidate.get("max_weight", "climactic")
            max_weight_level = self.WEIGHT_HIERARCHY.get(max_weight, 2)
            if current_weight_level > max_weight_level:
                skipped.append(candidate)
                continue
            
            # Filter: don't repeat last directive
            if candidate["text"] == self._last_directive_text:
                skipped.append(candidate)
                continue
            
            selected = candidate
            break
        
        # Return skipped items to bag (they'll be available next turn)
        self._directive_bag.extend(skipped)
        
        if not selected:
            return ""
        
        self._last_directive_text = selected["text"]
        
        return f"""## Style Suggestion (Secondary Layer)
The Profile DNA and Director Notes are your PRIMARY voice authority.
The following is a SECONDARY variation suggestion — apply it lightly,
only where it doesn't conflict with the established tone:

💡 {selected['text']}
"""

    def _build_freshness_check(self, recent_messages: list = None) -> str:
        """Build a vocabulary freshness advisory from working memory (Approach B).
        
        Scans recent DM messages for repeated construction-level patterns
        and suggests fresh alternatives. Respects the jargon whitelist.
        
        Returns:
            Freshness advisory block, or empty string if no significant repetition.
        """
        if not recent_messages:
            return ""
        
        # Collect DM content only
        dm_text = "\n".join(
            msg.get("content", "")
            for msg in recent_messages
            if msg.get("role") == "assistant"
        )
        
        if len(dm_text) < 200:  # Not enough text to analyze
            return ""
        
        # Extract construction-level patterns
        found_constructions: List[str] = []
        
        # Simile constructions
        for pattern in self.SIMILE_PATTERNS:
            matches = pattern.findall(dm_text)
            found_constructions.extend(m.strip().lower() for m in matches)
        
        # Personification patterns
        for pattern in self.PERSONIFICATION_PATTERNS:
            matches = pattern.findall(dm_text)
            found_constructions.extend(m.strip().lower() for m in matches)
        
        # Negation triples
        matches = self.NEGATION_PATTERN.findall(dm_text)
        found_constructions.extend(m.strip().lower() for m in matches)
        
        if not found_constructions:
            return ""
        
        # Count and filter to 3+ threshold
        counts = Counter(found_constructions)
        repeated = [(phrase, count) for phrase, count in counts.most_common(8)
                     if count >= self.FRESHNESS_THRESHOLD]
        
        if not repeated:
            return ""
        
        # Apply jargon whitelist (Layer 3: proper noun immunity handled here too)
        filtered = []
        for phrase, count in repeated:
            # Layer 3: Proper noun immunity — skip if phrase contains capitalized words
            # (we lowercased for counting, but check original)
            original_matches = [m for p in self.SIMILE_PATTERNS + self.PERSONIFICATION_PATTERNS
                               for m in p.findall(dm_text) if m.strip().lower() == phrase]
            has_proper_noun = any(
                any(w[0].isupper() for w in match.split() if len(w) > 1)
                for match in original_matches
            ) if original_matches else False
            
            if has_proper_noun:
                continue
            
            # Layer 1+2: Check against jargon whitelist
            phrase_words = set(phrase.split())
            if phrase_words & self._jargon_whitelist:
                continue
            
            filtered.append((phrase, count))
        
        if not filtered:
            return ""
        
        # Build advisory
        lines = [
            "## Vocabulary Freshness",
            "These constructions have appeared frequently in recent narration.",
            "Find fresh variations — different structures, different imagery:\n"
        ]
        for phrase, count in filtered[:5]:  # Cap at 5 suggestions
            lines.append(f"- \"{phrase}\" (×{count})")
        
        return "\n".join(lines) + "\n"

    def _build_sakuga_injection(self, intent: IntentOutput = None, outcome: OutcomeOutput = None) -> str:
        """Build sakuga mode injection with cinematic sub-mode selection (Approach C).
        
        Selects from 4 sub-modes using a strict priority ladder based on
        special_conditions from intent, with fallback to Choreographic.
        
        Args:
            intent: The classified intent (for special_conditions)
            outcome: The outcome judgment (for narrative_weight + intent-based fallback)
        """
        # --- RESOLVE SUB-MODE ---
        sub_mode = "choreographic"  # Default fallback
        
        if intent and intent.special_conditions:
            conditions = set(intent.special_conditions)
            for condition, mode in self.SAKUGA_PRIORITY:
                if condition in conditions:
                    sub_mode = mode
                    break  # Highest priority wins
        elif intent and outcome:
            # No special_conditions — infer from intent + weight
            weight = getattr(outcome, 'narrative_weight', NarrativeWeight.MINOR)
            if weight == NarrativeWeight.CLIMACTIC:
                if intent.intent == "SOCIAL":
                    sub_mode = "frozen_moment"
                # else stays choreographic
        
        logger.info(f"Sakuga sub-mode: {sub_mode}")
        
        # --- BUILD INJECTION ---
        if sub_mode == "choreographic":
            return """
## 🎬 SAKUGA MODE ACTIVE — Choreographic

This is a CLIMACTIC action moment. Full animation budget:

### Choreography Over Action
- Don't just say "He punched him"
- Describe the shift in weight, the blur of motion, the shockwave of impact
- Treat the text like a storyboard for an animation

### Sensory Overload
- **Visuals:** Lighting changes, color shifts (auras), speed lines
- **Audio:** The sound of breaking bone, the high-pitch whine of energy charging
- **Physical:** The heat, the wind pressure, the vibration

### Pacing Control
- Use short, punchy sentences for speed
- Use long, flowing sentences for buildup
- Use `---` dividers for "impact frame" frozen moments of extreme detail

### No Mechanical Talk
- Never mention HP, damage numbers, or dice
- "Critical Hit" → "A devastating blow that shatters defenses"
- "Miss" → "A hair's breadth dodge, the wind of the attack cutting the cheek"

### Profile Adherence
- Match the power system and visual language of this anime
- Use the DNA scales to calibrate the intensity

"""
        elif sub_mode == "frozen_moment":
            return """
## 🎬 SAKUGA MODE ACTIVE — Frozen Moment

This is a CLIMACTIC emotional moment. Time dilates:

### Time Dilation
- One second, one heartbeat, one decision — stretched across the scene
- Internal monologue dominates. The character THINKS before the world moves
- Sound drops out. Then one detail floods back in — a drip, a breath, a word

### Interiority Over Action
- The external action is secondary. What matters is what this MEANS
- Memory fragments surface unbidden — flashes of why this matters
- The body reacts before the mind catches up: trembling hands, held breath

### Emotional Architecture
- Build in layers: physical sensation → memory → realization → decision
- Let silence carry weight. Not every moment needs words
- The world waits for the character. Then it all crashes back

### Restraint
- No exposition. The reader should FEEL it, not be told about it
- Dialogue is minimal — a single word can be enough
- Match the profile's emotional register, not generic drama

"""
        elif sub_mode == "aftermath":
            return """
## 🎬 SAKUGA MODE ACTIVE — Aftermath

The climax just happened. Now: the silence after the explosion.

### Quiet Devastation
- The action is over. What's LEFT? Describe damage, wreckage, changed landscape
- Sound returns slowly — ringing ears, settling dust, dripping water
- Characters take stock: injuries, losses, what just changed forever

### Environmental Focus
- The WORLD tells the story of what happened. Cracked walls, scorched earth, shifted light
- Small details carry enormous weight: a cracked photograph, a single shoe, smoke rising
- The camera pulls back — show the scale of what occurred

### Emotional Exhaustion
- Characters are spent. Adrenaline crash. Numbness before the grief hits
- Dialogue is sparse, practical. "Can you walk?" Not speeches
- This is where consequences become REAL. Don't rush past the cost

### Bridge Forward
- Plant one seed of what comes next — a distant sound, a new arrival, a realization
- End on an image, not a statement

"""
        else:  # montage
            return """
## 🎬 SAKUGA MODE ACTIVE — Montage

Time compresses. Multiple scenes, one momentum:

### Quick Cuts
- Sentence fragments. Scene changes mid-paragraph
- `---` dividers between moments — each one a snapshot
- Dawn. Training. Noon. Failure. Dusk. Breakthrough. Night. Rest

### Show Progress
- Each cut shows change — improvement, deterioration, accumulation
- Repetition with variation: the same action, done differently each time
- Small victories stack. The montage ends differently than it began

### Sensory Snapshots
- Each beat gets ONE dominant sense — sweat, the sound of impact, the smell of rain
- No lingering. Quick impressions that imprint and move on
- The rhythm matters more than the detail

### Emotional Undercurrent
- Beneath the activity: determination, obsession, fear of failure
- One quiet moment in the middle — the character alone, the reason WHY
- End with arrival: they're ready. Or they think they are

"""
    
    async def _research_phase(
        self,
        player_input: str,
        intent: IntentOutput,
        context: GameContext,
        tools: ToolRegistry,
    ) -> str:
        """Run targeted research using tool-calling before narrative generation.
        
        Delegates to AgenticAgent.research_with_tools() for the fast-model
        tool-calling loop, keeping the same two-model pattern:
        fast model for research, creative model for writing.
        
        Args:
            player_input: The player's action
            intent: Classified intent (for knowing what to research)
            context: Current game context
            tools: The ToolRegistry with gameplay tools
            
        Returns:
            Research findings as formatted text, or empty string on failure
        """
        # Build intent-adaptive research strategy
        # Different intents need different investigation priorities
        intent_strategies = {
            "COMBAT": (
                "COMBAT RESEARCH PRIORITY:\n"
                "1. get_character_sheet — What abilities, level, and combat stats does the protagonist have?\n"
                "2. get_npc_details — If fighting someone, get their full profile (affinity, disposition, secrets)\n"
                "3. search_memory — Search for prior encounters with this enemy or similar combat situations\n"
                "4. get_recent_episodes — What happened in the last few turns leading to this fight?"
            ),
            "SOCIAL": (
                "SOCIAL RESEARCH PRIORITY:\n"
                "1. get_npc_details — Get the FULL profile of any NPC being interacted with (disposition, emotional milestones, secrets)\n"
                "2. search_memory — Search for shared history between protagonist and this NPC\n"
                "3. list_known_npcs — Who else is relevant to this social dynamic?\n"
                "4. search_transcript — Did the player say something earlier this session that relates?"
            ),
            "EXPLORATION": (
                "EXPLORATION RESEARCH PRIORITY:\n"
                "1. get_world_state — What's the current location, situation, and arc phase?\n"
                "2. search_memory — Any established lore about this area or what the player is exploring?\n"
                "3. get_recent_episodes — What led to the player arriving here?\n"
                "4. list_known_npcs — Are there NPCs associated with this place?"
            ),
            "ABILITY": (
                "ABILITY RESEARCH PRIORITY:\n"
                "1. get_character_sheet — What abilities and power level does the protagonist have?\n"
                "2. get_critical_memories — Are there Session Zero facts about this power/ability?\n"
                "3. search_memory — Has this ability been used before? What happened?\n"
                "4. get_world_state — Any environmental factors that affect ability use?"
            ),
            "INVENTORY": (
                "INVENTORY RESEARCH PRIORITY:\n"
                "1. get_character_sheet — What's in inventory, equipped items, power level?\n"
                "2. search_memory — Any established lore about this item or its origin?\n"
                "3. get_world_state — Environmental factors affecting item use?\n"
                "4. get_recent_episodes — Was this item recently acquired or mentioned?"
            ),
        }
        
        # Default strategy for OTHER, WORLD_BUILDING, META_FEEDBACK, etc.
        default_strategy = (
            "GENERAL RESEARCH PRIORITY:\n"
            "1. get_critical_memories — Ground yourself in canonical facts from Session Zero\n"
            "2. get_recent_episodes — What just happened? Maintain continuity\n"
            "3. search_memory — Anything relevant to what the player is doing?\n"
            "4. get_world_state — Current location, situation, arc context"
        )
        
        strategy = intent_strategies.get(intent.intent, default_strategy)
        
        # Build present NPC names if available
        npc_hint = ""
        if context.present_npcs:
            npc_hint = f"\nNPCs currently present in scene: {', '.join(context.present_npcs)}"
        
        research_prompt = f"""You are a narrative researcher preparing context for an anime RPG scene.
Your job: gather ONLY the facts that matter for THIS specific moment, then summarize.

## Current Situation
Player action: "{player_input}"
Intent: {intent.intent} — {intent.action}
Target: {intent.target or 'none'}
Location: {context.location or 'Unknown'}
Situation: {context.situation or 'Unknown'}{npc_hint}

## Investigation Strategy
{strategy}

## Rules
- Be SURGICAL. Only use 2-4 tool calls maximum — pick the ones most relevant to this action.
- SKIP tools that would return information already obvious from the situation above.
- If an NPC is mentioned or present, ALWAYS get their details — disposition and secrets guide narration.
- For combat/ability actions, ALWAYS check the character sheet — power levels matter.
- Do NOT repeat information that's already in the situation context.

## Output Format
After investigating, provide a TIGHT summary:
- **RELEVANT FACTS**: Established canon that affects this scene (from memories or character sheet)
- **NPC INTELLIGENCE**: Disposition, relationship state, secrets for any relevant NPCs
- **CONTINUITY**: What just happened that this scene follows from (only if non-obvious)
- **TACTICAL NOTE**: Any specific detail the narrative writer NEEDS to know (ability limits, environmental factors, unresolved threads)

Omit any section that has nothing useful. Brevity over completeness."""
        
        # Use fast model directly — KeyAnimator doesn't extend AgenticAgent,
        # so we call the provider without the base class wrapper.
        try:
            from ..llm import get_llm_manager
            manager = get_llm_manager()
            fast_provider = manager.fast_provider
            fast_model = manager.get_fast_model()
            
            response = await fast_provider.complete_with_tools(
                messages=[{"role": "user", "content": research_prompt}],
                tools=tools,
                system="You are a concise narrative researcher. Use tools to gather facts, then summarize.",
                model=fast_model,
                max_tokens=2048,
                max_tool_rounds=3,
            )
            
            findings = response.content.strip()
            if findings:
                call_log = tools.call_log
                tool_names = [c.tool_name for c in call_log]
                logger.info(f"Research phase: {len(call_log)} tool calls ({', '.join(tool_names)})")
                logger.info(f"Research findings: {len(findings)} chars")
                return findings
                
        except Exception as e:
            logger.error(f"Research phase failed (non-fatal): {e}")
        
        return ""

    
    async def generate(
        self,
        player_input: str,
        intent: IntentOutput,
        outcome: OutcomeOutput,
        context: GameContext,
        retrieved_context: Optional[dict] = None,
        recent_messages: list = None,
        sakuga_mode: bool = False,
        npc_context: Optional[str] = None,
        tools: Optional[ToolRegistry] = None,
        compaction_text: str = ""
    ) -> str:
        """Generate narrative prose for this turn.
        
        Args:
            player_input: The original player input
            intent: The classified intent
            outcome: The outcome judgment
            context: Current game context
            retrieved_context: RAG context (memories, rules)
            recent_messages: Working memory - last N messages from session (every turn)
            sakuga_mode: If True, inject high-intensity sakuga guidance for climactic moments
            
        Returns:
            Generated narrative prose
        """
        # === AGENTIC RESEARCH PHASE (optional) ===
        # When tools are provided, run a research loop before writing
        research_findings = ""
        if tools:
            research_findings = await self._research_phase(
                player_input=player_input,
                intent=intent,
                context=context,
                tools=tools,
            )
        
        # ===================================================================
        # CACHE-AWARE BLOCK CONSTRUCTION
        # 
        # Split the system prompt into 4 blocks for optimal prefix caching:
        #   Block 1 (STATIC — cached): Template + Profile DNA
        #     Changes: never (loaded once per session)
        #   Block 2 (SEMI-STATIC — cached): Compaction buffer
        #     Changes: only when new micro-summaries are appended (append-only)
        #   Block 3 (SEMI-STATIC — cached): Working memory transcript
        #     Changes: only when sliding window shifts
        #   Block 4 (DYNAMIC — not cached): Scene context, RAG, lore, etc.
        #     Changes: every turn
        #
        # Ordering matters for prefix caching — static content first.
        # ===================================================================
        
        # --- BLOCK 1: Static template + Profile DNA (cache=True) ---
        static_prompt = self.vibe_keeper_template
        static_prompt = static_prompt.replace("{{PROFILE_DNA_INJECTION}}", self._build_profile_dna())
        # Clear dynamic placeholders from the static template — they go in block 3
        static_prompt = static_prompt.replace("{{SCENE_CONTEXT_INJECTION}}", "")
        static_prompt = static_prompt.replace("{{DIRECTOR_NOTES_INJECTION}}", "")
        static_prompt = static_prompt.replace("{{SAKUGA_MODE_INJECTION}}", "")
        static_prompt = static_prompt.replace("{{LORE_INJECTION}}", "")
        static_prompt = static_prompt.replace("{{MEMORIES_INJECTION}}", "")
        static_prompt = static_prompt.replace("{{RETRIEVED_CHUNKS_INJECTION}}", "")
        
        # --- BLOCK 2: Compaction buffer (cache=True) ---
        compaction_block = ""
        if compaction_text:
            compaction_block = f"""
=== NARRATIVE CONTINUITY (Compacted History) ===
These are narrative beats from earlier in the session that are no longer
in the verbatim working memory below. Use for voice matching and continuity.

{compaction_text}

=== END COMPACTED HISTORY ===
"""
            logger.info(f"Injecting compaction buffer ({len(compaction_text)} chars)")
        
        # --- BLOCK 3: Working memory transcript (cache=True) ---
        working_memory_text = ""
        if recent_messages:
            transcript_lines = []
            for msg in recent_messages:
                role = "PLAYER" if msg.get("role") == "user" else "DM"
                content = msg.get("content", "")
                transcript_lines.append(f"[{role}]: {content}")
            
            transcript_text = "\n\n".join(transcript_lines)
            working_memory_text = f"""
=== RECENT CONVERSATION (Working Memory) ===
This is the recent dialogue. Use this for immediate context and continuity.
MATCH the established voice, humor, and style from these exchanges.

{transcript_text}

=== CONTINUE THE STORY ===
"""
            logger.info(f"Injecting working memory ({len(recent_messages)} messages, {len(transcript_text)} chars)")
        
        # --- BLOCK 4: Dynamic per-turn context (cache=False) ---
        dynamic_parts = []
        
        # NPC relationship context (set before building scene context)
        self._npc_context = npc_context
        
        # Scene Context (includes outcome + NPC cards)
        scene_context = self._build_scene_context(context)
        scene_context += "\n\n" + self._build_outcome_section(intent, outcome)
        dynamic_parts.append(f"## Scene Context\n\n{scene_context}")
        
        # Pacing Directive — pre-turn micro-check (#1)
        pacing = retrieved_context.get("pacing_directive") if retrieved_context else None
        if pacing:
            # #3: Strength-aware indicator
            strength = getattr(pacing, 'strength', 'suggestion')
            strength_icon = {"suggestion": "\U0001f4a1", "strong": "\u26a0\ufe0f", "override": "\U0001f6a8"}.get(strength, "\U0001f4a1")
            pacing_text = (
                f"## {strength_icon} Pacing Directive (This Turn) [{strength.upper()}]\n\n"
                f"**Beat**: {pacing.arc_beat} | **Tone**: {pacing.tone} | "
                f"**Escalation**: {pacing.escalation_target:.0%}\n"
            )
            # #3: Phase transition signal
            phase_transition = getattr(pacing, 'phase_transition', '')
            if phase_transition:
                pacing_text += f"**\u26a1 Phase Transition**: {phase_transition}\n"
            if pacing.must_reference:
                pacing_text += f"**Must reference**: {', '.join(pacing.must_reference)}\n"
            if pacing.avoid:
                pacing_text += f"**Avoid**: {', '.join(pacing.avoid)}\n"
            if pacing.foreshadowing_hint:
                pacing_text += f"**Foreshadowing**: {pacing.foreshadowing_hint}\n"
            if pacing.pacing_note:
                pacing_text += f"\n{pacing.pacing_note}\n"
            dynamic_parts.append(pacing_text)
        
        # Director Notes
        director_notes = getattr(context, "director_notes", None) or "(No specific guidance this turn)"
        dynamic_parts.append(f"## Director Notes\n\n{director_notes}")
        
        # NARRATIVE DIVERSITY: Style Drift Directive (Approach A)
        style_directive = self._build_style_drift_directive(intent, outcome, recent_messages)
        if style_directive:
            dynamic_parts.append(style_directive)
            logger.info("Style drift directive injected")
        
        # NARRATIVE DIVERSITY: Vocabulary Freshness (Approach B)
        freshness_check = self._build_freshness_check(recent_messages)
        if freshness_check:
            dynamic_parts.append(freshness_check)
            logger.info(f"Vocabulary freshness advisory injected")
        
        # SAKUGA MODE: Inject variant-aware high-intensity guidance (Approach C)
        if sakuga_mode:
            sakuga_injection = self._build_sakuga_injection(intent, outcome)
            dynamic_parts.append(sakuga_injection)
            logger.info("SAKUGA MODE ACTIVE - injecting high-intensity guidance")
        
        # RAG context (granular)
        memories_text = ""
        chunks_text = ""
        archetype_text = ""
        tension_text = ""
        npc_text = ""
        faction_text = ""
        if retrieved_context:
            if retrieved_context.get("memories"):
                memories_text = retrieved_context["memories"]
            if retrieved_context.get("rules"):
                chunks_text = retrieved_context["rules"]
            if retrieved_context.get("op_mode_guidance") and not self._static_rule_guidance:
                # Fallback: only inject dynamically if not already in Block 1
                archetype_text = f"\n\n## OP Protagonist Mode Active\n\n{retrieved_context['op_mode_guidance']}"
            if retrieved_context.get("tension_guidance"):
                tension_text = f"\n\n## Non-Combat Tension (Power Imbalance High)\n\n{retrieved_context['tension_guidance']}"
            if retrieved_context.get("npc_guidance"):
                npc_text = f"\n\n## Present NPCs (Module 04 Intelligence)\n\n{retrieved_context['npc_guidance']}"
            if retrieved_context.get("faction_guidance"):
                faction_text = f"\n\n{retrieved_context['faction_guidance']}"
            # #13: Rule library structural guidance
            # DNA and genre guidance are in Block 1 (cache-stable) when available.
            # Only inject dynamically as fallback.
            if retrieved_context.get("dna_guidance") and not self._static_rule_guidance:
                faction_text += f"\n\n{retrieved_context['dna_guidance']}"
            if retrieved_context.get("genre_guidance") and not self._static_rule_guidance:
                faction_text += f"\n\n{retrieved_context['genre_guidance']}"
            if retrieved_context.get("scale_guidance"):
                faction_text += f"\n\n{retrieved_context['scale_guidance']}"
            if retrieved_context.get("compatibility_guidance"):
                faction_text += f"\n\n{retrieved_context['compatibility_guidance']}"
            # #17: Active world consequences
            if retrieved_context.get("active_consequences"):
                faction_text += f"\n\n{retrieved_context['active_consequences']}"
            # #23: Pre-resolved combat result
            if retrieved_context.get("combat_result"):
                faction_text += f"\n\n{retrieved_context['combat_result']}"
        
        # Foreshadowing callback opportunities (#9)
        foreshadowing_text = ""
        if retrieved_context and retrieved_context.get("foreshadowing_callbacks"):
            foreshadowing_text = f"\n\n{retrieved_context['foreshadowing_callbacks']}"
        
        # Lore from profile research (canon reference)
        lore_text = ""
        if retrieved_context and retrieved_context.get("lore"):
            lore_text = f"""## 📚 Canon Reference (From Source Material)

{retrieved_context['lore']}

**Use this to ground your narrative:** correct terminology, power system rules, known locations."""
        
        # Research findings from agentic research phase
        if research_findings:
            memories_text = f"## Agentic Research Findings\n\n{research_findings}\n\n" + (memories_text or "")
        
        if lore_text:
            dynamic_parts.append(lore_text)
        dynamic_parts.append(f"## Retrieved Memories\n\n{memories_text or '(No relevant memories)'}")
        dynamic_parts.append(f"## Additional Guidance\n\n{chunks_text + archetype_text + tension_text + npc_text + faction_text + foreshadowing_text or '(No additional guidance)'}")
        
        dynamic_text = "\n\n".join(dynamic_parts)
        
        # --- Build cache-aware system blocks ---
        system_blocks = [
            (static_prompt, True),         # Block 1: template + Profile DNA (cached)
            (compaction_block, True),      # Block 2: compaction buffer (cached)
            (working_memory_text, True),   # Block 3: working memory (cached)
            (dynamic_text, False),         # Block 4: per-turn dynamics (not cached)
        ]
        # Filter out empty blocks
        system_blocks = [(text, cache) for text, cache in system_blocks if text.strip()]
        
        logger.info(f"[KeyAnimator] System blocks: {len(system_blocks)} blocks, "
              f"cached={sum(1 for _, c in system_blocks if c)}, "
              f"total={sum(len(t) for t, _ in system_blocks)} chars")
        
        # Add the player action
        user_message = f"## Player Action\n\n{player_input}\n\n## Write the scene."
        
        # Generate response using provider
        messages = [{"role": "user", "content": user_message}]
        
        # Extended thinking check
        settings = get_settings_store().load()
        use_extended_thinking = settings.extended_thinking
        
        # Adjust temperature for sakuga mode (higher for more creative flair)
        temperature = 0.85 if sakuga_mode else 0.7
        
        response = await self.provider.complete(
            messages=messages,
            system=system_blocks,
            model=self.model,
            max_tokens=8192,  # High limit for full narrative; anthropic_provider adds more if extended_thinking
            temperature=temperature,
            extended_thinking=use_extended_thinking
        )
        
        # Normalize escaped newlines - LLM sometimes outputs literal \n instead of actual newlines
        content = response.content.strip()
        content = content.replace('\\n', '\n')  # Convert escaped newlines to real newlines
        
        return content
