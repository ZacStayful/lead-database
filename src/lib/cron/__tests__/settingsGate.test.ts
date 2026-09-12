import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSettingsGate } from "../settingsGate";
import { contactPlanSettings } from "../../contact/contactPlan";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ESCALATE = "src/app/api/cron/escalate-leads/route.ts";
const FOLLOWUPS = "src/app/api/cron/contact-followups/route.ts";
const PLAN = "src/lib/contact/contactPlan.ts";
const LEAD_PAGE = "src/app/dashboard/leads/[id]/page.tsx";

/**
 * ⚠️ COMMENTS STRIPPED AND WHITESPACE COLLAPSED, and both halves are the guard
 * rather than tidying (§46, §51.11). Every file here explains in prose the
 * thing it must not do, so a naive scan matches the explanation and passes; and
 * prettier wraps at 80 columns, so any phrase looked for below is routinely
 * split across a newline and ten spaces of indentation.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
}

/** indexOf, refusing an anchor that is not unique — §50.9's trap. */
function onlyIndexOf(haystack: string, needle: string): number {
  const first = haystack.indexOf(needle);
  expect(first, `anchor absent: ${needle}`).toBeGreaterThan(-1);
  expect(
    haystack.indexOf(needle, first + 1),
    `anchor is not unique: ${needle}`
  ).toBe(-1);
  return first;
}

describe("resolveSettingsGate", () => {
  it("reads a populated table", () => {
    const gate = resolveSettingsGate(
      [
        { key: "escalation_enabled", value: "true" },
        { key: "pool_enabled", value: "false" }
      ],
      null
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.config.get("escalation_enabled")).toBe("true");
    expect(gate.config.get("pool_enabled")).toBe("false");
  });

  // ⚠️ The defect itself. An error must never resolve to a readable config,
  // because every caller then asks a Map that cannot answer and gets "off".
  it("reports an error as read_failed, never as an empty config", () => {
    const gate = resolveSettingsGate(null, { message: "fetch failed" });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("read_failed");
    expect(gate.message).toBe("fetch failed");
  });

  it("reports an error even when rows came back with it", () => {
    const gate = resolveSettingsGate(
      [{ key: "escalation_enabled", value: "true" }],
      { message: "statement timeout" }
    );
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("read_failed");
  });

  it("falls back to a message when the error carries none", () => {
    for (const err of [{}, { message: null }, { message: "   " }]) {
      const gate = resolveSettingsGate(null, err);
      expect(gate.ok).toBe(false);
      if (gate.ok) return;
      expect(gate.message.length).toBeGreaterThan(0);
    }
  });

  // Null with no error should not happen through supabase-js, and guessing
  // "empty" for it is how the original defect returns in a different hat.
  it("treats a null result with no error as a failed read", () => {
    for (const rows of [null, undefined]) {
      const gate = resolveSettingsGate(rows, null);
      expect(gate.ok).toBe(false);
      if (gate.ok) return;
      expect(gate.reason).toBe("read_failed");
    }
  });

  // ⚠️ Separate from read_failed on purpose: escalate-leads selects the whole
  // table and must refuse, contactPlanSettings names five keys and must not.
  it("distinguishes an empty table from a failed read", () => {
    const gate = resolveSettingsGate([], null);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe("not_configured");
  });

  // A key somebody deleted reads as absent. That genuinely is "not set to
  // true", and the caller reporting it as such is correct.
  it("does not treat a missing key as a failure", () => {
    const gate = resolveSettingsGate(
      [{ key: "pool_enabled", value: "true" }],
      null
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.config.get("escalation_enabled")).toBeUndefined();
  });
});

type PlanResult = { data: unknown; error: unknown };
function fakeAdmin(result: PlanResult) {
  return {
    from: () => ({ select: () => ({ in: () => Promise.resolve(result) }) }),
  } as unknown as Parameters<typeof contactPlanSettings>[0];
}

describe("contactPlanSettings", () => {
  it("reads the switch and the limits", async () => {
    const s = await contactPlanSettings(
      fakeAdmin({
        data: [
          { key: "contact_plans_enabled", value: "true" },
          { key: "contact_landlord_max_per_day", value: "2" }
        ],
        error: null,
      })
    );
    expect(s.readFailed).toBe(false);
    expect(s.enabled).toBe(true);
    expect(s.landlordMaxPerDay).toBe(2);
    expect(s.landlordMaxPerWeek).toBe(3);
  });

  // ⚠️ The half that matters. `enabled` still reads false — the feature fails
  // closed, as it must — but the caller can now tell WHY.
  it("flags a failed read while still failing closed", async () => {
    const s = await contactPlanSettings(
      fakeAdmin({ data: null, error: { message: "fetch failed" } })
    );
    expect(s.readFailed).toBe(true);
    expect(s.enabled).toBe(false);
    expect(s.landlordMaxPerDay).toBe(1);
    expect(s.landlordMaxPerWeek).toBe(3);
    expect(s.noticePct).toBe(50);
    expect(s.noticeMinOverdue).toBe(5);
  });

  // ⚠️ An empty result is the ordinary shape of a database where none of the
  // five keys is seeded. Calling it a failure would abort both crons on every
  // unconfigured install.
  it("does not flag an empty result as a failed read", async () => {
    const s = await contactPlanSettings(fakeAdmin({ data: [], error: null }));
    expect(s.readFailed).toBe(false);
    expect(s.enabled).toBe(false);
  });
});

describe("the wiring, on the real files", () => {
  it("escalate-leads keeps the error instead of discarding it", () => {
    const src = code(ESCALATE);
    expect(src).toContain("const { data, error } = await admin");
    expect(src).toContain("resolveSettingsGate(");
    expect(src).not.toContain(
      'const { data } = await admin.from("system_settings")'
    );
  });

  // ⚠️ ORDER IS THE RULE. The switch may only be consulted once the config is
  // known to have been read; the other way round is the defect verbatim.
  it("escalate-leads aborts on a failed read before consulting the switch", () => {
    const src = code(ESCALATE);
    const abort = onlyIndexOf(src, "if (!gate.ok)");
    const gate = onlyIndexOf(
      src,
      'config.get("escalation_enabled") !== "true"'
    );
    expect(abort).toBeLessThan(gate);
    // ⚠️ 500, not a 200 carrying "skipped". A cron run that answers 200 is a
    // cron run nobody looks at again.
    expect(src.slice(abort, gate)).toContain("{ status: 500 }");
    expect(src.slice(abort, gate)).toContain("reason: gate.reason");
  });

  it("contact-followups aborts on a failed read before reporting it disabled", () => {
    const src = code(FOLLOWUPS);
    const abort = onlyIndexOf(src, "if (settings.readFailed)");
    const disabled = onlyIndexOf(src, "if (!settings.enabled)");
    expect(abort).toBeLessThan(disabled);
    expect(src).toContain('error: "settings_read_failed"');
  });

  // ⚠️ read_failed ONLY. Mapping not_configured in as well would abort both
  // crons on an install that simply has not seeded the five keys.
  it("contactPlanSettings flags the read failure and nothing else", () => {
    const src = code(PLAN);
    expect(src).toContain("const { data, error } = await admin");
    expect(src).toContain(
      'readFailed: !gate.ok && gate.reason === "read_failed",'
    );
  });

  // ⚠️ The deliberate asymmetry, pinned so nobody "fixes" it: a transient blip
  // should hide a timeline block, never 500 a page a customer is reading.
  it("the customer lead page does not abort on a failed read", () => {
    expect(code(LEAD_PAGE)).not.toContain("readFailed");
  });
});
