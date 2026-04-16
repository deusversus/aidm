# MockLLMProvider Testing Infrastructure Audit

## 1. MOCKLLMPROVIDER IMPLEMENTATION

**File:** `/home/jcettison/aidm/tests/conftest.py` (lines 35-143)

### Current Implementation

```python
class MockLLMProvider(LLMProvider):
    def __init__(self):
        super().__init__(api_key="mock-key", default_model="mock-model")
        self._response_queue: deque[LLMResponse] = deque()
        self._schema_queue: deque[BaseModel] = deque()
        self._call_history: list[dict[str, Any]] = []
```

**Supported Methods:**
1. `queue_response(content, **kwargs)` - Queue text responses
2. `queue_schema_response(instance: BaseModel)` - Queue Pydantic model instances
3. `call_history` property - Inspect all calls made (method, messages, system, model, schema)

**Implemented LLMProvider Interface Methods:**
- `complete()` - Returns queued LLMResponse or default "mock response"
- `complete_with_schema()` - Returns queued BaseModel or schema.model_construct()
- `complete_with_tools()` - Returns queued LLMResponse or default "mock tool response"
- `name`, `get_default_model()`, `get_fast_model()`, `get_creative_model()` - Stub implementations

### Limitations & Gaps

| Limitation | Impact | Severity |
|-----------|--------|----------|
| **No schema validation** | Queued instances never validated against expected schema | HIGH |
| **No queue underflow detection** | Empty queues silently fall back to defaults; tests may pass with wrong responses | HIGH |
| **No queue overflow warning** | Leftover queued responses never reported; may hide test bugs | MEDIUM |
| **No error simulation** | Cannot test error handling paths | MEDIUM |
| **No latency simulation** | Cannot test timeout/performance behavior | LOW |
| **No malformed response simulation** | Cannot test partial/corrupt response handling | MEDIUM |
| **Limited call inspection** | `call_history` only tracks method/metadata, not full request objects | LOW |
| **No per-method queuing** | Single `_response_queue` for all text methods; could queue responses for wrong method | MEDIUM |

---

## 2. HOW TESTS USE IT

### Fixture Pattern (`conftest.py`)

```python
@pytest.fixture
def mock_provider():
    return MockLLMProvider()

@pytest.fixture
def mock_llm_manager(mock_provider):
    manager = MagicMock()
    manager.get_provider.return_value = mock_provider
    manager.get_provider_for_agent.return_value = (mock_provider, "mock-model")
    with patch("src.llm.manager.get_llm_manager", return_value=manager):
        with patch("src.agents.base.get_llm_manager", return_value=manager):
            yield manager
```

### Test Patterns

#### Pattern 1: Single-response tests (`test_llm_provider.py`)
```python
async def test_complete_returns_queued(self, mock_provider):
    mock_provider.queue_response("Hello from mock")
    resp = await mock_provider.complete(messages=[{"role": "user", "content": "Hi"}])
    assert resp.content == "Hello from mock"
```

#### Pattern 2: Schema tests (`test_base_agent.py`, `test_sz_compiler.py`)
```python
async def test_call_routes_through_complete_with_schema(self, mock_llm_manager):
    agent = DummyAgent()
    expected = DummyOutput(answer="42")
    provider = mock_llm_manager.get_provider_for_agent.return_value[0]
    provider.queue_schema_response(expected)
    result = await agent.call("What is the answer?")
    assert result is not None
```

#### Pattern 3: Multi-pass pipeline (`test_sz_compiler.py`, `test_handoff_compiler.py`)
```python
def _queue_full_pipeline_responses(self, mock_provider, session_id="test-session"):
    from src.agents.session_zero_schemas import (
        ExtractionPassOutput, EntityResolutionOutput, GapAnalysisOutput,
    )
    mock_provider.queue_schema_response(ExtractionPassOutput(chunk_start_index=0, chunk_end_index=6))
    mock_provider.queue_schema_response(EntityResolutionOutput())
    mock_provider.queue_schema_response(GapAnalysisOutput(handoff_safe=True))
    mock_provider.queue_schema_response(_make_package(session_id))
```

**Usage:** HandoffCompiler runs 4 sequential agents, each expecting ONE specific schema type in order.

#### Pattern 4: Call history inspection (`test_base_agent.py`)
```python
result = await agent.call("Test", system_prompt_override="Custom prompt")
call = provider.call_history[-1]
assert call["system"] == "Custom prompt"
```

#### Pattern 5: Error simulation (via monkey-patching, `test_pacing_directive.py`)
```python
async def failing_complete(*args, **kwargs):
    raise Exception("LLM unavailable")
provider.complete_with_schema = failing_complete
result = await pacing_agent.check(...)  # Test error handling
```

