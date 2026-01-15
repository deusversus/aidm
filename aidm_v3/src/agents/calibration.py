from typing import Dict, List, Optional, Type
from pydantic import BaseModel, Field
import json
import yaml

from src.agents.base import BaseAgent
import logging

logger = logging.getLogger(__name__)

class CalibrationResult(BaseModel):
    """Result of a character calibration check."""
    approved: bool
    calibration_score: float = Field(..., description="0.0 to 1.0 fit score")
    rejection_reason: Optional[str] = None
    suggested_archetype: Optional[str] = None
    generated_stats: Dict[str, int] = Field(default_factory=dict)
    narrative_goals: List[str] = Field(default_factory=list)
    starting_abilities: List[str] = Field(default_factory=list)

class StyleGuide(BaseModel):
    """Instructional guide for the GM Agent."""
    system_prompt_snippet: str
    key_mechanics: List[str]
    tone_instructions: str

class CalibrationAgent(BaseAgent):
    """
    Agent responsible for:
    1. Calibrating Player Characters against the Narrative Profile.
    2. Mapping 'Anime Logic' (Profile) to 'Game Mechanics' (Stats).
    3. Generating 'Style Guides' for the GM based on Tropes.
    """
    
    agent_name: str = "CalibrationAgent"

    def __init__(self, settings: Optional[dict] = None):
        super().__init__()
        # self.settings = settings # BaseAgent handles settings differently now

    @property
    def system_prompt(self) -> str:
        return "You are an expert Game Master and Anime Analyst. Your goal is to ensure characters fit the genre and logic of their respective worlds."

    @property
    def output_schema(self) -> Type[BaseModel]:
        return CalibrationResult

    async def calibrate_character(self, player_concept: str, profile_data: Dict) -> CalibrationResult:
        """
        Validates if a character concept fits the anime profile and generates stats.
        
        Args:
            player_concept: The user's text description (e.g., "I want to be a Ninja who uses bugs").
            profile_data: The parsed YAML profile (e.g., Naruto or Death Note).
        """
        print(f"DEBUG ARG TYPES: concept={type(player_concept)}, profile={type(profile_data)}")
        print(f"DEBUG PROFILE CONTENT: {str(profile_data)[:100]}")
        
        anime_title = profile_data.get('title', profile_data.get('name', 'Unknown'))
        logger.info(f"[{self.agent_name}] Calibrating concept: '{player_concept[:50]}...' against '{anime_title}'")

        # Construct the Prompt
        # We need to feed the Profile DNA (Tone, Power System, Tropes) into the LLM
        # and ask it to Judge and Generate.
        
        profile_context = f"""
        Anime Title: {profile_data.get('title')}
        Tone: {profile_data.get('tone', {})}
        Power System: {profile_data.get('power_system', {})}
        Tropes: {profile_data.get('tropes', {})}
        DNA Scales: {profile_data.get('dna_scales', {})}
        """

        prompt = f"""
        You are the Gatekeeper and System Architect for a Tabletop RPG based on the anime '{profile_data.get('title')}'.
        
        Your Job:
        1. VALIDATE: Does the player's concept fit the Tone and Power System?
           - Reject "Wizards" in Sci-Fi.
           - Reject "Silly Clowns" in Grimdark (unless specifically allowed).
           - Reject "Overpowered Gods" if the power scale is low.
        2. MAP MECHANICS: If approved, translate the concept into Game Stats (0-100 scale) based on the Power System.
           - Identify 3-5 core stats relevant to this anime (e.g., Chakra, Ninjutsu, Taijutsu for Naruto; Int, Social, Willpower for Death Note).
        3. DEFINE GOALS: Extract 1-3 narrative goals.

        Player Concept: "{player_concept}"

        Profile Context:
        {profile_context}

        Output JSON matching this schema:
        {{
            "approved": boolean,
            "calibration_score": float (0.0-1.0),
            "rejection_reason": "string or null",
            "suggested_archetype": "string (e.g. 'Aburame Clan Ninja')",
            "generated_stats": {{ "stat_name": value }},
            "narrative_goals": ["goal1", "goal2"],
            "starting_abilities": ["ability1", "ability2"]
        }}
        """

        try:
            # We use json_mode=True if available, or just rely on the provider
            # Using standard complete for now
            messages = [{"role": "user", "content": prompt}]
            response = await self.provider.complete(messages=messages)
            response_text = response.content
            
            # Clean and parse JSON
            try:
                data = self._clean_json(response_text)
                return CalibrationResult(**data)
            except Exception as e:
                logger.warning(f"JSON Parse Error: {e}. Attempting repair...")
                repaired = await self._repair_json(response_text, CalibrationResult, str(e))
                if repaired:
                    return repaired
                raise e
            
        except Exception as e:
            logger.error(f"[{self.agent_name}] Calibration failed: {e}")
            return CalibrationResult(
                approved=False, 
                calibration_score=0.0, 
                rejection_reason=f"System Error: {e}"
            )

    async def generate_style_guide(self, profile_data: Dict) -> StyleGuide:
        """
        Generates a concise Style Guide (System Prompt) for the GM Agent based on the Profile.
        """
        logger.info(f"[{self.agent_name}] Generating Style Guide for '{profile_data.get('title')}'")
        
        prompt = f"""
        Analyze this Anime Profile and generate a "Director's Style Guide".
        This guide will be injected into the GM AI's system prompt to ensure it runs the game correctly.

        Profile Data:
        Title: {profile_data.get('title')}
        Tropes: {profile_data.get('tropes')}
        Tone: {profile_data.get('tone')}
        Pacing: {profile_data.get('pacing')}

        Output JSON matching this schema:
        {{
            "system_prompt_snippet": "A concise paragraph (max 100 words) describing how the GM should narrate, handle failure, and reward players.",
            "key_mechanics": ["List of 3-5 short rules like 'Allow Talk-no-Jutsu resolution' or 'Enforce strict ammo tracking'"],
            "tone_instructions": "One sentence summary of the vibe (e.g. 'Optimistic shonen adventure with tragic backstories')."
        }}
        Do not use markdown code blocks if possible, just raw JSON.
        """
        
        try:
            messages = [{"role": "user", "content": prompt}]
            response = await self.provider.complete(messages=messages)
            response_text = response.content
            
            try:
                data = self._clean_json(response_text)
                return StyleGuide(**data)
            except Exception as e:
                logger.warning(f"StyleGuide JSON Error: {e}. Attempting repair...")
                repaired = await self._repair_json(response_text, StyleGuide, str(e))
                if repaired:
                    return repaired
                raise e
                
        except Exception as e:
            logger.error(f"Generate Style Guide failed: {e}")
            return StyleGuide(
                system_prompt_snippet="Error generating guide.", 
                key_mechanics=[], 
                tone_instructions="Error."
            )

    async def _repair_json(self, text: str, schema: Type[BaseModel], error: str) -> Optional[BaseModel]:
        """Attempt to repair broken JSON using ValidatorAgent."""
        from src.agents.validator import ValidatorAgent
        validator = ValidatorAgent()
        return await validator.repair_json(text, schema, str(error))

    def _clean_json(self, text: str) -> dict:
        """Simple cleanup for markdown code blocks"""
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0]
        elif "```" in text:
            text = text.split("```")[1].split("```")[0]
        return json.loads(text.strip())
