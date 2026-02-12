# IMPLEMENTATION TASKS — Remaining Gaps

> Based on code review of the refactored codebase against PLAN.md.
> Each task includes the problem, fix, and files to touch.
> Ordered by impact. Checkboxes for tracking progress.

---

## Task 1: Fix `load_foreshadowing_seeds()` dropping causal chain fields
**Status:** [ ] TODO
**Severity:** BUG — data loss on server restart
**Files:** `aidm_v3/src/db/state_manager.py`, `aidm_v3/tests/test_foreshadowing_persistence.py`

**Problem:** `state_manager.py:634-667` builds a dict for each seed row but omits `depends_on`, `triggers`, `conflicts_with`. These fields exist in the DB schema (`models.py:386-389`) and are written correctly by `save_foreshadowing_seed()`, but are silently dropped on load. Causal chains (#11) work within a session but vanish on restart.

**Fix:**
1. Add 3 lines to the dict in `load_foreshadowing_seeds()`:
   ```python
   "depends_on": row.depends_on or [],
   "triggers": row.triggers or [],
   "conflicts_with": row.conflicts_with or [],
   ```
2. Add test for causal chain round-trip persistence.

---

## Task 2: Move OP axis guidance from Block 4 → Block 1 (cache-stable)
**Status:** [ ] TODO
**Severity:** Performance — ~500-800 tokens re-tokenized every turn on OP campaigns
**Files:** `aidm_v3/src/core/orchestrator.py`, `aidm_v3/src/agents/key_animator.py`

**Problem:** `orchestrator.py:690-707` injects OP axis guidance into `rag_context` (Block 4, per-turn dynamic). Per #28 (caching economics), this guidance doesn't change turn-to-turn — it should be in Block 1 (cache-stable prefix) for zero marginal token cost after turn 1.

**Fix:**
1. In orchestrator, compute OP guidance once at session start (in `run_director_startup` or first turn) and store on the session/orchestrator.
2. Pass as a separate `op_guidance` parameter to KeyAnimator, not via `rag_context`.
3. In `key_animator.py`, inject OP guidance into the system prompt (Block 1) alongside the profile block, not in the dynamic context section.

---

## Task 3: Wire RecapAgent into session resume endpoint
**Status:** [ ] TODO
**Severity:** Medium — multi-session continuity gap
**Files:** `aidm_v3/api/routes/game.py`

**Problem:** `RecapAgent` exists and works on first gameplay turn. But `resume_session()` (`game.py:276-304`) doesn't inject a recap. Player reconnecting mid-campaign gets raw message history with no "Previously On..." priming.

**Fix:**
1. In `resume_session()`, after loading the session, check if it's a gameplay session with turns.
2. If so, generate a recap using `RecapAgent` (or retrieve a cached one).
3. Add the recap text to the response (new optional field `recap: Optional[str]` on `ResumeSessionResponse`).
4. Consider caching: store `Session.last_recap` so we don't regenerate every time.

---

## Task 4: Add `mark_memory_critical` tool to DirectorTools
**Status:** [ ] TODO
**Severity:** Medium — Director can't programmatically flag plot-critical memories
**Files:** `aidm_v3/src/agents/director_tools.py`, `aidm_v3/src/context/memory.py`

**Problem:** PLAN #6 says "The Director should be able to retroactively flag memories during its review pass via a `mark_memory_critical` tool." This tool doesn't exist in `director_tools.py`.

**Fix:**
1. Add `mark_memory_critical` tool to `build_director_tools()`:
   - Parameters: `memory_query: str` (search term to find the memory), `reason: str` (why it's critical)
   - Handler: search ChromaDB for matching memory, call `memory.mark_plot_critical(memory_id)`.
2. Return confirmation with the memory content that was flagged.

---

## Task 5: Add `active_threads` tracking to Campaign Bible
**Status:** [ ] TODO
**Severity:** Low-medium — Director can't manage multi-arc narratives
**Files:** `aidm_v3/src/db/state_manager.py`

**Problem:** PLAN #2 calls for `active_threads` in the Campaign Bible. Not implemented as a column or enforced JSON key. The Director has no structured way to track concurrent narrative threads.

**Fix:**
1. In `update_campaign_bible()`, ensure `planning_data` always includes an `active_threads` key (default `[]`).
2. Each thread entry: `{thread_id: str, name: str, status: str, last_updated_turn: int}`.
3. Director can manage these via `planning_data` during its review pass — no new column needed, just initialization and validation.

---

## Task 6: Populate `rules_summary` from RuleLibrary
**Status:** [ ] TODO
**Severity:** Low — hardcoded placeholder
**Files:** `aidm_v3/src/core/orchestrator.py`

**Problem:** `orchestrator.py:879`: `"rules_summary": "Standard Physics + Anime Logic",  # TODO: Get from RuleLibrary"`.

**Fix:**
1. Replace hardcoded string with `self.rules.get_relevant_rules(f"{intent.action} {db_context.situation}", top_k=3)` or a short profile-derived summary (e.g., profile.setting_rules or world_physics).

---

## Task 7: Enrich voice cards with relationship context (co-locate)
**Status:** [ ] TODO
**Severity:** Low — NPC voice and relationship data are in separate prompt sections
**Files:** `aidm_v3/src/agents/key_animator.py`

**Problem:** Voice cards (`key_animator.py:330-372`) have speech patterns but not disposition/milestones. That data is in a separate `_npc_context` section (line 374-380). They should be co-located so the LLM sees "how this NPC speaks" and "how this NPC feels" together.

**Fix:**
1. When building matching voice cards, look up the NPC in `_npc_context` data.
2. Append disposition label, intelligence stage, and top emotional milestone to each voice card block.
3. Remove or reduce the separate `_npc_context` section (data is now in the cards).

---

*Tasks 1-4 are high priority. Tasks 5-7 are polish.*
