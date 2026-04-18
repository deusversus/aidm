import { env } from "@/lib/env";
import * as schema from "@/lib/state/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type Db = typeof db;

// Graceful shutdown — Railway sends SIGTERM on redeploy. Close the pool so in-flight
// queries drain and new revisions don't inherit orphaned connections. `once()` guards
// against duplicate registration during dev hot reload.
declare global {
  var __aidmShutdownRegistered: boolean | undefined;
}

if (!globalThis.__aidmShutdownRegistered) {
  globalThis.__aidmShutdownRegistered = true;
  const shutdown = async (signal: string) => {
    try {
      await pool.end();
    } catch {
      // swallow — pool may already be closing or closed
    } finally {
      process.exit(signal === "SIGINT" ? 130 : 0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
