# IMPLEMENTATION TASKS — Remaining Gaps

> Based on code review of the refactored codebase against PLAN.md.
> Each task includes the problem, fix, and files to touch.
> Ordered by impact. Checkboxes for tracking progress.

---

## Task 1: Fix `load_foreshadowing_seeds()` dropping causal chain fields
**Status:** [x] DONE
**Severity:** BUG — data loss on server restart
**Files:** `aidm_v3/src/db/state_manager.py`, `aidm_v3/tests/test_foreshadowing_persistence.py`

**Problem:** `state_manager.py:634-667` builds a dict for each seed row but omits `depends_on`, `triggers`, `conflicts_with`. These fields exist in the DB schema (`models.py:386-389`) and are written correctly by `save_foreshadowing_seed()`, but are silently dropped on load. Causal chains (#11) work within a session but vanish on restart.

**Fix:** Added 3 fields to dict in `load_foreshadowing_seeds()`. Added `test_causal_chains_persist()` test. All 8 tests pass.

---

## Task 2: Move OP axis guidance from Block 4 → Block 1 (cache-stable)
**Status:** [x] DONE
**Severity:** Performance — ~500-800 tokens re-tokenized every turn on OP campaigns
**Files:** `aidm_v3/src/core/orchestrator.py`, `aidm_v3/src/agents/key_animator.py`

**Problem:** OP axis guidance and DNA/genre guidance injected into Block 4 (per-turn dynamic) instead of Block 1 (cache-stable prefix). Per #28, these don't change turn-to-turn.

**Fix:** Added `set_static_rule_guidance()` method to KeyAnimator. Orchestrator computes OP axis + DNA + genre guidance once on first turn, stores on KeyAnimator for Block 1 injection. Block 4 fallback for non-cached sessions. Scale/compatibility guidance stays in Block 4 (scene-dependent).

---

## Task 3: Wire RecapAgent into session resume endpoint
**Status:** [x] DONE
**Severity:** Medium — multi-session continuity gap
**Files:** `aidm_v3/api/routes/game.py`

**Problem:** `resume_session()` returned raw messages with no "Previously On..." recap.

**Fix:** Added optional `recap: Optional[str]` to `ResumeSessionResponse`. On resume of gameplay sessions with 3+ messages, generates recap via `RecapAgent` using arc_history, narrative beats, director notes, and world state. Non-fatal on failure.

---

## Task 4: Add `mark_memory_critical` tool to DirectorTools
**Status:** [x] DONE
**Severity:** Medium — Director can't programmatically flag plot-critical memories
**Files:** `aidm_v3/src/agents/director_tools.py`

**Problem:** No tool for Director to retroactively flag memories as plot-critical.

**Fix:** Added `mark_memory_critical` tool with `query` and `reason` parameters. Searches ChromaDB for best match, calls `memory.mark_plot_critical()`, returns confirmation with content preview. Error handling for no matches.

---

## Task 5: Add `active_threads` tracking to Campaign Bible
**Status:** [x] DONE
**Severity:** Low-medium — Director can't manage multi-arc narratives
**Files:** `aidm_v3/src/db/state_manager.py`

**Problem:** Campaign Bible had no `active_threads` key for multi-arc tracking.

**Fix:** `update_campaign_bible()` now ensures `active_threads` key always exists (default `[]`). Director can provide updated threads which are preserved across merges. Existing threads survive overwrites.

---

## Task 6: Populate `rules_summary` from RuleLibrary
**Status:** [x] DONE
**Severity:** Low — hardcoded placeholder
**Files:** `aidm_v3/src/core/orchestrator.py`

**Problem:** `rules_summary` was hardcoded as "Standard Physics + Anime Logic".

**Fix:** Replaced with `self.rules.get_relevant_rules(intent.action + situation, top_k=2)` with fallback to the original string.

---

## Task 7: Enrich voice cards with relationship context (co-locate)
**Status:** [x] DONE
**Severity:** Low — NPC voice and relationship data were in separate prompt sections
**Files:** `aidm_v3/src/agents/key_animator.py`

**Problem:** Voice cards (speech patterns) and NPC relationship data (disposition, milestones, intelligence) were in separate prompt sections. LLM had to cross-reference.

**Fix:** Voice card section now parses `_npc_context` and appends disposition/affinity/personality/milestones directly beneath each NPC's speech patterns. NPCs without voice cards shown separately as "Other Present NPCs". Section header updated to "Voice & Relationship Cards".

---

*All 7 tasks complete.*
