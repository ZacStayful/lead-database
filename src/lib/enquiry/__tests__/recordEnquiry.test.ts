import { describe, it, expect } from "vitest";
import { recordEnquiry } from "../recordEnquiry";
import { LEAD_INTEREST } from "@/lib/monday";

/**
 * The duplicate check (§57).
 *
 * ⚠️ THE LAYERS ARE NOT EQUALLY LOAD-BEARING, AND THIS FILE IS MOSTLY ABOUT
 * THE ONE THAT IS. `prospect_booking_nudges_active_uidx` is keyed on
 * CUSTOMER_ID, so two customer rows for one human means two ladders and two
 * WhatsApps from a real person's number to a member of the public — and the
 * index is perfectly happy. Matching an existing customer is the only thing
 * standing in the way of that; the claim table and the item-link check are
 * hygiene.
 *
 * And the mirror risk, which is the sharper one: a phone tier that merges two
 * colleagues on one office number means the second is NEVER CREATED AND NEVER
 * CHASED — a lost lead, invisible. §18 settles it: "under-matching costs a
 * duplicate, over-matching silently discards a real enquiry."
 */

interface Row {
  id: string;
  email: string;
  phone: string | null;
  account_status: string;
  monday_item_id: string | null;
  contact_name: string | null;
  business_name: string | null;
}

interface Ladder {
  customer_id: string;
  source: string;
  enquired_at: string;
}

function fakeAdmin(rows: Row[], ladders: Ladder[] = []) {
  const inserted: { customers: Record<string, unknown>[]; ladders: Record<string, unknown>[] } = {
    customers: [],
    ladders: [],
  };
  const updated: Record<string, unknown>[] = [];

  function builder(table: string) {
    const eqs: Record<string, unknown> = {};
    let ilikeVal: string | null = null;
    let gteAt: string | null = null;
    let pending: Record<string, unknown> | null = null;
    let mode: "select" | "insert" | "update" = "select";

    function matches(): Row[] {
      let out = rows;
      for (const [col, val] of Object.entries(eqs)) {
        out = out.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
      }
      if (ilikeVal) {
        const suffix = ilikeVal.replace(/%/g, "");
        out = out.filter((r) => (r.phone ?? "").endsWith(suffix));
      }
      return out;
    }

    const self = {
      select: () => self,
      eq: (c: string, v: unknown) => { eqs[c] = v; return self; },
      ilike: (_c: string, v: string) => { ilikeVal = v; return self; },
      gte: (_c: string, v: string) => { gteAt = v; return self; },
      limit: () => self,
      insert: (payload: Record<string, unknown>) => {
        mode = "insert";
        pending = payload;
        return self;
      },
      update: (payload: Record<string, unknown>) => {
        mode = "update";
        pending = payload;
        return self;
      },
      maybeSingle: async () => {
        if (mode === "insert" && pending) {
          if (table === "customers") {
            const dup = rows.some((r) => r.email === pending!.email);
            if (dup) return { data: null, error: { code: "23505" } };
            inserted.customers.push(pending);
            const row: Row = {
              id: `new-${inserted.customers.length}`,
              email: String(pending.email),
              phone: (pending.phone as string) ?? null,
              account_status: String(pending.account_status),
              monday_item_id: (pending.monday_item_id as string) ?? null,
              contact_name: (pending.contact_name as string) ?? null,
              business_name: (pending.business_name as string) ?? null,
            };
            rows.push(row);
            return { data: { id: row.id }, error: null };
          }
        }
        const hit = matches()[0];
        return { data: hit ?? null, error: null };
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
        if (mode === "insert" && pending && table === "prospect_booking_nudges") {
          const cid = String(pending.customer_id);
          if (ladders.some((l) => l.customer_id === cid)) {
            return resolve({ data: null, error: { code: "23505" } });
          }
          inserted.ladders.push(pending);
          ladders.push({
            customer_id: cid,
            source: String(pending.source),
            enquired_at: new Date().toISOString(),
          });
          return resolve({ data: null, error: null });
        }
        if (mode === "update" && pending) {
          updated.push(pending);
          const hit = matches()[0];
          if (hit) Object.assign(hit, pending);
          return resolve({ data: null, error: null });
        }
        if (table === "prospect_booking_nudges") {
          const cid = eqs.customer_id;
          const found = ladders.filter(
            (l) => l.customer_id === cid && (!gteAt || l.enquired_at >= gteAt)
          );
          return resolve({ data: found.map((l) => ({ id: "x" })), error: null });
        }
        return resolve({ data: matches(), error: null });
      },
    };
    return self;
  }

  return {
    client: { from: (t: string) => builder(t) } as never,
    inserted,
    updated,
    rows,
    ladders,
  };
}

