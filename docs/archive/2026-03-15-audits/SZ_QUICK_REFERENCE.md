# Session Zero Quick Reference Guide

## File Locations & Entry Points

| What | Where | Status |
|------|-------|--------|
| Handoff Compiler | `src/core/session_zero_compiler.py` | ✅ Complete |
| Compiler Schemas | `src/agents/session_zero_schemas.py` | ✅ Complete |
| DB Models | `src/db/models.py:SessionZeroRun, SessionZeroArtifact` | ✅ Complete |
| Artifact Helpers | `src/db/session_zero_artifacts.py` | ✅ Complete |
| Orchestrator Methods | `src/core/orchestrator.py:run_director_startup(), generate_opening_scene()` | ✅ Complete |
| Handoff Sequence | `api/routes/game/session_zero.py:_handle_gameplay_handoff()` | ✅ Complete |
| API Response | `api/routes/game/models.py:SessionZeroResponse` | ✅ Complete |
| Summary Builder | `api/routes/game/session_mgmt.py:_build_session_zero_summary()` | ✅ Complete |
| Tests | `tests/test_sz_compiler.py` | ⚠️ Needs expansion |
| Frontend | `web/js/app.js` | ⚠️ Basic handoff only |

---

## Key Classes & Signatures

### HandoffCompiler

```python
# Instantiate
compiler = HandoffCompiler(
    session_id: str,
    messages: list[dict],
    character_draft: dict,
    campaign_id: int | None,
    profile_context: str = "",
    tone_composition: dict = {},
    run_type: str = "handoff_compile"
)

# Run (async)
result: HandoffCompilerResult = await compiler.run()
# result.success: bool
# result.opening_state_package: OpeningStatePackage | None
# result.artifact_version: int | None
# result.run_id: int | None
# result.warnings: list[str]
# result.error: str | None

# Load artifacts post-compile
pkg = HandoffCompiler.load_active_package(session_id)
gap = HandoffCompiler.load_active_gap_analysis(session_id)
```

### Orchestrator Methods

```python
# Director startup (no return value, persists to bible)
await orchestrator.run_director_startup(
    session_zero_summary: str,
    character_name: str = "Unknown",
    character_concept: str = "",
    starting_location: str = "Unknown",
    power_tier: str | None = None,
    tension_source: str | None = None,
    power_expression: str | None = None,
    narrative_focus: str | None = None,
    composition_name: str | None = None,
    timeline_mode: str | None = None,
    canon_cast_mode: str | None = None,
    event_fidelity: str | None = None,
    opening_state_package: OpeningStatePackage | None = None,  # ← M2 requirement
)

# Opening scene generation (returns prose + portrait map)
narrative, portrait_map = await orchestrator.generate_opening_scene(
    opening_state_package: OpeningStatePackage,
    recent_messages: list[dict] | None = None,
)
# Returns: (str, dict[str, str])
# Raises: ValueError if opening_state_package is None
```

### SessionZeroResponse

```python
SessionZeroResponse(
    response: str,                                      # Agent dialogue
    phase: str,                                         # Current phase
    phase_complete: bool,                               # DEPRECATED
    character_draft: dict,                              # Current draft state
    session_id: str,                                    # Session UUID
    ready_for_gameplay: bool = False,                   # ← Primary gate
    
    # Handoff-specific fields:
    opening_scene: str | None = None,                   # Generated prose
    opening_portrait_map: dict[str, str] | None = None, # {NPC: /api/media/...}
    handoff_status: str | None = None,                  # complete|degraded|compiler_skipped|compiler_failed
    handoff_warnings: list[str] = [],                   # Non-blocking warnings
    gap_follow_up_prompt: str | None = None,            # Follow-up for gaps
    compiler_task_id: str | None = None,                # SSE progress stream ID
    compiler_artifact_version: int | None = None,       # Artifact version
)
```

### Database Persistence

```python
# Write artifacts in single transaction
from src.db.session_zero_artifacts import save_artifacts_transactional

run, saved = save_artifacts_transactional(
    session_id=session_id,
    artifacts={
        "opening_state_package": package,  # OpeningStatePackage
        "entity_graph": entity_output,      # EntityResolutionOutput
        "gap_analysis": gap_output,         # GapAnalysisOutput
    },
    run_type="handoff_compile",
    transcript_hash=compute_transcript_hash(messages),
    character_draft_hash=compute_draft_hash(draft_dict),
    run_metadata={
        "entities_extracted": 42,
        "entities_resolved": 38,
        "contradictions_found": 2,
        "unresolved_items": 1,
        "handoff_blocked": False,
        "checkpoints": [...]
    }
)
# Returns: (SessionZeroRun, {artifact_type: SessionZeroArtifact})
```

---

## OpeningStatePackage Structure (Minimal)

