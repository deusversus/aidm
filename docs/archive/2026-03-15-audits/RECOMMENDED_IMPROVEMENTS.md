# MockLLMProvider - Recommended Improvements with Code Examples

## Problem 1: Schema Validation

### Current Code (Vulnerable)
```python
def queue_schema_response(self, instance: BaseModel):
    """Queue a structured (Pydantic) response."""
    self._schema_queue.append(instance)  # No validation!
```

### Recommended Fix
```python
def queue_schema_response(self, instance: BaseModel, expected_schema: type[BaseModel] = None):
    """Queue a structured response with optional schema validation.
    
    Args:
        instance: The Pydantic model instance to queue
        expected_schema: Optional schema class to validate against
    
    Raises:
        TypeError: If instance doesn't match expected_schema
    """
    if expected_schema and not isinstance(instance, expected_schema):
        raise TypeError(
            f"Schema mismatch! Expected {expected_schema.__name__}, "
            f"got {type(instance).__name__}"
        )
    self._schema_queue.append(instance)

# Usage:
provider.queue_schema_response(
    ExtractionPassOutput(...), 
    expected_schema=ExtractionPassOutput  # Validates type
)
```

---

## Problem 2: Queue Underflow

### Current Code (Silent Failure)
```python
async def complete_with_schema(self, messages, schema, system=None, model=None, 
                               max_tokens=1024, extended_thinking=False) -> BaseModel:
    self._call_history.append({...})
    if self._schema_queue:
        return self._schema_queue.popleft()
    # Silent fallback!
    return schema.model_construct()  # Defaults; test may pass anyway!
```

### Recommended Fix
```python
async def complete_with_schema(self, messages, schema, system=None, model=None, 
                               max_tokens=1024, extended_thinking=False) -> BaseModel:
    self._call_history.append({...})
    if self._schema_queue:
        return self._schema_queue.popleft()
    
    # FAIL LOUDLY instead of silent defaults
    raise RuntimeError(
        f"Queue underflow in complete_with_schema()! "
        f"Expected {schema.__name__} but queue is empty. "
        f"Did you forget to call queue_schema_response()? "
        f"Call history: {len(self._call_history)} calls made. "
        f"Queued items: {len(self._schema_queue)} remaining."
    )

# Same for complete() and complete_with_tools()
```

---

## Problem 3: Queue Overflow

### Recommended Enhancement
```python
def assert_queue_empty(self, method_name: str = ""):
    """Verify all queued responses have been consumed.
    
    Call at end of test to detect over-queuing.
    
    Raises:
        AssertionError: If any responses remain in queues
    """
    resp_count = len(self._response_queue)
    schema_count = len(self._schema_queue)
    tools_count = len(self._tools_queue) if hasattr(self, '_tools_queue') else 0
    
    total = resp_count + schema_count + tools_count
    if total > 0:
        raise AssertionError(
            f"Queue overflow detected! {total} unconsummed responses "
            f"(text={resp_count}, schema={schema_count}, tools={tools_count}). "
            f"Expected {len(self._call_history)} calls but got "
            f"{len(self._call_history) - total} consumed. "
            f"{method_name or 'Test is over-queuing responses.'}"
        )

# Usage in test teardown:
async def test_compiler_run(self, mock_provider):
    # ... test code ...
    mock_provider.assert_queue_empty("TestCompilerRun")  # Verify clean
```

---

## Problem 4: Mixed Queues for Text Methods

### Current Code (Vulnerable)
```python
# Both methods share _response_queue!
async def complete(self, messages, ...):
    if self._response_queue:
        return self._response_queue.popleft()

async def complete_with_tools(self, messages, ...):
    if self._response_queue:  # Same queue!
        return self._response_queue.popleft()
```

