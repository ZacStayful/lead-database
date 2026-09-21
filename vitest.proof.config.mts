import { defineConfig } from "vitest/config";
import path from "path";

/**
 * The renders, on demand: `npm run proof:ads`.
 *
 * ⚠️ DELIBERATELY NOT IN THE DEFAULT SUITE. `vitest.config.mts` is PURE UNITS
 * ONLY and that constraint is what makes it safe to gate `next build` on — a
 * render pulls in ~2 MB of resvg and yoga wasm and takes seconds. The default
 * `include` matches `*.test.ts`, so a `*.proof.ts` file is invisible to it.
 *
 * What this is for: anybody changing a layout needs to LOOK at the result.
 * Byte counts are not proof — step 1 produced a valid PNG with a tofu box in
 * it, and a valid PNG with the spaces eaten out of the headline.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.proof.ts"],
    testTimeout: 120_000,
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
});
