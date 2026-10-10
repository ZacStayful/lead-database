/**
 * The events n8n picks up through POST /api/internal/n8n-events/claim (batch
 * 04 Phase 2, C8). Pure.
 */

/**
 * An event older than this is never handed out: the WhatsApp it was for would
 * arrive after the moment it was about. 48 hours, so one missed n8n run (or a
 * day of n8n being down) still delivers.
 */
export const N8N_EVENT_MAX_AGE_HOURS = 48;

/** What one claim hands out by default, and at most. */
export const N8N_CLAIM_DEFAULT_LIMIT = 25;
export const N8N_CLAIM_MAX_LIMIT = 100;

/**
 * The limit a claim request asked for: the default when the body names none,
 * null when it names one that is not a whole number from 1 to 100.
 */
export function n8nClaimLimit(body: unknown): number | null {
  if (body === null || body === undefined) return N8N_CLAIM_DEFAULT_LIMIT;
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).limit;
  if (raw === undefined) return N8N_CLAIM_DEFAULT_LIMIT;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > N8N_CLAIM_MAX_LIMIT) return null;
  return raw;
}
