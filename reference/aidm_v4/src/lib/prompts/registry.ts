import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Prompt registry — loads markdown prompts, resolves `{{include:id}}`
 * fragment references at load time, and fingerprints the composed output
 * with SHA-256.
 *
 * Every persisted turn captures the fingerprint of every prompt that ran,
 * so voice regressions caused by prompt edits are traceable to the
 * specific commit that changed them. Composition happens at load time
 * (not call time) so the cache block boundary KA ships to Anthropic is
 * deterministic — the same file layout produces the same bytes.
 *
 * Fragment syntax: `{{include:path/id}}` where `path/id` is the relative
 * path under `src/lib/prompts/` without the `.md` extension.
 *   {{include:fragments/sakuga_choreographic}} → inlines sakuga_choreographic.md
 *
 * Runtime template variables (e.g. `{{profile_dna}}`, `{{intent}}`) are
 * NOT resolved here — they're filled by the caller when the prompt is
 * rendered per-turn. This registry only does static composition.
 *
 * Dev vs. prod:
 *   - Prod (NODE_ENV === 'production'): load once, cache forever.
 *   - Dev: re-check each prompt's file + fragment mtimes on access; if any
 *     dependency changed, recompose. Gives fast iteration without a
 *     background watcher. Invalidation is O(deps-per-prompt) per call;
 *     prompts are small and few, so it's cheap.
 */

export interface ComposedPrompt {
  /** Flat ID: relative path under prompts root, no extension, forward slashes. */
  id: string;
  /** Absolute path of the source file on disk. */
  path: string;
  /** Final composed markdown with all `{{include:...}}` resolved. */
  content: string;
  /** SHA-256 hex of `content`. */
  fingerprint: string;
  /** Every fragment id that ended up in the composed content (transitive). */
  includedFragments: string[];
}

interface CacheEntry {
  composed: ComposedPrompt;
  deps: Array<{ path: string; mtimeMs: number }>;
}

const INCLUDE_RE = /\{\{include:([a-zA-Z0-9_\-/]+)\}\}/g;

const PROMPTS_ROOT = join(process.cwd(), "src", "lib", "prompts");

let cache = new Map<string, CacheEntry>();
let indexedIds: string[] | undefined;
let indexedMtime = 0;

function normalizeId(p: string): string {
  return p.replace(/\\/g, "/");
}

function idToPath(id: string): string {
  return `${join(PROMPTS_ROOT, ...id.split("/"))}.md`;
}

function scanPromptIds(): string[] {
  const ids: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(PROMPTS_ROOT, full).slice(0, -".md".length);
        ids.push(normalizeId(rel.split(sep).join("/")));
      }
    }
  };
  walk(PROMPTS_ROOT);
  return ids.sort();
}

function compose(
  id: string,
  visiting: Set<string>,
  deps: Array<{ path: string; mtimeMs: number }>,
  included: Set<string>,
): string {
  if (visiting.has(id)) {
    const cycle = [...visiting, id].join(" → ");
    throw new Error(`Prompt registry: include cycle detected: ${cycle}`);
  }
  const filePath = idToPath(id);
  let raw: string;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(
      `Prompt registry: cannot load prompt '${id}' at ${filePath}: ${(e as Error).message}`,
    );
  }
  deps.push({ path: filePath, mtimeMs: stat.mtimeMs });

  const next = new Set(visiting);
  next.add(id);

  const resolved = raw.replace(INCLUDE_RE, (_match, includeId: string) => {
    included.add(includeId);
    return compose(includeId, next, deps, included);
  });

  return resolved;
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function build(id: string): CacheEntry {
  const deps: Array<{ path: string; mtimeMs: number }> = [];
  const included = new Set<string>();
  const content = compose(id, new Set(), deps, included);
  const composed: ComposedPrompt = {
    id,
    path: idToPath(id),
    content,
    fingerprint: fingerprint(content),
    includedFragments: [...included].sort(),
  };
  return { composed, deps };
}

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

function isCacheStale(entry: CacheEntry): boolean {
  for (const dep of entry.deps) {
    try {
      const mtime = statSync(dep.path).mtimeMs;
      if (mtime !== dep.mtimeMs) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Load and compose a prompt by id. In dev, rechecks mtimes and recomposes
 * if the prompt or any included fragment changed. In prod, caches on first
 * access and never invalidates (restart to pick up changes — prompts are
 * baked into the deploy).
 */
export function getPrompt(id: string): ComposedPrompt {
  const cached = cache.get(id);
  if (cached && (!isDev() || !isCacheStale(cached))) {
    return cached.composed;
  }
  const entry = build(id);
  cache.set(id, entry);
  return entry.composed;
}

/**
 * List every prompt id discoverable under the prompts root. Used by
 * `pnpm prompts:dump` and by tests that assert registry completeness.
 */
export function listPromptIds(): string[] {
  if (indexedIds && !isDev()) return indexedIds;
  // In dev, rescan if the root's modification time changed.
  const rootMtime = statSync(PROMPTS_ROOT).mtimeMs;
  if (!indexedIds || rootMtime !== indexedMtime) {
    indexedIds = scanPromptIds();
    indexedMtime = rootMtime;
  }
  return indexedIds;
}

/**
 * Load every prompt. Used by the dump script and whole-registry tests.
 */
export function getAllPrompts(): ComposedPrompt[] {
  return listPromptIds().map(getPrompt);
}

/**
 * Drop all cached compositions. For tests and HMR hooks that know prompts
 * changed but don't want to rely on mtime detection.
 */
export function invalidateCache(): void {
  cache = new Map();
  indexedIds = undefined;
  indexedMtime = 0;
}

/** Exposed for testing and the dump script. */
export const __testing = { PROMPTS_ROOT };
