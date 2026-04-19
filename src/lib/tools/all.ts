/**
 * Side-effect import that registers every tool in the registry.
 *
 * Anything that needs the tool registry populated — tests, MCP server
 * factories, Mastra workflow steps, `pnpm prompts:dump`-style scripts —
 * imports this file before calling `listTools()` or `getTool()`. No
 * wildcard re-export: each tool's module runs its `registerTool(...)`
 * call at import time and the registry collects them.
 *
 * Ordered by layer for readability; duplicate-registration is caught at
 * runtime so accidental double-imports fail fast.
 */
import "./arc/get-arc-state";
import "./arc/list-active-seeds";
import "./arc/plant-foreshadowing-seed";
import "./arc/resolve-seed";
import "./critical/get-critical-memories";
import "./critical/get-overrides";
import "./entities/get-character-sheet";
import "./entities/get-npc-details";
import "./entities/get-world-state";
import "./entities/list-known-npcs";
import "./episodic/get-recent-episodes";
import "./episodic/get-turn-narrative";
import "./episodic/recall-scene";
import "./semantic/search-memory";
import "./voice/get-voice-exemplars-by-beat-type";
import "./voice/get-voice-patterns";
