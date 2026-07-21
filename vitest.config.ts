import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app's tsconfig sets jsx:"preserve" (Next owns that transform); vitest's
  // esbuild would otherwise default to the CLASSIC runtime and a rendered
  // component throws "React is not defined". The automatic runtime auto-imports
  // jsx-runtime — it affects vitest transforms only, never the Next build.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "evals/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Fail fast on CI so a broken test doesn't eat minutes.
    bail: process.env.CI ? 1 : 0,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
