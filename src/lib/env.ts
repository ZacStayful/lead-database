/**
 * Small helper to read required server env vars with a clear error message
 * instead of silently passing `undefined` into an SDK constructor.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Public base URL of the customer portal. Set NEXT_PUBLIC_APP_URL per
// environment; the default is the live portal domain so customer emails never
// fall back to a localhost link when the var is missing in a deploy.
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://leads.stayful.co.uk";

/** Login page — where a logged-out customer lands to view an assigned lead. */
export const LOGIN_URL = `${APP_URL}/login`;
