/**
 * Reading `system_settings`, and the difference between "switched off" and
 * "we could not tell".
 *
 * ⚠️ THIS EXISTS BECAUSE A SWALLOWED ERROR REPORTED A KILL SWITCH AS OFF.
 *
 * On 2026-09-12 the 11:00 escalation cron returned 200 and logged
 * `run skipped — escalation_enabled is not 'true'`, while the database held
 * `escalation_enabled = 'true'` and had since 13 August. Its settings reader
 * was `const { data } = await admin.from("system_settings")...` — the error
 * discarded, so a failed read produced an empty map, and an empty map is
 * indistinguishable from a switch somebody turned off.
 *
 * The cost was not the run. Escalation is idempotent and the next morning
 * catches up. The cost was the LOG LINE, which named a cause that was not the
 * cause, and the two daily snapshot series: `/api/cron/escalate-leads` captures
 * both after escalating, a skipped run captures neither, and §18.2 records that
 * neither can be backfilled. Thirteen unbroken days, then a hole with a
 * confident wrong explanation sitting over it.
 *
 * The whole point of a kill switch is being able to tell later why a week
 * produced nothing — the escalation route says so in its own comment. A switch
 * whose "off" message also means "the database was briefly unreachable" cannot
 * do that job.
 *
 * So: three outcomes, never two.
 *
 * | | Means | What a caller should do |
 * |---|---|---|
 * | `ok` | the table was read | consult the keys |
 * | `read_failed` | the read errored, or returned nothing at all | ⚠️ NEVER read as "off". Abort loudly, or fall back deliberately and say so |
 * | `not_configured` | the table was read and is empty | caller's judgement — an unseeded database for one caller, ordinary for another |
 *
 * ⚠️ `read_failed` AND `not_configured` ARE SEPARATE ON PURPOSE, and collapsing
 * them would break a caller either way. `/api/cron/escalate-leads` selects the
 * whole table, so empty means migration 0062 was never applied and refusing is
 * right. `contactPlanSettings` selects five keys by name, so empty is the
 * ordinary shape of a database where none of them is seeded and falling back to
 * the documented defaults is right. One reason cannot serve both.
 *
 * A populated table that simply lacks the key is deliberately NOT a failure.
 * That is a key somebody removed, it reads as absent, and "not set to true" is
 * exactly what the caller then reports.
 *
 * Pure, so the decision is unit-testable away from a route that cannot be
 * (§33's argument for lifting the credit decision out of the Stripe webhook).
 */

export type SettingsRow = { key: string; value: string };

/** The shape supabase-js returns in `error`; only the message is read. */
export type SettingsReadError = { message?: string | null } | null | undefined;

export type SettingsGate =
  | { ok: true; config: Map<string, string> }
  | { ok: false; reason: "read_failed" | "not_configured"; message: string };

export function resolveSettingsGate(
  rows: SettingsRow[] | null | undefined,
  error: SettingsReadError
): SettingsGate {
  if (error) {
    return {
      ok: false,
      reason: "read_failed",
      message: error.message?.trim() || "system_settings read failed",
    };
  }

  // ⚠️ Null with no error should not happen through supabase-js, and is still
  // a failed read rather than an empty table. Guessing "empty" here is how the
  // original defect would come back wearing a different hat.
  if (!rows) {
    return {
      ok: false,
      reason: "read_failed",
      message: "system_settings returned no result",
    };
  }

  if (rows.length === 0) {
    return {
      ok: false,
      reason: "not_configured",
      message: "system_settings is empty",
    };
  }

  return {
    ok: true,
    config: new Map(rows.map((r) => [r.key, r.value])),
  };
}
