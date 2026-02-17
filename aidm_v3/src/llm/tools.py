"""
Tool infrastructure for AIDM agentic agents.

Provides a provider-agnostic framework for defining tools, converting them
to each provider's native format, and executing them in a tool-calling loop.

Usage:
    registry = ToolRegistry()
    registry.register(ToolDefinition(
        name="search_memory",
        description="Search for relevant memories",
        parameters=[ToolParam("query", "str", "The search query", required=True)],
        handler=lambda query: memory.search(query)
    ))
    
    # Convert to provider-native format
    google_tools = registry.to_google_format()
    anthropic_tools = registry.to_anthropic_format()
"""

import json
import logging
import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Core Types
# ---------------------------------------------------------------------------

@dataclass
class ToolParam:
    """A single parameter for a tool."""
    name: str
    type: str           # "str", "int", "float", "bool", "list"
    description: str
    required: bool = True
    default: Any = None
    enum: Optional[List[str]] = None  # For constrained string values


@dataclass
class ToolDefinition:
    """A tool that an agent can call.
    
    The handler is the actual Python function to execute when the tool is called.
    Parameters describe the tool's interface for the LLM.
    """
    name: str
    description: str
    parameters: List[ToolParam]
    handler: Callable
    
    def get_required_params(self) -> List[str]:
        return [p.name for p in self.parameters if p.required]
    
    def get_optional_params(self) -> List[str]:
        return [p.name for p in self.parameters if not p.required]


@dataclass
class ToolResult:
    """Result from executing a tool."""
    tool_name: str
    arguments: Dict[str, Any]
    result: Any
    error: Optional[str] = None
    
    def to_string(self) -> str:
        """Convert result to a string for the LLM."""
        if self.error:
            return f"Error calling {self.tool_name}: {self.error}"
        
        if isinstance(self.result, (dict, list)):
            try:
                return json.dumps(self.result, indent=2, default=str)
            except (TypeError, ValueError):
                return str(self.result)
        return str(self.result)


@dataclass
class ToolCallLog:
    """Log entry for a tool call (for debugging/tracing)."""
    tool_name: str
    arguments: Dict[str, Any]
    result_preview: str  # First 200 chars of result
    round_number: int


# ---------------------------------------------------------------------------
# Tool Registry
# ---------------------------------------------------------------------------