const BASE = {
  source: "monday_sync" as const,
  name: "Niall Byrne",
  email: "niall@wyndale.uk",
  phone: "+447932557572",
  websiteUrl: "https://wyndale.uk",
  propertiesManaged: "40",
  leadInterest: LEAD_INTEREST.management,
  planKey: "lead_20" as const,
  monday: { kind: "existing" as const, itemId: "13028756392" },
  matchBy: ["email", "phone"] as const,
};

describe("a new person", () => {
  it("is created waitlisted and gets a ladder", async () => {
    const f = fakeAdmin([]);
    const r = await recordEnquiry(f.client, BASE);

    expect(r.customer).toBe("created");
    expect(r.ladder).toBe("created");
    expect(f.inserted.customers[0]).toMatchObject({
      email: "niall@wyndale.uk",
      account_status: "waitlisted",
      subscription_status: "inactive",
      phone: "+447932557572",
    });
  });

  // ⚠️ Not "created": we neither made this item nor guessed at it, and
  // /api/admin/monday-status-check reports "created" as a high-confidence link.
  it("records the board link as adopted, not created", async () => {
    const f = fakeAdmin([]);
    await recordEnquiry(f.client, BASE);
    expect(f.inserted.customers[0]).toMatchObject({
      monday_item_id: "13028756392",
      monday_link_matched_by: "monday_sync",
    });
  });

  it("records which door they came through", async () => {
    const f = fakeAdmin([]);
    await recordEnquiry(f.client, BASE);
    expect(f.inserted.ladders[0]).toMatchObject({ source: "monday_sync" });
  });
});

describe("somebody we already have", () => {
  const existing = (over: Partial<Row> = {}): Row => ({
    id: "c1",
    email: "niall@wyndale.uk",
    phone: "+447932557572",
    account_status: "waitlisted",
    monday_item_id: null,
    contact_name: "Niall Byrne",
    business_name: "Niall Byrne",
    ...over,
  });

  it("is matched by email, not duplicated", async () => {
    const f = fakeAdmin([existing()]);
    const r = await recordEnquiry(f.client, BASE);
    expect(r.customer).toBe("updated");
    expect(f.inserted.customers).toHaveLength(0);
  });

  /**
   * ⚠️ The website→Monday→sync loop, and the case measured on the real board:
   * all three genuine items already match a customer on all three tiers.
   */
  it("is matched even when the email differs, if the phone AND name agree", async () => {
    const f = fakeAdmin([existing({ email: "niall@oldaddress.uk" })]);
    const r = await recordEnquiry(f.client, BASE);
    expect(r.customer).toBe("updated");
    expect(f.inserted.customers).toHaveLength(0);
  });

  /**
   * ⚠️ THE SHARPEST EDGE. Two colleagues on one office number. A phone-only
   * match merges them, and the second person is never created and never
   * chased — a lost lead, and invisible. §18: over-matching silently discards
   * a real enquiry, so this fails OPEN and flags for a human.
   */
  it("is NOT merged when the phone matches but the name disagrees", async () => {
    const f = fakeAdmin([
      existing({
        email: "colleague@wyndale.uk",
        contact_name: "Someone Else",
        business_name: "Someone Else",
      }),
    ]);
    const r = await recordEnquiry(f.client, BASE);

    expect(r.phoneAmbiguous).toBe(true);
    expect(r.customer).toBe("ambiguous");
    // The lead is NOT lost.
    expect(f.inserted.customers).toHaveLength(1);
  });

  it("is not merged when two rows share the number", async () => {
    const f = fakeAdmin([
      existing({ id: "c1", email: "a@x.uk" }),
      existing({ id: "c2", email: "b@x.uk" }),
    ]);
    const r = await recordEnquiry(f.client, BASE);
    expect(r.phoneAmbiguous).toBe(true);
    expect(f.inserted.customers).toHaveLength(1);
  });

  /** A paying customer filling in an ad form must not be chased to book. */
  it("is left completely alone once they are past waitlisted", async () => {
    const f = fakeAdmin([existing({ account_status: "active" })]);
    const r = await recordEnquiry(f.client, BASE);

    expect(r.customer).toBe("left_alone");
    expect(r.ladder).toBe("not_waitlisted");
    expect(f.updated).toHaveLength(0);
    expect(f.inserted.ladders).toHaveLength(0);
  });

  /** First item wins — repointing would send status writes to the duplicate. */
  it("keeps the board link it already had", async () => {
    const f = fakeAdmin([existing({ monday_item_id: "11111111" })]);
    await recordEnquiry(f.client, BASE);
    expect(f.updated[0]).not.toHaveProperty("monday_item_id");
  });
});

