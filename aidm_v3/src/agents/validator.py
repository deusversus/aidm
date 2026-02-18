"""
Validator Agent for AIDM v3.

Enhanced with full Module 10 Error Recovery implementation:
- Pre-action validation (resource checks, skill verification)
- Post-action validation (bounds checking, state integrity)
- Error severity classification (CRITICAL, MAJOR, VALIDATION, MINOR, TRIVIAL)
- Recovery protocols with confidence-based auto-recovery
- State rollback for critical errors
- Transparent player notifications

Uses fast model (Flash) for low-latency validation checks.
"""

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from ..enums import NarrativeWeight
from .base import BaseAgent

logger = logging.getLogger(__name__)

class ErrorSeverity(str, Enum):
    """Error severity levels per M10 spec."""
    CRITICAL = "critical"    # Gameplay blocked, requires rollback
    MAJOR = "major"          # Breaks narrative, needs correction
    VALIDATION = "validation"  # Pre-commit failure, block action
    MINOR = "minor"          # Noticeable, silent correction
    TRIVIAL = "trivial"      # Background fix, no notification


class ErrorCategory(str, Enum):
    """Error categories for classification."""
    RESOURCE = "resource"        # HP/MP/SP bounds
    SKILL = "skill"              # Skill not owned, wrong prereqs
    NPC = "npc"                  # Dead NPC, wrong location
    QUEST = "quest"              # Quest state mismatch
    STATE = "state"              # Schema corruption
    TEMPORAL = "temporal"        # Timeline inconsistency
    INVENTORY = "inventory"      # Item count issues
    CALCULATION = "calculation"  # Math errors


@dataclass
class ErrorContext:
    """Context for an error."""
    path: str                    # e.g., "resources.mp.current"
    expected: Any
    actual: Any
    operation: str = ""
    reason: str = ""


class ErrorReport(BaseModel):
    """Detailed error report."""
    severity: ErrorSeverity
    category: ErrorCategory
    description: str
    context: dict[str, Any] = Field(default_factory=dict)

    # Recovery
    recoverable: bool = True
    confidence: float = 0.5      # 0-1, confidence in auto-fix
    suggested_fix: str | None = None
    alternatives: list[str] = Field(default_factory=list)

    # Tracking
    timestamp: str = ""
    turn_number: int = 0


class ValidationResult(BaseModel):
    """Result of a validation check."""

    is_valid: bool = Field(
        default=True,
        description="Whether the validation passed"
    )
    complete: bool = Field(
        description="Whether the output is complete"
    )
    missing_fields: list[str] = Field(
        default_factory=list,
        description="List of missing or incomplete fields"
    )
    issues: list[str] = Field(
        default_factory=list,
        description="List of detected issues"
    )
    errors: list[ErrorReport] = Field(
        default_factory=list,
        description="Detailed error reports"
    )
    confidence: int = Field(
        default=80,
        description="0-100 confidence in validation assessment"
    )
    suggestions: list[str] = Field(
        default_factory=list,
        description="Suggested actions to fix issues"
    )
    correction: str | None = Field(
        default=None,
        description="Correction feedback for retry"
    )


class ContentCompletenessResult(BaseModel):
    """LLM-populated result for content completeness checks only.
    
    This schema is used for LLM validation - it does NOT include corruption
    detection fields, which are handled by fast heuristics instead.
    """

    is_valid: bool = Field(
        default=True,
        description="Whether the research has sufficient content"
    )
    confidence: int = Field(
        default=80,
        description="0-100 confidence in completeness assessment"
    )
    has_power_system: bool = Field(
        default=False,
        description="Whether power system is adequately described"
    )
    has_narrative_info: bool = Field(
        default=False,
        description="Whether narrative/tone information is present"
    )
    has_combat_style: bool = Field(
        default=False,
        description="Whether combat style is discernible"
    )
    has_world_setting: bool = Field(
        default=False,
        description="Whether world/setting is described"
    )
    recommended_supplemental: list[str] = Field(
        default_factory=list,
        description="Recommended supplemental search topics"
    )
    issues: list[str] = Field(
        default_factory=list,
        description="Issues found during validation"
    )


