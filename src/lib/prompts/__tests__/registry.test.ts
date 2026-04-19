import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * These tests import the registry module *after* writing fixture prompts
 * into `src/lib/prompts/__fixtures__/`. The registry walks the whole
 * `src/lib/prompts/` tree so we keep fixtures under a dedicated subdir
 * and restrict our assertions to ids starting with `__fixtures__/`.
 *
 * invalidateCache() is called in beforeEach so each test starts from a
 * fresh cache state — necessary because the registry is process-wide.
 */

const FIXTURES_DIR = join(process.cwd(), "src", "lib", "prompts", "__fixtures__");

function writeFixture(relPath: string, body: string) {
  const full = join(FIXTURES_DIR, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
}

describe("prompt registry", () => {
  beforeEach(async () => {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const { invalidateCache } = await import("../registry");
    invalidateCache();
  });

  afterEach(() => {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });

  it("loads a prompt with no includes verbatim", async () => {
    writeFixture("simple.md", "hello world\n");
    const { getPrompt } = await import("../registry");
    const p = getPrompt("__fixtures__/simple");
    expect(p.content).toBe("hello world\n");
    expect(p.includedFragments).toEqual([]);
  });

  it("resolves {{include:...}} fragments at load time", async () => {
    writeFixture("frag.md", "fragment body");
    writeFixture("host.md", "before\n{{include:__fixtures__/frag}}\nafter");
    const { getPrompt } = await import("../registry");
    const p = getPrompt("__fixtures__/host");
    expect(p.content).toBe("before\nfragment body\nafter");
    expect(p.includedFragments).toContain("__fixtures__/frag");
  });

  it("produces byte-identical content across loads (determinism)", async () => {
    writeFixture("frag.md", "fragment body");
    writeFixture("host.md", "before\n{{include:__fixtures__/frag}}\nafter");
    const { getPrompt, invalidateCache } = await import("../registry");
    const a = getPrompt("__fixtures__/host");
    invalidateCache();
    const b = getPrompt("__fixtures__/host");
    expect(a.content).toBe(b.content);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("fingerprint changes when a fragment changes", async () => {
    writeFixture("frag.md", "v1");
    writeFixture("host.md", "{{include:__fixtures__/frag}}");
    const { getPrompt, invalidateCache } = await import("../registry");
    const before = getPrompt("__fixtures__/host").fingerprint;

    invalidateCache();
    writeFixture("frag.md", "v2");
    const after = getPrompt("__fixtures__/host").fingerprint;

    expect(after).not.toBe(before);
  });

  it("resolves transitive includes (A → B → C)", async () => {
    writeFixture("a.md", "[A:{{include:__fixtures__/b}}]");
    writeFixture("b.md", "[B:{{include:__fixtures__/c}}]");
    writeFixture("c.md", "C");
    const { getPrompt } = await import("../registry");
    const p = getPrompt("__fixtures__/a");
    expect(p.content).toBe("[A:[B:C]]");
    expect(p.includedFragments.sort()).toEqual(["__fixtures__/b", "__fixtures__/c"]);
  });

  it("throws on include cycles", async () => {
    writeFixture("a.md", "{{include:__fixtures__/b}}");
    writeFixture("b.md", "{{include:__fixtures__/a}}");
    const { getPrompt } = await import("../registry");
    expect(() => getPrompt("__fixtures__/a")).toThrow(/cycle/i);
  });

  it("errors clearly when an included id is missing", async () => {
    writeFixture("host.md", "{{include:__fixtures__/does-not-exist}}");
    const { getPrompt } = await import("../registry");
    expect(() => getPrompt("__fixtures__/host")).toThrow(/cannot load prompt.*does-not-exist/i);
  });

  it("listPromptIds includes fixtures + real prompts", async () => {
    writeFixture("dummy.md", "x");
    const { listPromptIds } = await import("../registry");
    const ids = listPromptIds();
    expect(ids).toContain("__fixtures__/dummy");
    // Smoke-check a real agent prompt exists so we catch catastrophic regressions.
    expect(ids).toContain("agents/intent-classifier");
  });

  it("every real prompt in the registry composes without error", async () => {
    const { getAllPrompts } = await import("../registry");
    const all = getAllPrompts();
    // At least the agent stubs + KA blocks + fragments we authored.
    expect(all.length).toBeGreaterThanOrEqual(18);
    for (const p of all) {
      expect(p.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(p.content.length).toBeGreaterThan(0);
    }
  });
});
