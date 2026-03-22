"""Anthropic Claude LLM provider."""

import json
import logging
import os
import time
from typing import Any

from pydantic import BaseModel

from .provider import LLMProvider, LLMResponse
from ..observability import get_current_agent, log_generation

logger = logging.getLogger(__name__)

# Anthropic OAuth constants
_ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
_ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
_ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"


class AnthropicProvider(LLMProvider):
    """Anthropic Claude provider implementation.

    Supports Claude model family:
    - Haiku 4.5: Fast, affordable for structured tasks
    - Sonnet 4.5: Balanced quality/speed for creative work
    - Sonnet 4.6: Latest Sonnet — fast, sharp, excellent coding
    - Opus 4.5: Previous-gen Opus, still excellent
    - Opus 4.6: Latest Opus — highest quality, nearly Sonnet pricing

    Also supports web search via the Anthropic API (May 2025+).

    Supports two auth methods:
    - API key (sk-ant-api03-*): Standard, via X-Api-Key header
    - OAuth token (sk-ant-oat01-*): Via Authorization: Bearer header,
      with automatic token refresh
    """

    def __init__(
        self,
        api_key: str = "",
        oauth_token: str = "",
        refresh_token: str = "",
        oauth_expires_at: float = 0.0,
    ):
        """Initialize with either API key or OAuth credentials.

        When both are provided, OAuth is preferred.
        """
        # Pass a non-empty string to base class to satisfy its contract.
        # We never use self.api_key from the base — _init_client handles auth.
        super().__init__(api_key=api_key or "oauth")

        self._api_key = api_key
        self._oauth_token = oauth_token
        self._refresh_token = refresh_token
        self._oauth_expires_at = oauth_expires_at
        self._using_oauth = bool(oauth_token)

    @property
    def name(self) -> str:
        return "anthropic"

    def get_default_model(self) -> str:
        return "claude-sonnet-4-6"

    def get_fast_model(self) -> str:
        return "claude-haiku-4-5"

    def get_creative_model(self) -> str:
        """Get creative model - defaults to Sonnet, can be set to Opus via env var."""
        preference = os.getenv("ANTHROPIC_CREATIVE_MODEL", "sonnet").lower()
        if preference == "opus":
            return "claude-opus-4-6"
        return "claude-sonnet-4-6"

    def get_opus_model(self) -> str:
        """Get Opus model explicitly."""
        return "claude-opus-4-6"

    # Models that support the 1M token context window via beta header.
    _1M_CONTEXT_MODELS = frozenset({"opus-4-6", "sonnet-4-6", "sonnet-4-5"})

    def _get_betas(self, model_name: str, base_betas: list[str] | None = None) -> list[str]:
        """Return the beta features list for the given model.

        - OAuth tokens require the ``oauth-2025-04-20`` beta header.
        - The ``context-1m`` beta is incompatible with OAuth tokens,
          so it's only added for API key auth.
        """
        betas = list(base_betas or [])

        if self._using_oauth:
            betas.append("oauth-2025-04-20")
            # context-1m is rejected when using OAuth — skip it
        else:
            if any(slug in model_name for slug in self._1M_CONTEXT_MODELS):
                betas.append("context-1m-2025-08-07")

        return betas

    def get_research_model(self) -> str:
        """Model optimized for research with web search."""
        return "claude-sonnet-4-6"

    def get_max_concurrent_requests(self) -> int:
        """Anthropic Tier 2+ can handle more concurrent requests."""
        return 10

    # ── Token management ───────────────────────────────────────────────────

    def _ensure_client(self):
        """Override: refresh OAuth token if needed, then init client.

        For API key auth, this is a no-op (token never expires).
        For OAuth auth, proactively refresh before expiry.
        """
        if self._using_oauth:
            needs_refresh = (
                self._oauth_expires_at > 0
                and time.time() >= self._oauth_expires_at - 120  # 120s buffer
            )
            if needs_refresh:
                try:
                    self._refresh_oauth_token()
                except Exception:
                    self._client = None
                    raise
                self._client = None  # force reinit with new token

        if self._client is None:
            self._init_client()

    def _refresh_oauth_token(self):
        """Synchronously refresh the OAuth access token using the refresh token."""
        import urllib.request
        import urllib.error

        if not self._refresh_token:
            raise RuntimeError(
                "Anthropic OAuth token expired and no refresh token available — "
                "please reconnect Anthropic in Settings."
            )

        logger.info("[anthropic] Refreshing OAuth token...")

        req = urllib.request.Request(
            _ANTHROPIC_TOKEN_URL,
            data=json.dumps({
                "grant_type": "refresh_token",
                "refresh_token": self._refresh_token,
                "client_id": _ANTHROPIC_CLIENT_ID,
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise RuntimeError(
                    "Anthropic OAuth refresh failed (authorization revoked) — "
                    "please reconnect Anthropic in Settings."
                ) from exc
            raise RuntimeError(
                f"Anthropic OAuth refresh failed (HTTP {exc.code})"
            ) from exc

        new_access = data.get("access_token", "")
        new_refresh = data.get("refresh_token", self._refresh_token)
        expires_in = data.get("expires_in", 3600)

        if not new_access:
            raise RuntimeError("Anthropic OAuth refresh returned no access_token")

        self._oauth_token = new_access
        self._refresh_token = new_refresh
        self._oauth_expires_at = time.time() + expires_in

        # Persist updated tokens
        try:
            from ..settings import get_settings_store
            get_settings_store().set_anthropic_oauth(
                new_access, new_refresh, self._oauth_expires_at
            )
        except Exception as e:
            logger.warning(f"[anthropic] Failed to persist refreshed tokens: {e}")

        logger.info(f"[anthropic] OAuth token refreshed, expires in {expires_in}s")

    def _init_client(self):
        """Initialize the Anthropic client with either API key or OAuth token.

        For OAuth:
        - Temporarily mask ``ANTHROPIC_API_KEY`` env var so the SDK doesn't
          auto-read it and add an invalid ``X-Api-Key`` header.
        - ``auth_token`` sends ``Authorization: Bearer <token>``
        - ``anthropic-beta: oauth-2025-04-20`` header is required
        """
        import os

        import anthropic

        if self._using_oauth and self._oauth_token:
            # The SDK reads ANTHROPIC_API_KEY from the environment even when
            # api_key=None is passed. Temporarily remove it so the client
            # only sends Authorization: Bearer.
            saved_key = os.environ.pop("ANTHROPIC_API_KEY", None)
            try:
                self._client = anthropic.AsyncAnthropic(
                    api_key=None,
                    auth_token=self._oauth_token,
                    default_headers={"anthropic-beta": "oauth-2025-04-20"},
                )
            finally:
                if saved_key is not None:
                    os.environ["ANTHROPIC_API_KEY"] = saved_key
        else:
            self._client = anthropic.AsyncAnthropic(api_key=self._api_key)

    @staticmethod
    def _build_system_blocks(system) -> list:
        """Convert system prompt to Anthropic cache-aware content blocks.
        
        Accepts either:
          - str: plain text (backward compatible, no caching)
          - list[tuple[str, bool]]: cache-aware blocks [(text, should_cache), ...]
        
        Returns an array of content blocks for Anthropic's system parameter.
        Blocks marked with should_cache=True get cache_control breakpoints,
        which tells Anthropic to cache that prefix for 5 minutes at 10%
        of base input token cost.
        """
        if not system:
            return ""

        # Plain string — no caching, backward compatible
        if isinstance(system, str):
            return system

        # List of (text, should_cache) tuples — build content blocks
        blocks = []
        for text, should_cache in system:
            if not text:
                continue
            block = {"type": "text", "text": text}
            if should_cache:
                block["cache_control"] = {"type": "ephemeral"}
            blocks.append(block)

        return blocks if blocks else ""

    async def complete(
        self,
        messages: list[dict[str, str]],
        system: str | None = None,
        model: str | None = None,
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
            "system": self._build_system_blocks(system),
            "messages": messages
        }

        # Extended thinking
        if extended_thinking:
            # Claude requires: budget_tokens < max_tokens
            # Using conservative values to stay within limits
            from .provider import THINKING_TOKEN_BUDGET
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": THINKING_TOKEN_BUDGET
            }
            # CRITICAL: Anthropic requires temperature=1 when thinking is enabled
            kwargs["temperature"] = 1.0
            # Ensure max_tokens > budget_tokens
            kwargs["max_tokens"] = max(max_tokens, 8192)

        # Use streaming to prevent truncation issues with long responses
        betas = self._get_betas(model_name)
        async def _stream_and_collect():
            full_text = ""
            final_message = None
            stream_ctx = (
                self._client.beta.messages.stream(**kwargs, betas=betas)
                if betas else
                self._client.messages.stream(**kwargs)
            )
            async with stream_ctx as stream:
                async for text in stream.text_stream:
                    full_text += text
                final_message = await stream.get_final_message()
            return full_text, final_message

        full_text, final_message = await self._call_with_retry(_stream_and_collect)

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
                logger.info(f"{cached_tokens} tokens cached ({cached_tokens/usage.get('prompt_tokens', 1)*100:.0f}% of prompt)")

        log_generation(
            agent_name=get_current_agent() or model_name,
            model=model_name,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
        )
        return LLMResponse(
            content=full_text,
            model=model_name,
            usage=usage,
            raw_response=final_message
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
            "system": self._build_system_blocks(system),
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
        betas = self._get_betas(model_name)
        async def _stream_and_collect():
            content = ""
            search_results = []
            citations = []
            final_message = None

            stream_ctx = (
                self._client.beta.messages.stream(**kwargs, betas=betas)
                if betas else
                self._client.messages.stream(**kwargs)
            )
            async with stream_ctx as stream:
                async for text in stream.text_stream:
                    content += text
                final_message = await stream.get_final_message()

            # Extract search metadata from final message
            if final_message:
                for block in final_message.content:
                    if hasattr(block, 'citations') and block.citations:
                        citations.extend(block.citations)
                    if hasattr(block, 'type'):
                        if block.type == "server_tool_use" and getattr(block, 'name', '') == "web_search":
                            search_results.append(getattr(block, 'input', {}))

            return content, search_results, citations, final_message

        content, search_results, citations, final_message = await self._call_with_retry(_stream_and_collect)

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
        messages: list[dict[str, str]],
        schema: type[BaseModel],
        system: str | None = None,
        model: str | None = None,
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
            "system": self._build_system_blocks(system),
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

            # For extended thinking, append instruction to the system prompt
            # Handle both plain string and cache block formats
            extra = "\n\nIMPORTANT: You must respond by calling the 'respond' tool to provide the structured output."
            if isinstance(system, list):
                # Append extra instruction to the last block (uncached)
                kwargs["system"] = self._build_system_blocks(system + [(extra, False)])
            else:
                system_instruction = system if system else ""
                kwargs["system"] = self._build_system_blocks([(system_instruction + extra, False)])
        else:
            kwargs["tool_choice"] = {"type": "tool", "name": "respond"}

        # Use streaming to prevent truncation with long responses
        betas = self._get_betas(model_name)
        async def _stream_and_collect():
            text_content = ""
            final_message = None
            stream_ctx = (
                self._client.beta.messages.stream(**kwargs, betas=betas)
                if betas else
                self._client.messages.stream(**kwargs)
            )
            async with stream_ctx as stream:
                async for text in stream.text_stream:
                    text_content += text
                final_message = await stream.get_final_message()
            return text_content, final_message

        text_content, final_message = await self._call_with_retry(_stream_and_collect)

        # Extract tool use response from final message
        if final_message:
            # Log token usage to current observability trace
            try:
                usage = getattr(final_message, "usage", None)
                if usage:
                    log_generation(
                        agent_name=get_current_agent() or schema.__name__,
                        model=model_name,
                        input_tokens=getattr(usage, "input_tokens", 0),
                        output_tokens=getattr(usage, "output_tokens", 0),
                    )
            except Exception:
                pass

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
                            logger.error(f"Validator repair failed: {repair_error}")

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
                logger.error(f"Validator repair failed: {repair_error}")

        raise ValueError("Could not parse structured response from Claude")

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
        schema_instruction = """
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

        # Route to beta.messages.create for models that need context-1m header
        betas = self._get_betas(model_name)
        if betas:
            response = await self._call_with_retry(
                self._client.beta.messages.create,
                betas=betas,
                **kwargs
            )
        else:
            response = await self._call_with_retry(
                self._client.messages.create,
                **kwargs
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

        raise ValueError("Could not parse structured response from Claude")

    async def complete_with_tools(
        self,
        messages: list[dict[str, str]],
        tools: Any,  # ToolRegistry
        system: str | None = None,
        model: str | None = None,
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

        model_name = model or self.get_fast_model()

        # Try programmatic tool calling first, fall back to standard
        try:
            result = await self._complete_with_tools_programmatic(
                messages, tools, system, model_name, max_tokens, max_tool_rounds
            )
        except Exception as e:
            logger.error(f"Programmatic tool calling failed ({e}), falling back to standard")
            result = await self._complete_with_tools_standard(
                messages, tools, system, model_name, max_tokens, max_tool_rounds
            )
        log_generation(
            agent_name=get_current_agent() or model_name,
            model=model_name,
            input_tokens=result.usage.get("prompt_tokens", 0) if result.usage else 0,
            output_tokens=result.usage.get("completion_tokens", 0) if result.usage else 0,
        )
        return result

    async def _complete_with_tools_programmatic(
        self,
        messages: list[dict[str, str]],
        tools: Any,  # ToolRegistry
        system: str | None,
        model_name: str,
        max_tokens: int,
        max_tool_rounds: int,
    ) -> LLMResponse:
        """Programmatic Tool Calling -- Claude writes code to orchestrate tools.
        
        Claude generates Python that calls tools as async functions inside a
        sandbox. The API pauses on each tool_use block and we provide results.
        Intermediate results stay in the sandbox, not in Claude's context.
        """

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
                "betas": self._get_betas(model_name, ["advanced-tool-use-2025-11-20"]),
                "max_tokens": max_tokens,
                "system": self._build_system_blocks(system),
                "messages": conversation,
                "tools": anthropic_tools,
            }
            if container_id:
                kwargs["container"] = container_id

            response = await self._call_with_retry(
                self._client.beta.messages.create,
                **kwargs
            )

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
                logger.info(f"Round {round_num+1}: Final text ({len(final_text)} chars) [{mode}]")
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
            logger.info(f"Round {round_num+1}: {len(tool_use_blocks)} tool call(s) [{mode_label}]")

            conversation.append({"role": "assistant", "content": assistant_content})

            tool_results = []
            for block in tool_use_blocks:
                tool_name = block.name
                tool_args = block.input if isinstance(block.input, dict) else {}
                tool_id = block.id

                logger.info(f"  [Tool] {tool_name}({tool_args})")

                result = await tools.async_execute(tool_name, tool_args, round_number=round_num)
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
        logger.info(f"Hit max rounds ({max_tool_rounds}), forcing final response [programmatic]")

        conversation.append({
            "role": "user",
            "content": "You've completed your research. Now produce your final response based on everything you've found."
        })

        final_response = await self._call_with_retry(
            self._client.beta.messages.create,
            model=model_name,
            betas=self._get_betas(model_name, ["advanced-tool-use-2025-11-20"]),
            max_tokens=max_tokens,
            system=system or "",
            messages=conversation,
        )

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
        messages: list[dict[str, str]],
        tools: Any,  # ToolRegistry
        system: str | None,
        model_name: str,
        max_tokens: int,
        max_tool_rounds: int,
    ) -> LLMResponse:
        """Standard (non-programmatic) tool calling -- fallback implementation.
        
        Uses standard messages.create with tool_use blocks. Each tool call
        is a separate round-trip through the model.
        """

        anthropic_tools = tools.to_anthropic_format()
        conversation = list(messages)
        all_tool_calls = []
        total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        for round_num in range(max_tool_rounds):
            kwargs = {
                "model": model_name,
                "max_tokens": max_tokens,
                "system": self._build_system_blocks(system),
                "messages": conversation,
                "tools": anthropic_tools,
            }

            betas = self._get_betas(model_name)
            if betas:
                response = await self._call_with_retry(
                    self._client.beta.messages.create,
                    betas=betas,
                    **kwargs
                )
            else:
                response = await self._call_with_retry(
                    self._client.messages.create,
                    **kwargs
                )

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
                logger.info(f"Round {round_num+1}: Final text ({len(final_text)} chars) [standard]")
                return LLMResponse(
                    content=final_text,
                    tool_calls=all_tool_calls,
                    model=model_name,
                    usage=total_usage,
                    raw_response=response,
                    metadata={"tool_rounds": round_num + 1, "programmatic": False}
                )

            logger.info(f"Round {round_num+1}: {len(tool_use_blocks)} tool call(s) [standard]")

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

                logger.info(f"  [Tool] {tool_name}({tool_args})")

                result = await tools.async_execute(tool_name, tool_args, round_number=round_num)
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

        logger.info(f"Hit max rounds ({max_tool_rounds}), forcing final response [standard]")

        conversation.append({
            "role": "user",
            "content": "You've completed your research. Now produce your final response based on everything you've found."
        })

        _betas = self._get_betas(model_name)
        if _betas:
            final_response = await self._call_with_retry(
                self._client.beta.messages.create,
                model=model_name,
                betas=_betas,
                max_tokens=max_tokens,
                system=system or "",
                messages=conversation,
            )
        else:
            final_response = await self._call_with_retry(
                self._client.messages.create,
                model=model_name,
                max_tokens=max_tokens,
                system=system or "",
                messages=conversation,
            )

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