```python
OpeningStatePackage(
    package_metadata=PackageMetadata(
        session_id="uuid",
        campaign_id=42,
        created_at="2025-03-14T...",
        package_version=1,
        source_run_id=123,
        transcript_hash="sha256...",
        character_draft_hash="sha256...",
    ),
    readiness=PackageReadiness(
        handoff_status=HandoffStatus.OPENING_PACKAGE_READY,
        blocking_issues=[],
        warnings=[],
    ),
    player_character=PlayerCharacterBrief(
        name="Character Name",
        concept="Their archetype",
        appearance="How they look",
        personality="Who they are",
        goals={"short_term": "...", "long_term": "..."},
    ),
    opening_situation=OpeningSituation(
        starting_location="Where the scene begins",
        immediate_situation="What's happening right now",
        scene_question="What's the central dramatic question?",
        why_this_moment_is_the_start="Why start here?",
    ),
    # ... all other sections optional but recommended for quality
)
```

---

## Handoff Sequence (Simplified)

```
1. Settings sync + profile resolution
2. Index Session Zero to memory (vectorization)
3. reset_orchestrator() — fresh singleton with new campaign_id
4. Run HandoffCompiler (if enabled)
   ├─ Pass 1: Extract facts from transcript
   ├─ Pass 2: Resolve & deduplicate entities
   ├─ Pass 3: Gap analysis (detect contradictions, unresolved items)
   └─ Pass 4: Assemble OpeningStatePackage
5. Persist artifacts (transactional)
6. Update world state from package
7. Inject SZ context into memory
8. Director startup (briefing + arc planning)
9. Opening scene generation (dedicated pathway if enabled, else fallback)
10. Return SessionZeroResponse with opening_scene, handoff_status, warnings
```

---

## Config Flags

```python
# In src/config.py:
Config.SESSION_ZERO_COMPILER_ENABLED  # Default: False
Config.SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED  # Default: False
Config.SESSION_ZERO_ORCHESTRATOR_ENABLED  # Default: False (future)

# Set via environment:
export SESSION_ZERO_COMPILER_ENABLED=true
export SESSION_ZERO_DEDICATED_OPENING_SCENE_ENABLED=true
```

---

## Testing Quick Start

### Minimal Test

```python
import pytest
from src.core.session_zero_compiler import HandoffCompiler
from src.agents.session_zero_schemas import OpeningStatePackage

@pytest.mark.asyncio
async def test_compiler_basic():
    messages = [
        {"role": "user", "content": "I want to play a bounty hunter"},
        {"role": "assistant", "content": "Great! Let's build your character..."},
    ]
    draft = {
        "name": "Spike Spiegel",
        "concept": "Bounty hunter",
        "media_reference": "Cowboy Bebop",
        "backstory": "A man with a past",
    }
    
    compiler = HandoffCompiler(
        session_id="test-session",
        messages=messages,
        character_draft=draft,
        campaign_id=1,
    )
    
    result = await compiler.run()
    assert result.success
    assert result.opening_state_package is not None
    assert result.opening_state_package.player_character.name == "Spike Spiegel"
```

### Test with MockLLMProvider

```python
from unittest.mock import AsyncMock, patch

@pytest.mark.asyncio
async def test_compiler_with_mock():
    # Mock the extractor agent
    with patch("src.core.session_zero_compiler.SZExtractorAgent") as mock_extractor:
        mock_instance = AsyncMock()
        mock_instance.extract_chunk.return_value = ExtractionPassOutput(
            entity_records=[...],
            relationship_records=[...],
            fact_records=[...],
            opening_scene_cues=[...],
        )
        mock_extractor.return_value = mock_instance
        
        compiler = HandoffCompiler(...)
        result = await compiler.run()
        assert result.success
```

### Test Database Persistence

```python
from src.db.session_zero_artifacts import save_artifacts_transactional, get_active_artifact
from src.db.session import get_session

def test_artifact_versioning():
    session_id = "test-session"
    
    # Write version 1
    pkg1 = _make_package(session_id)
    run1, saved1 = save_artifacts_transactional(
        session_id=session_id,
        artifacts={"opening_state_package": pkg1},
        run_type="handoff_compile",
    )
    assert saved1["opening_state_package"].version == 1
    
    # Write version 2 (different content)
    pkg2 = _make_package(session_id)
    pkg2.player_character.name = "Different Name"
    run2, saved2 = save_artifacts_transactional(
        session_id=session_id,
        artifacts={"opening_state_package": pkg2},
        run_type="handoff_compile",
    )
    assert saved2["opening_state_package"].version == 2
    
    # Get active should return version 2
    with get_session() as db:
        active = get_active_artifact(db, session_id, "opening_state_package")
        assert active.version == 2
```

---

## Common Patterns

