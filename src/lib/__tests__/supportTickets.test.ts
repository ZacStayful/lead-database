import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TICKET_CHANNELS,
  TICKET_KINDS,
  TICKET_PATCH_FIELDS,
  TICKET_SOURCES,
  TICKET_STATUSES,
  adminStatusLabel,
  channelLabel,
  customerStatusLabel,
  defaultVisibility,
  kindLabel,
  nextResolvedAt,
  ticketReference,
  validateNoteWrite,
  validateStatusWrite,
  validateTicketPatch,
  validateTicketWrite,
} from "@/lib/supportTickets";
import { defaultProductFor, planSnapshot } from "@/lib/supportTicketLog";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/0133_support_tickets.sql"),
  "utf8"
);

/** Pull the values out of a `check (col in ('a', 'b'))` clause in 0133. */
function checkValues(column: string): string[] {
  const m = MIGRATION.match(
    new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`)
  );
  expect(m, `no CHECK found for ${column}`).not.toBeNull();
  return Array.from(m![1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

describe("0133's CHECK constraints match the library vocabularies", () => {
  // The library's header says these mirror the migration and nothing enforces
  // it mechanically — this is the mechanism, following cancelOptions.test.ts.
  // A drift is a constraint violation on submit in production, so it should be
  // a red test here first.
  it("source", () => expect(checkValues("source")).toEqual([...TICKET_SOURCES]));
  it("kind", () => expect(checkValues("kind")).toEqual([...TICKET_KINDS]));
  it("status", () => expect(checkValues("status")).toEqual([...TICKET_STATUSES]));
  it("channel", () =>
    expect(checkValues("channel")).toEqual([...TICKET_CHANNELS]));
});

describe("vocabularies", () => {
  // Asserted against LITERAL lists, deliberately. A test deriving the expected
  // values from the source under test passes whatever changed (§27.2).
  it("are exactly these values", () => {
    expect([...TICKET_SOURCES]).toEqual(["feedback_form", "support_form", "admin"]);
    expect([...TICKET_KINDS]).toEqual(["support", "feature", "bug"]);
    expect([...TICKET_STATUSES]).toEqual(["open", "in_progress", "done", "wont_do"]);
    expect([...TICKET_CHANNELS]).toEqual(["in_app", "email", "whatsapp", "phone"]);
  });
});

describe("ticketReference", () => {
  it("pads to four digits", () => {
    expect(ticketReference(1)).toBe("STF-0001");
    expect(ticketReference(9)).toBe("STF-0009");
    expect(ticketReference(1234)).toBe("STF-1234");
  });

  it("grows rather than truncating past 9999", () => {
    // A wrong reference on a customer's email is worse than a long one.
    expect(ticketReference(12345)).toBe("STF-12345");
  });
});

describe("status labels", () => {
  it("are blunt for the admin", () => {
    expect(adminStatusLabel("open")).toBe("Open");
    expect(adminStatusLabel("in_progress")).toBe("In progress");
    expect(adminStatusLabel("done")).toBe("Done");
    expect(adminStatusLabel("wont_do")).toBe("Won't do");
  });

  it("are civil to the customer", () => {
    expect(customerStatusLabel("open")).toBe("Logged");
    expect(customerStatusLabel("in_progress")).toBe("Being worked on");
    expect(customerStatusLabel("done")).toBe("Done");
    expect(customerStatusLabel("wont_do")).toBe("Not planned");
  });

  it("NEVER show a customer the words 'Won't do'", () => {
    // The one label rule in this feature that is about a person rather than a
    // column. A blunt refusal in a dashboard, with no sentence beside it and
    // nobody to reply to, reads as contempt.
    for (const status of TICKET_STATUSES) {
      expect(customerStatusLabel(status).toLowerCase()).not.toContain("won't");
      expect(customerStatusLabel(status).toLowerCase()).not.toContain("wont");
    }
  });

  it("labels every kind and channel", () => {
    for (const kind of TICKET_KINDS) expect(kindLabel(kind)).toBeTruthy();
    for (const channel of TICKET_CHANNELS) expect(channelLabel(channel)).toBeTruthy();
  });
});

describe("defaultVisibility", () => {
  it("shows a customer their own form submission", () => {
    expect(defaultVisibility("feedback_form", "cus-1")).toBe(true);
    expect(defaultVisibility("support_form", "cus-1")).toBe(true);
  });

  it("HIDES a hand-logged ticket, because those are our words about them", () => {
    expect(defaultVisibility("admin", "cus-1")).toBe(false);
  });

  it("hides an anonymous submission — there is nobody to show it to", () => {
    expect(defaultVisibility("feedback_form", null)).toBe(false);
    expect(defaultVisibility("support_form", null)).toBe(false);
  });
});

describe("nextResolvedAt", () => {
  const now = new Date("2026-09-09T12:00:00Z");

  it("stamps on entering a terminal status", () => {
    expect(nextResolvedAt("done", now)).toBe("2026-09-09T12:00:00.000Z");
    expect(nextResolvedAt("wont_do", now)).toBe("2026-09-09T12:00:00.000Z");
  });

  it("CLEARS on reopening, unlike cancelled_at", () => {
    // A ticket legitimately round-trips. A stale resolved date printed beside
    // an open ticket is a lie the admin list would render.
    expect(nextResolvedAt("open", now)).toBeNull();
    expect(nextResolvedAt("in_progress", now)).toBeNull();
  });
});

describe("planSnapshot", () => {
  const base = {
    account_status: "waitlisted",
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    monthly_allocation: 10,
    gr_monthly_allocation: 10,
  } as never;

  it("reads a GR-only subscriber as PAYING, not as a prospect", () => {
    // ⚠️ THE REGRESSION THAT MATTERS. Karey Summers and Emanuela Sharra both
    // raised tickets and both sit at account_status = 'waitlisted' for ever
    // (§18A) because that column is management-only. Anything reading it files
    // two paying GR subscribers as unconverted prospects.
    const karey = { ...(base as object), gr_subscription_status: "active" } as never;
    expect(planSnapshot(karey)).toBe("Guaranteed Rent £150/10");
    expect(defaultProductFor(karey)).toBe("guaranteed_rent");
  });

  it("prices management off its own allocation", () => {
    const marcus = {
      ...(base as object),
      account_status: "active",
      subscription_status: "active",
      monthly_allocation: 20,
    } as never;
    expect(planSnapshot(marcus)).toBe("Management £300/20");
    expect(defaultProductFor(marcus)).toBe("management");
  });

  it("names both products when both are held, and defaults the product to null", () => {
    const both = {
      ...(base as object),
      account_status: "active",
      subscription_status: "active",
      gr_subscription_status: "active",
      monthly_allocation: 10,
    } as never;
    expect(planSnapshot(both)).toBe(
      "Management £150/10 · Guaranteed Rent £150/10"
    );
    // Guessing between two products is worse than leaving it platform-wide.
    expect(defaultProductFor(both)).toBeNull();
  });

  it("returns null for a cancelled customer, holding neither", () => {
    const leslie = {
      ...(base as object),
      account_status: "cancelled",
      subscription_status: "canceled",
    } as never;
    expect(planSnapshot(leslie)).toBeNull();
    expect(defaultProductFor(leslie)).toBeNull();
  });

  it("counts past_due as held — a billing problem is not a lapsed account", () => {
    const pastDue = {
      ...(base as object),
      subscription_status: "past_due",
    } as never;
    expect(planSnapshot(pastDue)).toBe("Management £150/10");
  });
});

describe("validateTicketWrite", () => {
  const good = {
    kind: "support",
    channel: "phone",
    submitter_name: "Emily Kitts",
    submitter_email: "emily@thehostingedit.co.uk",
    subject: "Rang about lead vetting",
    body: "Asked whether leads are checked before they go out.",
  };

  it("accepts a well-formed hand-logged ticket", () => {
    const v = validateTicketWrite(good);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.kind).toBe("support");
      expect(v.value.channel).toBe("phone");
      expect(v.value.product).toBeNull();
    }
  });

  it("defaults the channel to email", () => {
    const v = validateTicketWrite({ ...good, channel: undefined });
    expect(v.ok && v.value.channel).toBe("email");
  });

  it("accepts a backdated submitted_at, because a call logged today happened yesterday", () => {
    const v = validateTicketWrite({ ...good, submitted_at: "2026-08-25T09:00:00Z" });
    expect(v.ok && v.value.submitted_at).toBe("2026-08-25T09:00:00.000Z");
  });

  it("refuses what it should", () => {
    expect(validateTicketWrite(null).ok).toBe(false);
    expect(validateTicketWrite("nope").ok).toBe(false);
    expect(validateTicketWrite({ ...good, kind: "question" }).ok).toBe(false);
    expect(validateTicketWrite({ ...good, channel: "pigeon" }).ok).toBe(false);
    expect(validateTicketWrite({ ...good, submitter_name: "  " }).ok).toBe(false);
    expect(validateTicketWrite({ ...good, subject: "" }).ok).toBe(false);
    expect(validateTicketWrite({ ...good, body: "x".repeat(10001) }).ok).toBe(false);
    expect(validateTicketWrite({ ...good, subject: "x".repeat(201) }).ok).toBe(false);
    expect(validateTicketWrite({ ...good, product: "both" }).ok).toBe(false);
    expect(validateTicketWrite({ ...good, submitted_at: "not a date" }).ok).toBe(false);
  });

  it("accepts a body at exactly the cap", () => {
    expect(validateTicketWrite({ ...good, body: "x".repeat(10000) }).ok).toBe(true);
  });
});

describe("validateTicketPatch", () => {
  it("is a CLOSED allow-list", () => {
    expect([...TICKET_PATCH_FIELDS]).toEqual([
      "kind",
      "product",
      "visible_to_customer",
      "shipped_migration",
      "shipped_claude_section",
    ]);
  });

  it("REFUSES the columns that record who asked and when", () => {
    // These are the history this table exists to keep. A route that took a key
    // from the body could rewrite it (§40.14).
    for (const field of [
      "status",
      "reference",
      "source",
      "customer_id",
      "submitted_at",
      "backfill_key",
      "body",
      "subject",
    ]) {
      const v = validateTicketPatch({ [field]: "anything" });
      expect(v.ok, `${field} must be refused`).toBe(false);
    }
  });

  it("refuses a non-boolean visible_to_customer BEFORE coercing it", () => {
    // ⚠️ Number(true) is 1 and Number(null) is 0, both finite — §40.14 caught
    // exactly that. Here a truthy coercion would publish an admin's private
    // note-taking to a customer's dashboard.
    expect(validateTicketPatch({ visible_to_customer: 1 }).ok).toBe(false);
    expect(validateTicketPatch({ visible_to_customer: null }).ok).toBe(false);
    expect(validateTicketPatch({ visible_to_customer: "true" }).ok).toBe(false);
    expect(validateTicketPatch({ visible_to_customer: true }).ok).toBe(true);
    expect(validateTicketPatch({ visible_to_customer: false }).ok).toBe(true);
  });

  it("validates a migration reference, including the 0100a shape", () => {
    expect(validateTicketPatch({ shipped_migration: "0133" }).ok).toBe(true);
    expect(validateTicketPatch({ shipped_migration: "0100a" }).ok).toBe(true);
    expect(validateTicketPatch({ shipped_migration: "133" }).ok).toBe(false);
    expect(validateTicketPatch({ shipped_migration: "0133_support" }).ok).toBe(false);
    // Clearing it is allowed.
    const cleared = validateTicketPatch({ shipped_migration: null });
    expect(cleared.ok && cleared.value.shipped_migration).toBeNull();
  });

  it("clears the product when it is sent empty", () => {
    const v = validateTicketPatch({ product: "" });
    expect(v.ok && v.value.product).toBeNull();
  });

  it("refuses an empty patch", () => {
    expect(validateTicketPatch({}).ok).toBe(false);
  });
});

describe("validateStatusWrite", () => {
  it("accepts every status in the vocabulary", () => {
    for (const status of TICKET_STATUSES) {
      expect(validateStatusWrite({ status }).ok).toBe(true);
    }
  });

  it("refuses anything else", () => {
    expect(validateStatusWrite({ status: "archived" }).ok).toBe(false);
    expect(validateStatusWrite({ status: "" }).ok).toBe(false);
    expect(validateStatusWrite({}).ok).toBe(false);
    expect(validateStatusWrite(null).ok).toBe(false);
  });
});

describe("validateNoteWrite", () => {
  it("accepts a note and trims it", () => {
    const v = validateNoteWrite({ body: "  shipped as §37  " });
    expect(v.ok && v.value).toBe("shipped as §37");
  });

  it("refuses an empty or over-long note", () => {
    expect(validateNoteWrite({ body: "   " }).ok).toBe(false);
    expect(validateNoteWrite({ body: "x".repeat(5001) }).ok).toBe(false);
    expect(validateNoteWrite({ body: "x".repeat(5000) }).ok).toBe(true);
    expect(validateNoteWrite({}).ok).toBe(false);
  });
});
