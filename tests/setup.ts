import { afterEach, beforeEach, vi } from "vitest";

// DB integration tests hit the real dev Postgres (working agreement: no
// mocked DB in integration-flavored tests). Locally the connection string
// lives in .env.local; CI injects DATABASE_URL directly, so a missing file
// is fine.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local — CI or fresh checkout
}

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
