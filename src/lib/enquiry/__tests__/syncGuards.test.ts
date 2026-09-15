import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Strip comments before matching. Every file here EXPLAINS its own guard, and
 * the explanation names the very thing the guard forbids — so a naive
 * substring check passes on the prose and trains the next person to delete the
 * prose. §46 hit exactly this, and §51.10 had to fix it a second time.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The project's TS target predates spreading a matchAll iterator. */
function matchAllGroups(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(text)) !== null) out.push(m[1]);
  return out;
}

const SYNC = "src/lib/enquiry/syncMondayEnquiries.ts";
const ROUTE = "src/app/api/cron/monday-enquiry-sync/route.ts";
const SHARED = "src/lib/enquiry/recordEnquiry.ts";
const ITEM = "src/lib/enquiry/enquiryItem.ts";

describe("the sync's load-bearing ordering", () => {
  const sync = code(SYNC);

  /**
   * ⚠️ ANCHORED ON THE INSERT, NOT ON THE TABLE NAME.
   *
   * `.from("monday_enquiry_claims")` appears three times in this file — the
   * pre-read, this insert, and the settle — so `indexOf` on the table name
   * finds the PRE-READ and stays green with the claim deleted entirely. That
   * is §50.9's trap, which this repo has now recorded four times, and §42.8
   * records what it cost: 91 follow-up runs destroyed by a boundary a pull
   * request asserted in words and nobody actually wrote.
   */
  it("claims by INSERT before it records anything", () => {
    const claim = sync.indexOf(".insert({\n          monday_item_id: item.id,");
    const record = sync.indexOf("await recordEnquiry(admin, {");
    expect(claim).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(record);
  });

  /**
   * ⚠️ A claim collision is the ordinary case at a once-a-minute cadence, and
   * the right answer is to do nothing at all — not to record an error and not
   * to carry on and create a second customer.
   */
  it("treats a claim collision as a reason to do nothing", () => {
    expect(sync).toContain('claimError.code !== "23505"');
  });

  /**
   * ⚠️ MONDAY LAST (§23.6). Tidying the phone cell is cosmetic; the customer
   * and the ladder are not. A Monday failure must never cost us the enquiry.
   */
  it("writes to Monday only after the enquiry is recorded", () => {
    const record = sync.indexOf("await recordEnquiry(admin, {");
    const monday = sync.indexOf("await setEnquiryMobile({");
    expect(monday).toBeGreaterThan(record);
  });

  /**
   * ⚠️ The sync adopts a board item; it must never mint one. Creating a second
   * item for a lead already on the board is how sales ends up working the
   * duplicate while status writes go to the original.
   */
  it("never creates a board item, or writes a status or an update", () => {
    for (const src of [sync, code(ROUTE)]) {
      expect(src).not.toContain("createEnquiryContact");
      expect(src).not.toContain("setEnquiryStatus");
      expect(src).not.toContain("createEnquiryUpdate");
    }
  });

  /**
   * ⚠️ Writes `text_mm50hfvg` only. `phone_mm6c5qkc` is a column nothing in
   * this app has ever written (§23.1's rule about the board's duplicate date
   * columns), and it is READ here — so the guard is on the writer, not on the
   * column id appearing at all.
   */
  it("tidies only the Mobile cell it owns", () => {
    const writer = code("src/lib/monday.ts");
    const fn = writer.slice(writer.indexOf("export async function setEnquiryMobile"));
    expect(fn).toContain("ENQUIRY_COLUMN_MAP.mobile");
    expect(fn.slice(0, fn.indexOf("export async function setEnquiryStatus")))
      .not.toContain("ENQUIRY_PHONE_COLUMN");
  });

  /**
   * ⚠️ A pending claim is a LOST LEAD: the row is written before the customer,
   * so a crash in between leaves an item claimed with nothing behind it and
   * nothing would ever look at it again.
   */
  it("retries a stranded claim, and reports one it has given up on", () => {
    expect(sync).toContain("RETRY_AFTER_MS");
    expect(sync).toContain("RETRY_GIVE_UP_MS");
    expect(sync).toContain("result.stuck.push(item.id)");
  });

  /**
   * ⚠️ The cooldown is what stops a person being chased twice when Monday's
   * own "Duplicate item" mints a new id the claims table cannot see.
   */
  it("passes a cooldown, and the name-corroborated phone tier", () => {
    expect(sync).toContain("ladderCooldownDays: 30");
    expect(sync).toContain('matchBy: ["email", "phone"]');
  });
});

