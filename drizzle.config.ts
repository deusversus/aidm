import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/state/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aidm",
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
