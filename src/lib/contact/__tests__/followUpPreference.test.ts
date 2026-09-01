/**
 * §21.7's four-place rule, pinned for `contact_followups` (§42).
 *
 * A new notification key has to land in four places, and each half-done
 * combination fails silently in its own way:
 *
 *   - missing from the TYPE          → the cron cannot name it, so it sends
 *                                      to everybody including opt-outs
 *   - missing from PREFERENCE_KEYS   → the settings route 400s the save, so
 *                                      the toggle looks broken
 *   - missing from DEFAULT_PREFERENCES → the merge drops it and the stored
 *                                      value is silently reset on the next save
 *   - missing from the PANEL         → the customer has no way to turn it off
 *                                      at all, which for a DAILY email is the
 *                                      worst of the four
 *
 * Source assertions rather than imports, because two of the four live in a
 * "use client" component and a route this suite cannot load (§27.2's rule that
 * a test deriving its expectation from the source proves nothing applies here
 * too — these read four INDEPENDENT files and agree them against one literal).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NotificationPreferences } from "@/lib/types";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "../../..", rel), "utf8");

const KEY = "contact_followups";

describe("the contact-followups opt-out exists in all four places", () => {
  it("1 — is a key on NotificationPreferences", () => {
    // Compiles only if the key is on the type; the runtime half is the guard
    // against it being typed as something other than a boolean.
    const prefs: Pick<NotificationPreferences, "contact_followups"> = {
      contact_followups: true,
    };
    expect(prefs.contact_followups).toBe(true);
  });

  it("2 — is accepted by the settings route", () => {
    const src = read("app/api/customer/settings/notifications/route.ts");
    const keys = src.slice(src.indexOf("PREFERENCE_KEYS"), src.indexOf("];"));
    expect(keys).toContain(`"${KEY}"`);
  });

  it("3 — has an all-true default, so a missing key reads as opted in", () => {
    const src = read("app/api/customer/settings/notifications/route.ts");
    const start = src.indexOf("DEFAULT_PREFERENCES");
    expect(src.slice(start, src.indexOf("};", start))).toContain(
      `${KEY}: true`
    );
  });

  it("4 — is a row the customer can actually switch off, and is initialised", () => {
    const src = read("components/dashboard/SettingsPanel.tsx");
    // The row itself…
    expect(src.slice(src.indexOf("PREFERENCE_ROWS"), src.indexOf("];"))).toContain(
      `key: "${KEY}"`
    );
    // …and the useState initialiser, which is the half most easily forgotten:
    // without it the switch renders as `undefined` and reads as off.
    // Whitespace-tolerant: this is one prettier reflow away from a false
    // failure, and the fact being pinned is the CALL, not its line breaks.
    expect(src).toMatch(
      new RegExp(`prefOn\\(\\s*customer\\.notification_preferences,\\s*"${KEY}"`)
    );
  });

  it("and the migration both defaults it and backfills existing rows", () => {
    const sql = readFileSync(
      join(here, "../../../../supabase/migrations/0128_contact_followup_notices.sql"),
      "utf8"
    );
    expect(sql).toContain(`"${KEY}": true`);
    // `||` is a MERGE. A replace here would wipe every other stream's explicit
    // false across the whole book.
    expect(sql).toContain("notification_preferences ||");
    expect(sql).toContain(`where not (notification_preferences ? '${KEY}')`);
  });
});
