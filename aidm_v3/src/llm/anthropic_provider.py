"""Anthropic Claude LLM provider."""

import json
import os
from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel

from .provider import LLMProvider, LLMResponse


class AnthropicProvider(LLMProvider):
    """Anthropic Claude provider implementation.
    
    Supports Claude 4.5 model family:
    - Haiku 4.5: Fast, affordable for structured tasks
    - Sonnet 4.5: Balanced quality/speed for creative work
    - Opus 4.5: Highest quality, now nearly Sonnet pricing
    
    Also supports web search via the Anthropic API (May 2025+).
    """
    
    @property
    def name(self) -> str:
        return "anthropic"
    
    def get_default_model(self) -> str:
        return "claude-sonnet-4-5"
    
    def get_fast_model(self) -> str:
        return "claude-haiku-4-5"
    
    def get_creative_model(self) -> str:
        """Get creative model - defaults to Sonnet, can be set to Opus via env var."""
        preference = os.getenv("ANTHROPIC_CREATIVE_MODEL", "sonnet").lower()
        if preference == "opus":
            return "claude-opus-4-5"
        return "claude-sonnet-4-5"
    
    def get_opus_model(self) -> str:
        """Get Opus model explicitly."""
        return "claude-opus-4-5"
    
    def get_research_model(self) -> str:
        """Model optimized for research with web search."""
        return "claude-sonnet-4-5"
    
    def get_max_concurrent_requests(self) -> int:
        """Anthropic Tier 2+ can handle more concurrent requests."""
        return 10
    
    def _init_client(self):
        """Initialize the Anthropic client."""
        import anthropic
        self._client = anthropic.Anthropic(api_key=self.api_key)
    
    async def complete(
        self,
        messages: List[Dict[str, str]],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        extended_thinking: bool = False,
    ) -> LLMResponse:
        """Generate a text completion using Claude."""
        self._ensure_client()
        
        model_name = model or self.default_model
        
        # Prepare request args
        kwargs = {
            "model": model_name,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system if system else "",
            "messages": messages
        }
        
        # Extended thinking
        if extended_thinking:
            # Claude requires: budget_tokens < max_tokens
            # Using conservative values to stay within limits
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": 4096  # Reduced from 8192
            }
            # CRITICAL: Anthropic requires temperature=1 when thinking is enabled
            kwargs["temperature"] = 1.0
            # Ensure max_tokens > budget_tokens
            kwargs["max_tokens"] = max(max_tokens, 8192)
            
        # Use streaming to prevent truncation issues with long responses
        import asyncio
        loop = asyncio.get_running_loop()
        
        def _stream_and_collect():
            full_text = ""
            final_message = None
            with self._client.messages.stream(**kwargs) as stream:
                for text in stream.text_stream:
                    full_text += text
                final_message = stream.get_final_message()
            return full_text, final_message
        
        full_text, final_message = await loop.run_in_executor(None, _stream_and_collect)
        
        # Extract usage (including cache hits) from final message
        usage = {}
        if final_message and hasattr(final_message, 'usage'):
            usage = {
                "prompt_tokens": final_message.usage.input_tokens,
                "completion_tokens": final_message.usage.output_tokens,
                "total_tokens": final_message.usage.input_tokens + final_message.usage.output_tokens,
            }
            
            # Check for cache hits (Anthropic prompt caching)
            cached_tokens = getattr(final_message.usage, 'cache_read_input_tokens', 0)
            if cached_tokens and cached_tokens > 0:
                usage["cached_tokens"] = cached_tokens
                print(f"[Cache Hit] {cached_tokens} tokens cached ({cached_tokens/usage.get('prompt_tokens', 1)*100:.0f}% of prompt)")
        
        return LLMResponse(
            content=full_text,
            model=model_name,
            usage=usage,
            raw_response=final_message
        )
    
    async def complete_with_search(
        self,
        messages: List[Dict[str, str]],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.5,
        extended_thinking: bool = False,
    ) -> LLMResponse:
        """Generate a completion with web search enabled.
        
        Claude will automatically search the web for relevant information
        and synthesize results with citations.
        """
        self._ensure_client()
        
        model_name = model or self.get_research_model()
        
        # Enable web search tool - use web_search_20250305 type per Anthropic docs
        tools = [{
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": 5
        }]
        
        kwargs = {
            "model": model_name,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system if system else "",
            "messages": messages,
            "tools": tools,
        }
        
        if extended_thinking:
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": 4096
            }
            kwargs["temperature"] = 1.0
            kwargs["max_tokens"] = max(max_tokens, 8192)
        
        # Use streaming to prevent truncation with long responses
        import asyncio
        loop = asyncio.get_running_loop()
        
        def _stream_and_collect():
            content = ""
            search_results = []
            citations = []
            final_message = None
            
            with self._client.messages.stream(**kwargs) as stream:
                for text in stream.text_stream:
                    content += text
                final_message = stream.get_final_message()
            
            # Extract search metadata from final message
            if final_message:
                for block in final_message.content:
                    if hasattr(block, 'citations') and block.citations:
                        citations.extend(block.citations)
                    if hasattr(block, 'type'):
                        if block.type == "server_tool_use" and getattr(block, 'name', '') == "web_search":
                            search_results.append(getattr(block, 'input', {}))
            
            return content, search_results, citations, final_message
        
        content, search_results, citations, final_message = await loop.run_in_executor(None, _stream_and_collect)
        
        # Extract usage from final message
        usage = {}
        if final_message and hasattr(final_message, 'usage'):
            usage = {
                "prompt_tokens": final_message.usage.input_tokens,
                "completion_tokens": final_message.usage.output_tokens,
                "total_tokens": final_message.usage.input_tokens + final_message.usage.output_tokens,
            }
        
        return LLMResponse(
            content=content,
            model=model_name,
            usage=usage,
            raw_response=final_message,
            metadata={
                "search_enabled": True,
                "search_queries": search_results,
                "citations": citations
            }
        )
    
    async def complete_with_schema(
        self,
        messages: List[Dict[str, str]],
        schema: Type[BaseModel],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 1024,
        extended_thinking: bool = False,
    ) -> BaseModel:
        """Generate a structured completion using tool use."""
        self._ensure_client()
        
        model_name = model or self.default_model
        
        # Get JSON schema from Pydantic model
        json_schema = schema.model_json_schema()
        
        # Create tool for structured output
        tools = [{
            "name": "respond",
            "description": f"Provide your response as a {schema.__name__}",
            "input_schema": json_schema
        }]
        
        kwargs = {
            "model": model_name,
            "max_tokens": max_tokens,
        # Configure tool choice
            "system": system if system else "",
            "messages": messages,
            "tools": tools,
        }

        # Configure tool choice
        if extended_thinking:
            kwargs["tool_choice"] = {"type": "auto"}
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": 4096
            }
            kwargs["temperature"] = 1.0
            kwargs["max_tokens"] = max(max_tokens, 8192)
            
            system_instruction = system if system else ""
            kwargs["system"] = f"{system_instruction}\n\nIMPORTANT: You must respond by calling the 'respond' tool to provide the structured output."
        else:
            kwargs["tool_choice"] = {"type": "tool", "name": "respond"}

        # Use streaming to prevent truncation with long responses
        import asyncio
        loop = asyncio.get_running_loop()
        
        def _stream_and_collect():
            text_content = ""
            final_message = None
            
            with self._client.messages.stream(**kwargs) as stream:
                for text in stream.text_stream:
                    text_content += text
                final_message = stream.get_final_message()
            
            return text_content, final_message
        
        text_content, final_message = await loop.run_in_executor(None, _stream_and_collect)
        
        # Extract tool use response from final message
        if final_message:
            for block in final_message.content:
                if hasattr(block, 'type') and block.type == "thinking":
                    continue
                
                if hasattr(block, 'type') and block.type == "tool_use":
                    input_data = block.input
                    if isinstance(input_data, str):
                        try:
                            input_data = json.loads(input_data)
                        except json.JSONDecodeError:
                            pass
                    
                    try:
                        return schema.model_validate(input_data)
                    except Exception as e:
                        broken_json = json.dumps(input_data) if isinstance(input_data, dict) else str(input_data)
                        try:
                            from ..agents.validator import get_validator
                            validator = get_validator()
                            repaired = await validator.repair_json(
                                broken_json=broken_json,
                                target_schema=schema,
                                error_msg=f"Tool use returned invalid data: {e}"
                            )
                            if repaired:
                                return repaired
                        except Exception as repair_error:
                            print(f"[Schema Repair] Validator repair failed: {repair_error}")
        
        # Fallback: try to parse text content as JSON
        if text_content:
            try:
                data = json.loads(text_content)
                return schema.model_validate(data)
            except (json.JSONDecodeError, Exception):
                pass
            
            # Last resort: validator repair
            try:
                from ..agents.validator import get_validator
                validator = get_validator()
                repaired = await validator.repair_json(
                    broken_json=text_content,
                    target_schema=schema,
                    error_msg="Tool use did not return structured data"
                )
                if repaired:
                    return repaired
            except Exception as repair_error:
                print(f"[Schema Repair] Validator repair failed: {repair_error}")
        
        raise ValueError(f"Could not parse structured response from Claude")
    
    async def complete_with_schema_and_search(
        self,
        messages: List[Dict[str, str]],
        schema: Type[BaseModel],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        extended_thinking: bool = False,
    ) -> BaseModel:
        """Generate a structured completion with web search.
        
        Claude will search the web, then provide a structured response.
        """
        self._ensure_client()
        
        model_name = model or self.get_research_model()
        
        json_schema = schema.model_json_schema()
        
        # Combined tools: web search + structured output
        tools = [
            {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5
            },
            {
                "name": "respond",
                "description": f"After researching, provide your response as a {schema.__name__}",
                "input_schema": json_schema
            }
        ]
        
        # Add schema instructions to system prompt
        schema_instruction = f"""
After researching using web search, provide your final response using the 'respond' tool.
Your response must match the required JSON schema.
"""
        full_system = f"{system}\n\n{schema_instruction}" if system else schema_instruction
        
        kwargs = {
            "model": model_name,
            "max_tokens": max_tokens,
            "system": full_system,
            "messages": messages,
            "tools": tools,
        }
        
        if extended_thinking:
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": 4096
            }
            # CRITICAL: Anthropic requires temperature=1 when thinking is enabled
            kwargs["temperature"] = 1.0
            kwargs["max_tokens"] = max(max_tokens, 8192)
        
        # Regular messages endpoint - no beta needed for web search
        import asyncio
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(
            None,
            lambda: self._client.messages.create(**kwargs)
        )
        
        # Extract structured response from tool use
        for block in response.content:
            if block.type == "tool_use" and block.name == "respond":
                return schema.model_validate(block.input)
        
        # Fallback: try to parse text content
        for block in response.content:
            if hasattr(block, 'text'):
                try:
                    data = json.loads(block.text)
                    return schema.model_validate(data)
                except (json.JSONDecodeError, Exception):
                    pass
        
        raise ValueError(f"Could not parse structured response from Claude")

