"""
Intent Resolution Agent — Intelligent title disambiguation and profile mapping.

Replaces the brittle if/elif ladder in session_zero.py with an agentic
approach that can search, verify, and reason about user intent.

Flow:
    1. User says "I want to play Dragon Ball Super Super Hero"
    2. Agent searches AniList → gets candidates
    3. Agent verifies the right entry by ID
    4. Agent checks local profiles for existing matches
    5. Agent maps franchise graph if relevant
    6. Returns resolved intent: which profile(s) to use/create

Output:
    IntentResolution — structured result with:
    - resolved_titles: List of (profile_id, anilist_id, canonical_title) tuples
    - composition_type: "single" | "franchise_link" | "cross_ip_blend" | "custom"
    - needs_research: List of titles that need new profile generation
    - disambiguation_needed: Whether to ask the user for clarification
    - disambiguation_options: Options to present to the user
"""

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field

from .base import AgenticAgent
from .intent_resolution_tools import build_intent_resolution_tools

logger = logging.getLogger(__name__)


# ─── Output Schema ───────────────────────────────────────────────────────


class ResolvedTitle(BaseModel):
    """A single resolved title mapping."""
    profile_id: str = Field(description="Local profile ID (e.g., 'dragon_ball_z')")
    anilist_id: int | None = Field(default=None, description="AniList media ID")
    mal_id: int | None = Field(default=None, description="MyAnimeList media ID (consensus)")
    canonical_title: str = Field(description="Canonical display title")
    already_exists: bool = Field(default=False, description="Whether a local profile already exists")
    role: str = Field(default="primary", description="Role in composition: primary, supplementary, flavor")


class DisambiguationOption(BaseModel):
    """An option to present to the user for disambiguation."""
    anilist_id: int = Field(description="AniList media ID")
    title: str = Field(description="Display title")
    format: str | None = Field(default=None, description="Media format (TV, MOVIE, etc.)")
    year: int | None = Field(default=None, description="Start year")
    description: str = Field(default="", description="Brief description for the user")


class IntentResolution(BaseModel):
    """Complete result from the Intent Resolution Agent."""

    # Resolved profile mappings
    resolved_titles: list[ResolvedTitle] = Field(
        default_factory=list,
        description="Resolved title→profile mappings"
    )

    # Composition type
    composition_type: str = Field(
        default="single",
        description="How profiles should be composed: single, franchise_link, cross_ip_blend, custom"
    )

    # Research needed
    needs_research: list[str] = Field(
        default_factory=list,
        description="Titles that need new profile generation (no existing profile found)"
    )

    # Disambiguation
    disambiguation_needed: bool = Field(
        default=False,
        description="Whether user clarification is needed"
    )
    disambiguation_options: list[DisambiguationOption] = Field(
        default_factory=list,
        description="Options to present to user if disambiguation is needed"
    )
    disambiguation_question: str = Field(
        default="",
        description="Question to ask the user for disambiguation"
    )

    # Confidence
    confidence: float = Field(
        default=1.0,
        description="Agent's confidence in the resolution (0.0-1.0)"
    )
    reasoning: str = Field(
        default="",
        description="Brief explanation of how the resolution was determined"
    )


# ─── System Prompt ───────────────────────────────────────────────────────


INTENT_RESOLUTION_PROMPT = """You are the Intent Resolution Agent for an anime RPG system.

Your job: Given a user's anime/manga reference, determine EXACTLY which title(s) they mean
and map them to profiles for the game system.

## Rules

1. ALWAYS search_anilist first to get candidates
2. If there are multiple plausible candidates, use fetch_anilist_by_id to verify the most likely one
3. If the user's input is ambiguous (e.g., "Dragon Ball" could be DB, DBZ, DBS, DBGT),
   use get_franchise_graph to understand the structure, then ask for clarification
4. ALWAYS search_local_profiles to check if a profile already exists
5. Only mark disambiguation_needed=true if you genuinely cannot determine which entry they mean

## Disambiguation Guidelines

- "Dragon Ball" → Ambiguous (5+ distinct series). Ask which one.
- "Naruto" → Usually means the original. Naruto Shippuden is a common sequel. Ask if they want both.
- "Attack on Titan" → Unambiguous (single continuity).
- "Fate" → Very ambiguous (huge franchise). Ask which.
- "One Piece" → Unambiguous.
- If user says "Dragon Ball Super Super Hero" → That's the movie. Match it precisely.

## Composition Types

- "single": User wants one IP (most common)
- "franchise_link": User wants multiple entries from same franchise (e.g., "DBZ and DBS")
- "cross_ip_blend": User wants to mix different IPs (e.g., "Naruto meets Bleach")
- "custom": User wants an original world (no canonical IP)

## Output

After your investigation, provide a JSON summary in this exact format:
{
  "resolved_titles": [...],
  "composition_type": "single|franchise_link|cross_ip_blend|custom",
  "needs_research": [...],
  "disambiguation_needed": true|false,
  "disambiguation_options": [...],
  "disambiguation_question": "...",
  "confidence": 0.0-1.0,
  "reasoning": "..."
}"""


