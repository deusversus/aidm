# Fix Plan: Post-Review Cleanup

## Issue 1: `source_path` AttributeError in Admin API
**File:** `aidm_v3/api/main.py` (lines 86, 108)
**Problem:** References `pv.source_path` but `PromptVersion` only has `source` (a string).
Both `/api/admin/prompts` and `/api/admin/prompts/{name}` will crash at runtime.
**Fix:** Change `pv.source_path` → `pv.source` in both endpoints. Remove the `if pv.source_path` guard
(source is always a non-empty string like `"file:prompts/scope.md"` or `"inline:scope"`).

## Issue 2: Duplicate `has_field` key in `scope_naruto.json`
**File:** `aidm_v3/fixtures/scope_naruto.json`
**Problem:** JSON doesn't support duplicate keys. Two `has_field` entries — only the second
(`"reasoning"`) survives, silently dropping the `"scope"` assertion.
**Fix:** Restructure expected traits to use unique keys. The eval harness's `check_trait()` function
uses the key as the trait type and value as the argument, so we need two distinct trait checks.
Looking at the eval code, `has_field` takes a field name as value. To check both fields, we can use
the `_gte`/`_in`/`_matches` pattern or restructure expected as a list. Since the current schema uses
a dict, the simplest fix is to use two different trait assertions that still validate the same thing —
e.g. keep `has_field: "scope"` and use `output_contains: "reasoning"` or add a second field check
via a different trait name. Actually, the cleanest fix is to change the eval harness to support a list
of assertions instead of a dict, but that's scope creep. For now: use `has_field` for one and a
`scope_in` or similar trait for the other. Looking at the fixture again — it already has `scope_in`
for the scope value check, so we just need ONE `has_field` for `"reasoning"` and the `scope_in`
already covers the scope field existence implicitly. Fix: remove the duplicate `has_field: "scope"`
since `scope_in` already validates that field.

## Issue 3: `tmp` file in git history
**File:** `tmp` (project root)
**Problem:** 512-line conversation dump committed in `1ef9b20`. Already deleted on disk but
deletion not staged.
**Fix:** `git rm tmp` to stage the deletion.

## Issue 4: Store boilerplate — use `get_session()` context manager
**Files:**
- `aidm_v3/src/db/session_store.py`
- `aidm_v3/src/scrapers/lore_store.py`
- `aidm_v3/src/scrapers/cache.py`
- `aidm_v3/src/profiles/session_profile.py`
**Problem:** Every method uses manual `create_session()` + try/except/rollback/finally/close
(~6 lines of boilerplate per method) when `get_session()` context manager already handles this.
**Fix:** Replace manual session management with `with get_session() as db:` across all four stores.
For read-only methods (load, get, list, has_profile, get_stats), the auto-commit in
`get_session()` is harmless (no dirty state). For write methods, the context manager commits
on success and rolls back on exception — same behavior as the current try/except blocks.