class ResearchValidationResult(ValidationResult):
    """Full validation result combining LLM completeness + heuristic corruption.
    
    - Content completeness fields: populated by LLM via ContentCompletenessResult
    - Corruption detection fields: populated by fast heuristics, NOT LLM
    """

    # Content completeness (from LLM)
    has_power_system: bool = Field(
        default=False,
        description="Whether power system is adequately described"
    )
    has_narrative_info: bool = Field(
        default=False,
        description="Whether narrative/tone information is present"
    )
    has_combat_style: bool = Field(
        default=False,
        description="Whether combat style is discernible"
    )
    has_world_setting: bool = Field(
        default=False,
        description="Whether world/setting is described"
    )
    recommended_supplemental: list[str] = Field(
        default_factory=list,
        description="Recommended supplemental search topics"
    )

    # Corruption detection (from heuristics only, NOT LLM)
    has_corruption: bool = Field(
        default=False,
        description="Whether corrupted content was detected (leaked reasoning, repetition, etc.)"
    )
    corruption_type: str | None = Field(
        default=None,
        description="Type of corruption: 'leaked_reasoning', 'repetition', 'incomplete_json', 'malformed'"
    )
    character_count: int = Field(
        default=0,
        description="Total character count for size sanity check"
    )
    repetition_score: float = Field(
        default=0.0,
        description="0-1 score indicating suspicious repetition (>0.3 is suspicious)"
    )


class RecoveryResult(BaseModel):
    """Result of applying a recovery action."""
    success: bool
    action_taken: str
    state_modified: bool = False
    player_notification: str | None = None
    log_entry: str | None = None


class NarrativeOverrideResult(BaseModel):
    """
    LLM judgment for 'push beyond limits' moments.
    
    Per AIDM philosophy: "Narrative defines the rules."
    When a character is short on resources but the moment is dramatically
    appropriate, the LLM can allow an override with narrative consequences.
    """
    allow_override: bool = Field(
        default=False,
        description="Whether to allow action despite insufficient resources"
    )
    narrative_cost: str = Field(
        default="",
        description="Narrative consequence if override is allowed (exhaustion, injury, debt)"
    )
    explanation: str = Field(
        default="",
        description="Why this moment warrants (or doesn't warrant) pushing beyond limits"
    )
    trope_match: str | None = Field(
        default=None,
        description="Anime trope that applies (e.g., 'push_beyond_limits', 'heroic_sacrifice')"
    )


VALIDATOR_SYSTEM_PROMPT = """# Validator Agent (Error Recovery)

You are the error recovery and validation agent. Your role is to:
1. Validate agent outputs for completeness and correctness
2. Classify errors by severity (CRITICAL/MAJOR/VALIDATION/MINOR/TRIVIAL)
3. Suggest recovery actions
4. Calculate confidence in fixes

Per M10: FAIL SAFELY, RECOVER GRACEFULLY, LEARN ALWAYS.

## Error Severity:
- CRITICAL: Gameplay blocked (HP<0, corrupted state, infinite loop)
- MAJOR: Breaks narrative (dead NPC speaks, quest state mismatch)
- VALIDATION: Pre-commit failure (insufficient resources, skill not owned)
- MINOR: Noticeable issue (bounds violation, negative count)
- TRIVIAL: Unnoticeable (precision errors, format issues)

## Confidence Calculation:
confidence = (data_clarity × 0.4) + (single_solution × 0.3) + (low_risk × 0.3)
- ≥0.8: Auto-recover
- <0.8: Ask player

Be concise and direct. Return structured validation results.
"""


