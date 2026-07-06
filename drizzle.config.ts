import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Lands with the C3 substrate commit (nine-layer schema).
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aidm_v5",
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
