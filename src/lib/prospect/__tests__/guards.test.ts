import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENQUIRY_CHASE_STATUS, mayWriteChaseLabel } from "@/lib/monday";
import { prospectFirstName } from "@/lib/prospect/name";
import { prospectPhone } from "@/lib/prospect/sendProspectWhatsapp";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Strip comments before matching. Every file here EXPLAINS its own guard, and
 * the explanation names the very thing the guard forbids — so a naive
 * substring check passes on the prose and trains the next person to delete the
 * prose. §46 hit exactly this.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("mayWriteChaseLabel — the Status column has two owners already", () => {
  it("writes into an empty cell", () => {
    expect(mayWriteChaseLabel(null)).toBe(true);
    expect(mayWriteChaseLabel("")).toBe(true);
    expect(mayWriteChaseLabel("   ")).toBe(true);
  });

  it("writes over New Enquiries, which is where a fresh enquirer sits", () => {
    expect(mayWriteChaseLabel("New Enquiries")).toBe(true);
  });

  it("writes over its own labels, so the chase can advance itself", () => {
    expect(mayWriteChaseLabel(ENQUIRY_CHASE_STATUS.chasing)).toBe(true);
    expect(mayWriteChaseLabel(ENQUIRY_CHASE_STATUS.chased_no_booking)).toBe(true);
  });

  /**
   * ⚠️ THE ASSERTION THIS FILE EXISTS FOR. Sales owns seven labels on this
   * column and sets them by hand. An automated chase writing over "In the
   * future" — a human judgement about a real conversation — is the failure
   * that would make this feature worse than nothing.
   */
  it("refuses every sales label", () => {
    for (const label of [
      "Web meeting booked",
      "Web meeting sat",
      "Web meeting no show",
      "In the future",
      "In the future due to call",
      "Abandoned",
      "Cancelled due to contact",
    ]) {
      expect(mayWriteChaseLabel(label)).toBe(false);
    }
  });

  it("refuses every subscription label too", () => {
    // These are code-owned but by mondayStatusLabelFor, not by the chase.
    // Writing over "Management Customer" would un-report a paying customer.
    for (const label of [
      "Management Customer",
      "Guaranteed rent customer",
      "Paused",
      "Wants to pay card declined",
      "Cancelling",
      "Cancelled",
    ]) {
      expect(mayWriteChaseLabel(label)).toBe(false);
    }
  });

  /**
   * ⚠️ These two strings are typed BY HAND into the board before the code
   * ships, and setEnquiryStatus writes with create_labels_if_missing: false —
   * so a label differing by one character fails every push. Punctuation is the
   * way that happens invisibly: an en dash typed where an em dash was meant
   * looks identical in the Monday UI.
   */
  it("uses labels with no punctuation to type wrong", () => {
    for (const label of Object.values(ENQUIRY_CHASE_STATUS)) {
      expect(label).toMatch(/^[A-Za-z ]+$/);
    }
  });
});

describe("prospectFirstName reuses both existing name rules", () => {
  it("takes a plain first name", () => {
    expect(prospectFirstName("Ann Brown")).toBe("Ann");
    expect(prospectFirstName("Ann")).toBe("Ann");
  });

  /**
   * ⚠️ Both of these are REAL values from the live book (§36.3, §40.14).
   * firstNameOf alone accepts them — it only asks for 2–40 characters with a
   * letter — which is fair when the name goes to a model and catastrophic when
   * it is pasted into a greeting sent from a real person's number.
   */
  it("refuses an email address in the name field", () => {
    expect(prospectFirstName("natalyanaq@gmail.com")).toBe("");
  });

  it("refuses junk", () => {
    expect(prospectFirstName("Dbncc")).toBe("");
    expect(prospectFirstName("")).toBe("");
    expect(prospectFirstName(null)).toBe("");
  });
});

describe("prospectPhone uses the STRICT rule, not the matching one", () => {
  it("accepts a UK mobile in every shape the book stores", () => {
    for (const raw of [
      "07700900123",
      "07700 900123",
      "+447700900123",
      // ⚠️ 89 of 193 live management leads store it this way: +44 followed by a
      // FULL national number. §36.2's normaliser is the only thing that gets
      // this right, and a startsWith("+44") slice mangles it.
      "+4407700900123",
    ]) {
      const r = prospectPhone(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.phone).toBe("+447700900123");
    }
  });

  /**
   * ⚠️ §40.9A: a number one digit short sailed through toE164 — the loose 0070
   * IDENTITY rule — to a bare http_400 at the vendor. It is refused here, before
   * any credential is decrypted.
   */
  it("refuses a number that is one digit short", () => {
    const r = prospectPhone("+44778643769");
    expect(r.ok).toBe(false);
  });

  it("refuses a landline and a placeholder", () => {
    expect(prospectPhone("02071234567").ok).toBe(false);
    expect(prospectPhone("00000000000").ok).toBe(false);
    expect(prospectPhone(null).ok).toBe(false);
  });

  it("lets an explicitly foreign number through to the provider", () => {
    // A prospect abroad is a fact, not an error (§36.2). The provider decides.
    const r = prospectPhone("+31612345678");
    expect(r.ok).toBe(true);
  });
});

