import { afterEach, beforeEach, vi } from "vitest";

/**
 * Defensive global reset. Any test that mutates process.env should still
 * snapshot/restore in its own beforeEach/afterEach, but this ensures module
 * cache is always fresh and Vitest's env stubs don't leak.
 */
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});
