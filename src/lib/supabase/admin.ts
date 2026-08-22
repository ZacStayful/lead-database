import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. Bypasses RLS — server-side ONLY.
 * Never import this into a Client Component or expose the key to the browser.
 *
 * ⚠️ EVERY REQUEST IS `cache: "no-store"`, AND THAT IS LOAD-BEARING.
 *
 * supabase-js talks to PostgREST over `fetch`, and the Next.js App Router
 * patches the global `fetch` with its own Data Cache. Left alone, a privileged
 * read can be answered from a cached copy of an earlier response, and — worse —
 * a call that is only ever made for its SIDE EFFECT can be skipped entirely
 * because Next already has a response for it.
 *
 * That is not hypothetical: the API rate limiter was built on an RPC that
 * increments a counter and returns the new value. Its writes never reached the
 * database from a deployed build, while the same function committed normally
 * when called directly over SQL, so the limit could never be reached and 66
 * requests in a minute all passed. The tell was that the response was
 * byte-identical across calls minutes apart and still described a function
 * signature that had since been replaced.
 *
 * Plain inserts kept working throughout, which is what made it look like a
 * database problem rather than a caching one — so if a privileged read ever
 * looks stale again, or an RPC seems not to run, start here.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
    }
  );
}