describe("the cron route's load-bearing ordering", () => {
  const route = code("src/app/api/cron/prospect-nudges/route.ts");

  /**
   * ⚠️ §42.8 records 91 follow-up runs destroyed by a boundary a pull request
   * asserted in words and never actually wrote, and §50.9 records two
   * assertions here written weak enough to survive the mutation they existed
   * to catch. These read the REAL file rather than a restatement of it.
   */
  it("claims by INSERT before it ever calls a provider", () => {
    /**
     * ⚠️ ANCHORED ON THE INSERT ITSELF, NOT ON THE TABLE NAME.
     *
     * The first draft of this matched `.from("prospect_nudge_sends")`, which
     * also appears TWICE more — the daily-cap count at the top of the function
     * and the outcome update at the bottom. indexOf therefore found the cap
     * count, which is always before the sends whatever the claim does, so
     * deleting the claim entirely left the test green. Caught by the mutation
     * run and nothing else; it is the third time this repo has recorded an
     * assertion written weak enough to survive its own mutation (§50.9).
     */
    const claim = route.indexOf(".insert({ nudge_id:");
    const whatsapp = route.indexOf("sendProspectWhatsapp(");
    const email = route.indexOf("sendProspectBookingNudgeEmail(");
    expect(claim).toBeGreaterThan(-1);
    expect(whatsapp).toBeGreaterThan(claim);
    expect(email).toBeGreaterThan(claim);
  });

  it("treats a claim collision as a reason to send nothing", () => {
    // 23505 means another tick beat us to it. The only correct response is to
    // skip the channel entirely — not to send anyway and hope.
    expect(route).toContain("already_claimed");
  });

  it("checks Calendly before it sends anything", () => {
    const calendly = route.indexOf("hasBookedWebMeeting(");
    const whatsapp = route.indexOf("sendProspectWhatsapp(");
    expect(calendly).toBeGreaterThan(-1);
    expect(whatsapp).toBeGreaterThan(calendly);
  });

  it("aborts with a 500 when system_settings cannot be read", () => {
    // §18.3: a failed read is not a switched-off cron, and a 200 carrying
    // "skipped" is something nobody looks at again.
    expect(route).toContain("resolveSettingsGate");
    expect(route).toContain("settings_read_failed");
    expect(route).toMatch(/status:\s*500/);
  });

  /**
   * ⚠️ §40.6. A lead_messages row is a delivery claim tied to a lead and an
   * assignment; a lead_notes row is a claim that an operator did work, read by
   * ~25 predicates. A prospect has neither, and writing to either would corrupt
   * the pool bar, escalation, discard and the filter refund.
   */
  it("writes to no lead-shaped table anywhere in the prospect path", () => {
    for (const file of [
      "src/app/api/cron/prospect-nudges/route.ts",
      "src/lib/prospect/sendProspectWhatsapp.ts",
    ]) {
      const src = code(file);
      expect(src).not.toContain("lead_messages");
      expect(src).not.toContain("lead_notes");
      expect(src).not.toContain("lead_message_threads");
    }
  });

  it("writes to Monday only after the ledger is updated", () => {
    const ledger = route.indexOf('.from("prospect_nudge_sends")');
    const monday = route.indexOf("pushToMonday(");
    expect(monday).toBeGreaterThan(ledger);
  });

  /**
   * ⚠️ Writing "Web meeting booked" would fire the board's group-move
   * automation AND trip the stayful-presentation workflow, which is keyed on
   * exactly that transition. The booking is recorded as an update instead.
   */
  it("never writes the sales-owned booked label", () => {
    expect(route).not.toContain("Web meeting booked");
  });

  it("reads the current label before writing one", () => {
    // The deliberate departure from §23.4 — this is the one Monday write in
    // the codebase that is conditional on somebody else's edit.
    const fetchItem = route.indexOf("fetchEnquiryItem(");
    const guard = route.indexOf("mayWriteChaseLabel(");
    const write = route.indexOf("setEnquiryStatus(");
    expect(fetchItem).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(fetchItem);
    expect(write).toBeGreaterThan(guard);
  });
});

describe("the enquiry route starts the ladder", () => {
  const route = code("src/app/api/enquiry/route.ts");

  it("inserts a ladder row", () => {
    expect(route).toContain('.from("prospect_booking_nudges")');
  });

  it("tolerates a duplicate rather than failing the enquiry", () => {
    // The partial unique index fires on a repeat enquiry; that is the ordinary
    // case, not an error, and the enquiry itself must survive it regardless.
    expect(route).toContain("23505");
  });
});
