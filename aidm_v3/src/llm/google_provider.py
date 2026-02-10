"""Google Gemini LLM provider using new google.genai SDK.

This provider supports:
- Gemini 3 Flash/Pro for standard completions
- Google Search grounding for research tasks
- Structured output with Pydantic schemas
"""

import json
import os
from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel

from .provider import LLMProvider, LLMResponse


class GoogleProvider(LLMProvider):
    """Google Gemini provider using the new google.genai SDK.
    
    Supports:
    - Gemini 3 Flash/Pro for standard completions
    - Google Search grounding for research tasks
    - Structured output with JSON schemas
    """
    
    @property
    def name(self) -> str:
        return "google"
    
    def get_default_model(self) -> str:
        return "gemini-3-flash-preview"
    
    def get_fast_model(self) -> str:
        return "gemini-3-flash-preview"
    
    def get_creative_model(self) -> str:
        return "gemini-3-pro-preview"
    
    def get_research_model(self) -> str:
        """Model optimized for research with web search."""
        return "gemini-3-pro-preview"
    
    def get_max_concurrent_requests(self) -> int:
        """Max concurrent requests - Google has generous rate limits."""
        return 10
    
    def _init_client(self):
        """Initialize the Google GenAI client."""
        from google import genai
        self._client = genai.Client(api_key=self.api_key)
    
    async def complete(
        self,
        messages: List[Dict[str, str]],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        extended_thinking: bool = False,
    ) -> LLMResponse:
        """Generate a text completion using Gemini."""
        self._ensure_client()
        
        model_name = model or self.default_model
        
        # Build contents from messages
        contents = self._build_contents(messages)
        
        # Build config
        config = {
            "max_output_tokens": max_tokens,
            "temperature": temperature,
        }
        if system:
            config["system_instruction"] = system
            
        # Extended thinking
        if extended_thinking:
            config["thinking_config"] = {"include_thoughts": True}  # Gemini 2.0 style
            # For Gemini 3 specific parameter if available:
            # config["thinkingLevel"] = "high"
            # Note: Using the most compatible approach for the google.genai SDK version

        
        # Use streaming to prevent truncation issues with long responses
        import asyncio
        loop = asyncio.get_running_loop()
        
        def _stream_and_collect():
            stream = self._client.models.generate_content_stream(
                model=model_name,
                contents=contents,
                config=config
            )
            full_text = ""
            last_chunk = None
            for chunk in stream:
                full_text += chunk.text or ""
                last_chunk = chunk
            return full_text, last_chunk
        
        full_text, last_chunk = await loop.run_in_executor(None, _stream_and_collect)
        
        # Extract usage info from final chunk (including cache hits)
        usage = {}
        cached_tokens = 0
        if last_chunk and hasattr(last_chunk, 'usage_metadata') and last_chunk.usage_metadata:
            usage = {
                "prompt_tokens": getattr(last_chunk.usage_metadata, 'prompt_token_count', 0),
                "completion_tokens": getattr(last_chunk.usage_metadata, 'candidates_token_count', 0),
                "total_tokens": getattr(last_chunk.usage_metadata, 'total_token_count', 0),
            }
            # Check for cache hits (Gemini implicit caching)
            cached_tokens = getattr(last_chunk.usage_metadata, 'cached_content_token_count', 0) or 0
            if cached_tokens > 0:
                usage["cached_tokens"] = cached_tokens
                print(f"[Cache Hit] {cached_tokens} tokens cached ({cached_tokens/max(usage.get('prompt_tokens', 1), 1)*100:.0f}% of prompt)")
        
        return LLMResponse(
            content=full_text,
            model=model_name,
            usage=usage,
            raw_response=last_chunk
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
        """Generate a completion with Google Search grounding.
        
        The model will automatically search Google for relevant information
        and synthesize results into its response.
        
        Args:
            messages: Conversation messages
            system: System prompt
            model: Model to use (defaults to research model)
            max_tokens: Max output tokens
            temperature: Temperature for generation
            
        Returns:
            LLMResponse with search-grounded content
        """
        self._ensure_client()
        
        from google.genai.types import Tool, GoogleSearch
        
        model_name = model or self.get_research_model()
        
        # Build contents from messages
        contents = self._build_contents(messages)
        
        # Build config with search tool
        config = {
            "max_output_tokens": max_tokens,
            "temperature": temperature,
        }
        
        tools_config = [Tool(google_search=GoogleSearch())]
        config["tools"] = tools_config
        
        if system:
            config["system_instruction"] = system
            
        if extended_thinking:
            config["thinking_config"] = {"include_thoughts": True}
        
        # Use streaming to prevent truncation issues with long responses
        import asyncio
        loop = asyncio.get_running_loop()
        
        def _stream_and_collect():
            stream = self._client.models.generate_content_stream(
                model=model_name,
                contents=contents,
                config=config
            )
            full_text = ""
            last_chunk = None
            chunk_count = 0
            for chunk in stream:
                full_text += chunk.text or ""
                last_chunk = chunk
                chunk_count += 1
            print(f"[Google Streaming] Collected {chunk_count} chunks, {len(full_text)} chars")
            return full_text, last_chunk
        
        full_text, last_chunk = await loop.run_in_executor(None, _stream_and_collect)
        
        # Extract grounding metadata if available (from last chunk)
        grounding_info = {}
        if last_chunk and hasattr(last_chunk, 'candidates') and last_chunk.candidates:
            candidate = last_chunk.candidates[0]
            if hasattr(candidate, 'grounding_metadata') and candidate.grounding_metadata:
                meta = candidate.grounding_metadata
                grounding_info = {
                    "search_queries": getattr(meta, 'web_search_queries', []),
                    "grounding_chunks": len(getattr(meta, 'grounding_chunks', None) or []),
                    "grounding_supports": len(getattr(meta, 'grounding_supports', None) or []),
                }
        
        # Extract usage from last chunk
        usage = {}
        if last_chunk and hasattr(last_chunk, 'usage_metadata') and last_chunk.usage_metadata:
            usage = {
                "prompt_tokens": getattr(last_chunk.usage_metadata, 'prompt_token_count', 0),
                "completion_tokens": getattr(last_chunk.usage_metadata, 'candidates_token_count', 0),
                "total_tokens": getattr(last_chunk.usage_metadata, 'total_token_count', 0),
            }
        
        return LLMResponse(
            content=full_text,
            model=model_name,
            usage=usage,
            raw_response=last_chunk,
            metadata={"grounding": grounding_info, "search_enabled": True}
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
        """Generate a structured completion matching a Pydantic schema.
        
        Uses Gemini's native JSON mode for reliable structured output.
        """
        self._ensure_client()
        
        model_name = model or self.default_model
        
        # Get JSON schema from Pydantic model
        json_schema = schema.model_json_schema()
        
        # Build contents from messages
        contents = self._build_contents(messages)
        
        # Build config with native JSON mode
        config = {
            "max_output_tokens": max_tokens,
            "temperature": 0.3,  # Lower temperature for structured output
            "response_mime_type": "application/json",
            "response_json_schema": json_schema,
        }
        
        if system:
            config["system_instruction"] = system
            
        if extended_thinking:
            config["thinking_config"] = {"include_thoughts": True}
        
        # Use streaming to prevent truncation issues with long responses
        import asyncio
        loop = asyncio.get_running_loop()
        
        def _stream_and_collect():
            stream = self._client.models.generate_content_stream(
                model=model_name,
                contents=contents,
                config=config
            )
            full_text = ""
            last_chunk = None
            for chunk in stream:
                full_text += chunk.text or ""
                last_chunk = chunk
            return full_text, last_chunk
        
        full_text, last_chunk = await loop.run_in_executor(None, _stream_and_collect)
        
        # Extract usage (including cache hits) from last chunk
        if last_chunk and hasattr(last_chunk, 'usage_metadata') and last_chunk.usage_metadata:
            cached_tokens = getattr(last_chunk.usage_metadata, 'cached_content_token_count', 0) or 0
            if cached_tokens > 0:
                prompt_tokens = getattr(last_chunk.usage_metadata, 'prompt_token_count', 1) or 1
                print(f"[Cache Hit] {cached_tokens} tokens cached ({cached_tokens/max(prompt_tokens, 1)*100:.0f}% of prompt)")
        
        # Parse response - should be valid JSON thanks to native mode
        content = full_text.strip() if full_text else "{}"
        
        try:
            data = json.loads(content)
            return schema.model_validate(data)
        except (json.JSONDecodeError, Exception) as e:
            # Fallback: validator repair (shouldn't be needed with native mode)
            try:
                from ..agents.validator import get_validator
                validator = get_validator()
                repaired = await validator.repair_json(
                    broken_json=content,
                    target_schema=schema,
                    error_msg=str(e)
                )
                if repaired:
                    return repaired
            except Exception as repair_error:
                print(f"[Schema Repair] Validator repair also failed: {repair_error}")
            
            raise ValueError(f"Failed to parse JSON response: {e}\nResponse: {content[:500]}")
    
    async def complete_with_schema_and_search(
        self,
        messages: List[Dict[str, str]],
        schema: Type[BaseModel],
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        extended_thinking: bool = False,
    ) -> BaseModel:
        """Generate a structured completion with Google Search grounding.
        
        Combines search grounding with structured output.
        """
        self._ensure_client()
        
        model_name = model or self.get_research_model()
        
        # Get JSON schema
        json_schema = schema.model_json_schema()
        
        # Build system prompt with schema
        schema_instruction = f"""
After researching using Google Search, provide your response as valid JSON matching this schema:
{json.dumps(json_schema, indent=2)}

Respond ONLY with the JSON object, no markdown formatting or explanation.
"""
        full_system = f"{system}\n\n{schema_instruction}" if system else schema_instruction
        
        # Generate with search
        response = await self.complete_with_search(
            messages=messages,
            system=full_system,
            model=model_name,
            max_tokens=max_tokens,
            temperature=0.3
        )
        
        # Parse JSON from response
        content = response.content.strip()
        content = self._extract_json(content)
        
        try:
            data = json.loads(content)
            return schema.model_validate(data)
        except json.JSONDecodeError as e:
            raise ValueError(f"Failed to parse JSON response: {e}\nResponse: {content}")
    
    async def complete_with_tools(
        self,
        messages: List[Dict[str, str]],
        tools: Any,  # ToolRegistry
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: int = 4096,
        max_tool_rounds: int = 5,
    ) -> LLMResponse:
        """Run a tool-calling loop with Google Gemini function calling.
        
        Uses non-streaming generate_content for multi-turn tool interactions.
        The loop continues until the model produces a text response (no more
        function calls) or max_tool_rounds is reached.
        """
        self._ensure_client()
        from google.genai import types
        import asyncio
        
        model_name = model or self.get_fast_model()
        
        # Convert ToolRegistry to Google format
        google_tools = tools.to_google_format()
        
        # Build initial contents as proper Content objects for multi-turn
        contents = []
        for msg in messages:
            role = msg.get("role", "user")
            content_text = msg.get("content", "")
            # Google uses "user" and "model" roles
            genai_role = "model" if role == "assistant" else "user"
            contents.append(types.Content(
                role=genai_role,
                parts=[types.Part.from_text(text=content_text)]
            ))
        
        # Build config
        config = {
            "max_output_tokens": max_tokens,
            "temperature": 0.3,  # Low temperature for tool-calling reasoning
            "tools": google_tools,
            # Disable automatic function calling — we handle the loop manually
            "automatic_function_calling": types.AutomaticFunctionCallingConfig(
                disable=True
            ),
        }
        if system:
            config["system_instruction"] = system
        
        all_tool_calls = []
        total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        
        loop = asyncio.get_running_loop()
        
        for round_num in range(max_tool_rounds):
            # Make the API call (non-streaming for tool calling)
            def _generate(contents=contents, config=config):
                return self._client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=config
                )
            
            response = await loop.run_in_executor(None, _generate)
            
            # Accumulate usage
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                total_usage["prompt_tokens"] += getattr(response.usage_metadata, 'prompt_token_count', 0) or 0
                total_usage["completion_tokens"] += getattr(response.usage_metadata, 'candidates_token_count', 0) or 0
                total_usage["total_tokens"] += getattr(response.usage_metadata, 'total_token_count', 0) or 0
            
            # Check if the model returned function calls
            candidate = response.candidates[0] if response.candidates else None
            if not candidate or not candidate.content or not candidate.content.parts:
                # No content — return empty
                print(f"[ToolLoop] Round {round_num+1}: No content returned, ending loop")
                break
            
            # Separate text parts and function call parts
            text_parts = []
            function_calls = []
            for part in candidate.content.parts:
                if hasattr(part, 'function_call') and part.function_call:
                    function_calls.append(part.function_call)
                elif hasattr(part, 'text') and part.text:
                    text_parts.append(part.text)
            
            if not function_calls:
                # Model is done — returned text without function calls
                final_text = "".join(text_parts)
                print(f"[ToolLoop] Round {round_num+1}: Model returned final text ({len(final_text)} chars)")
                return LLMResponse(
                    content=final_text,
                    tool_calls=all_tool_calls,
                    model=model_name,
                    usage=total_usage,
                    raw_response=response,
                    metadata={"tool_rounds": round_num + 1}
                )
            
            # Execute each function call
            print(f"[ToolLoop] Round {round_num+1}: {len(function_calls)} tool call(s)")
            
            # Add the model's response (with function calls) to contents
            contents.append(candidate.content)
            
            # Execute tools and build function response parts
            function_response_parts = []
            for fc in function_calls:
                tool_name = fc.name
                tool_args = dict(fc.args) if fc.args else {}
                
                print(f"  [Tool] {tool_name}({tool_args})")
                
                # Execute via ToolRegistry
                result = tools.execute(tool_name, tool_args, round_number=round_num)
                result_str = result.to_string()
                
                # Log for return value
                all_tool_calls.append({
                    "name": tool_name,
                    "arguments": tool_args,
                    "result_preview": result_str[:200],
                    "round": round_num + 1
                })
                
                # Build function response part
                function_response_parts.append(types.Part.from_function_response(
                    name=tool_name,
                    response={"result": result_str}
                ))
            
            # Add function responses as a user turn
            contents.append(types.Content(
                role="user",
                parts=function_response_parts
            ))
        
        # Hit max_tool_rounds — force a final text generation without tools
        print(f"[ToolLoop] Hit max rounds ({max_tool_rounds}), forcing final response")
        config_no_tools = {
            "max_output_tokens": max_tokens,
            "temperature": 0.3,
        }
        if system:
            config_no_tools["system_instruction"] = system
        
        # Add instruction to produce final answer
        contents.append(types.Content(
            role="user",
            parts=[types.Part.from_text(
                text="You've completed your research. Now produce your final response based on everything you've found."
            )]
        ))
        
        def _final_generate(contents=contents, config=config_no_tools):
            return self._client.models.generate_content(
                model=model_name,
                contents=contents,
                config=config_no_tools
            )
        
        final_response = await loop.run_in_executor(None, _final_generate)
        final_text = ""
        if final_response.candidates and final_response.candidates[0].content:
            for part in final_response.candidates[0].content.parts:
                if hasattr(part, 'text') and part.text:
                    final_text += part.text
        
        return LLMResponse(
            content=final_text,
            tool_calls=all_tool_calls,
            model=model_name,
            usage=total_usage,
            raw_response=final_response,
            metadata={"tool_rounds": max_tool_rounds, "forced_finish": True}
        )
    
    def _build_contents(self, messages: List[Dict[str, str]]) -> str:
        """Build contents string from messages for the new SDK."""
        # For simple cases, just concatenate user messages
        # The new SDK handles multi-turn differently
        parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "user":
                parts.append(content)
            elif role == "assistant":
                parts.append(f"Previous response: {content}")
        return "\n\n".join(parts)
    
    def _extract_json(self, content: str) -> str:
        """Extract JSON from response, handling markdown code blocks."""
        if content.startswith("```"):
            lines = content.split("\n")
            json_lines = []
            in_block = False
            for line in lines:
                if line.startswith("```"):
                    in_block = not in_block
                    continue
                if in_block or not line.startswith("```"):
                    json_lines.append(line)
            content = "\n".join(json_lines)
        return content