describe("the cron route fails in the right direction", () => {
  const route = code(ROUTE);

  /** §18.3 — a failed settings read is not a switched-off cron. */
  it("aborts with a 500 when system_settings cannot be read", () => {
    expect(route).toContain("resolveSettingsGate");
    expect(route).toContain('gate.reason === "read_failed"');
    expect(route).toContain('{ ok: false, error: "settings_read_failed" }, { status: 500 }');
  });

  /**
   * ⚠️ THE CUTOFF FAILS CLOSED. Unreadable means ingest NOTHING, never ingest
   * everything — §42.9's contact_notify_from rule, where getting this
   * backwards would have emailed 326 stale prospects.
   */
  it("refuses to run at all on an unreadable cutoff", () => {
    expect(route).toContain('error: "cutoff_unreadable"');
    const disabled = route.indexOf('skipped: "enquiry_sync_disabled"');
    const cutoff = route.indexOf('error: "cutoff_unreadable"');
    // The switch is consulted first, so switching off is not reported as a fault.
    expect(disabled).toBeLessThan(cutoff);
  });

  /**
   * ⚠️ The `since` override widens the window and must never be able to make a
   * REAL run ingest the back catalogue. Dry run only, enforced here.
   */
  it("refuses the since override outside a dry run", () => {
    expect(route).toContain('error: "since_requires_dry_run"');
  });

  /**
   * ⚠️ maxDuration 60, not 300: it fires every minute, and a five-minute
   * ceiling on a one-minute schedule is five runs deep.
   */
  it("is sized for a once-a-minute schedule", () => {
    expect(route).toContain("export const maxDuration = 60;");
  });
});

describe("the chase itself is untouched", () => {
  /**
   * ⚠️ THE WHOLE SAFETY ARGUMENT FOR THIS FEATURE IS THAT THE PROVEN PATH DOES
   * NOT MOVE. §55's chase is the one part of this pipeline with a production
   * record — it has sent real messages and stopped itself on a real Calendly
   * booking. Nothing in §57 changes it: the sync creates the ladder row and
   * the chase picks it up exactly as it does for a website enquiry.
   *
   * A file-text guard rather than a diff, because it is the claim that a
   * reviewer most needs to be able to trust without reading two thousand
   * lines.
   */
  it("the prospect-nudges cron neither knows nor cares where a ladder came from", () => {
    const cron = code("src/app/api/cron/prospect-nudges/route.ts");
    expect(cron).not.toContain("monday_sync");
    expect(cron).not.toContain("enquiry_sync");
    expect(cron).not.toContain("syncMondayEnquiries");
  });
});

describe("the claim vocabulary matches the database", () => {
  /**
   * ⚠️ Asserted against the MIGRATION rather than derived from the TypeScript,
   * the cancelOptions.ts arrangement (§29). A value in one and not the other
   * is a 23514 at runtime, on the path that records what happened to a lead.
   */
  it("every outcome the sync can write is in 0151's CHECK", () => {
    const migration = read("supabase/migrations/0151_monday_enquiry_sync.sql");
    const check = migration.slice(
      migration.indexOf("monday_enquiry_claims_outcome_check\n  check"),
      migration.indexOf("-- The stuck report")
    );
    const ts = read("src/lib/enquiry/syncMondayEnquiries.ts");
    const union = ts.slice(
      ts.indexOf("export type EnquiryClaimOutcome"),
      ts.indexOf("export interface SyncMondayEnquiriesOptions")
    );
    const values = matchAllGroups(union, /"([a-z_]+)"/g);
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) {
      expect(check, `outcome "${v}" is missing from 0151's CHECK`).toContain(`'${v}'`);
    }
  });
});

describe("the decision module stays pure", () => {
  /**
   * ⚠️ It is imported by the sync and unit-tested without a client. An import
   * that reaches supabase-js or the Monday client would make every one of
   * those tests need a fake, and §40.12 records the same rule for sendWindow:
   * the decision is worth being able to test in that style.
   */
  it("imports nothing but the shared junk-name rule", () => {
    const imports = matchAllGroups(read(ITEM), /from "([^"]+)"/g);
    expect(imports).toEqual(["@/lib/leadQuality"]);
  });

  /** The website's 400 refusal must not leak into the shared module. */
  it("and the shared recorder never refuses a mobile", () => {
    expect(code(SHARED)).not.toContain("UK_MOBILE_ERRORS");
  });
});
