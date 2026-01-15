from typing import Dict, Any, Optional, Tuple
from .base import BaseAgent
from ..core.turn import Turn

class SakugaAgent(BaseAgent):
    """
    Specialized agent for high-intensity, visually descriptive narrative generation ("Sakuga").
    Used when the outcome involves combat or high epicness levels.
    """

    @property
    def agent_name(self) -> str:
        return "sakuga"  # Uses sakuga model config from settings

    @property
    def system_prompt(self) -> str:
        with open("prompts/sakuga.md", "r", encoding="utf-8") as f:
            return f.read()

    @property
    def output_schema(self) -> Optional[Any]:
        return None  # Returns raw text string

    async def generate_scene(self, turn: Turn, context: Dict[str, Any]) -> str:
        """
        Generate a 'sakuga' style narrative scene based on the turn outcome.
        """
        # Prepare template variables
        variables = {
            "{{PROFILE_NAME}}": context.get("profile_name", "Unknown"),
            "{{CHARACTER_NAME}}": context.get("character_name", "Player"),
            "{{PLAYER_INTENT}}": turn.intent.intent if turn.intent else "Unknown action",
            "{{OUTCOME}}": f"{turn.outcome.success_level} (Weight: {turn.outcome.narrative_weight})",
            "{{SITUATION_SUMMARY}}": f"Location: {context.get('location')}. Status: {context.get('status', 'Combat')}"
        }

        # User message focuses on the specific action resolution
        user_message_content = (
            f"Action: {turn.input_text}\n"
            f"Result: {turn.outcome.success_level}\n"
            f"Details: {turn.outcome.consequence}\n\n"
            "Animate this scene."
        )

        # Get creative model (Sakuga needs the best model available)
        # Use our own provider (which is key_animator's provider)
        provider = self.provider
        # Force creative model if we can, Sakuga deserves it
        creative_model = provider.get_creative_model()
        
        # Build prompt using base method logic (but we do it manually to ensure variable injection)
        system_prompt = self._inject_variables(self.system_prompt, variables)
        
        # Use simple complete since we strictly want text
        response = await provider.complete(
            messages=[{"role": "user", "content": user_message_content}],
            system=system_prompt,
            model=creative_model,
            max_tokens=8192,  # High limit for full narrative (was defaulting to 1024!)
            temperature=0.85  # Slightly higher temp for creativity/flair
        )

        return response.content

    def _inject_variables(self, template: str, variables: Dict[str, str]) -> str:
        for key, value in variables.items():
            template = template.replace(key, str(value))
        return template
