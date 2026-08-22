import { defineConfig } from "vitest/config";
import path from "path";

/**
 * The repo's first test suite, scoped to the public API.
 *
 * PURE UNITS ONLY — no network, no database, no React. That constraint is what
 * makes it safe to gate the build on (see the `build` script in package.json):
 * the whole run is sub-second, so a deploy is never held up by a slow or flaky
 * test, and a failure is always a real one.
 *
 * The database-dependent checks — the resolver against live Supabase, the
 * rate-limit concurrency property, the migration replay — stay manual and are
 * recorded in CLAUDE.md, because standing up a test database in a repo with no
 * supabase/config.toml is a project of its own.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
