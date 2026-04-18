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