#### Pattern 6: Queue clearing (emergency, `test_sz_compiler.py:294`)
```python
mock_provider._schema_queue.clear()  # Force underflow condition
```

---

## 3. QUEUE_SCHEMA_RESPONSE vs OTHER METHODS

### Distinction

| Method | Queue | Purpose | Validation |
|--------|-------|---------|-----------|
| `queue_response(content, **kwargs)` | `_response_queue` (deque[LLMResponse]) | Text responses for `complete()` | **NONE** |
| `queue_schema_response(instance)` | `_schema_queue` (deque[BaseModel]) | Structured responses for `complete_with_schema()` | **NONE** |
| `queue_response()` (reused) | `_response_queue` | Tool responses for `complete_with_tools()` | **NONE** |

### Critical Gap: NO SCHEMA VALIDATION

**Expected behavior:** `queue_schema_response(instance: BaseModel)` should validate that `instance` matches the schema expected by the calling agent.

**Actual behavior:** The instance is stored as-is and returned blindly. **Type safety is completely lost.**

**Example:**
```python
provider.queue_schema_response(ExtractionPassOutput(...))  # Queued
result = await resolver.resolve_entities(...)              # Expects EntityResolutionOutput
# ERROR: received ExtractionPassOutput instead, but no error is raised!
# Test silently uses wrong data.
```

**Impact:** Tests can pass with completely wrong responses because there's no enforcement that queued responses match the actual schema expected by agents.

---

## 4. UNDERFLOW & OVERFLOW HANDLING

### Queue Underflow (Empty Queue)

**Current Behavior:**

```python
async def complete_with_schema(self, messages, schema, ...):
    if self._schema_queue:
        return self._schema_queue.popleft()
    return schema.model_construct()  # Returns instance with all defaults
```

**What happens:**
- If queue is empty, `model_construct()` is called with no arguments
- Pydantic creates an instance using field defaults
- **Test continues silently with default data**
- Test may pass when it should fail

**Example:**
```python
# Forgot to queue a response for the 4th agent
mock_provider.queue_schema_response(ExtractionPassOutput(...))
mock_provider.queue_schema_response(EntityResolutionOutput())
mock_provider.queue_schema_response(GapAnalysisOutput(...))
# Missing: mock_provider.queue_schema_response(_make_package(...))

result = await compiler.run()
# The 4th pass gets: OpeningStatePackage() with all empty/default fields
# Test might still pass if defaults happen to work!
```

**Text Completion Underflow:**

```python
async def complete(self, messages, ...):
    if self._response_queue:
        return self._response_queue.popleft()
    return LLMResponse(content="mock response", model="mock-model")
```

**What happens:**
- Returns a generic "mock response" string
- Tests using this may pass even if they expected specific content

### Queue Overflow (Leftover Responses)

**Current Behavior:** No detection whatsoever.

```python
mock_provider.queue_response("Response A")
mock_provider.queue_response("Response B")
mock_provider.queue_response("Response C")

await agent.call(...)  # Pops "Response A"
await agent.call(...)  # Pops "Response B"
# Leftover: "Response C" never consumed

# Test passes. No warning about leftover data.
```

**Impact:** Indicates test is not calling LLM the expected number of times, but this goes undetected.

### Current Tests Don't Detect These Issues

Only one test explicitly clears the queue to test failure:
```python
mock_provider._schema_queue.clear()  # test_compiler_run_failure_is_non_blocking
```

No tests check:
- ✗ Underflow detection (expected N calls, got <N)
- ✗ Overflow detection (expected N calls, got >N)
- ✗ Mismatch detection (queued schema type ≠ expected schema type)

---

## 5. ADVANCED FEATURES SUPPORT

| Feature | Supported | How | Notes |
|---------|-----------|-----|-------|
| **Error simulation** | ⚠️ Limited | Manual monkey-patch: `provider.complete_with_schema = async_func` | Not integrated; fragile |
| **Latency simulation** | ✗ NO | — | No async delay capability |
| **Partial/malformed responses** | ✗ NO | — | Cannot queue incomplete Pydantic models |
| **Response inspection** | ✓ Partial | `call_history` property | Only tracks method/metadata; no request bodies or full context |
| **Model validation** | ✗ NO | — | No validation that queued response matches schema |
| **Call counting** | ✓ Yes | `len(call_history)` | Works but no assertion helpers |
| **Per-method response tracking** | ✗ NO | — | Mixed queues can cause wrong response for wrong method |

---

## 6. BUGS & FRAGILE PATTERNS IDENTIFIED