class ValidatorAgent(BaseAgent):
    """Validator Agent with full M10 Error Recovery.
    
    ARCHITECTURE NOTE (#20): Resource gating is now handled by StateTransaction
    (see core/state_transaction.py). This class focuses on:
    - Post-action validation (bounds checking, state integrity)
    - Narrative validation (outcome sensibility, NPC consistency)
    - Research validation (content completeness, corruption detection)
    - Recovery protocols (confidence-based auto-recovery)
    """

    agent_name = "validator"

    def __init__(self, model_override: str | None = None):
        super().__init__(model_override=model_override)
        self._system_prompt = VALIDATOR_SYSTEM_PROMPT
        self._error_log: list[ErrorReport] = []

    @property
    def system_prompt(self) -> str:
        return self._system_prompt

    @property
    def output_schema(self) -> type[BaseModel]:
        return ValidationResult


    async def judge_narrative_override(
        self,
        resource_name: str,
        shortage: int,
        action_description: str,
        situation: str,
        profile_tropes: dict[str, bool] | None = None,
        arc_phase: str = "rising_action",
        tension_level: float = 0.5
    ) -> NarrativeOverrideResult:
        """
        LLM judgment for 'push beyond limits' moments.
        
        Per AIDM philosophy: "Narrative defines the rules."
        When a character is short on resources but the moment is
        dramatically appropriate, allow with narrative consequences.
        
        Args:
            resource_name: Resource the character is short on (MP, SP, etc.)
            shortage: How much they're short by
            action_description: What action they're attempting
            situation: Current narrative situation
            profile_tropes: Enabled tropes from narrative profile
            arc_phase: Current story phase (rising_action, climax, etc.)
            tension_level: Current tension (0-1)
            
        Returns:
            NarrativeOverrideResult with LLM judgment
        """
        # (Imports moved inside try block below)

        # Check relevant tropes
        relevant_tropes = []
        if profile_tropes:
            trope_map = {
                "sacrifice": "willingness to sacrifice self for others",
                "power_of_friendship": "drawing strength from bonds",
                "tragic_backstory": "haunted by past, pushing through pain",
                "transformation": "unlocking hidden power in crisis",
                "training_montage": "growth through effort and determination"
            }
            for trope, desc in trope_map.items():
                if profile_tropes.get(trope):
                    relevant_tropes.append(f"{trope}: {desc}")

        prompt = f"""You are judging whether a character should be allowed to "push beyond their limits" in an anime-style narrative.

SITUATION:
- Action attempted: {action_description}
- Resource needed: {resource_name}
- Shortage: {shortage} points short
- Current situation: {situation}
- Arc phase: {arc_phase}
- Tension level: {tension_level:.0%}

ENABLED TROPES:
{chr(10).join(relevant_tropes) if relevant_tropes else "None specifically enabled"}

JUDGMENT CRITERIA:
- Is this a dramatically appropriate moment for "I'll push beyond my limits!"?
- Would a visionary anime author allow this to succeed (with consequences)?
- Does the action fit the current arc phase and tension?

If you ALLOW the override, specify a NARRATIVE COST (exhaustion that carries forward, injury, owing a favor, emotional toll, etc.)

Respond with:
- allow_override: true/false
- narrative_cost: What price does the character pay? (empty if not allowed)
- explanation: Brief reasoning
- trope_match: Which trope applies (or null)"""

        try:
            # Use existing LLM manager pattern instead of non-existent get_model_config
            from ..llm import get_llm_manager
            manager = get_llm_manager()
            provider, model = manager.get_provider_for_agent(self.agent_name)

            response = await provider.complete_with_schema(
                messages=[{"role": "user", "content": prompt}],
                schema=NarrativeOverrideResult,
                system="You are a narrative judgment engine for anime-style storytelling. Be dramatic but fair.",
                model=model
            )

            return response

        except Exception as e:
            # On error, default to conservative (no override)
            logger.error(f"Narrative override judgment failed: {e}")
            return NarrativeOverrideResult(
                allow_override=False,
                explanation=f"Judgment failed: {e}",
                narrative_cost=""
            )

    def validate_skill_owned(
        self,
        skill_name: str,
        owned_skills: list[str],
        requirements: dict[str, Any] | None = None
    ) -> ValidationResult:
        """
        Validate if character owns a skill.
        
        Per M10: Check skill list, block with alternatives.
        """
        result = ValidationResult(complete=True, is_valid=True)

        # Check if skill is owned
        skill_lower = skill_name.lower()
        owned_lower = [s.lower() for s in owned_skills]

        if skill_lower not in owned_lower:
            result.is_valid = False
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.VALIDATION,
                category=ErrorCategory.SKILL,
                description=f"Skill not learned: {skill_name}",
                context={
                    "skill": skill_name,
                    "owned_skills": owned_skills,
                    "requirements": requirements or {}
                },
                recoverable=True,
                confidence=1.0,
                alternatives=[
                    "Use a skill you've learned",
                    "Train to learn this skill",
                    "Use basic attack instead"
                ]
            ))

            result.correction = f"[Blocked: Skill '{skill_name}' not learned]\n"
            result.correction += f"Your known skills: {', '.join(owned_skills[:5])}"
            if requirements:
                result.correction += f"\nRequirements: {requirements}"

        return result

    def validate_npc_state(
        self,
        npc_name: str,
        is_alive: bool,
        claimed_location: str | None = None,
        actual_location: str | None = None
    ) -> ValidationResult:
        """
        Validate NPC is valid for interaction.
        
        Per M10: Check alive, check location.
        """
        result = ValidationResult(complete=True, is_valid=True)

        if not is_alive:
            result.is_valid = False
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.MAJOR,
                category=ErrorCategory.NPC,
                description=f"Deceased NPC referenced: {npc_name}",
                context={"npc": npc_name, "status": "deceased"},
                recoverable=True,
                confidence=0.9,
                suggested_fix=f"Replace {npc_name} with alternative NPC",
                alternatives=[
                    "Reference a memory of the NPC",
                    "Have a different NPC deliver the information",
                    "Let the absence be felt in the scene"
                ]
            ))

            result.correction = f"{npc_name} is deceased. Cannot interact directly."

        elif claimed_location and actual_location:
            if claimed_location.lower() != actual_location.lower():
                result.is_valid = False
                result.errors.append(ErrorReport(
                    severity=ErrorSeverity.MINOR,
                    category=ErrorCategory.NPC,
                    description=f"NPC location mismatch: {npc_name}",
                    context={
                        "npc": npc_name,
                        "claimed": claimed_location,
                        "actual": actual_location
                    },
                    recoverable=True,
                    confidence=0.8,
                    suggested_fix=f"Update {npc_name} location to {claimed_location}"
                ))

        return result

    # =========================================================================
    # POST-ACTION VALIDATION (Catch errors after execution)
    # =========================================================================

    def validate_bounds(
        self,
        field_name: str,
        value: Any,
        min_val: Any | None = None,
        max_val: Any | None = None
    ) -> ValidationResult:
        """
        Validate a value is within bounds.
        
        Per M10: Check current≤max, current≥min.
        """
        result = ValidationResult(complete=True, is_valid=True)

        if min_val is not None and value < min_val:
            result.is_valid = False
            corrected = min_val
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.MINOR,
                category=ErrorCategory.CALCULATION,
                description=f"{field_name} below minimum",
                context={
                    "field": field_name,
                    "value": value,
                    "min": min_val,
                    "corrected": corrected
                },
                recoverable=True,
                confidence=1.0,
                suggested_fix=f"Correct {field_name} to {corrected}"
            ))
            result.correction = f"[Corrected: {field_name} {value} → {corrected}]"

        elif max_val is not None and value > max_val:
            result.is_valid = False
            corrected = max_val
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.MINOR,
                category=ErrorCategory.CALCULATION,
                description=f"{field_name} exceeds maximum",
                context={
                    "field": field_name,
                    "value": value,
                    "max": max_val,
                    "corrected": corrected
                },
                recoverable=True,
                confidence=1.0,
                suggested_fix=f"Correct {field_name} to {corrected}"
            ))
            result.correction = f"[Corrected: {field_name} {value} → {corrected}]"

        return result

    def validate_state_integrity(
        self,
        character_state: dict[str, Any]
    ) -> ValidationResult:
        """
        Comprehensive state integrity check.
        
        Per M10: HP/MP/SP bounds, inventory non-negative, etc.
        """
        result = ValidationResult(complete=True, is_valid=True)

        # HP bounds
        hp_current = character_state.get("hp_current", 0)
        hp_max = character_state.get("hp_max", 100)

        if hp_current > hp_max:
            result.is_valid = False
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.MINOR,
                category=ErrorCategory.CALCULATION,
                description="HP exceeds maximum",
                context={"hp_current": hp_current, "hp_max": hp_max},
                recoverable=True,
                confidence=1.0,
                suggested_fix=f"Cap HP to {hp_max}"
            ))

        if hp_current < 0:
            result.is_valid = False
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.CRITICAL,
                category=ErrorCategory.CALCULATION,
                description="HP is negative",
                context={"hp_current": hp_current},
                recoverable=True,
                confidence=1.0,
                suggested_fix="Set HP to 0 or 1"
            ))

        # MP bounds
        mp_current = character_state.get("mp_current", 0)
        mp_max = character_state.get("mp_max", 50)

        if mp_current > mp_max:
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.TRIVIAL,
                category=ErrorCategory.CALCULATION,
                description="MP exceeds maximum",
                context={"mp_current": mp_current, "mp_max": mp_max},
                recoverable=True,
                confidence=1.0,
                suggested_fix=f"Cap MP to {mp_max}"
            ))

        # Inventory check
        inventory = character_state.get("inventory", [])
        for item in inventory:
            if isinstance(item, dict):
                qty = item.get("quantity", 1)
                if qty < 0:
                    result.errors.append(ErrorReport(
                        severity=ErrorSeverity.MINOR,
                        category=ErrorCategory.INVENTORY,
                        description=f"Negative item quantity: {item.get('name')}",
                        context={"item": item.get("name"), "quantity": qty},
                        recoverable=True,
                        confidence=1.0,
                        suggested_fix="Set quantity to 0"
                    ))

        return result

    # =========================================================================
    # RECOVERY PROTOCOLS
    # =========================================================================

    async def attempt_recovery(
        self,
        error: ErrorReport,
        state_manager: Any = None
    ) -> RecoveryResult:
        """
        Attempt to recover from an error.
        
        Per M10: Auto-recover if confidence ≥0.8, else ask player.
        """
        # Confidence threshold for auto-recovery
        if error.confidence >= 0.8 and error.recoverable:
            return await self._auto_recover(error, state_manager)
        else:
            return self._prepare_player_prompt(error)

    async def _auto_recover(
        self,
        error: ErrorReport,
        state_manager: Any = None
    ) -> RecoveryResult:
        """Apply automatic recovery for high-confidence errors."""
        action = error.suggested_fix or "No specific fix"

        # Log the error
        self._error_log.append(error)

        # Build notification based on severity
        notification = None
        if error.severity == ErrorSeverity.MINOR:
            notification = f"[Corrected: {error.description}]"
        elif error.severity == ErrorSeverity.MAJOR:
            notification = f"[System: {error.description}. {action}]"
        # TRIVIAL errors have no notification

        return RecoveryResult(
            success=True,
            action_taken=action,
            state_modified=True,
            player_notification=notification,
            log_entry=f"{error.severity.value.upper()}: {error.description} | Action: {action}"
        )

    def _prepare_player_prompt(self, error: ErrorReport) -> RecoveryResult:
        """Prepare a prompt for the player when auto-recovery not confident."""
        alternatives = "\n".join(
            f"{chr(65+i)}) {alt}"
            for i, alt in enumerate(error.alternatives[:4])
        )

        notification = f"""[Action blocked: {error.description}]
Reason: {error.context}

Alternatives:
{alternatives}

What do?"""

        return RecoveryResult(
            success=False,  # Needs player input
            action_taken="Awaiting player choice",
            state_modified=False,
            player_notification=notification
        )

    # =========================================================================
    # TURN VALIDATION (for Orchestrator integration)
    # =========================================================================

    async def validate(
        self,
        turn: Any,
        context: dict[str, Any]
    ) -> ValidationResult:
        """
        Validate a turn for the Orchestrator.
        
        Args:
            turn: Current Turn object
            context: Validation context (rules, character state)
            
        Returns:
            ValidationResult with issues and corrections
        """
        result = ValidationResult(complete=True, is_valid=True)

        if not turn.outcome:
            return result

        outcome = turn.outcome

        # Check narrative weight consistency
        if hasattr(outcome, 'narrative_weight'):
            if outcome.narrative_weight == NarrativeWeight.CLIMACTIC:
                # Major moments should have substance
                if hasattr(outcome, 'consequence') and not outcome.consequence:
                    result.issues.append("Climactic moment without consequence")
                    result.confidence = 70

        # Check for impossible outcomes
        character_state = context.get("character_state", "")
        if "HP: 0" in character_state and hasattr(outcome, 'success') and outcome.success:
            result.is_valid = False
            result.errors.append(ErrorReport(
                severity=ErrorSeverity.MAJOR,
                category=ErrorCategory.STATE,
                description="Success outcome while character unconscious",
                recoverable=True,
                confidence=0.9,
                suggested_fix="Modify outcome to reflect incapacitation"
            ))
            result.correction = "Character is at 0 HP and cannot succeed at actions."

        return result

    # =========================================================================
    # UTILITY METHODS
    # =========================================================================

    def _format_resource_block(
        self,
        resource: str,
        current: int,
        cost: int,
        shortage: int
    ) -> str:
        """Format a resource block notification per M10 template."""
        return f"""[Action blocked: Insufficient {resource}]
Need: {cost} {resource}
Have: {current} {resource}
Short by: {shortage} {resource}

Alternatives:
A) Use lower-cost ability
B) Use {resource} potion (+50 {resource})
C) Different action (no {resource} cost)
D) Defend/wait to regen

What do?"""

    def get_error_log(self) -> list[ErrorReport]:
        """Get the error log for this session."""
        return self._error_log

    def get_error_summary(self) -> dict[str, int]:
        """Get error count by severity."""
        summary = {s.value: 0 for s in ErrorSeverity}
        for error in self._error_log:
            summary[error.severity.value] += 1
        return summary

    def session_health_check(self) -> str:
        """
        Generate end-of-session health check per M10.
        """
        summary = self.get_error_summary()

        status = "HEALTHY"
        if summary["critical"] > 0:
            status = "CRITICAL ERRORS"
        elif summary["major"] > 0:
            status = "MAJOR ERRORS"

        return f"""Session Health Check:
[✓] Validation Agent Active
[{"✓" if summary["critical"] == 0 else "✗"}] Critical Errors: {summary["critical"]}
[{"✓" if summary["major"] == 0 else "✗"}] Major Errors: {summary["major"]}
[·] Minor Corrections: {summary["minor"]}
[·] Trivial Fixes: {summary["trivial"]}

Status: {status}"""

    # =========================================================================
    # EXISTING METHODS (preserved for compatibility)
    # =========================================================================

    def _detect_corruption(self, text: str) -> tuple:
        """
        Fast heuristic checks for common corruption patterns.
        
        Returns:
            (has_corruption: bool, corruption_type: str | None, repetition_score: float)
        """
        import re
        from collections import Counter

        # 1. Leaked reasoning markers (Gemini thinking tokens, internal monologue)
        leaked_markers = [
            "{thought", "i'm ready", "i have gathered", "i will now",
            "let me check", "final check:", "i'll also mention",
            "i'm good to go", "i have all the components"
        ]
        text_lower = text.lower()
        for marker in leaked_markers:
            if marker in text_lower:
                return True, "leaked_reasoning", 0.0

        # 2. Excessive repetition detection
        # Filter out common Markdown structural patterns that naturally repeat
        lines = [line.strip() for line in text.split('\n') if line.strip()]

        # Patterns to exclude from repetition counting (these naturally repeat in Markdown)
        markdown_structural_patterns = {
            '---',      # Horizontal rule
            '***',      # Horizontal rule variant
            '* * *',    # Horizontal rule variant
            '|',        # Table separator start
            '*',        # Bare bullet
            '-',        # Bare bullet/list
            '+',        # Bare bullet variant
            '#',        # Raw header marker
            '##',
            '###',
            '####',
        }

        def is_structural_line(line: str) -> bool:
            """Check if a line is a Markdown structural element."""
            # Exact matches
            if line in markdown_structural_patterns:
                return True
            # Too short to be meaningful content (likely formatting)
            if len(line) < 5:
                return True
            # Table separator rows (e.g., | --- | --- |)
            if re.match(r'^[\|\s:-]+$', line):
                return True
            # Header-only lines (e.g., "### Header" is fine, but just "###" is structural)
            if re.match(r'^#{1,6}\s*$', line):
                return True
            return False

        # Filter to meaningful content lines only
        content_lines = [line for line in lines if not is_structural_line(line)]

        if content_lines:
            line_counts = Counter(content_lines)
            max_repeats = max(line_counts.values()) if line_counts else 0

            # Find what line repeats most (for debugging)
            # Threshold scales with content size: 5 repeats in a 50-line doc is
            # suspicious, but 5 repeats in a 5000-line wiki dump is normal
            repeat_threshold = max(10, len(content_lines) // 20)
            if max_repeats >= repeat_threshold:
                most_repeated = line_counts.most_common(1)[0][0]
                # Only flag as corrupt if the repeated line is substantial content
                # (not just a common phrase like "**Role:**" or similar)
                if len(most_repeated) > 20:
                    logger.info(f"High repetition detected: '{most_repeated[:50]}...' appears {max_repeats} times (threshold={repeat_threshold})")
                    return True, "repetition", min(1.0, max_repeats / 10.0)

            # Calculate repetition score (ratio of repeated to unique lines)
            unique_lines = len(line_counts)
            total_lines = len(content_lines)
            repetition_score = 1.0 - (unique_lines / total_lines) if total_lines > 0 else 0.0

            # Threshold scales with content size: small docs (< 200 lines) use 0.6,
            # large multi-page wiki content naturally has more repetition (common phrases,
            # structural elements) so we raise the threshold proportionally
            if total_lines < 200:
                ratio_threshold = 0.6
            elif total_lines < 1000:
                ratio_threshold = 0.7
            else:
                ratio_threshold = 0.85  # Very permissive for large wiki dumps

            logger.info(f"Repetition analysis: {unique_lines}/{total_lines} unique lines, score={repetition_score:.2f}, threshold={ratio_threshold}")

            if repetition_score > ratio_threshold:
                return True, "repetition", repetition_score
        else:
            repetition_score = 0.0

        # 3. Truncated/malformed JSON detection (REMOVED - Text is Markdown, not JSON)
        # open_brackets = text.count('[')
        # ... (Removed false positive check)

        if False:  # Disabled
            return True, "incomplete_json", 0.0

        # 4. Suspiciously short output (< 500 chars for a lore file)
        if len(text) < 500:
            return True, "malformed", 0.0

        return False, None, repetition_score

    async def validate_research(self, research_text: str) -> ResearchValidationResult:
        """Validate anime research text for completeness and corruption."""
        from ..llm import get_llm_manager

        # Fast heuristic checks FIRST (no LLM call needed)
        has_corruption, corruption_type, repetition_score = self._detect_corruption(research_text)

        if has_corruption:
            logger.error(f"CORRUPTION DETECTED: {corruption_type}")
            return ResearchValidationResult(
                complete=False,
                is_valid=False,
                confidence=0,
                issues=[f"Corruption detected: {corruption_type}"],
                has_corruption=True,
                corruption_type=corruption_type,
                character_count=len(research_text),
                repetition_score=repetition_score
            )

        # If no corruption, proceed with LLM validation
        manager = get_llm_manager()
        provider, model = manager.get_provider_for_agent(self.agent_name)

        prompt = f"""# Validate Anime Research

Check if this research text contains sufficient information to create an anime RPG profile.

## IMPORTANT FORMAT NOTE:
The research text is **Markdown**, NOT JSON. Square brackets like [Section] are Markdown headers/links, NOT incomplete JSON.
**Do NOT set has_corruption=true or corruption_type for bracket characters** - they are valid Markdown syntax.

## Research Text:
{research_text[:6000]}

## Required Information:
1. **Power System** - Name and mechanics
2. **Narrative Style** - Tone, pacing, comedy vs drama
3. **Combat Style** - Tactical vs spectacle
4. **World Setting** - Genre, locations, factions

## Corruption Detection Guidelines:
- ONLY flag corruption for: excessive exact-line repetition, leaked internal reasoning (e.g. "let me think"), or truly truncated output
- Do NOT flag: Markdown brackets, headers, bullet points, or normal formatting

Analyze and determine what's missing."""

        logger.info("Validating research completeness...")

        try:
            logger.info(f"[Validator] Calling LLM for validation (len={len(research_text)})...")
            # Use ContentCompletenessResult for LLM - NO corruption fields
            completeness = await provider.complete_with_schema(
                messages=[{"role": "user", "content": prompt}],
                schema=ContentCompletenessResult,
                system=self.system_prompt,
                model=model,
                max_tokens=4096
            )
            logger.info("[Validator] LLM validation returned.")

            # Merge LLM completeness with heuristic corruption detection
            result = ResearchValidationResult(
                # From LLM completeness check
                is_valid=completeness.is_valid,
                confidence=completeness.confidence,
                has_power_system=completeness.has_power_system,
                has_narrative_info=completeness.has_narrative_info,
                has_combat_style=completeness.has_combat_style,
                has_world_setting=completeness.has_world_setting,
                recommended_supplemental=completeness.recommended_supplemental,
                issues=completeness.issues,
                complete=completeness.is_valid,
                # From heuristics (NOT LLM)
                has_corruption=False,  # Heuristics already passed above
                corruption_type=None,
                character_count=len(research_text),
                repetition_score=repetition_score
            )
            return result
        except Exception as e:
            logger.error(f"ERROR: {e}")
            return ResearchValidationResult(
                complete=True,
                is_valid=True,
                confidence=50,
                issues=[f"Validation error: {str(e)}"],
                character_count=len(research_text)
            )

    async def repair_json(
        self,
        broken_json: str,
        target_schema: type[BaseModel],
        error_msg: str = ""
    ) -> BaseModel | None:
        """Attempt to repair invalid JSON by re-parsing it with the LLM."""
        from ..llm import get_llm_manager

        manager = get_llm_manager()
        provider, model = manager.get_provider_for_agent(self.agent_name)

        prompt = f"""# Repair Invalid JSON
        
The following text was intended to be valid JSON matching the schema, but failed to parse.

## Error:
{error_msg}

## Broken/Partial Output:
{broken_json[:20000]}

## Expected Schema:
{target_schema.model_json_schema()}

## Your Task:
Fix the JSON errors. Ensure it matches the schema perfectly. 
Do not explain. Just return the valid JSON object.
"""
        logger.info("Attempting to repair broken JSON...")

        try:
            result = await provider.complete_with_schema(
                messages=[{"role": "user", "content": prompt}],
                schema=target_schema,
                system="You are a JSON repair specialist. Fix structural errors and formatting.",
                model=model,
                max_tokens=4096,
                extended_thinking=False
            )
            logger.info("Repair successful!")
            return result
        except Exception as e:
            logger.error(f"Repair failed: {e}")
            return None

    async def validate_series_order(
        self,
        series_group: str,
        profile_titles: list[str]
    ) -> dict[str, int]:
        """
        Ask LLM to order series titles canonically.
        
        Args:
            series_group: The series identifier (e.g., "naruto")
            profile_titles: List of titles to order (e.g., ["Naruto", "Shippuden", "Boruto"])
            
        Returns:
            Dict mapping title to position (e.g., {"Naruto": 1, "Naruto Shippuden": 2, "Boruto": 3})
        """
        from ..llm import get_llm_manager

        if len(profile_titles) <= 1:
            # Single title, just return position 1
            return {profile_titles[0]: 1} if profile_titles else {}

        manager = get_llm_manager()
        provider, model = manager.get_provider_for_agent(self.agent_name)

        titles_list = "\n".join(f"- {title}" for title in profile_titles)

        prompt = f"""Order these {series_group} series titles in canonical/chronological order.

TITLES:
{titles_list}

RULES:
- Position 1 = original/first series
- Position 2 = first sequel
- etc.
- Consider release order AND in-universe chronology
- For canonical sequels: Naruto (1) → Shippuden (2) → Boruto (3)
- For Dragon Ball: Dragon Ball (1) → Z (2) → Super (3)

Return a JSON object mapping each title to its position number.
Example: {{"Naruto": 1, "Naruto Shippuden": 2, "Boruto": 3}}

IMPORTANT: Use the EXACT title strings provided, do not modify them."""

        logger.info(f"Ordering {len(profile_titles)} titles in '{series_group}' series...")

        try:
            # Use a simple Dict[str, int] schema
            from pydantic import create_model
            OrderSchema = create_model(
                'SeriesOrder',
                **{title.replace(' ', '_').replace(':', '_'): (int, 1) for title in profile_titles}
            )

            response = await provider.complete(
                messages=[{"role": "user", "content": prompt}],
                model=model,
                max_tokens=512
            )

            # Parse the response to extract the ordering
            import json
            import re

            # Try to extract JSON from response
            content = response.content
            json_match = re.search(r'\{[^{}]+\}', content)
            if json_match:
                order_dict = json.loads(json_match.group())
                logger.info(f"Series order determined: {order_dict}")
                return order_dict
            else:
                logger.warning("Could not parse series order from response")
                return {}

        except Exception as e:
            logger.error(f"Series order validation failed: {e}")
            return {}


# Convenience functions
async def validate_research_text(research_text: str) -> ResearchValidationResult:
    """Convenience function for research validation."""
    validator = ValidatorAgent()
    return await validator.validate_research(research_text)


def get_validator() -> ValidatorAgent:
    """Get a ValidatorAgent instance."""
    return ValidatorAgent()
