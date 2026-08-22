/**
 * THE HIGHEST-VALUE TEST IN THIS FEATURE.
 *
 * The key-set assertions below are what fail when a future migration adds a
 * column to `leads` or `lead_assignments` and somebody wires it into
 * schema.ts without thinking. Everything else about containment is enforced by
 * construction; this is the one thing that needs a tripwire, because adding a
 * field is a deliberate act that still might be the wrong one.
 *
 * The literal lists here are duplicated from schema.ts ON PURPOSE. A test that
 * derived them from the same source would pass no matter what changed.
 */
import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_COLUMNS,
  LEAD_COLUMNS,
  serializeAssignment,
  serializeLead,
  serializeNote,
} from "@/lib/api/serialize";
import { NEVER_EXPOSED } from "@/lib/api/schema";
import { SORTS } from "@/lib/api/cursor";

const EXPECTED_LEAD_FIELDS = [
  "id",
  "lead_type",
  "lead_name",
  "address",
  "postcode",
  "postcode_area",
  "bedrooms",
  "phone",
  "email",
  "lead_profile",
  "desired_rent",
  "created_at",
  "gross_annual_income",
  "avg_nightly_rate",
  "occupancy_rate",
  "income_report_available",
].sort();

const EXPECTED_ASSIGNMENT_FIELDS = [
  "id",
  "status",
  "pipeline_stage",
  "source",
  "assigned_at",
  "viewed_at",
  "first_contacted_at",
  "last_status_change_at",
  "due_to_call_date",
  "income_estimate",
  "price_paid",
  "closed_at",
  "closed_reason",
  "lead",
].sort();

/** A row carrying every internal column we must never publish. */
function hostileLeadRow() {
  return {
    id: "lead-1",
    lead_type: "management",
    lead_name: "A Landlord",
    address: "1 Test Street",
    postcode: "M20 1AA",
    postcode_area: "M20",
    bedrooms: "3",
    phone: "07000000000",
    email: "landlord@example.com",
    lead_profile: "Wants a valuation",
    desired_rent: null,
    created_at: "2026-08-01T09:00:00.000000+00:00",
    gross_annual_income: 36112,
    avg_nightly_rate: 157,
    occupancy_rate: 63,
    income_report_path: "lead-1/analysis.pdf",
    // Everything below must not survive serialization.
    assignment_count: 3,
    max_assignments: 3,
    enquiry_date: "sometime in June",
    monday_item_id: "9999",
    income_report_asset_id: "asset-1",
    income_report_status: "parsed",
    pool_entry_basis: "ignored",
    net_annual_income: 20000,
  };
}

describe("serializeLead", () => {
  it("emits exactly the documented field set", () => {
    expect(Object.keys(serializeLead(hostileLeadRow())!).sort()).toEqual(
      EXPECTED_LEAD_FIELDS
    );
  });

  it("publishes no field on the never-exposed list", () => {
    const keys = Object.keys(serializeLead(hostileLeadRow())!);
    for (const banned of NEVER_EXPOSED) {
      expect(keys).not.toContain(banned);
    }
  });

  it("never reveals how many operators hold the lead", () => {
    const out = serializeLead(hostileLeadRow())!;
    expect(JSON.stringify(out)).not.toContain("assignment_count");
    expect(out).not.toHaveProperty("max_assignments");
  });

  it("reduces the stored report path to a boolean and never leaks it", () => {
    const withReport = serializeLead(hostileLeadRow())!;
    expect(withReport.income_report_available).toBe(true);
    expect(JSON.stringify(withReport)).not.toContain("analysis.pdf");

    const without = serializeLead({ ...hostileLeadRow(), income_report_path: null })!;
    expect(without.income_report_available).toBe(false);
  });

  it("returns null rather than an empty shell for a missing lead", () => {
    expect(serializeLead(null)).toBeNull();
  });
});

describe("serializeAssignment", () => {
  const row = {
    id: "assignment-1",
    status: "contacted",
    pipeline_stage: "web_meeting_booked",
    claimed_from_pool_at: null,
    assigned_at: "2026-08-02T10:00:00.123456+00:00",
    viewed_at: null,
    first_contacted_at: "2026-08-02T11:00:00+00:00",
    last_status_change_at: "2026-08-03T09:00:00+00:00",
    due_to_call_date: null,
    income_estimate: 1500,
    price_paid: 15,
    closed_at: null,
    closed_reason: null,
    customer_id: "customer-1",
    notification_sent: true,
    email_sent: true,
    is_reclaimed: false,
    lead: hostileLeadRow(),
  };

  it("emits exactly the documented field set", () => {
    expect(Object.keys(serializeAssignment(row)).sort()).toEqual(
      EXPECTED_ASSIGNMENT_FIELDS
    );
  });

  it("drops customer_id and our own delivery mechanics", () => {
    const out = serializeAssignment(row);
    expect(out).not.toHaveProperty("customer_id");
    expect(out).not.toHaveProperty("notification_sent");
    expect(out).not.toHaveProperty("email_sent");
    expect(out).not.toHaveProperty("is_reclaimed");
  });

  it("derives source from the pool-claim marker rather than exposing it", () => {
    expect(serializeAssignment(row).source).toBe("allocated");
    expect(
      serializeAssignment({ ...row, claimed_from_pool_at: "2026-08-04T00:00:00Z" })
        .source
    ).toBe("pool_claim");
    expect(serializeAssignment(row)).not.toHaveProperty("claimed_from_pool_at");
  });

  it("keeps Stayful's projection and the operator's estimate separate", () => {
    const out = serializeAssignment(row);
    expect(out.income_estimate).toBe(1500);
    expect((out.lead as Record<string, unknown>).gross_annual_income).toBe(36112);
  });
});

describe("serializeNote", () => {
  it("emits only id, body and created_at", () => {
    const out = serializeNote({
      id: "note-1",
      body: "Rang, no answer",
      created_at: "2026-08-02T12:00:00+00:00",
      customer_id: "customer-1",
      lead_assignment_id: "assignment-1",
    });
    expect(Object.keys(out).sort()).toEqual(["body", "created_at", "id"]);
  });
});

describe("select strings", () => {
  it("never selects a never-exposed column", () => {
    const selected = `${LEAD_COLUMNS} ${ASSIGNMENT_COLUMNS}`;
    for (const banned of NEVER_EXPOSED) {
      // income_report_path IS selected — it is the source for the derived
      // boolean — so it is the one documented exception.
      if (banned === "income_report_path") continue;
      expect(selected).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
  });

  it("selects both sort columns, or pagination silently breaks", () => {
    for (const { column } of Object.values(SORTS)) {
      expect(ASSIGNMENT_COLUMNS).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });
});