### BUG #1: Mixed Queue for Text Responses (MEDIUM SEVERITY)

**Location:** `conftest.py:97-99, 137-139`

```python
# Both complete() and complete_with_tools() pop from SAME queue
async def complete(self, ...):
    if self._response_queue:
        return self._response_queue.popleft()
    return LLMResponse(content="mock response", ...)

async def complete_with_tools(self, ...):
    if self._response_queue:
        return self._response_queue.popleft()  # Same queue!
    return LLMResponse(content="mock tool response", ...)
```

**Problem:** Test can queue a response intending it for `complete()`, but if an agent first calls `complete_with_tools()`, the response is consumed by the wrong method.

**Example:**
```python
provider.queue_response("Agent answer")
result1 = await agent.call_with_tools(...)  # Pops "Agent answer" meant for regular call
result2 = await agent.call(...)              # Queue now empty, gets default "mock response"
# Test expects specific answer in result2 but gets generic response
```

### BUG #2: model_construct() With No Arguments (MEDIUM SEVERITY)

**Location:** `conftest.py:120`

```python
async def complete_with_schema(self, messages, schema, ...):
    if self._schema_queue:
        return self._schema_queue.popleft()
    return schema.model_construct()  # No kwargs!
```

**Problem:** Some Pydantic schemas have `required` fields with no defaults. Calling `model_construct()` without arguments will:
1. Bypass validation (as intended)
2. **Create instances with unset required fields** (not intended)
3. May cause KeyError or AttributeError downstream

**Example:**
```python
class RequiredSchema(BaseModel):
    required_field: str  # No default!

# Forget to queue response
result = await agent.complete_with_schema(..., schema=RequiredSchema)
# result.required_field doesn't exist!
# agent.field_summary → KeyError
```

### BUG #3: No Per-Call Schema Tracking (MEDIUM SEVERITY)

**Location:** `conftest.py:110-120`

```python
async def complete_with_schema(self, messages, schema, ...):
    self._call_history.append({
        "method": "complete_with_schema",
        "messages": messages,
        "schema": schema,  # Only the class, not instance
        "system": system,
        "model": model,
    })
    if self._schema_queue:
        return self._schema_queue.popleft()
```

**Problem:** Stores the **schema class**, not the instance that was queued. No way to verify that queued response matches expected schema.

**Example:**
```python
provider.queue_schema_response(ExtractionPassOutput(...))
await resolver.resolve_entities(...)
# call_history shows schema=EntityResolutionOutput (expected)
# But queued was ExtractionPassOutput (wrong!)
# No way to detect the mismatch
```

### BUG #4: Fragile Pipeline Queueing Order (HIGH SEVERITY)

**Location:** All multi-pass tests (test_sz_compiler.py, test_handoff_compiler.py, test_phase2_enrichment.py)

```python
def _queue_full_pipeline_responses(self, mock_provider, session_id="test-session"):
    mock_provider.queue_schema_response(ExtractionPassOutput(...))          # [0]
    mock_provider.queue_schema_response(EntityResolutionOutput())           # [1]
    mock_provider.queue_schema_response(GapAnalysisOutput(...))             # [2]
    mock_provider.queue_schema_response(_make_package(session_id))          # [3]
```

**Problem:** Order is implicit. If any agent is called out of sequence or skipped, queues become misaligned.

**Example:**
```python
# If error handling causes retry of pass 1:
await extractor.extract()     # Pops [0] ✓
await extractor.extract()     # Pops [1] but expected [0]! ✗
# Queued EntityResolutionOutput is used for extraction
# No error; test silently gets wrong data
```

**Current Test Reliance:** Entire test suite assumes perfect call sequencing. One agent skip = cascading failures.

### BUG #5: Direct Queue Access (FRAGILE PATTERN)

**Location:** `test_sz_compiler.py:294`

```python
mock_provider._schema_queue.clear()  # Direct access to private attribute
```

**Problem:**
- Tests accessing private `_schema_queue` and `_response_queue` directly
- Breaks encapsulation; future refactoring will break tests
- No public API for clearing/debugging queues

**Better approach:**
```python
provider.clear_queues()  # Public method
assert provider.queue_size() == 0
```

### BUG #6: Call History Does Not Track Response (LOW SEVERITY)

**Location:** `conftest.py:91-96`

```python
self._call_history.append({
    "method": "complete",
    "messages": messages,
    "system": system,
    "model": model,
    # Missing: "response" or "queued_response"
})
```

**Problem:** Can inspect what was requested, but cannot verify what was returned.

**Example:**
```python
provider.queue_response("Answer 42")
await agent.call(...)
call = provider.call_history[0]
assert call["response"] == "Answer 42"  # KeyError: 'response'
```

