/**
 * The allow-list, and the bounds.
 *
 * ⚠️ THE POINT OF THIS FILE IS THE FIRST TEST. `system_settings` is one table
 * holding `escalation_enabled`, `pool_enabled`, `max_active_customers`, the
 * escalation thresholds and the pool clocks. A settings route that wrote a key
 * from the request body could stop lead allocation for the whole platform from
 * the messaging screen — so the allow-list is a security boundary, not tidiness,
 * and it is asserted against a literal list rather than derived from the source
 * (the §27.2 rule: a test deriving its expectation from the thing under test
 * passes whatever changed).
 */
import { describe, it, expect } from "vitest";
import {
  MESSAGING_SETTINGS,
  coerceMessagingSetting,
  messagingSettingSpec,
  validateQuietWindow,
} from "../adminSettings";

describe("the allow-list is closed", () => {
  it("names exactly these keys and no others", () => {
    expect(MESSAGING_SETTINGS.map((s) => s.key).sort()).toEqual([
      "contact_landlord_max_per_day",
      "contact_landlord_max_per_week",
      "contact_plans_enabled",
      "followup_adherence_notice_min_overdue",
      "followup_adherence_notice_pct",
      "landlord_prefs_nudge_first_hours",
      "landlord_prefs_nudge_second_hours",
      "landlord_prefs_reask_days",
      "landlord_referral_nudge_enabled",
      "messaging_email_enabled",
      "messaging_enabled",
      "messaging_lead_cooldown_hours",
      "messaging_quiet_end_hour",
      "messaging_quiet_start_hour",
      "messaging_sequence_daily_draft_cap",
      "messaging_sequence_review_hours",
      "messaging_sequences_enabled",
      "messaging_whatsapp_ceiling_per_second",
    ]);
  });

  it("refuses a key that would reach lead allocation", () => {
    for (const key of [
      "escalation_enabled",
      "pool_enabled",
      "max_active_customers",
      "gr_max_active_customers",
      "api_enabled",
      "pool_entry_days",
    ]) {
      expect(messagingSettingSpec(key)).toBeNull();
      expect(coerceMessagingSetting(key, true).ok).toBe(false);
    }
  });

  it("refuses a key that does not exist at all", () => {
    expect(coerceMessagingSetting("messaging_enabled_", true).ok).toBe(false);
    expect(coerceMessagingSetting("", true).ok).toBe(false);
  });
});

describe("coercion", () => {
  it("stores a boolean as the literal string every reader compares against", () => {
    // messagingEnabled() tests `value === "true"`. Storing 1/0 or "on" would
    // read as false for ever, silently.
    expect(coerceMessagingSetting("messaging_enabled", true)).toEqual({
      ok: true,
      value: "true",
    });
    expect(coerceMessagingSetting("messaging_enabled", false)).toEqual({
      ok: true,
      value: "false",
    });
  });

  it("refuses a truthy non-boolean for a switch", () => {
    expect(coerceMessagingSetting("messaging_enabled", "true").ok).toBe(false);
    expect(coerceMessagingSetting("messaging_enabled", 1).ok).toBe(false);
  });

  it("refuses a boolean for a number — Number(true) is 1, not NaN", () => {
    // Caught by this test, not by review. Without an explicit type check a
    // switch value posted against a number field stores as "1", and
    // Number(null) is 0 — which would disable the cross-operator cooldown.
    expect(coerceMessagingSetting("messaging_quiet_start_hour", true).ok).toBe(false);
    expect(coerceMessagingSetting("messaging_lead_cooldown_hours", null).ok).toBe(false);
    expect(coerceMessagingSetting("messaging_lead_cooldown_hours", []).ok).toBe(false);
    expect(coerceMessagingSetting("messaging_lead_cooldown_hours", "").ok).toBe(false);
    expect(coerceMessagingSetting("messaging_lead_cooldown_hours", "  ").ok).toBe(false);
  });

  it("still accepts a numeric string, which is what a number input posts", () => {
    expect(coerceMessagingSetting("messaging_quiet_start_hour", "9")).toEqual({
      ok: true,
      value: "9",
    });
  });

  it("refuses a fraction rather than rounding it", () => {
    expect(coerceMessagingSetting("messaging_quiet_start_hour", 9.5).ok).toBe(false);
  });

  it("caps the TimelinesAI ceiling at the vendor's own per-IP limit", () => {
    // 30 is theirs, and it is shared across every tenant on our egress — so
    // above it buys nothing and starves the customer-facing Send button.
    expect(coerceMessagingSetting("messaging_whatsapp_ceiling_per_second", 30).ok).toBe(true);
    expect(coerceMessagingSetting("messaging_whatsapp_ceiling_per_second", 31).ok).toBe(false);
    expect(coerceMessagingSetting("messaging_whatsapp_ceiling_per_second", 0).ok).toBe(false);
  });

  it("allows a cooldown of zero, which disables it", () => {
    expect(coerceMessagingSetting("messaging_lead_cooldown_hours", 0).ok).toBe(true);
  });

  it("bounds the quiet hours to a real clock", () => {
    expect(coerceMessagingSetting("messaging_quiet_start_hour", 0).ok).toBe(true);
    expect(coerceMessagingSetting("messaging_quiet_start_hour", 23).ok).toBe(true);
    expect(coerceMessagingSetting("messaging_quiet_start_hour", 24).ok).toBe(false);
    expect(coerceMessagingSetting("messaging_quiet_end_hour", 24).ok).toBe(true);
    expect(coerceMessagingSetting("messaging_quiet_end_hour", 0).ok).toBe(false);
  });
});

