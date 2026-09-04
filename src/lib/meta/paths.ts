/**
 * Which paths the browser pixel is allowed to load on.
 *
 * Ads land on the public marketing pages, so those are what we measure. The
 * subscriber dashboard and the admin area are deliberately excluded: those are
 * paying customers and staff, not ad traffic, and counting their pageviews
 * would pollute the behaviour Meta's optimiser learns from — as well as
 * tracking people's use of a product they have already bought, which is not
 * what they were told the pixel is for.
 *
 * Pure and free of React so it can be unit-tested directly.
 */
const EXCLUDED_PREFIXES = ["/dashboard", "/admin"];

export function isTrackedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  // ⚠️ Exact-or-followed-by-slash, never a bare startsWith: `startsWith(
  // "/dashboard")` also matches a hypothetical `/dashboards` and would
  // silently stop tracking a real marketing page.
  return !EXCLUDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