describe("the chase", () => {
  const waitlisted: Row = {
    id: "c1",
    email: "niall@wyndale.uk",
    phone: "+447932557572",
    account_status: "waitlisted",
    monday_item_id: null,
    contact_name: "Niall Byrne",
    business_name: "Niall Byrne",
  };

  it("is not started twice while one is live", async () => {
    const f = fakeAdmin([waitlisted], [
      { customer_id: "c1", source: "website", enquired_at: new Date().toISOString() },
    ]);
    const r = await recordEnquiry(f.client, BASE);
    expect(r.ladder).toBe("already_active");
    expect(f.inserted.ladders).toHaveLength(0);
  });

  /**
   * ⚠️ Monday's own "Duplicate item" mints a NEW item id the claims table
   * cannot see. Without the cooldown, a COMPLETED earlier ladder would be
   * restarted and the same person chased all over again.
   */
  it("is not restarted inside the cooldown, even once the old one has finished", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const f = fakeAdmin([waitlisted], []);
    f.ladders.push({ customer_id: "c1", source: "monday_sync", enquired_at: twoDaysAgo });
    // The partial index only covers a LIVE ladder, so this one is invisible to
    // it — the cooldown is the only thing that sees it.
    const r = await recordEnquiry(f.client, { ...BASE, ladderCooldownDays: 30 });
    expect(r.ladder).toBe("cooldown");
    expect(f.inserted.ladders).toHaveLength(0);
  });

  /**
   * ⚠️ An item too old to chase still becomes a customer. This is what makes a
   * misread cutoff harmless: idempotent upserts and ZERO messages.
   */
  it("is skipped for an old item, but the customer is still created", async () => {
    const f = fakeAdmin([]);
    const r = await recordEnquiry(f.client, { ...BASE, chase: false });
    expect(r.customer).toBe("created");
    expect(r.ladder).toBe("not_chased");
    expect(f.inserted.ladders).toHaveLength(0);
  });
});

describe("the website keeps its own behaviour", () => {
  /** matchBy defaults to email only — today's semantics, byte for byte. */
  it("does not use the phone tier unless asked", async () => {
    const f = fakeAdmin([
      {
        id: "c1",
        email: "someone.else@wyndale.uk",
        phone: "+447932557572",
        account_status: "waitlisted",
        monday_item_id: null,
        contact_name: "Niall Byrne",
        business_name: "Niall Byrne",
      },
    ]);
    const r = await recordEnquiry(f.client, {
      ...BASE,
      source: "website",
      matchBy: undefined,
    });
    // A different email is a different person as far as the website is
    // concerned, exactly as before §57.
    expect(r.customer).toBe("created");
  });
});