# ─── Agent ───────────────────────────────────────────────────────────────


class IntentResolutionAgent(AgenticAgent):
    """Agentic title resolver using AniList search, franchise graphs, and local profiles.

    Uses the fast model (same as WikiScout) for efficiency.
    The tool loop allows it to iteratively search, verify, and reason.
    """

    agent_name = "intent_resolution"

    def __init__(self, profiles_dir: Path | None = None):
        super().__init__()
        self._profiles_dir = profiles_dir or Path(__file__).parent.parent / "profiles"
        self._tools = build_intent_resolution_tools(profiles_dir=self._profiles_dir)

    @property
    def system_prompt(self) -> str:
        return INTENT_RESOLUTION_PROMPT

    @property
    def output_schema(self) -> type[BaseModel]:
        return IntentResolution

    async def resolve(
        self,
        user_input: str,
        *,
        context: str | None = None,
        max_tool_rounds: int = 5,
    ) -> IntentResolution:
        """Resolve a user's anime/manga reference to canonical profiles.

        Args:
            user_input: The user's raw input (e.g., "Dragon Ball Super Super Hero")
            context: Optional additional context (e.g., "hybrid with Naruto")
            max_tool_rounds: Max tool-call iterations

        Returns:
            IntentResolution with resolved titles, composition type, etc.
        """
        # Build the research prompt
        prompt_parts = [f'Resolve the following anime/manga reference: "{user_input}"']
        if context:
            prompt_parts.append(f"Additional context: {context}")
        prompt_parts.append(
            "Use tools to search, verify, and check local profiles. "
            "Then provide your resolution as JSON."
        )

        research_prompt = "\n\n".join(prompt_parts)

        # Run agentic research with tools
        findings = await self.research_with_tools(
            research_prompt=research_prompt,
            system=INTENT_RESOLUTION_PROMPT,
            max_tool_rounds=max_tool_rounds,
            max_tokens=4096,
        )

        if not findings:
            logger.warning(f"Intent resolution returned no findings for: {user_input}")
            return IntentResolution(
                disambiguation_needed=True,
                disambiguation_question=f"I couldn't find any results for '{user_input}'. Could you try a different title?",
                confidence=0.0,
                reasoning="No results from search tools",
            )

        # Parse the agent's JSON output
        return self._parse_resolution(findings, user_input)

    def _parse_resolution(self, findings: str, original_input: str) -> IntentResolution:
        """Parse the agent's text findings into a structured IntentResolution."""
        # Try to extract JSON from the findings
        try:
            # Look for JSON block in the response
            json_start = findings.find("{")
            json_end = findings.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                json_str = findings[json_start:json_end]
                data = json.loads(json_str)

                # --- Coerce mixed-type LLM output before Pydantic validates ---

                # resolved_titles: LLM sometimes returns plain strings instead of dicts
                raw_titles = data.get("resolved_titles", [])
                coerced_titles = []
                for rt in raw_titles:
                    if isinstance(rt, str):
                        # Plain string → minimal ResolvedTitle dict
                        coerced_titles.append({
                            "profile_id": rt.lower().replace(" ", "_"),
                            "canonical_title": rt,
                            "already_exists": True,
                        })
                    elif isinstance(rt, dict):
                        coerced_titles.append(rt)
                if raw_titles:
                    data["resolved_titles"] = coerced_titles

                # needs_research: LLM sometimes returns dicts instead of strings
                raw_research = data.get("needs_research", [])
                coerced_research = []
                for nr in raw_research:
                    if isinstance(nr, dict):
                        # Extract title string from common keys
                        title_str = (
                            nr.get("title")
                            or nr.get("canonical_title")
                            or nr.get("profile_id")
                            or original_input
                        )
                        coerced_research.append(str(title_str))
                    elif isinstance(nr, str):
                        coerced_research.append(nr)
                data["needs_research"] = coerced_research

                # disambiguation_question: LLM sometimes returns None
                if data.get("disambiguation_question") is None:
                    data["disambiguation_question"] = ""

                return IntentResolution(**data)
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            logger.warning(f"Failed to parse resolution JSON: {e}")

        # Fallback: create a basic resolution from the text
        logger.info(f"Using fallback parsing for resolution of: {original_input}")
        return self._fallback_parse(findings, original_input)

    def _fallback_parse(self, findings: str, original_input: str) -> IntentResolution:
        """Create a basic IntentResolution when JSON parsing fails."""
        # The agent gave us text but not valid JSON — extract what we can
        findings_lower = findings.lower()

        # Check for disambiguation signals
        if any(word in findings_lower for word in ["ambiguous", "multiple", "which one", "clarify"]):
            return IntentResolution(
                disambiguation_needed=True,
                disambiguation_question=f"Which version of '{original_input}' did you mean?",
                confidence=0.3,
                reasoning=f"Fallback parse from agent findings: {findings[:200]}",
            )

        # Check for "not found" signals
        if any(word in findings_lower for word in ["no results", "not found", "couldn't find"]):
            return IntentResolution(
                needs_research=[original_input],
                confidence=0.5,
                reasoning=f"Title not found in AniList, may need direct research: {findings[:200]}",
            )

        # Check for profile-found signals — agent found it but couldn't format JSON correctly
        if any(sig in findings_lower for word in ["profile_id", "already_exists", "profile found",
                                                   "local profile", "existing profile", "found in profiles"]
               for sig in [word]):
            # Build a best-effort resolved title from the input
            profile_id = original_input.lower().replace(" ", "_")[:80]
            logger.info(f"Fallback: profile-found signal detected, treating as resolved: {profile_id}")
            return IntentResolution(
                resolved_titles=[
                    ResolvedTitle(
                        profile_id=profile_id,
                        canonical_title=original_input,
                        already_exists=True,
                    )
                ],
                composition_type="single",
                confidence=0.6,
                reasoning=f"Fallback: profile-found signal in agent text; {findings[:200]}",
            )

        # Default: assume single title, needs research
        return IntentResolution(
            needs_research=[original_input],
            confidence=0.5,
            reasoning=f"Could not extract structured resolution; defaulting to research: {findings[:200]}",
        )

    async def resolve_hybrid(
        self,
        titles: list[str],
        *,
        max_tool_rounds: int = 8,
    ) -> IntentResolution:
        """Resolve multiple titles for a hybrid/blend session.

        Args:
            titles: List of anime/manga titles to combine
            max_tool_rounds: Max tool-call iterations

        Returns:
            IntentResolution with all titles resolved and composition type set
        """
        prompt_parts = [
            f"Resolve the following {len(titles)} anime/manga titles for a HYBRID session:",
        ]
        for i, title in enumerate(titles, 1):
            prompt_parts.append(f"  {i}. {title}")
        prompt_parts.append(
            "\nSearch and verify EACH title. Check if local profiles exist for each. "
            "Determine if this is a franchise_link (same franchise) or cross_ip_blend "
            "(different IPs). Set appropriate roles and weights."
        )

        findings = await self.research_with_tools(
            research_prompt="\n".join(prompt_parts),
            system=INTENT_RESOLUTION_PROMPT,
            max_tool_rounds=max_tool_rounds,
            max_tokens=4096,
        )

        if not findings:
            return IntentResolution(
                needs_research=titles,
                composition_type="cross_ip_blend",
                confidence=0.3,
                reasoning="Could not resolve hybrid titles through search",
            )

        resolution = self._parse_resolution(findings, " × ".join(titles))

        # Ensure composition type is appropriate for multi-title
        if len(titles) > 1 and resolution.composition_type == "single":
            resolution.composition_type = "cross_ip_blend"

        return resolution
