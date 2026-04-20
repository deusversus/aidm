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
// Chronicler write tools (post-turn archivist). Same registry; different
// call sites — KA doesn't call these from its prompt, but they share the
// MCP surface so the authorization gate is the only thing keeping KA
// out of the write path by convention.
import "./chronicler/adjust-spotlight-debt";
import "./chronicler/plant-foreshadowing-candidate";
import "./chronicler/ratify-foreshadowing-seed";
import "./chronicler/record-relationship-event";
import "./chronicler/register-faction";
import "./chronicler/register-location";
import "./chronicler/register-npc";
import "./chronicler/retire-foreshadowing-seed";
import "./chronicler/trigger-compactor";
import "./chronicler/update-arc-plan";
import "./chronicler/update-npc";
import "./chronicler/update-voice-patterns";
import "./chronicler/write-director-note";
import "./chronicler/write-episodic-summary";
import "./chronicler/write-semantic-memory";
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