describe("the quiet window can only be judged as a pair", () => {
  it("accepts the shipped 9–20", () => {
    expect(validateQuietWindow(9, 20).ok).toBe(true);
  });

  it("refuses a window that never opens", () => {
    // withinSendingHours is `hour >= start && hour < end`, so start === end is
    // permanently closed: every manual send refused, every scheduled step
    // rescheduled for ever.
    expect(validateQuietWindow(20, 20).ok).toBe(false);
    expect(validateQuietWindow(21, 9).ok).toBe(false);
  });

  it("accepts a single-hour window", () => {
    expect(validateQuietWindow(9, 10).ok).toBe(true);
  });
});

describe("every spec's fallback is what the reader actually falls back to", () => {
  // A fallback here that disagreed with the code's own default would make the
  // admin page show a value the platform is not using.
  const expected: Record<string, string> = {
    messaging_enabled: "false",
    messaging_sequences_enabled: "false",
    messaging_email_enabled: "false",
    messaging_quiet_start_hour: "9",
    messaging_quiet_end_hour: "20",
    messaging_lead_cooldown_hours: "24",
    messaging_whatsapp_ceiling_per_second: "12",
    messaging_sequence_review_hours: "18",
    messaging_sequence_daily_draft_cap: "250",
    // ⚠️ These four must equal contactPlanSettings()'s own fallbacks (§42), or
    // the admin page shows a limit the rationing is not actually using.
    contact_plans_enabled: "false",
    contact_landlord_max_per_day: "1",
    contact_landlord_max_per_week: "3",
    followup_adherence_notice_pct: "50",
    followup_adherence_notice_min_overdue: "5",
    // ⚠️ These four must equal the defaults the READERS use (§41.1), which for
    // three of them live in SQL: get_due_landlord_nudges coalesces the two hour
    // settings to 48 and 72, and claim_landlord_referral coalesces the re-ask
    // floor to 7. landlordNudgeEnabled fails closed, so its fallback is false.
    landlord_referral_nudge_enabled: "false",
    landlord_prefs_nudge_first_hours: "48",
    landlord_prefs_nudge_second_hours: "72",
    landlord_prefs_reask_days: "7",
  };

  it("matches DEFAULT_QUIET_*, DEFAULT_LEAD_COOLDOWN_HOURS and sequenceSettings", () => {
    for (const spec of MESSAGING_SETTINGS) {
      expect(spec.fallback).toBe(expected[spec.key]);
    }
  });
});
