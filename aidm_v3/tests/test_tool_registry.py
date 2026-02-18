"""Tests for the ToolRegistry and related types.

Covers:
- Registration and lookup
- Execution (success and error paths)
- JSON schema generation
- Provider format conversion (Anthropic, OpenAI)
"""

import pytest
from src.llm.tools import ToolRegistry, ToolDefinition, ToolParam, ToolResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _echo_tool(**kwargs):
    """Handler that returns its kwargs."""
    return kwargs


def _add_tool(a: int, b: int) -> int:
    return a + b


def _explosive_tool(**kwargs):
    raise RuntimeError("boom")


def _make_echo_definition():
    return ToolDefinition(
        name="echo",
        description="Echoes arguments back",
        parameters=[
            ToolParam(name="message", type="string", description="Message to echo"),
        ],
        handler=_echo_tool,
    )


def _make_add_definition():
    return ToolDefinition(
        name="add",
        description="Adds two numbers",
        parameters=[
            ToolParam(name="a", type="integer", description="First number"),
            ToolParam(name="b", type="integer", description="Second number"),
        ],
        handler=_add_tool,
    )


def _make_explosive_definition():
    return ToolDefinition(
        name="explode",
        description="Always fails",
        parameters=[],
        handler=_explosive_tool,
    )


# ---------------------------------------------------------------------------
# Tests: Registration
# ---------------------------------------------------------------------------

class TestToolRegistration:
    def test_register_and_get(self):
        reg = ToolRegistry()
        tool = _make_echo_definition()
        reg.register(tool)
        assert reg.get("echo") is tool

    def test_get_missing_returns_none(self):
        reg = ToolRegistry()
        assert reg.get("nonexistent") is None

    def test_all_tools(self):
        reg = ToolRegistry()
        reg.register(_make_echo_definition())
        reg.register(_make_add_definition())
        assert len(reg.all_tools()) == 2

    def test_overwrite_on_re_register(self):
        reg = ToolRegistry()
        tool1 = _make_echo_definition()
        tool2 = ToolDefinition(
            name="echo",
            description="New echo",
            parameters=[],
            handler=lambda **kw: "new",
        )
        reg.register(tool1)
        reg.register(tool2)
        assert reg.get("echo") is tool2


# ---------------------------------------------------------------------------
# Tests: Execution
# ---------------------------------------------------------------------------

class TestToolExecution:
    def test_execute_success(self):
        reg = ToolRegistry()
        reg.register(_make_add_definition())
        result = reg.execute("add", {"a": 3, "b": 5})
        assert isinstance(result, ToolResult)
        assert result.result == 8
        assert result.error is None

    def test_execute_kwargs_handler(self):
        """Handlers using **kwargs must receive arguments correctly."""
        reg = ToolRegistry()
        reg.register(_make_echo_definition())
        result = reg.execute("echo", {"message": "hello"})
        assert result.result == {"message": "hello"}
        assert result.error is None

    def test_execute_captures_handler_error(self):
        reg = ToolRegistry()
        reg.register(_make_explosive_definition())
        result = reg.execute("explode", {})
        assert result.error is not None
        assert "boom" in result.error

    def test_execute_unknown_tool(self):
        reg = ToolRegistry()
        result = reg.execute("ghost", {})
        assert result.error is not None

    def test_call_log(self):
        reg = ToolRegistry()
        reg.register(_make_add_definition())
        reg.execute("add", {"a": 1, "b": 2}, round_number=1)
        reg.execute("add", {"a": 3, "b": 4}, round_number=2)
        log = reg.call_log
        assert len(log) == 2
        assert log[0].round_number == 1
        assert log[1].round_number == 2


# ---------------------------------------------------------------------------
# Tests: ToolResult
# ---------------------------------------------------------------------------

class TestToolResult:
    def test_to_string_success(self):
        result = ToolResult(tool_name="add", arguments={"a": 1}, result=42)
        text = result.to_string()
        assert "42" in text

    def test_to_string_error(self):
        result = ToolResult(tool_name="add", arguments={}, result=None, error="failed")
        text = result.to_string()
        assert "failed" in text.lower() or "error" in text.lower()


# ---------------------------------------------------------------------------
# Tests: ToolDefinition helpers
# ---------------------------------------------------------------------------

class TestToolDefinitionHelpers:
    def test_get_required_params(self):
        """get_required_params returns List[str] (parameter names)."""
        tool = ToolDefinition(
            name="test",
            description="test",
            parameters=[
                ToolParam(name="req", type="string", description="required", required=True),
                ToolParam(name="opt", type="string", description="optional", required=False),
            ],
            handler=lambda **kw: None,
        )
        required = tool.get_required_params()
        optional = tool.get_optional_params()
        assert required == ["req"]
        assert optional == ["opt"]


# ---------------------------------------------------------------------------
# Tests: Provider format conversion
# ---------------------------------------------------------------------------

class TestProviderFormats:
    @pytest.fixture
    def loaded_registry(self):
        reg = ToolRegistry()
        reg.register(ToolDefinition(
            name="search",
            description="Search for documents",
            parameters=[
                ToolParam(name="query", type="string", description="Search query"),
                ToolParam(name="limit", type="integer", description="Max results", required=False, default=10),
            ],
            handler=lambda **kw: [],
        ))
        return reg

    def test_anthropic_format(self, loaded_registry):
        fmt = loaded_registry.to_anthropic_format()
        assert len(fmt) == 1
        assert fmt[0]["name"] == "search"
        assert "input_schema" in fmt[0]

    def test_openai_format(self, loaded_registry):
        fmt = loaded_registry.to_openai_format()
        assert len(fmt) == 1
        assert fmt[0]["type"] == "function"
        assert fmt[0]["function"]["name"] == "search"
