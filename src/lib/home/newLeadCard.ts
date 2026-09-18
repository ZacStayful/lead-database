/**
 * The new-lead card on the dashboard home (§63.6): the in-app half of the
 * notification. A customer who logs in instead of tapping the link sees the
 * lead that just arrived, what it is, and one button to open it.
 *
 * PURE, so it is unit-tested without React (vitest.config.mts). The page reads
 * the rows; this decides what to show.
 *
 * ⚠️ BOUNDED, because production held 141 unread `new_lead` notifications the
 * day this was written, one customer with 40. The page reads only rows from
 * the last NEW_LEAD_CARD_DAYS, and this drops any whose assignment has since
 * been viewed — so a first login after deploy shows the leads that are
 * genuinely new, not a wall of history. "and N more" links to the list.
 */

import { extractCity } from "@/lib/utils";
import { buildIncomeProjection } from "@/lib/incomeProjection";
import { formatRangeGbp } from "@/lib/home/incomeAcrossWon";
import { leadPagePath } from "@/lib/leadLink";

/** How far back the page reads unread notifications. */
export const NEW_LEAD_CARD_DAYS = 7;
/** The newest in full, then at most this many in the compact list. */
export const NEW_LEAD_CARD_REST = 3;

export interface NewLeadRow {
  id: string;
  created_at: string;
  lead_assignments: {
    id: string;
    lead_id: string;
    viewed_at: string | null;
    lead: {
      id: string;
      lead_name: string;
      address: string | null;
      postcode_area: string | null;
      bedrooms: string | null;
      lead_type: string | null;
      gross_annual_income: number | string | null;
      owner_customer_id: string | null;
    } | null;
  } | null;
}

export interface NewLeadItem {
  notificationId: string;
  leadId: string;
  name: string;
  town: string;
  postcodeArea: string | null;
  bedrooms: string | null;
  /** Stayful's projection, management only, or null. */
  projectedGross: string | null;
  receivedLabel: string;
  href: string;
}

export interface NewLeadCard {
  primary: NewLeadItem;
  rest: NewLeadItem[];
  moreCount: number;
}

/** "just now" / "12 minutes ago" / "3 hours ago" / "yesterday" / "12 Sep". */
export function receivedLabel(createdAt: string, now: Date): string {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return "";
  const mins = Math.floor((now.getTime() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return new Date(t).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

export function buildNewLeadCard(
  rows: NewLeadRow[],
  opts: { now: Date; viewerId: string }
): NewLeadCard | null {
  const items: NewLeadItem[] = [];
  for (const row of rows) {
    const a = row.lead_assignments;
    const lead = a?.lead;
    if (!a || !lead) continue;
    if (a.viewed_at) continue;
    // Your own upload is not "a new lead" — and its notification row does not
    // exist anyway; the guard is belt and braces (§30.8).
    if (lead.owner_customer_id && lead.owner_customer_id === opts.viewerId) continue;

    // Postgres numerics arrive as strings through PostgREST; the projection
    // wants a number.
    const gross =
      lead.gross_annual_income == null ? null : Number(lead.gross_annual_income);
    const projection =
      (lead.lead_type ?? "management") === "management"
        ? buildIncomeProjection({ gross_annual_income: Number.isFinite(gross) ? gross : null })
        : null;
    items.push({
      notificationId: row.id,
      leadId: lead.id,
      name: lead.lead_name,
      town: extractCity(lead.address),
      postcodeArea: lead.postcode_area ?? null,
      bedrooms: lead.bedrooms ?? null,
      projectedGross: projection
        ? `${formatRangeGbp(projection.grossAnnualLow, projection.grossAnnualHigh)} a year`
        : null,
      receivedLabel: receivedLabel(row.created_at, opts.now),
      href: `${leadPagePath(lead.id)}?from=leads`,
    });
  }
  if (items.length === 0) return null;

  items.sort((x, y) => {
    const tx = Date.parse(rows.find((r) => r.id === x.notificationId)?.created_at ?? "") || 0;
    const ty = Date.parse(rows.find((r) => r.id === y.notificationId)?.created_at ?? "") || 0;
    return ty - tx;
  });

  const [primary, ...others] = items;
  return {
    primary,
    rest: others.slice(0, NEW_LEAD_CARD_REST),
    moreCount: Math.max(0, others.length - NEW_LEAD_CARD_REST),
  };
}
