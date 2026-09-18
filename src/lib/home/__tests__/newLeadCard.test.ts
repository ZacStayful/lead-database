import { describe, expect, it } from "vitest";
import {
  NEW_LEAD_CARD_REST,
  buildNewLeadCard,
  receivedLabel,
  type NewLeadRow,
} from "../newLeadCard";

const now = new Date("2026-09-18T10:00:00Z");
const viewer = "cust-1";

const row = (
  over: Partial<{
    id: string;
    createdAt: string;
    viewedAt: string | null;
    leadType: string;
    gross: number | null;
    owner: string | null;
    address: string | null;
    area: string | null;
    beds: string | null;
    noAssignment: boolean;
  }> = {}
): NewLeadRow => ({
  id: over.id ?? "n1",
  created_at: over.createdAt ?? "2026-09-18T09:30:00Z",
  lead_assignments: over.noAssignment
    ? null
    : {
        id: `a-${over.id ?? "n1"}`,
        lead_id: `l-${over.id ?? "n1"}`,
        viewed_at: over.viewedAt ?? null,
        lead: {
          id: `l-${over.id ?? "n1"}`,
          lead_name: `Landlord ${over.id ?? "n1"}`,
          address: over.address === undefined ? "12 Gill Avenue, Bristol, BS16 2PH" : over.address,
          postcode_area: over.area === undefined ? "BS" : over.area,
          bedrooms: over.beds === undefined ? "3" : over.beds,
          lead_type: over.leadType ?? "management",
          gross_annual_income: over.gross === undefined ? 36112 : over.gross,
          owner_customer_id: over.owner ?? null,
        },
      },
});

describe("buildNewLeadCard", () => {
  it("is null with nothing to show", () => {
    expect(buildNewLeadCard([], { now, viewerId: viewer })).toBeNull();
  });

  it("drops viewed leads, missing assignments and the viewer's own uploads", () => {
    const card = buildNewLeadCard(
      [
        row({ id: "viewed", viewedAt: "2026-09-18T09:45:00Z" }),
        row({ id: "orphan", noAssignment: true }),
        row({ id: "mine", owner: viewer }),
      ],
      { now, viewerId: viewer }
    );
    expect(card).toBeNull();
  });

  it("a resold lead someone ELSE uploaded still shows", () => {
    const card = buildNewLeadCard([row({ id: "bought", owner: "cust-2" })], { now, viewerId: viewer });
    expect(card?.primary.leadId).toBe("l-bought");
  });

  it("shows the newest in full and links it to the lead page", () => {
    const card = buildNewLeadCard(
      [
        row({ id: "older", createdAt: "2026-09-17T09:00:00Z" }),
        row({ id: "newest", createdAt: "2026-09-18T09:50:00Z" }),
      ],
      { now, viewerId: viewer }
    );
    expect(card?.primary.leadId).toBe("l-newest");
    expect(card?.primary.href).toBe("/dashboard/leads/l-newest?from=leads");
    expect(card?.primary.town).toBe("Bristol");
    expect(card?.primary.postcodeArea).toBe("BS");
    expect(card?.primary.bedrooms).toBe("3");
    expect(card?.primary.receivedLabel).toBe("10 minutes ago");
    expect(card?.rest.map((r) => r.leadId)).toEqual(["l-older"]);
    expect(card?.moreCount).toBe(0);
  });

  it("caps the compact list and counts the rest", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((i) =>
      row({ id: `n${i}`, createdAt: `2026-09-18T0${i}:00:00Z` })
    );
    const card = buildNewLeadCard(rows, { now, viewerId: viewer });
    expect(card?.primary.leadId).toBe("l-n6");
    expect(card?.rest).toHaveLength(NEW_LEAD_CARD_REST);
    expect(card?.rest.map((r) => r.leadId)).toEqual(["l-n5", "l-n4", "l-n3"]);
    expect(card?.moreCount).toBe(2);

    const two = buildNewLeadCard(rows.slice(0, 2), { now, viewerId: viewer });
    expect(two?.rest).toHaveLength(1);
    expect(two?.moreCount).toBe(0);
  });

  it("carries the projection for a management lead with a figure and nothing otherwise", () => {
    const withFigure = buildNewLeadCard([row()], { now, viewerId: viewer });
    expect(withFigure?.primary.projectedGross).toMatch(/^£.* – £.* a year$/);
    const noFigure = buildNewLeadCard([row({ gross: null })], { now, viewerId: viewer });
    expect(noFigure?.primary.projectedGross).toBeNull();
    // A management fee is not what a GR operator earns (§25, invariant 6).
    const gr = buildNewLeadCard([row({ leadType: "guaranteed_rent" })], { now, viewerId: viewer });
    expect(gr?.primary.projectedGross).toBeNull();
  });

  it("copes with a lead missing its address, area and bedrooms", () => {
    const card = buildNewLeadCard([row({ address: null, area: null, beds: null })], {
      now,
      viewerId: viewer,
    });
    expect(card?.primary.town).toBe("");
    expect(card?.primary.postcodeArea).toBeNull();
    expect(card?.primary.bedrooms).toBeNull();
  });
});

describe("receivedLabel", () => {
  it("buckets by age", () => {
    expect(receivedLabel("2026-09-18T09:59:40Z", now)).toBe("just now");
    expect(receivedLabel("2026-09-18T09:59:00Z", now)).toBe("1 minute ago");
    expect(receivedLabel("2026-09-18T09:35:00Z", now)).toBe("25 minutes ago");
    expect(receivedLabel("2026-09-18T07:00:00Z", now)).toBe("3 hours ago");
    expect(receivedLabel("2026-09-17T07:00:00Z", now)).toBe("yesterday");
    expect(receivedLabel("2026-09-12T07:00:00Z", now)).toBe("12 Sept");
    expect(receivedLabel("not a date", now)).toBe("");
  });
});