### Recommended Fix
```python
class MockLLMProvider(LLMProvider):
    def __init__(self):
        super().__init__(api_key="mock-key", default_model="mock-model")
        self._complete_queue: deque[LLMResponse] = deque()      # For complete()
        self._tools_queue: deque[LLMResponse] = deque()         # For complete_with_tools()
        self._schema_queue: deque[BaseModel] = deque()
        self._call_history: list[dict[str, Any]] = []

    def queue_response(self, content: str = "", for_complete_method: bool = True, **kwargs):
        """Queue a text response.
        
        Args:
            content: Response text
            for_complete_method: True=queue for complete(), False=queue for complete_with_tools()
        """
        response = LLMResponse(content=content, model="mock-model", **kwargs)
        if for_complete_method:
            self._complete_queue.append(response)
        else:
            self._tools_queue.append(response)

    async def complete(self, messages, ...):
        if self._complete_queue:
            return self._complete_queue.popleft()
        raise RuntimeError("complete() queue is empty - forgot to queue_response()?")

    async def complete_with_tools(self, messages, ...):
        if self._tools_queue:
            return self._tools_queue.popleft()
        raise RuntimeError("complete_with_tools() queue is empty - forgot queue_response(for_complete_method=False)?")

# Usage:
provider.queue_response("Answer", for_complete_method=True)
provider.queue_response("Tool result", for_complete_method=False)
```

---

## Problem 5: No Response Tracking

### Current Code (Limited)
```python
self._call_history.append({
    "method": "complete_with_schema",
    "messages": messages,
    "schema": schema,           # Only the class!
    "system": system,
    "model": model,
    # Missing: what was actually returned!
})
```

### Recommended Fix
```python
async def complete_with_schema(self, messages, schema, system=None, model=None, 
                               max_tokens=1024, extended_thinking=False) -> BaseModel:
    # ... get response from queue ...
    response = self._schema_queue.popleft()
    
    # Track what was returned, not just what was requested
    self._call_history.append({
        "method": "complete_with_schema",
        "messages": messages,
        "requested_schema": schema.__name__,
        "returned_schema": type(response).__name__,
        "schema_mismatch": not isinstance(response, schema),  # Auto-detect!
        "system": system,
        "model": model,
        "response": response,  # Store the actual response
    })
    
    if self._call_history[-1]["schema_mismatch"]:
        # Auto-detect mismatches in strict mode
        if getattr(self, "_strict_mode", False):
            raise TypeError(
                f"Schema mismatch! Queued {type(response).__name__} "
                f"but {schema.__name__} expected."
            )
    
    return response
```

---

## Problem 6: Fragile Pipeline Ordering

### Current Code (No Sync)
```python
def _queue_full_pipeline_responses(self, mock_provider):
    # Order is implicit; no way to enforce or verify
    mock_provider.queue_schema_response(ExtractionPassOutput(...))      # [0]
    mock_provider.queue_schema_response(EntityResolutionOutput())       # [1]
    mock_provider.queue_schema_response(GapAnalysisOutput(...))         # [2]
    mock_provider.queue_schema_response(_make_package(session_id))      # [3]
    # If agents called out of order, queues become misaligned with no error
```

### Recommended Fix - Method 1: Labeled Queues
```python
class MockLLMProvider(LLMProvider):
    def __init__(self):
        # Named queues instead of positional
        self._labeled_queues: dict[str, deque] = {}
        
    def queue_schema_for_agent(self, agent_name: str, instance: BaseModel):
        """Queue a response for a specific agent (idempotent)."""
        if agent_name not in self._labeled_queues:
            self._labeled_queues[agent_name] = deque()
        self._labeled_queues[agent_name].append(instance)
    
    async def complete_with_schema(self, messages, schema, system=None, model=None, ...):
        # Agents register themselves
        agent_name = self._infer_agent_from_schema(schema)
        if agent_name in self._labeled_queues:
            return self._labeled_queues[agent_name].popleft()
        raise RuntimeError(f"No queued response for {agent_name} ({schema.__name__})")
        
# Usage - clearer intent:
provider.queue_schema_for_agent("extractor", ExtractionPassOutput(...))
provider.queue_schema_for_agent("resolver", EntityResolutionOutput())
provider.queue_schema_for_agent("gap_analyzer", GapAnalysisOutput(...))
provider.queue_schema_for_agent("handoff", OpeningStatePackage(...))
# Now if agents called out of order, they'll get correct response
```

