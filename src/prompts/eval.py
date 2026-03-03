"""Prompt eval harness — lightweight regression testing for prompt changes.

Run golden fixtures against live agents to detect regressions when prompts change.
Fixtures are JSON files with input + expected structural traits (not exact match).

CLI: python -m src.prompts.eval --agent director --fixture fixtures/director_basic.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .registry import get_registry

logger = logging.getLogger(__name__)

# ── Fixture Schema ───────────────────────────────────────────────────

@dataclass
class Fixture:
    """A golden test case for a prompt/agent."""
    agent: str
    description: str
    input_text: str
    context: dict[str, str] = field(default_factory=dict)
    expected: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_file(cls, path: Path) -> "Fixture":
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            agent=data["agent"],
            description=data.get("description", path.stem),
            input_text=data["input"],
            context=data.get("context", {}),
            expected=data.get("expected", {}),
        )


@dataclass
class AssertionResult:
    """Result of a single trait assertion."""
    trait: str
    passed: bool
    detail: str = ""


@dataclass
class FixtureResult:
    """Result of running a single fixture."""
    fixture: Fixture
    prompt_hash: str
    assertions: list[AssertionResult] = field(default_factory=list)
    output: Any = None
    error: str | None = None
    elapsed_ms: int = 0

    @property
    def passed(self) -> bool:
        return self.error is None and all(a.passed for a in self.assertions)


# ── Trait Assertions ─────────────────────────────────────────────────

def check_trait(output: Any, trait_name: str, trait_value: Any) -> AssertionResult:
    """Check a single trait assertion against agent output.

    Supported traits:
    - has_field: field exists and is non-empty
    - field_gte: field value >= expected
    - field_in: field value in expected list
    - field_type: field is of expected type
    - output_contains: output string contains substring
    - field_matches: field value matches expected exactly
    """
    try:
        if trait_name == "has_field":
            # trait_value is a field name that should be non-empty
            if hasattr(output, trait_value):
                val = getattr(output, trait_value)
                ok = val is not None and val != "" and val != []
            elif isinstance(output, dict) and trait_value in output:
                val = output[trait_value]
                ok = val is not None and val != "" and val != []
            else:
                ok = False
            return AssertionResult(
                f"has_field({trait_value})", ok,
                f"{'present' if ok else 'missing or empty'}"
            )

        if trait_name.endswith("_gte"):
            field_name = trait_name[:-4]
            val = _get_field(output, field_name)
            ok = val is not None and val >= trait_value
            return AssertionResult(
                f"{field_name} >= {trait_value}", ok,
                f"actual={val}"
            )

        if trait_name.endswith("_in"):
            field_name = trait_name[:-3]
            val = _get_field(output, field_name)
            ok = val in trait_value
            return AssertionResult(
                f"{field_name} in {trait_value}", ok,
                f"actual={val}"
            )

        if trait_name == "output_contains":
            text = str(output)
            ok = trait_value.lower() in text.lower()
            return AssertionResult(
                f"output_contains({trait_value})", ok,
                f"{'found' if ok else 'not found'}"
            )

        if trait_name.endswith("_matches"):
            field_name = trait_name[:-8]
            val = _get_field(output, field_name)
            ok = val == trait_value
            return AssertionResult(
                f"{field_name} == {trait_value}", ok,
                f"actual={val}"
            )

        return AssertionResult(trait_name, False, f"Unknown trait type: {trait_name}")

    except Exception as e:
        return AssertionResult(trait_name, False, f"Error: {e}")


def _get_field(obj: Any, field_name: str) -> Any:
    """Get a field from a Pydantic model or dict."""
    if hasattr(obj, field_name):
        return getattr(obj, field_name)
    if isinstance(obj, dict):
        return obj.get(field_name)
    return None


# ── Runner ───────────────────────────────────────────────────────────

async def run_fixture(fixture: Fixture) -> FixtureResult:
    """Run a single fixture against a live agent."""
    registry = get_registry()
    prompt_hash = registry.get_hash(fixture.agent) if fixture.agent in registry.list_names() else "unknown"

    result = FixtureResult(fixture=fixture, prompt_hash=prompt_hash)

    try:
        # Dynamic agent import — maps agent names to classes
        agent = _get_agent(fixture.agent)
        if agent is None:
            result.error = f"Agent '{fixture.agent}' not found"
            return result

        start = time.time()
        output = await agent.call(fixture.input_text, **fixture.context)
        result.elapsed_ms = int((time.time() - start) * 1000)
        result.output = output

        # Run trait assertions
        for trait_name, trait_value in fixture.expected.items():
            result.assertions.append(check_trait(output, trait_name, trait_value))

    except Exception as e:
        result.error = str(e)

    return result


async def run_fixtures(fixture_dir: Path, agent_filter: str | None = None) -> list[FixtureResult]:
    """Run all fixtures in a directory."""
    results = []
    for path in sorted(fixture_dir.glob("*.json")):
        fixture = Fixture.from_file(path)
        if agent_filter and fixture.agent != agent_filter:
            continue
        result = await run_fixture(fixture)
        results.append(result)
    return results


def _get_agent(name: str):
    """Get an agent instance by name."""
    try:
        from src.agents import (
            compactor, combat, director, key_animator,
            outcome_judge, pacing_agent, production_agent,
            recap_agent, scope, validator,
        )
        agents = {
            "compactor": compactor.CompactorAgent,
            "combat": combat.CombatAgent,
            "director": director.DirectorAgent,
            "key_animator": key_animator.KeyAnimatorAgent,
            "outcome_judge": outcome_judge.OutcomeJudge,
            "pacing": pacing_agent.PacingAgent,
            "production": production_agent.ProductionAgent,
            "recap": recap_agent.RecapAgent,
            "scope": scope.ScopeAgent,
            "validator": validator.ValidatorAgent,
        }
        cls = agents.get(name)
        return cls() if cls else None
    except Exception as e:
        logger.error(f"Failed to load agent '{name}': {e}")
        return None


# ── CLI ──────────────────────────────────────────────────────────────

def format_results(results: list[FixtureResult]) -> str:
    """Format results for terminal output."""
    lines = []
    passed = sum(1 for r in results if r.passed)
    total = len(results)

    lines.append(f"\n{'='*60}")
    lines.append(f"  Prompt Eval Results: {passed}/{total} passed")
    lines.append(f"{'='*60}\n")

    for r in results:
        icon = "✓" if r.passed else "✗"
        lines.append(f"  {icon} {r.fixture.agent}/{r.fixture.description}")
        lines.append(f"    Prompt hash: {r.prompt_hash[:16]}...")
        lines.append(f"    Elapsed: {r.elapsed_ms}ms")

        if r.error:
            lines.append(f"    ERROR: {r.error}")
        else:
            for a in r.assertions:
                a_icon = "✓" if a.passed else "✗"
                lines.append(f"    {a_icon} {a.trait}: {a.detail}")
        lines.append("")

    return "\n".join(lines)


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Prompt eval harness")
    parser.add_argument("--agent", type=str, help="Filter by agent name")
    parser.add_argument("--fixture", type=str, help="Run a single fixture file")
    parser.add_argument(
        "--fixtures-dir", type=str, default="fixtures",
        help="Directory containing fixture JSON files"
    )
    args = parser.parse_args()

    if args.fixture:
        fixture = Fixture.from_file(Path(args.fixture))
        results = asyncio.run(asyncio.gather(run_fixture(fixture)))
    else:
        fixture_dir = Path(args.fixtures_dir)
        if not fixture_dir.exists():
            print(f"Fixtures directory '{fixture_dir}' not found")
            sys.exit(1)
        results = asyncio.run(run_fixtures(fixture_dir, args.agent))

    print(format_results(results))

    # Exit with error code if any failed
    if not all(r.passed for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