---

## 7. MISSING CAPABILITIES FOR ROBUST TESTING

### High Priority

1. **Schema Validation on Queue**
   ```python
   def queue_schema_response(self, instance: BaseModel, expected_schema: type[BaseModel] = None):
       if expected_schema and not isinstance(instance, expected_schema):
           raise TypeError(f"Expected {expected_schema}, got {type(instance)}")
       self._schema_queue.append(instance)
   ```

2. **Queue Underflow Detection**
   ```python
   async def complete_with_schema(self, messages, schema, ...):
       if not self._schema_queue:
           raise RuntimeError(
               f"Queue underflow! Expected {schema.__name__} but queue is empty. "
               f"Did you forget to queue_schema_response()?"
           )
       return self._schema_queue.popleft()
   ```

3. **Queue Overflow Detection**
   ```python
   def assert_queue_empty(self, method_name: str = ""):
       if self._response_queue or self._schema_queue:
           resp_count = len(self._response_queue)
           schema_count = len(self._schema_queue)
           raise AssertionError(
               f"Queue overflow! {resp_count} text responses and {schema_count} schema "
               f"responses remain after {method_name or 'all calls'}. "
               f"Did you queue too many responses?"
           )
   ```

4. **Separate Queues by Method**
   ```python
   def __init__(self):
       self._complete_queue = deque()
       self._schema_queue = deque()
       self._tools_queue = deque()
   ```

5. **Per-Call Schema Tracking**
   ```python
   self._call_history.append({
       "method": "complete_with_schema",
       "requested_schema": schema.__name__,
       "queued_schema": type(returned_instance).__name__,
       "match": isinstance(returned_instance, schema),
   })
   ```

### Medium Priority

6. **Error Simulation**
   ```python
   def queue_error(self, exception: Exception, for_method: str = "any"):
       """Queue an exception to be raised on next call."""
   ```

7. **Latency Simulation**
   ```python
   def queue_response(self, content, latency_ms: int = 0):
       """Queue response with simulated latency."""
   ```

8. **Malformed Response**
   ```python
   def queue_malformed_json(self, content="invalid json"):
       """Queue unparseable response."""
   ```

9. **Response Inspection Helpers**
   ```python
   def get_last_call(self) -> dict[str, Any]:
       return self._call_history[-1] if self._call_history else None
   
   def calls_to_method(self, method_name: str) -> list[dict]:
       return [c for c in self._call_history if c["method"] == method_name]
   
   def get_call_count(self, method_name: str = None) -> int:
       if method_name:
           return len(self.calls_to_method(method_name))
       return len(self._call_history)
   ```

### Low Priority

10. **Debug Mode**
    ```python
    def set_debug(self, enabled: bool = True):
        """Log all queue operations."""
    ```

---

## 8. SUMMARY TABLE

| Aspect | Status | Grade | Notes |
|--------|--------|-------|-------|
| **Basic text responses** | ✓ Works | A | Functional for simple tests |
| **Schema responses** | ⚠️ Fragile | D+ | No validation; underflow silent |
| **Multi-pass pipelines** | ⚠️ Fragile | D | Relies on perfect call order; no sync checking |
| **Error handling** | ✗ Missing | F | Manual monkey-patch required |
| **Call inspection** | ⚠️ Limited | C | call_history works but incomplete |
| **Queue safety** | ✗ None | F | No overflow/underflow detection |
| **Test reliability** | ⚠️ Medium | C | Tests can pass with wrong responses |
| **Maintainability** | ⚠️ Poor | D | Direct private attribute access; implicit ordering |

---

## 9. RECOMMENDED ACTIONS

### Immediate (Critical)
- [ ] Add `queue_schema_response(instance, expected_schema)` with type checking
- [ ] Replace silent underflow with `RuntimeError`
- [ ] Add `assert_queue_empty()` helper for end-of-test verification
- [ ] Create separate queues for `complete()` vs `complete_with_tools()`

### Short Term (High Value)
- [ ] Add public `clear_queues()` and `queue_size()` methods
- [ ] Track returned schema in `call_history`
- [ ] Add `calls_to_method(name)` and `get_call_count(name)` helpers
- [ ] Document expected call sequences in multi-pass tests

### Medium Term (Nice to Have)
- [ ] Error simulation via `queue_error(exception)`
- [ ] Latency simulation
- [ ] Malformed response queuing
- [ ] Debug mode with logging

### Long Term (Consider)
- [ ] Pytest plugin for automatic queue verification
- [ ] Test harness that validates agent contracts
- [ ] Fixture that auto-detects call sequence from agent definitions