### Recommended Fix - Method 2: Sequence Validation
```python
class MockLLMProvider(LLMProvider):
    def __init__(self):
        self._expected_schema_sequence: list[type[BaseModel]] = []
        self._schema_queue: deque[BaseModel] = deque()
        self._call_sequence: list[type[BaseModel]] = []
    
    def set_expected_schema_sequence(self, *schemas: type[BaseModel]):
        """Define the expected call sequence."""
        self._expected_schema_sequence = list(schemas)
    
    async def complete_with_schema(self, messages, schema, ...):
        # Track actual sequence
        self._call_sequence.append(schema)
        
        # Validate against expected
        idx = len(self._call_sequence) - 1
        if idx < len(self._expected_schema_sequence):
            expected = self._expected_schema_sequence[idx]
            if schema != expected:
                raise RuntimeError(
                    f"Call sequence mismatch at position {idx}! "
                    f"Expected {expected.__name__}, got {schema.__name__}. "
                    f"Full sequence: {[s.__name__ for s in self._call_sequence]}"
                )
        
        return self._schema_queue.popleft()

# Usage:
provider.set_expected_schema_sequence(
    ExtractionPassOutput,
    EntityResolutionOutput,
    GapAnalysisOutput,
    OpeningStatePackage,
)
provider.queue_schema_response(ExtractionPassOutput(...))
# ... etc ...
# If agents called wrong order, error immediately!
```

---

## Problem 7: Direct Private Attribute Access

### Current Code (Breaks Encapsulation)
```python
# In tests:
mock_provider._schema_queue.clear()  # BAD: accessing private attribute
```

### Recommended Fix
```python
class MockLLMProvider(LLMProvider):
    def clear_queues(self):
        """Clear all queued responses."""
        self._complete_queue.clear()
        self._tools_queue.clear()
        self._schema_queue.clear()
    
    def queue_size(self) -> dict[str, int]:
        """Get current queue depths."""
        return {
            "complete": len(self._complete_queue),
            "tools": len(self._tools_queue),
            "schema": len(self._schema_queue),
            "total": (len(self._complete_queue) + len(self._tools_queue) + 
                     len(self._schema_queue)),
        }

# Usage in tests:
provider.clear_queues()  # GOOD: public API
assert provider.queue_size()["schema"] == 0
```

---

## Problem 8: Error Simulation

### Current Workaround (Manual Monkey-Patching)
```python
# In test:
async def failing_complete(*args, **kwargs):
    raise Exception("LLM unavailable")
provider.complete_with_schema = failing_complete  # Monkey patch
```

### Recommended Built-In Solution
```python
class MockLLMProvider(LLMProvider):
    def __init__(self):
        # ... existing init ...
        self._error_queues: dict[str, deque[Exception]] = {
            "complete": deque(),
            "complete_with_schema": deque(),
            "complete_with_tools": deque(),
        }
    
    def queue_error(self, exception: Exception, for_method: str = "complete_with_schema"):
        """Queue an exception to be raised on next call to method.
        
        Args:
            exception: The exception to raise
            for_method: "complete", "complete_with_schema", or "complete_with_tools"
        """
        if for_method not in self._error_queues:
            raise ValueError(f"Unknown method: {for_method}")
        self._error_queues[for_method].append(exception)
    
    async def complete_with_schema(self, messages, schema, ...):
        # Check error queue first
        if self._error_queues["complete_with_schema"]:
            raise self._error_queues["complete_with_schema"].popleft()
        
        # Normal flow
        if self._schema_queue:
            return self._schema_queue.popleft()
        raise RuntimeError("Queue empty")

# Usage in test:
provider.queue_error(
    RuntimeError("API rate limit"),
    for_method="complete_with_schema"
)
with pytest.raises(RuntimeError, match="rate limit"):
    await agent.call(...)
```

---

