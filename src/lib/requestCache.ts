import * as React from "react";

/**
 * Per-request memoisation for server-side reads.
 *
 * React's `cache` deduplicates a call for the lifetime of one server request,
 * which is what makes it safe for a layout and its page — rendered
 * CONCURRENTLY by Next — to both ask "who is signed in?" without racing.
 *
 * ⚠️ IT IS NOT AVAILABLE IN BOTH RUNTIMES, AND THE FALLBACK IS DELIBERATE.
 * `cache` is exported only under the "react-server" export condition:
 *
 *   - In the App Router, `react` resolves to Next's vendored server build
 *     (`next/dist/compiled/react/react.react-server.js`), which exports it.
 *     That is where every Server Component runs, so the memoisation is real
 *     exactly where the concurrency it guards against exists.
 *   - Under vitest (`environment: "node"`), `react` resolves to the stock
 *     client build, which does not export it — stock React 18.3.1's
 *     shared-subset entry throws "not yet supported outside of experimental
 *     channels" if you reach for it directly.
 *
 * So this degrades to a pass-through in tests, which is behaviourally
 * identical there: a unit test calls once. What it must never do is throw at
 * import time, because `src/lib/auth.ts` is imported by a dozen test files.
 */
type AnyFn = (...args: never[]) => unknown;

type CacheFn = <T extends AnyFn>(fn: T) => T;

const reactCache = (React as unknown as { cache?: CacheFn }).cache;

export const requestCache: CacheFn = reactCache ?? ((fn) => fn);

/**
 * Whether the real thing is in play. Exported so a test can say which runtime
 * it is asserting against rather than guessing, and so the pass-through can
 * never be mistaken for the memoisation actually working.
 */
export const REQUEST_CACHE_IS_REAL = typeof reactCache === "function";