### Check if Handoff is Ready

```python
response: SessionZeroResponse = ...

# Old way (still works but fragile):
is_handoff = response.phase == "gameplay"

# New way (recommended):
is_handoff = response.ready_for_gameplay

# Check if opening scene is available:
if response.opening_scene:
    display_opening_scene(response.opening_scene)
    
# Check if there are warnings:
if response.handoff_status == "degraded":
    display_warnings(response.handoff_warnings)
    
# Check if player needs to follow up:
if response.gap_follow_up_prompt:
    show_prompt(response.gap_follow_up_prompt)
```

### Load Compiled Artifacts

```python
from src.core.session_zero_compiler import HandoffCompiler
from src.agents.session_zero_schemas import OpeningStatePackage, GapAnalysisOutput

# Load the compiled package
pkg = HandoffCompiler.load_active_package(session_id)
if pkg:
    print(f"Package version {pkg.package_metadata.package_version}")
    print(f"Handoff safe: {pkg.readiness.handoff_safe}")
    
# Load gap analysis
gap = HandoffCompiler.load_active_gap_analysis(session_id)
if gap:
    print(f"Unresolved items: {len(gap.unresolved_items)}")
    print(f"Blocking issues: {gap.blocking_issues}")
```

### Use with Director

```python
from src.agents.director import DirectorAgent

director = DirectorAgent()

# Pass the package to director (M2 requirement)
director_output = await director.run_startup_briefing(
    session_zero_summary="...",
    profile=profile,
    opening_state_package=package,  # ← NEW
)

# Director output includes:
# - arc_phase
# - current_arc
# - tension_level
# - foreshadowing seeds
# - voice journal
```

---

## Enum Values

### HandoffStatus

```python
HandoffStatus.NOT_READY
HandoffStatus.HANDOFF_COMPILING
HandoffStatus.OPENING_PACKAGE_READY
HandoffStatus.DIRECTOR_STARTUP_READY
HandoffStatus.OPENING_SCENE_GENERATING
HandoffStatus.OPENING_SCENE_READY
HandoffStatus.OPENING_SCENE_FAILED
HandoffStatus.HANDOFF_BLOCKED
```

### UnresolvedCategory

```python
UnresolvedCategory.IDENTITY
UnresolvedCategory.NPC
UnresolvedCategory.FACTION
UnresolvedCategory.LOCATION
UnresolvedCategory.QUEST
UnresolvedCategory.CANONICALITY
UnresolvedCategory.MECHANICS
UnresolvedCategory.WORLD_LORE
UnresolvedCategory.RELATIONSHIP
UnresolvedCategory.OTHER
```

### ProvenanceKind

```python
ProvenanceKind.TRANSCRIPT
ProvenanceKind.PROFILE_RESEARCH
ProvenanceKind.INFERRED
ProvenanceKind.PLAYER_CONFIRMED
ProvenanceKind.IMPORTED_CANON
```

---

## Debugging

### Enable Compiler Logging

```python
import logging
logging.getLogger("src.core.session_zero_compiler").setLevel(logging.DEBUG)
```

### Inspect Package After Compile

```python
result = await compiler.run()
if result.success:
    pkg = result.opening_state_package
    
    # Check what was extracted
    print(f"Character: {pkg.player_character.name}")
    print(f"Location: {pkg.opening_situation.starting_location}")
    print(f"Blocking issues: {pkg.readiness.blocking_issues}")
    print(f"Warnings: {pkg.readiness.warnings}")
    print(f"Unresolved: {pkg.uncertainties.known_unknowns}")
```

### Check Artifact Versions

```python
from src.db.session_zero_artifacts import list_artifacts
from src.db.session import get_session

with get_session() as db:
    artifacts = list_artifacts(db, session_id)
    for art in artifacts:
        print(f"{art.artifact_type} v{art.version}: {art.status}")
```

---

## Next Steps

1. **Run existing tests** to verify infrastructure works:
   ```bash
   pytest tests/test_sz_compiler.py::TestSessionZeroSchemas -v
   ```

2. **Write Phase 1 tests** (unit tests for compiler pipeline):
   - Start with `test_compiler_instantiation()` and `test_compiler_run_success()`
   - Use MockLLMProvider for determinism
   - Takes ~2-4 hours

3. **Write Phase 2 tests** (integration tests with SQLite):
   - Test end-to-end compilation
   - Test artifact persistence
   - Takes ~4-6 hours

4. **Write Phase 3 tests** (API contract):
   - Test SessionZeroResponse fields
   - Test config flag behavior
   - Takes ~1-2 hours

5. **Write Phase 4 tests** (fixture scenarios F1-F8):
   - Each scenario ~50-80 lines
   - Total ~8 scenarios = ~400-640 lines
   - Takes ~6-8 hours

