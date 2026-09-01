/**
 * The messaging settings an admin may change, and the bounds on each (§40).
 *
 * ⚠️ A CLOSED ALLOW-LIST, AND THE ROUTE MAY NEVER WRITE A KEY FROM THE BODY.
 * `system_settings` is one table holding `escalation_enabled`, `pool_enabled`,
 * `max_active_customers`, the escalation thresholds and the pool clocks. A
 * route that upserts whatever key it is handed is a route that can stop lead
 * allocation for the whole platform from the messaging screen.
 *
 * §16 already set this precedent for the capacity route — it resolves its key
 * through `capacitySettingKey()` so "a request can never name a key the reader
 * does not know". This is the same rule with more keys.
 *
 * Pure, so the bounds are testable without a client.
 */

export type MessagingSettingKind = "boolean" | "number";

export interface MessagingSettingSpec {
  key: string;
  label: string;
  kind: MessagingSettingKind;
  /** What the reader falls back to when the row is missing. */
  fallback: string;
  min?: number;
  max?: number;
}

/**
 * ⚠️ Every `max` here is a real ceiling, not a tidy round number.
 *
 * `messaging_whatsapp_ceiling_per_second` is capped at 30 because that is
 * TimelinesAI's own documented limit — and it is **per IP**, so every tenant
 * shares Vercel's egress. Setting it above 30 does not buy throughput; it
 * spends the platform's whole allowance on one cron and starts failing the
 * customer-facing Send button.
 *
 * The quiet-hours bounds are 0–23 rather than 9–20 on purpose: an admin may
 * legitimately narrow the window, and `withinSendingHours` is inclusive of the
 * start and exclusive of the end, so start must be strictly less than end.
 */
export const MESSAGING_SETTINGS: MessagingSettingSpec[] = [
  {
    key: "messaging_enabled",
    label: "Messaging",
    kind: "boolean",
    fallback: "false",
  },
  {
    key: "messaging_sequences_enabled",
    label: "Follow-up sequences",
    kind: "boolean",
    fallback: "false",
  },
  {
    key: "messaging_email_enabled",
    label: "Email channel",
    kind: "boolean",
    fallback: "false",
  },
  {
    key: "messaging_quiet_start_hour",
    label: "Sending starts",
    kind: "number",
    fallback: "9",
    min: 0,
    max: 23,
  },
  {
    key: "messaging_quiet_end_hour",
    label: "Sending stops",
    kind: "number",
    fallback: "20",
    min: 1,
    max: 24,
  },
  {
    key: "messaging_lead_cooldown_hours",
    label: "Cross-operator cooldown (hours)",
    kind: "number",
    fallback: "24",
    min: 0,
    max: 720,
  },
  {
    key: "messaging_whatsapp_ceiling_per_second",
    label: "Requests a second to TimelinesAI",
    kind: "number",
    fallback: "12",
    min: 1,
    max: 30,
  },
  {
    key: "messaging_sequence_review_hours",
    label: "Draft this far ahead (hours)",
    kind: "number",
    fallback: "18",
    min: 1,
    max: 72,
  },
  {
    key: "messaging_sequence_daily_draft_cap",
    label: "Sequence drafts per customer a day",
    kind: "number",
    fallback: "250",
    min: 1,
    max: 5000,
  },
  // Contact plans (§42). Same table, same allow-list, for the reason at the
  // top of this file — and because a switch nobody can reach is not a switch,
  // which is what `contact_plans_enabled` was between 0127 and here.
  {
    key: "contact_plans_enabled",
    label: "Contact plans",
    kind: "boolean",
    fallback: "false",
  },
  {
    key: "contact_landlord_max_per_day",
    label: "Approaches to one landlord a day",
    kind: "number",
    fallback: "1",
    min: 1,
    max: 10,
  },
  {
    key: "contact_landlord_max_per_week",
    label: "Approaches to one landlord a week",
    kind: "number",
    fallback: "3",
    min: 1,
    max: 50,
  },
  {
    key: "followup_adherence_notice_pct",
    label: "Falling-behind threshold (%)",
    kind: "number",
    fallback: "50",
    min: 0,
    max: 100,
  },
  {
    key: "followup_adherence_notice_min_overdue",
    label: "Falling-behind minimum overdue",
    kind: "number",
    fallback: "5",
    min: 1,
    max: 500,
  },
];

const BY_KEY = new Map(MESSAGING_SETTINGS.map((s) => [s.key, s]));

export function messagingSettingSpec(key: string): MessagingSettingSpec | null {
  return BY_KEY.get(key) ?? null;
}

export type SettingVerdict =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Turn a submitted value into the string that goes in the column, or say why
 * not. Booleans are stored as the literal "true"/"false" every reader in the
 * codebase compares against, never as 1/0.
 */
export function coerceMessagingSetting(
  key: string,
  raw: unknown
): SettingVerdict {
  const spec = BY_KEY.get(key);
  if (!spec) return { ok: false, error: `Unknown setting: ${key}` };

  if (spec.kind === "boolean") {
    if (typeof raw !== "boolean") {
      return { ok: false, error: `${spec.label} must be true or false.` };
    }
    return { ok: true, value: raw ? "true" : "false" };
  }

  // ⚠️ The type test comes FIRST, and `Number()` is not a substitute for it.
  // `Number(true)` is 1 and `Number(null)` is 0 — both finite integers — so a
  // switch value posted against a number field would store as "1" and a null
  // as "0". A cooldown of 0 disables the cross-operator guard entirely, which
  // is the shape of accident this rejects rather than coerces.
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { ok: false, error: `${spec.label} must be a whole number.` };
  }
  if (typeof raw === "string" && raw.trim() === "") {
    return { ok: false, error: `${spec.label} must be a whole number.` };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: `${spec.label} must be a whole number.` };
  }
  if (spec.min !== undefined && n < spec.min) {
    return { ok: false, error: `${spec.label} cannot be below ${spec.min}.` };
  }
  if (spec.max !== undefined && n > spec.max) {
    return { ok: false, error: `${spec.label} cannot be above ${spec.max}.` };
  }
  return { ok: true, value: String(n) };
}

/**
 * ⚠️ The quiet-hours window is the one setting whose two halves can only be
 * judged together. `withinSendingHours` is `hour >= start && hour < end`, so a
 * start at or past the end is a window that is never open — every message
 * refused, and on the sequence side every step rescheduled for ever.
 *
 * Checked against the values that will be STORED, not against the pair that
 * happens to be in the request: an admin moving only the start must still be
 * judged against the end already in the database.
 */
export function validateQuietWindow(
  startHour: number,
  endHour: number
): SettingVerdict {
  if (startHour >= endHour) {
    return {
      ok: false,
      error:
        "Sending must start before it stops. A window that never opens would refuse every message and hold every scheduled step for ever.",
    };
  }
  return { ok: true, value: "" };
}
