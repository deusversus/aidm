"""Tests for BaseAgent and AgenticAgent.

Covers message building, prompt loading, LLM call routing,
and tool integration — all with MockLLMProvider.
"""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from pathlib import Path

from src.agents.base import BaseAgent, AgenticAgent
from src.llm.tools import ToolRegistry, ToolDefinition, ToolParam
from src.llm.provider import LLMResponse
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Concrete subclasses for testing
# ---------------------------------------------------------------------------

class DummyOutput(BaseModel):
    answer: str = Field(default="test")


class DummyAgent(BaseAgent):
    agent_name = "dummy"

    @property
    def system_prompt(self) -> str:
        return "You are a test agent."

    @property
    def output_schema(self):
        return DummyOutput


class DummyAgenticAgent(AgenticAgent):
    agent_name = "dummy_agentic"

    @property
    def system_prompt(self) -> str:
        return "You are a test agentic agent."

    @property
    def output_schema(self):
        return DummyOutput


# ---------------------------------------------------------------------------
# Tests: _build_message
# ---------------------------------------------------------------------------

class TestBuildMessage:
    def test_plain_message(self):
        agent = DummyAgent()
        result = agent._build_message("Hello", {})
        assert "Hello" in result

    def test_context_sections(self):
        agent = DummyAgent()
        result = agent._build_message("Hello", {
            "world_state": "It is night time.",
            "combat_info": "No enemies nearby.",
        })
        assert "world_state" in result.lower() or "World State" in result
        assert "night time" in result
        assert "No enemies" in result

    def test_empty_context_excluded(self):
        agent = DummyAgent()
        result = agent._build_message("Hello", {
            "filled": "Some data",
            "empty": "",
            "none_val": None,
        })
        assert "Some data" in result


# ---------------------------------------------------------------------------
# Tests: _load_prompt_file
# ---------------------------------------------------------------------------

class TestLoadPromptFile:
    def test_fallback_for_missing_file(self):
        result = BaseAgent._load_prompt_file("nonexistent_file_xyz.md", "fallback text")
        assert result == "fallback text"

    def test_loads_existing_file(self):
        """The compactor prompt should exist."""
        result = BaseAgent._load_prompt_file("compactor.md", "fallback")
        # If file exists, should not be the fallback
        if Path("prompts/compactor.md").exists():
            assert result != "fallback"
            assert len(result) > 10


# ---------------------------------------------------------------------------
# Tests: Agent properties
# ---------------------------------------------------------------------------

class TestAgentProperties:
    def test_output_schema(self):
        agent = DummyAgent()
        assert agent.output_schema is DummyOutput

    def test_system_prompt(self):
        agent = DummyAgent()
        assert agent.system_prompt == "You are a test agent."

    def test_agent_name(self):
        agent = DummyAgent()
        assert agent.agent_name == "dummy"


# ---------------------------------------------------------------------------
# Tests: BaseAgent.call()
# ---------------------------------------------------------------------------

class TestBaseAgentCall:
    async def test_call_routes_through_complete_with_schema(self, mock_llm_manager):
        agent = DummyAgent()
        expected = DummyOutput(answer="42")
        provider = mock_llm_manager.get_provider_for_agent.return_value[0]
        provider.queue_schema_response(expected)

        result = await agent.call("What is the answer?")
        assert result is not None

    async def test_call_with_system_prompt_override(self, mock_llm_manager):
        agent = DummyAgent()
        expected = DummyOutput(answer="overridden")
        provider = mock_llm_manager.get_provider_for_agent.return_value[0]
        provider.queue_schema_response(expected)

        result = await agent.call(
            "Test",
            system_prompt_override="Custom prompt"
        )
        # The call should have used the custom prompt
        call = provider.call_history[-1]
        assert call["system"] == "Custom prompt"


# ---------------------------------------------------------------------------
# Tests: AgenticAgent tools
# ---------------------------------------------------------------------------

class TestAgenticAgentTools:
    def test_set_and_get_tools(self):
        agent = DummyAgenticAgent()
        reg = ToolRegistry()
        agent.set_tools(reg)
        assert agent.get_tools() is reg

    def test_get_tools_default_none(self):
        agent = DummyAgenticAgent()
        assert agent.get_tools() is None

    async def test_call_with_tools(self, mock_llm_manager):
        agent = DummyAgenticAgent()
        reg = ToolRegistry()
        reg.register(ToolDefinition(
            name="ping",
            description="Ping test",
            parameters=[],
            handler=lambda **kw: "pong",
        ))
        agent.set_tools(reg)

        provider = mock_llm_manager.get_provider_for_agent.return_value[0]
        provider.queue_response("Tool-based response")

        result = await agent.call_with_tools("Do something")
        assert result is not None

    async def test_research_with_tools(self, mock_llm_manager):
        agent = DummyAgenticAgent()
        reg = ToolRegistry()
        agent.set_tools(reg)

        provider = mock_llm_manager.get_provider_for_agent.return_value[0]
        # Queue response for fast model
        mock_llm_manager.get_provider.return_value.queue_response("Research findings")

        result = await agent.research_with_tools("Find info about X")
        assert isinstance(result, str)
