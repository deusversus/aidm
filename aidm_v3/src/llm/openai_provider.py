"""OpenAI ChatGPT LLM provider."""

import json
import logging
from typing import Any

from pydantic import BaseModel

from .provider import LLMProvider, LLMResponse

logger = logging.getLogger(__name__)

class OpenAIProvider(LLMProvider):
    """OpenAI ChatGPT provider implementation.
    
    Supports GPT-5 family with:
    - Standard completions
    - Structured output via function calling
    - Web search via Responses API
    """

    @property
    def name(self) -> str:
        return "openai"

    def get_default_model(self) -> str:
        return "gpt-5.2"

    def get_fast_model(self) -> str:
        return "gpt-5-mini"

    def get_creative_model(self) -> str:
        return "gpt-5.2"

    def get_research_model(self) -> str:
        """Model optimized for research with web search."""
        return "gpt-5.2"

    def get_fallback_model(self) -> str:
        return "gpt-4o"

    def get_max_concurrent_requests(self) -> int:
        """Max concurrent requests - OpenAI has generous rate limits."""
        return 10

    def _init_client(self):
        """Initialize the OpenAI client."""
        import openai
        self._client = openai.OpenAI(api_key=self.api_key)

    @staticmethod
    def _flatten_system(system) -> str:
        """Flatten system prompt to a plain string.
        
        Accepts either:
          - str: returned as-is
          - list[tuple[str, bool]]: concatenated text (OpenAI doesn't support block caching)
        """
        if not system:
            return ""
        if isinstance(system, str):
            return system
        return "\n\n".join(text for text, _ in system if text)

    async def complete(
        self,
        messages: list[dict[str, str]],
        system: str | None = None,
        model: str | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        extended_thinking: bool = False,
    ) -> LLMResponse:
        """Generate a text completion using ChatGPT."""
        self._ensure_client()

        model_name = model or self.default_model

        # Build messages with system prompt
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": self._flatten_system(system)})
        full_messages.extend(messages)

        # Generate response using streaming to prevent truncation
        try:
            # Handle parameter differences for newer models (GPT-5+)
            if "gpt-5" in model_name or "o1" in model_name:
                # GPT-5/o1 often don't support temperature or use max_completion_tokens
                kwargs = {
                    "model": model_name,
                    "messages": full_messages,
                    "max_completion_tokens": max_tokens,
                    "stream": True,
                    "stream_options": {"include_usage": True}
                }
                if extended_thinking:
                    kwargs["reasoning_effort"] = "medium"
                    kwargs["max_completion_tokens"] = max(max_tokens, 8192)
            else:
                kwargs = {
                    "model": model_name,
                    "messages": full_messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "stream": True,
                    "stream_options": {"include_usage": True}
                }

            def _stream_and_collect():
                stream = self._client.chat.completions.create(**kwargs)
                full_text = ""
                final_usage = None
                for chunk in stream:
                    if chunk.choices and chunk.choices[0].delta.content:
                        full_text += chunk.choices[0].delta.content
                    # Capture usage from final chunk
                    if hasattr(chunk, 'usage') and chunk.usage:
                        final_usage = chunk.usage
                return full_text, final_usage

            full_text, final_usage = await self._run_with_retry(_stream_and_collect)

        except Exception as e:
            if self._is_retryable(e):
                raise  # Let retry wrapper handle it
            raise RuntimeError(f"OpenAI completion failed for {model_name}: {e}")

        # Extract usage (including cache hits)
        usage = {}
        if final_usage:
            usage = {
                "prompt_tokens": final_usage.prompt_tokens,
                "completion_tokens": final_usage.completion_tokens,
                "total_tokens": final_usage.total_tokens,
            }
            # Check for cache hits (OpenAI prompt caching)
            if hasattr(final_usage, 'prompt_tokens_details') and final_usage.prompt_tokens_details:
                cached_tokens = getattr(final_usage.prompt_tokens_details, 'cached_tokens', 0)
                if cached_tokens and cached_tokens > 0:
                    usage["cached_tokens"] = cached_tokens
                    logger.info(f"{cached_tokens} tokens cached ({cached_tokens/usage.get('prompt_tokens', 1)*100:.0f}% of prompt)")

        return LLMResponse(
            content=full_text,
            model=model_name,
            usage=usage,
            raw_response=None
        )

    async def complete_with_search(
        self,
        messages: list[dict[str, str]],
        system: str | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.5,
        extended_thinking: bool = False,
    ) -> LLMResponse:
        """Generate a completion with web search enabled.
        
        Uses the GPT-5 web search tool for real-time information.
        """
        self._ensure_client()

        model_name = model or self.get_research_model()

        # Build messages
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": self._flatten_system(system)})
        full_messages.extend(messages)

        # Enable web search tool
        tools = [{
            "type": "web_search"
        }]

        try:
            # Use the Responses API for web search with streaming
            kwargs = {
                "model": model_name,
                "input": full_messages,
                "tools": tools,
                "max_output_tokens": max_tokens,
                "stream": True,
            }

            if extended_thinking:
                kwargs["reasoning"] = {"effort": "medium"}
                kwargs["max_output_tokens"] = max(max_tokens, 8192)

            def _stream_and_collect():
                stream = self._client.responses.create(**kwargs)
                content = ""
                search_info = []
                final_response = None

                for event in stream:
                    # Handle different event types
                    if hasattr(event, 'type'):
                        if event.type == "response.output_text.delta":
                            content += event.delta or ""
                        elif event.type == "response.web_search_call.completed":
                            search_info.append({
                                "query": getattr(event, 'query', ''),
                                "status": "completed"
                            })
                        elif event.type == "response.completed":
                            final_response = event.response
                    # Fallback: accumulate text from any text-like events
                    elif hasattr(event, 'delta') and event.delta:
                        content += event.delta

                return content, search_info, final_response

            content, search_info, final_response = await self._run_with_retry(_stream_and_collect)

            # Extract usage from final response
            usage = {}
            if final_response and hasattr(final_response, 'usage'):
                usage = {
                    "prompt_tokens": final_response.usage.input_tokens,
                    "completion_tokens": final_response.usage.output_tokens,
                    "total_tokens": final_response.usage.input_tokens + final_response.usage.output_tokens,
                }

            return LLMResponse(
                content=content,
                model=model_name,
                usage=usage,
                raw_response=final_response,
                metadata={
                    "search_enabled": True,
                    "search_queries": search_info
                }
            )

        except Exception as e:
            raise RuntimeError(f"OpenAI web search failed for {model_name}: {e}")

    async def complete_with_schema(
        self,
        messages: list[dict[str, str]],
        schema: type[BaseModel],
        system: str | None = None,
        model: str | None = None,
        max_tokens: int = 1024,
        extended_thinking: bool = False,
    ) -> BaseModel:
        """Generate a structured completion using function calling."""
        self._ensure_client()

        model_name = model or self.default_model

        # Get JSON schema from Pydantic model
        json_schema = schema.model_json_schema()

        # Build messages with system prompt
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": self._flatten_system(system)})
        full_messages.extend(messages)

        # Create function for structured output
        tools = [{
            "type": "function",
            "function": {
                "name": "respond",
                "description": f"Provide your response as a {schema.__name__}",
                "parameters": json_schema
            }
        }]

        # Generate response with function calling using streaming
        try:
            if "gpt-5" in model_name or "o1" in model_name:
                kwargs = {
                    "model": model_name,
                    "messages": full_messages,
                    "max_completion_tokens": max_tokens,
                    "tools": tools,
                    "tool_choice": {"type": "function", "function": {"name": "respond"}},
                    "stream": True,
                    "stream_options": {"include_usage": True}
                }
                if extended_thinking:
                    kwargs["reasoning_effort"] = "medium"
                    kwargs["max_completion_tokens"] = max(max_tokens, 8192)
            else:
                kwargs = {
                    "model": model_name,
                    "messages": full_messages,
                    "max_tokens": max_tokens,
                    "tools": tools,
                    "tool_choice": {"type": "function", "function": {"name": "respond"}},
                    "stream": True,
                    "stream_options": {"include_usage": True}
                }

            def _stream_and_collect():
                stream = self._client.chat.completions.create(**kwargs)
                tool_args = ""
                tool_name = ""
                content = ""
                final_usage = None

                for chunk in stream:
                    # Capture usage from final chunk
                    if hasattr(chunk, 'usage') and chunk.usage:
                        final_usage = chunk.usage

                    if not chunk.choices:
                        continue

                    delta = chunk.choices[0].delta

                    # Accumulate tool call arguments
                    if hasattr(delta, 'tool_calls') and delta.tool_calls:
                        tc = delta.tool_calls[0]
                        if hasattr(tc, 'function'):
                            if tc.function.name:
                                tool_name = tc.function.name
                            if tc.function.arguments:
                                tool_args += tc.function.arguments

                    # Also capture content if present
                    if delta.content:
                        content += delta.content

                return tool_name, tool_args, content, final_usage

            tool_name, tool_args, content, final_usage = await self._run_with_retry(_stream_and_collect)

        except Exception as e:
            if self._is_retryable(e):
                raise
            raise RuntimeError(f"OpenAI structured completion failed for {model_name}: {e}")

        # Parse the streamed tool call response
        if tool_name == "respond" and tool_args:
            try:
                data = json.loads(tool_args)
                return schema.model_validate(data)
            except (json.JSONDecodeError, Exception) as e:
                # Function call returned invalid JSON - try to repair
                try:
                    from ..agents.validator import get_validator
                    validator = get_validator()
                    repaired = await validator.repair_json(
                        broken_json=tool_args,
                        target_schema=schema,
                        error_msg=f"Function call returned invalid JSON: {e}"
                    )
                    if repaired:
                        return repaired
                except Exception as repair_error:
                    logger.error(f"Validator repair failed: {repair_error}")

        # Fallback: try to parse content as JSON
        if content:
            try:
                data = json.loads(content)
                return schema.model_validate(data)
            except (json.JSONDecodeError, Exception):
                pass

            # Last resort: validator repair on content
            try:
                from ..agents.validator import get_validator
                validator = get_validator()
                repaired = await validator.repair_json(
                    broken_json=content,
                    target_schema=schema,
                    error_msg="Function call did not return structured data"
                )
                if repaired:
                    return repaired
            except Exception as repair_error:
                logger.error(f"Validator repair failed: {repair_error}")

        raise ValueError("Could not parse structured response from OpenAI")

    async def complete_with_schema_and_search(
        self,
        messages: list[dict[str, str]],
        schema: type[BaseModel],
        system: str | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        extended_thinking: bool = False,
    ) -> BaseModel:
        """Generate a structured completion with web search.
        
        GPT-5 searches the web, then provides a structured response.
        """
        self._ensure_client()

        model_name = model or self.get_research_model()

        json_schema = schema.model_json_schema()

        # Build system prompt with schema
        schema_instruction = f"""
After researching using web search, provide your response as valid JSON matching this schema:
{json.dumps(json_schema, indent=2)}

Respond ONLY with the JSON object, no markdown formatting.
"""
        full_system = f"{system}\n\n{schema_instruction}" if system else schema_instruction

        # Build messages
        full_messages = []
        full_messages.append({"role": "system", "content": full_system})
        full_messages.extend(messages)

        # Enable web search
        tools = [{"type": "web_search"}]

        try:
            kwargs = {
                "model": model_name,
                "input": full_messages,
                "tools": tools,
                "max_output_tokens": max_tokens,
            }

            if extended_thinking:
                kwargs["reasoning"] = {"effort": "medium"}
                kwargs["max_output_tokens"] = max(max_tokens, 8192)

            response = await self._run_with_retry(
                lambda: self._client.responses.create(**kwargs)
            )

            # Extract content
            content = ""
            for output in response.output:
                if output.type == "message":
                    for block in output.content:
                        if hasattr(block, 'text'):
                            content += block.text

            # Parse JSON
            content = content.strip()
            if content.startswith("```"):
                lines = content.split("\n")
                json_lines = []
                in_block = False
                for line in lines:
                    if line.startswith("```"):
                        in_block = not in_block
                        continue
                    if in_block:
                        json_lines.append(line)
                content = "\n".join(json_lines)

            data = json.loads(content)
            return schema.model_validate(data)

        except json.JSONDecodeError as e:
            raise ValueError(f"Failed to parse JSON response: {e}\nResponse: {content}")
        except Exception as e:
            raise RuntimeError(f"OpenAI web search with schema failed: {e}")

    async def complete_with_tools(
        self,
        messages: list[dict[str, str]],
        tools: Any,  # ToolRegistry
        system: str | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        max_tool_rounds: int = 5,
    ) -> LLMResponse:
        """Run a tool-calling loop with OpenAI Chat Completions.
        
        Uses non-streaming chat.completions.create for clean tool_call extraction.
        The loop continues until the model produces a text response (no tool_calls)
        or max_tool_rounds is reached.
        """
        self._ensure_client()

        model_name = model or self.get_fast_model()

        # Convert ToolRegistry to OpenAI format
        openai_tools = tools.to_openai_format()

        # Build conversation with system prompt
        conversation = []
        if system:
            conversation.append({"role": "system", "content": self._flatten_system(system)})
        conversation.extend(messages)

        all_tool_calls = []
        total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        for round_num in range(max_tool_rounds):
            # Build kwargs with model-appropriate parameters
            if "gpt-5" in model_name or "o1" in model_name:
                kwargs = {
                    "model": model_name,
                    "messages": conversation,
                    "max_completion_tokens": max_tokens,
                    "tools": openai_tools,
                }
            else:
                kwargs = {
                    "model": model_name,
                    "messages": conversation,
                    "max_tokens": max_tokens,
                    "temperature": 0.3,  # Low temperature for tool-calling reasoning
                    "tools": openai_tools,
                }

            # Non-streaming for clean tool call extraction
            response = await self._run_with_retry(
                lambda kwargs=kwargs: self._client.chat.completions.create(**kwargs)
            )

            # Accumulate usage
            if response.usage:
                total_usage["prompt_tokens"] += response.usage.prompt_tokens or 0
                total_usage["completion_tokens"] += response.usage.completion_tokens or 0
                total_usage["total_tokens"] += response.usage.total_tokens or 0

            choice = response.choices[0] if response.choices else None
            if not choice:
                logger.info(f"Round {round_num+1}: No choices returned, ending loop")
                break

            message = choice.message

            # Check if the model returned tool calls
            if not message.tool_calls:
                # Model is done — returned text without tool calls
                final_text = message.content or ""
                logger.info(f"Round {round_num+1}: Final text ({len(final_text)} chars)")
                return LLMResponse(
                    content=final_text,
                    tool_calls=all_tool_calls,
                    model=model_name,
                    usage=total_usage,
                    raw_response=response,
                    metadata={"tool_rounds": round_num + 1}
                )

            # Execute tool calls
            logger.info(f"Round {round_num+1}: {len(message.tool_calls)} tool call(s)")

            # Add the assistant's message (with tool_calls) to conversation
            # Must serialize to dict format OpenAI expects
            assistant_msg = {"role": "assistant", "content": message.content or ""}
            assistant_msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    }
                }
                for tc in message.tool_calls
            ]
            conversation.append(assistant_msg)

            # Execute each tool and add results
            for tc in message.tool_calls:
                tool_name = tc.function.name
                try:
                    tool_args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                except json.JSONDecodeError:
                    tool_args = {}
                tool_call_id = tc.id

                logger.info(f"  [Tool] {tool_name}({tool_args})")

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

                # Add tool result as a tool message
                conversation.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": result_str,
                })

        # Hit max_tool_rounds — force a final text response without tools
        logger.info(f"Hit max rounds ({max_tool_rounds}), forcing final response")

        conversation.append({
            "role": "user",
            "content": "You've completed your research. Now produce your final response based on everything you've found."
        })

        # Final call without tools
        if "gpt-5" in model_name or "o1" in model_name:
            final_kwargs = {
                "model": model_name,
                "messages": conversation,
                "max_completion_tokens": max_tokens,
            }
        else:
            final_kwargs = {
                "model": model_name,
                "messages": conversation,
                "max_tokens": max_tokens,
                "temperature": 0.3,
            }

        final_response = await self._run_with_retry(
            lambda kwargs=final_kwargs: self._client.chat.completions.create(**kwargs)
        )

        final_text = ""
        if final_response.choices:
            final_text = final_response.choices[0].message.content or ""

        return LLMResponse(
            content=final_text,
            tool_calls=all_tool_calls,
            model=model_name,
            usage=total_usage,
            raw_response=final_response,
            metadata={"tool_rounds": max_tool_rounds, "forced_finish": True}
        )
