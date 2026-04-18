import { env } from "@/lib/env";
import * as schema from "@/lib/state/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

// Lazy singleton. Module-load-time pool construction breaks Next.js production
// builds (page-data collection imports route handlers before DATABASE_URL is set).
// First call during request handling is when env/pool actually get touched.
let _db: Db | undefined;
let _pool: Pool | undefined;

export function getDb(): Db {
  if (_db) return _db;
  _pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
  });
  _db = drizzle(_pool, { schema, casing: "snake_case" });

  // Graceful shutdown — Railway sends SIGTERM on redeploy. Drain the pool so
  // in-flight queries finish and new revisions don't inherit orphaned
  // connections. Registration guarded against duplicate handlers under HMR.
  if (!globalThis.__aidmShutdownRegistered) {
    globalThis.__aidmShutdownRegistered = true;
    const shutdown = async (signal: string) => {
      try {
        await _pool?.end();
      } catch {
        // swallow — pool may already be closing or closed
      } finally {
        process.exit(signal === "SIGINT" ? 130 : 0);
      }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  }

  return _db;
}

declare global {
  var __aidmShutdownRegistered: boolean | undefined;
}
