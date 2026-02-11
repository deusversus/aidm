"""Anthropic Claude LLM provider."""

import json
import os
from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel

from .provider import LLMProvider, LLMResponse


class AnthropicProvider(LLMProvider):
    """Anthropic Claude provider implementation.
    
    Supports Claude model family:
    - Haiku 4.5: Fast, affordable for structured tasks
    - Sonnet 4.5: Balanced quality/speed for creative work
    - Opus 4.6: Latest Opus — highest quality, nearly Sonnet pricing
    - Opus 4.5: Previous-gen Opus, still excellent
    
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
            return "claude-opus-4-6"
        return "claude-sonnet-4-5"
    
    def get_opus_model(self) -> str:
        """Get Opus model explicitly."""
        return "claude-opus-4-6"
    
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
    
    async def complete_with_tools(
        self,
        messages: List[Dict[str, str]],
        tools: Any,  # ToolRegistry
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        max_tool_rounds: int = 5,
    ) -> LLMResponse:
        """Run a tool-calling loop with Anthropic Claude.
        
        Uses Programmatic Tool Calling (beta) to let Claude orchestrate
        multiple tool calls via generated code in a sandboxed container.
        This reduces API round-trips and avoids intermediate tool results
        entering the context window — only the final code output is seen
        by the model, which saves tokens and latency.
        
        Falls back to standard tool calling if the beta API errors.
        
        Beta: advanced-tool-use-2025-11-20
        Requires: code_execution_20250825 server tool
        """
        self._ensure_client()
        import asyncio
        
        model_name = model or self.get_fast_model()
        
        # Try programmatic tool calling first, fall back to standard
        try:
            return await self._complete_with_tools_programmatic(
                messages, tools, system, model_name, max_tokens, max_tool_rounds
            )
        except Exception as e:
            print(f"[Anthropic] Programmatic tool calling failed ({e}), falling back to standard")
            return await self._complete_with_tools_standard(
                messages, tools, system, model_name, max_tokens, max_tool_rounds
            )
    
    async def _complete_with_tools_programmatic(
        self,
        messages: List[Dict[str, str]],
        tools: Any,  # ToolRegistry
        system: Optional[str],
        model_name: str,
        max_tokens: int,
        max_tool_rounds: int,
    ) -> LLMResponse:
        """Programmatic Tool Calling -- Claude writes code to orchestrate tools.
        
        Claude generates Python that calls tools as async functions inside a
        sandbox. The API pauses on each tool_use block and we provide results.
        Intermediate results stay in the sandbox, not in Claude's context.
        """
        import asyncio
        loop = asyncio.get_running_loop()
        
        # Convert tools with allowed_callers for programmatic calling
        anthropic_tools = tools.to_anthropic_format(programmatic=True)
        
        # Prepend the code execution server tool
        anthropic_tools.insert(0, {
            "type": "code_execution_20250825",
            "name": "code_execution",
        })
        
        conversation = list(messages)
        all_tool_calls = []
        total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        container_id = None  # Reuse container across rounds
        
        for round_num in range(max_tool_rounds):
            kwargs = {
                "model": model_name,
                "betas": ["advanced-tool-use-2025-11-20"],
                "max_tokens": max_tokens,
                "system": system or "",
                "messages": conversation,
                "tools": anthropic_tools,
            }
            if container_id:
                kwargs["container"] = container_id
            
            def _create(kwargs=kwargs):
                return self._client.beta.messages.create(**kwargs)
            
            response = await loop.run_in_executor(None, _create)
            
            # Track container for reuse
            if hasattr(response, 'container') and response.container:
                ctr = response.container
                container_id = ctr.id if hasattr(ctr, 'id') else (ctr.get('id') if isinstance(ctr, dict) else None)
            
            # Accumulate usage
            if hasattr(response, 'usage'):
                total_usage["prompt_tokens"] += response.usage.input_tokens
                total_usage["completion_tokens"] += response.usage.output_tokens
                total_usage["total_tokens"] += (
                    response.usage.input_tokens + response.usage.output_tokens
                )
            
            # Classify response blocks
            text_parts = []
            tool_use_blocks = []       # Client tool calls we need to execute
            assistant_content = []      # Full content for conversation history
            
            for block in response.content:
                block_type = getattr(block, 'type', None)
                
                if block_type == "text":
                    text_parts.append(block.text)
                    assistant_content.append({"type": "text", "text": block.text})
                    
                elif block_type == "tool_use":
                    # Client tool call -- we execute this
                    tool_use_blocks.append(block)
                    entry = {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    }
                    if hasattr(block, 'caller') and block.caller:
                        caller = block.caller
                        if hasattr(caller, '__dict__'):
                            entry["caller"] = {"type": getattr(caller, 'type', 'direct')}
                            if hasattr(caller, 'tool_id'):
                                entry["caller"]["tool_id"] = caller.tool_id
                        elif isinstance(caller, dict):
                            entry["caller"] = caller
                    assistant_content.append(entry)
                    
                elif block_type == "server_tool_use":
                    # Code execution block -- pass through as-is
                    assistant_content.append({
                        "type": "server_tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input if hasattr(block, 'input') else {},
                    })
                    
                elif block_type == "code_execution_tool_result":
                    # Code execution result -- pass through
                    assistant_content.append({
                        "type": "code_execution_tool_result",
                        "tool_use_id": block.tool_use_id if hasattr(block, 'tool_use_id') else "",
                        "content": block.content if hasattr(block, 'content') else {},
                    })
            
            # If no tool_use blocks, we are done
            if not tool_use_blocks:
                final_text = "\n".join(text_parts)
                mode = "programmatic" if container_id else "direct"
                print(f"[ToolLoop/Anthropic] Round {round_num+1}: Final text ({len(final_text)} chars) [{mode}]")
                return LLMResponse(
                    content=final_text,
                    tool_calls=all_tool_calls,
                    model=model_name,
                    usage=total_usage,
                    raw_response=response,
                    metadata={
                        "tool_rounds": round_num + 1,
                        "programmatic": True,
                        "container_id": container_id,
                    }
                )
            
            # Execute tool calls
            is_programmatic = any(
                hasattr(b, 'caller') and b.caller and
                getattr(b.caller, 'type', None) == 'code_execution_20250825'
                for b in tool_use_blocks
            )
            mode_label = "programmatic" if is_programmatic else "direct"
            print(f"[ToolLoop/Anthropic] Round {round_num+1}: {len(tool_use_blocks)} tool call(s) [{mode_label}]")
            
            conversation.append({"role": "assistant", "content": assistant_content})
            
            tool_results = []
            for block in tool_use_blocks:
                tool_name = block.name
                tool_args = block.input if isinstance(block.input, dict) else {}
                tool_id = block.id
                
                print(f"  [Tool] {tool_name}({tool_args})")
                
                result = tools.execute(tool_name, tool_args, round_number=round_num)
                result_str = result.to_string()
                
                all_tool_calls.append({
                    "name": tool_name,
                    "arguments": tool_args,
                    "result_preview": result_str[:200],
                    "round": round_num + 1,
                    "programmatic": is_programmatic,
                })
                
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result_str,
                })
            
            # For programmatic calls: tool_result-only (no text allowed)
            conversation.append({"role": "user", "content": tool_results})
        
        # Hit max_tool_rounds
        print(f"[ToolLoop/Anthropic] Hit max rounds ({max_tool_rounds}), forcing final response [programmatic]")
        
        conversation.append({
            "role": "user",
            "content": "You've completed your research. Now produce your final response based on everything you've found."
        })
        
        def _final_create():
            return self._client.beta.messages.create(
                model=model_name,
                betas=["advanced-tool-use-2025-11-20"],
                max_tokens=max_tokens,
                system=system or "",
                messages=conversation,
            )
        
        final_response = await loop.run_in_executor(None, _final_create)
        
        final_text = ""
        for block in final_response.content:
            if hasattr(block, 'text'):
                final_text += block.text
        
        return LLMResponse(
            content=final_text,
            tool_calls=all_tool_calls,
            model=model_name,
            usage=total_usage,
            raw_response=final_response,
            metadata={
                "tool_rounds": max_tool_rounds,
                "forced_finish": True,
                "programmatic": True,
                "container_id": container_id,
            }
        )
    
    async def _complete_with_tools_standard(
        self,
        messages: List[Dict[str, str]],
        tools: Any,  # ToolRegistry
        system: Optional[str],
        model_name: str,
        max_tokens: int,
        max_tool_rounds: int,
    ) -> LLMResponse:
        """Standard (non-programmatic) tool calling -- fallback implementation.
        
        Uses standard messages.create with tool_use blocks. Each tool call
        is a separate round-trip through the model.
        """
        import asyncio
        loop = asyncio.get_running_loop()
        
        anthropic_tools = tools.to_anthropic_format()
        conversation = list(messages)
        all_tool_calls = []
        total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        
        for round_num in range(max_tool_rounds):
            kwargs = {
                "model": model_name,
                "max_tokens": max_tokens,
                "system": system or "",
                "messages": conversation,
                "tools": anthropic_tools,
            }
            
            def _create(kwargs=kwargs):
                return self._client.messages.create(**kwargs)
            
            response = await loop.run_in_executor(None, _create)
            
            if hasattr(response, 'usage'):
                total_usage["prompt_tokens"] += response.usage.input_tokens
                total_usage["completion_tokens"] += response.usage.output_tokens
                total_usage["total_tokens"] += (
                    response.usage.input_tokens + response.usage.output_tokens
                )
            
            text_parts = []
            tool_use_blocks = []
            for block in response.content:
                if hasattr(block, 'type'):
                    if block.type == "text":
                        text_parts.append(block.text)
                    elif block.type == "tool_use":
                        tool_use_blocks.append(block)
            
            if not tool_use_blocks:
                final_text = "\n".join(text_parts)
                print(f"[ToolLoop/Anthropic] Round {round_num+1}: Final text ({len(final_text)} chars) [standard]")
                return LLMResponse(
                    content=final_text,
                    tool_calls=all_tool_calls,
                    model=model_name,
                    usage=total_usage,
                    raw_response=response,
                    metadata={"tool_rounds": round_num + 1, "programmatic": False}
                )
            
            print(f"[ToolLoop/Anthropic] Round {round_num+1}: {len(tool_use_blocks)} tool call(s) [standard]")
            
            conversation.append({
                "role": "assistant",
                "content": [
                    {"type": b.type, **({
                        "text": b.text} if b.type == "text" else {
                        "id": b.id, "name": b.name, "input": b.input})}
                    for b in response.content
                    if hasattr(b, 'type') and b.type in ("text", "tool_use")
                ]
            })
            
            tool_results = []
            for block in tool_use_blocks:
                tool_name = block.name
                tool_args = block.input if isinstance(block.input, dict) else {}
                tool_id = block.id
                
                print(f"  [Tool] {tool_name}({tool_args})")
                
                result = tools.execute(tool_name, tool_args, round_number=round_num)
                result_str = result.to_string()
                
                all_tool_calls.append({
                    "name": tool_name,
                    "arguments": tool_args,
                    "result_preview": result_str[:200],
                    "round": round_num + 1,
                })
                
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result_str,
                })
            
            conversation.append({"role": "user", "content": tool_results})
        
        print(f"[ToolLoop/Anthropic] Hit max rounds ({max_tool_rounds}), forcing final response [standard]")
        
        conversation.append({
            "role": "user",
            "content": "You've completed your research. Now produce your final response based on everything you've found."
        })
        
        def _final_create():
            return self._client.messages.create(
                model=model_name,
                max_tokens=max_tokens,
                system=system or "",
                messages=conversation,
            )
        
        final_response = await loop.run_in_executor(None, _final_create)
        
        final_text = ""
        for block in final_response.content:
            if hasattr(block, 'text'):
                final_text += block.text
        
        return LLMResponse(
            content=final_text,
            tool_calls=all_tool_calls,
            model=model_name,
            usage=total_usage,
            raw_response=final_response,
            metadata={"tool_rounds": max_tool_rounds, "forced_finish": True, "programmatic": False}
        )
