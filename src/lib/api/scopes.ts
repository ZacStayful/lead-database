/**
 * The scope vocabulary for API keys.
 *
 * Kept in step with the `customer_api_keys_scopes_known` CHECK in 0095 — a
 * scope this file knows and the database does not would be rejected at key
 * creation with a constraint error rather than a message, and one the database
 * knows and this file does not would silently never grant anything.
 *
 * Phase 1 is read-only, so both scopes are reads. Adding a write scope means
 * extending the CHECK by drop-and-re-add (never a bare `add constraint`, which
 * fails the second time a migration is applied).
 */
export const API_SCOPES = ["profile:read", "leads:read"] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Everything a key may be granted. Also what a session caller holds. */
export const ALL_SCOPES: readonly ApiScope[] = API_SCOPES;

/** Default for a key created without an explicit choice. */
export const DEFAULT_SCOPES: readonly ApiScope[] = API_SCOPES;

export function isApiScope(value: unknown): value is ApiScope {
  return (
    typeof value === "string" && (API_SCOPES as readonly string[]).includes(value)
  );
}

/** Human label for the settings panel and the admin list. */
export const SCOPE_LABELS: Record<ApiScope, string> = {
  "profile:read": "Read your account, plan and pacing",
  "leads:read": "Read your leads, notes and analysis reports",
};