class ToolRegistry:
    """Register tools and convert to provider-native formats.
    
    Handles:
    - Registration and lookup by name
    - Conversion to Google/Anthropic/OpenAI schemas
    - Safe execution with error handling
    """
    
    def __init__(self):
        self._tools: Dict[str, ToolDefinition] = {}
        self._call_log: List[ToolCallLog] = []
    
    def register(self, tool: ToolDefinition) -> None:
        """Register a tool. Overwrites if name already exists."""
        self._tools[tool.name] = tool
        logger.debug(f"[ToolRegistry] Registered tool: {tool.name}")
    
    def get(self, name: str) -> Optional[ToolDefinition]:
        """Look up a tool by name."""
        return self._tools.get(name)
    
    def all_tools(self) -> List[ToolDefinition]:
        """Get all registered tools."""
        return list(self._tools.values())
    
    @property
    def call_log(self) -> List[ToolCallLog]:
        """Get the log of all tool calls made via execute()."""
        return self._call_log
    
    def execute(self, tool_name: str, arguments: Dict[str, Any], round_number: int = 0) -> ToolResult:
        """Execute a tool by name with the given arguments.
        
        Returns ToolResult (never raises — errors are captured in result).
        """
        tool = self._tools.get(tool_name)
        if not tool:
            result = ToolResult(
                tool_name=tool_name,
                arguments=arguments,
                result=None,
                error=f"Unknown tool: {tool_name}"
            )
            self._call_log.append(ToolCallLog(
                tool_name=tool_name,
                arguments=arguments,
                result_preview=result.to_string()[:200],
                round_number=round_number
            ))
            return result
        
        try:
            # Filter arguments to only those the handler accepts
            sig = inspect.signature(tool.handler)
            has_var_keyword = any(
                p.kind == inspect.Parameter.VAR_KEYWORD
                for p in sig.parameters.values()
            )

            if has_var_keyword:
                # Handler accepts **kwargs (e.g. lambda **kw: _func(state, **kw))
                # Pass ALL LLM-provided arguments through
                valid_args = dict(arguments)
            else:
                valid_args = {}
                for param_name, param in sig.parameters.items():
                    if param_name in arguments:
                        valid_args[param_name] = arguments[param_name]
                    elif param.default is not inspect.Parameter.empty:
                        pass  # Use the function's default
                    elif param_name in [p.name for p in tool.parameters if not p.required]:
                        pass  # Optional tool param, not provided
            
            output = tool.handler(**valid_args)
            result = ToolResult(
                tool_name=tool_name,
                arguments=arguments,
                result=output
            )
            logger.info(f"[Tool] {tool_name}({arguments}) → {str(output)[:100]}")
            
        except Exception as e:
            result = ToolResult(
                tool_name=tool_name,
                arguments=arguments,
                result=None,
                error=f"{type(e).__name__}: {e}"
            )
            logger.warning(f"[Tool] {tool_name} failed: {e}")
        
        self._call_log.append(ToolCallLog(
            tool_name=tool_name,
            arguments=arguments,
            result_preview=result.to_string()[:200],
            round_number=round_number
        ))
        return result
    
    # -------------------------------------------------------------------
    # Provider Format Converters
    # -------------------------------------------------------------------
    
    def _param_type_to_json_schema(self, type_str: str) -> dict:
        """Convert our type strings to JSON Schema types."""
        mapping = {
            "str": {"type": "string"},
            "string": {"type": "string"},
            "int": {"type": "integer"},
            "integer": {"type": "integer"},
            "float": {"type": "number"},
            "number": {"type": "number"},
            "bool": {"type": "boolean"},
            "boolean": {"type": "boolean"},
            "list": {"type": "array", "items": {"type": "string"}},
            "array": {"type": "array", "items": {"type": "string"}},
        }
        return mapping.get(type_str.lower(), {"type": "string"})
    
    def _build_json_schema(self, tool: ToolDefinition) -> dict:
        """Build a JSON Schema object for a tool's parameters."""
        properties = {}
        required = []
        
        for param in tool.parameters:
            prop = self._param_type_to_json_schema(param.type)
            prop["description"] = param.description
            if param.enum:
                prop["enum"] = param.enum
            properties[param.name] = prop
            
            if param.required:
                required.append(param.name)
        
        schema = {
            "type": "object",
            "properties": properties,
        }
        if required:
            schema["required"] = required
        return schema
    
    def to_google_format(self) -> list:
        """Convert tools to Google GenAI FunctionDeclaration format.
        
        Returns a list of dicts suitable for the google.genai tools parameter.
        """
        from google.genai import types
        
        declarations = []
        for tool in self._tools.values():
            params_schema = self._build_json_schema(tool)
            
            decl = types.FunctionDeclaration(
                name=tool.name,
                description=tool.description,
                parameters=params_schema if tool.parameters else None,
            )
            declarations.append(decl)
        
        return [types.Tool(function_declarations=declarations)]
    
    def to_anthropic_format(self, programmatic: bool = False) -> list:
        """Convert tools to Anthropic tool schema format.
        
        Args:
            programmatic: If True, add allowed_callers for programmatic
                tool calling (code execution sandbox). This lets Claude
                orchestrate multiple tool calls via generated code in a
                single round, reducing latency and token consumption.
        
        Returns a list of dicts for Anthropic's tools parameter.
        """
        tools = []
        for tool in self._tools.values():
            tool_def = {
                "name": tool.name,
                "description": tool.description,
                "input_schema": self._build_json_schema(tool)
            }
            if programmatic:
                tool_def["allowed_callers"] = ["code_execution_20250825"]
            tools.append(tool_def)
        return tools
    
    def to_openai_format(self) -> list:
        """Convert tools to OpenAI function calling format.
        
        Returns a list of dicts for OpenAI's tools parameter.
        """
        tools = []
        for tool in self._tools.values():
            tools.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": self._build_json_schema(tool)
                }
            })
        return tools