## Problem 9: No Latency Simulation

### Recommended Addition
```python
import asyncio
import time

class MockLLMProvider(LLMProvider):
    def __init__(self):
        # ... existing init ...
        self._latency_queue: deque[float] = deque()  # milliseconds
        self._default_latency_ms: float = 0.0
    
    def queue_response(self, content: str = "", latency_ms: float = None, **kwargs):
        """Queue a text response with optional latency.
        
        Args:
            latency_ms: Simulate response latency (milliseconds)
        """
        response = LLMResponse(content=content, model="mock-model", **kwargs)
        self._complete_queue.append(response)
        if latency_ms is not None:
            self._latency_queue.append(latency_ms / 1000.0)
    
    def set_default_latency(self, latency_ms: float):
        """Set default latency for all responses."""
        self._default_latency_ms = latency_ms / 1000.0
    
    async def complete(self, messages, ...):
        # Apply latency if queued
        if self._latency_queue:
            latency = self._latency_queue.popleft()
        else:
            latency = self._default_latency_ms
        
        if latency > 0:
            await asyncio.sleep(latency)
        
        if self._complete_queue:
            return self._complete_queue.popleft()
        raise RuntimeError("Queue empty")

# Usage in test:
provider.queue_response("Fast", latency_ms=10)
provider.queue_response("Slow", latency_ms=500)
start = time.time()
await provider.complete(...)  # Takes ~10ms
await provider.complete(...)  # Takes ~500ms
```

---

## Integration Example: Improved Multi-Pass Test

### Before (Fragile)
```python
def _queue_full_pipeline_responses(self, mock_provider, session_id="test-session"):
    # Silent ordering; no validation
    mock_provider.queue_schema_response(ExtractionPassOutput(...))
    mock_provider.queue_schema_response(EntityResolutionOutput())
    mock_provider.queue_schema_response(GapAnalysisOutput(...))
    mock_provider.queue_schema_response(_make_package(session_id))
```

### After (Robust)
```python
def _queue_full_pipeline_responses(self, mock_provider, session_id="test-session"):
    # Named queues + validation
    provider.queue_schema_for_agent("extractor", ExtractionPassOutput(...))
    provider.queue_schema_for_agent("resolver", EntityResolutionOutput())
    provider.queue_schema_for_agent("gap_analyzer", GapAnalysisOutput(...))
    provider.queue_schema_for_agent("handoff", _make_package(session_id))
    
    # Expected sequence validation
    provider.set_expected_schema_sequence(
        ExtractionPassOutput,
        EntityResolutionOutput,
        GapAnalysisOutput,
        OpeningStatePackage,
    )

async def test_compiler_run(self, mock_provider, fresh_db):
    self._queue_full_pipeline_responses(mock_provider)
    
    compiler = HandoffCompiler(...)
    result = await compiler.run()
    
    assert result.success
    # NEW: Verify all responses consumed
    mock_provider.assert_queue_empty("test_compiler_run")
    
    # NEW: Inspect what actually happened
    calls = mock_provider.calls_to_method("complete_with_schema")
    assert len(calls) == 4
    assert calls[0]["returned_schema"] == "ExtractionPassOutput"
    assert calls[1]["returned_schema"] == "EntityResolutionOutput"
```

---

## Summary: Phased Implementation

**Phase 1 (Immediate - 1 day):**
- Add schema validation to `queue_schema_response()`
- Replace silent underflow with `RuntimeError`
- Add `assert_queue_empty()`

**Phase 2 (Short term - 3 days):**
- Separate `_complete_queue` and `_tools_queue`
- Add response tracking to `call_history`
- Add helper methods: `calls_to_method()`, `get_call_count()`, `clear_queues()`, `queue_size()`

**Phase 3 (Medium term - 1 week):**
- Label-based queuing for complex pipelines
- Error/latency/malformed response simulation
- Strict mode with automatic mismatch detection

**Phase 4 (Long term - optional):**
- Pytest plugin for automatic queue verification
- Schema-aware fixture generation
