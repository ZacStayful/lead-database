import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct, type ProductCustomerFields } from "@/lib/products";
import { planForProductAllocation } from "@/lib/plans";
import { productLabel } from "@/lib/topup";
import {
  defaultVisibility,
  type TicketChannel,
  type TicketKind,
  type TicketSource,
} from "@/lib/supportTickets";
import type { LeadType } from "@/lib/types";

/**
 * Writing a support ticket, and working out who and what it belongs to
 * (CLAUDE.md §46).
 *
 * Split from `supportTickets.ts` because this half reaches supabase-js and the
 * plan helpers, and the admin table is a `"use client"` component that needs
 * the labels from the other half. Same split, same reason, as
 * `featureRequest.ts` versus `announcements.ts`.
 */

/** The account block both feedback and support emails already render. */
export type TicketAccount = {
  customer_id: string;
  business_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
};

/** The columns `planSnapshot` and `defaultProductFor` read. */
export type TicketPlanFields = ProductCustomerFields & {
  monthly_allocation: number | null;
  gr_monthly_allocation: number | null;
};

/** What `loadTicketAccount` hands back: the email block plus the plan columns. */
export type TicketAccountContext = {
  account: TicketAccount;
  customer: TicketPlanFields;
};

const ACCOUNT_COLUMNS =
  "id, business_name, contact_name, email, phone, account_status, " +
  "subscription_status, gr_subscription_status, monthly_allocation, " +
  "gr_monthly_allocation";

/**
 * Resolve the signed-in user's customer row.
 *
 * ⚠️ THIS IS THE ONE DEFINITION. It replaces a `loadAccount` helper that was
 * duplicated verbatim in `/api/feedback` and `/api/support` — two readings of
 * "whose submission is this" that would eventually have disagreed, silently and
 * in the direction that matters, which is the discipline §22.1 and §19.4 keep
 * insisting on. It selects a wider column list than the old copies because the
 * plan snapshot needs the per-product columns.
 *
 * `maybeSingle()` errors (PGRST116) when more than one row matches, and both
 * old copies swallowed that into `null` — treating a signed-in customer as
 * anonymous. §18D says archived duplicate signups exist and §43.3 warns that a
 * mismatched Stripe email can create a second row and a second auth user, so
 * the shape is reachable in principle. Measured on production 2026-09-09
 * before this shipped: 26 rows carry a `user_id` and ZERO `user_id` values are
 * duplicated, so the behaviour is kept rather than changed — the §43.1
 * discipline of measuring first and recording the measurement.
 */
export async function loadTicketAccount(
  userId: string
): Promise<TicketAccountContext | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("customers")
    .select(ACCOUNT_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;

  const row = data as unknown as Record<string, unknown>;
  return {
    account: {
      customer_id: row.id as string,
      business_name: row.business_name as string,
      contact_name: row.contact_name as string,
      email: row.email as string,
      phone: (row.phone as string | null) ?? null,
    },
    customer: {
      account_status: row.account_status as never,
      subscription_status: row.subscription_status as never,
      gr_subscription_status: row.gr_subscription_status as never,
      monthly_allocation: (row.monthly_allocation as number | null) ?? null,
      gr_monthly_allocation: (row.gr_monthly_allocation as number | null) ?? null,
    },
  };
}

/**
 * A short label for what the customer was paying when they asked.
 *
 * ⚠️ BUILT ON holdsProduct(), NEVER ON account_status. A GR-only subscriber
 * sits at `account_status = 'waitlisted'` for ever (§18A) — Karey Summers and
 * Emanuela Sharra are both that shape, and both raised tickets — so reading
 * that column files two paying subscribers as unconverted prospects. Invariant
 * 6: every eligibility branch must handle both products and must not gate one
 * on the other's columns.
 *
 * Stored once at submission and never read for logic. It is not recoverable
 * later: Leslie Rogers is cancelled today, so her row now says nothing at all
 * about the three tickets she raised while paying.
 */
export function planSnapshot(customer: TicketPlanFields): string | null {
  const held: string[] = [];
  for (const leadType of ["management", "guaranteed_rent"] as LeadType[]) {
    if (!holdsProduct(customer, leadType)) continue;
    const allocation =
      leadType === "guaranteed_rent"
        ? customer.gr_monthly_allocation
        : customer.monthly_allocation;
    const plan = planForProductAllocation(leadType, allocation ?? 0);
    held.push(`${productLabel(leadType)} £${plan.priceGbp}/${plan.leads}`);
  }
  return held.length > 0 ? held.join(" · ") : null;
}

/**
 * Which product a request probably concerns, from what the customer holds.
 *
 * Only a default — an admin can change it, and it is deliberately null for a
 * customer holding both or neither, because guessing between two products is
 * worse than leaving the ticket platform-wide until somebody reads it.
 */
export function defaultProductFor(customer: TicketPlanFields): LeadType | null {
  const management = holdsProduct(customer, "management");
  const guaranteedRent = holdsProduct(customer, "guaranteed_rent");
  if (management && !guaranteedRent) return "management";
  if (guaranteedRent && !management) return "guaranteed_rent";
  return null;
}

export type LoggedTicket = { id: string; reference: number };

/**
 * Persist a submission, BEFORE the notification email goes out.
 *
 * ⚠️ THE ORDER IS THE POINT. Until §46 a Resend failure returned 502 and the
 * submission was gone — the customer was told to try again and nothing
 * anywhere recorded that they had asked. Writing first makes the record of the
 * ask the durable half and the email the best-effort one, which is the
 * claim-by-write discipline `credit_invoice` and `announcement_deliveries`
 * already use against Stripe redelivery and a double-clicked send.
 *
 * ⚠️ IT NEVER THROWS, AND A FAILED INSERT MUST NOT BLOCK THE EMAIL. Losing the
 * log row is a reporting gap; losing the customer's message is their problem
 * going unanswered. On failure it logs and returns null, and the caller sends
 * regardless — which is exactly today's behaviour, so this can only improve on
 * it.
 */
export async function logSupportTicket(params: {
  source: TicketSource;
  kind: TicketKind;
  channel?: TicketChannel;
  name: string;
  email: string;
  business: string | null;
  subject: string;
  body: string;
  page?: string | null;
  account: TicketAccount | null;
  customer: TicketPlanFields | null;
}): Promise<LoggedTicket | null> {
  const customerId = params.account?.customer_id ?? null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("support_tickets")
      .insert({
        source: params.source,
        kind: params.kind,
        channel: params.channel ?? "in_app",
        customer_id: customerId,
        submitter_name: params.name,
        submitter_email: params.email,
        submitter_business: params.business,
        subject: params.subject,
        body: params.body,
        page: params.page ?? null,
        product: params.customer ? defaultProductFor(params.customer) : null,
        plan_snapshot: params.customer ? planSnapshot(params.customer) : null,
        visible_to_customer: defaultVisibility(params.source, customerId),
      })
      .select("id, reference")
      .single();

    if (error || !data) {
      console.error("support ticket: could not log submission", error);
      return null;
    }
    return { id: data.id as string, reference: data.reference as number };
  } catch (err) {
    console.error("support ticket: could not log submission", err);
    return null;
  }
}
