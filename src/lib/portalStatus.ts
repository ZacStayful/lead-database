/**
 * The one-word status the Customer portal picker prints beside each customer
 * (§62). Pure, so it can be unit-tested over real row shapes — the first
 * version of this lived inline in the page, tested `pendingCancellation()`
 * as a boolean when it returns an OBJECT, and labelled every unpaused
 * customer "cancelling" the day it shipped.
 *
 * The order is the rule: a pause or a pending cancellation outranks "active",
 * because both are true of an active subscriber and are the more useful fact.
 */
import { pendingCancellation } from "@/lib/cancelOptions";
import { holdsProduct } from "@/lib/products";
import type { Customer } from "@/lib/types";

export type PortalStatusFields = Pick<
  Customer,
  | "account_status"
  | "subscription_status"
  | "gr_subscription_status"
  | "paused_at"
  | "cancel_at_period_end"
  | "gr_cancel_at_period_end"
  | "cancel_effective_at"
  | "gr_cancel_effective_at"
>;

export type PortalStatus =
  | "active"
  | "paused"
  | "cancelling"
  | "declined"
  | "invited"
  | "waitlisted"
  | "cancelled";

export function portalStatus(c: PortalStatusFields): PortalStatus {
  const holdsAny = holdsProduct(c, "management") || holdsProduct(c, "guaranteed_rent");
  if (c.paused_at) return "paused";
  if (
    pendingCancellation(c, "management").pending ||
    pendingCancellation(c, "guaranteed_rent").pending
  ) {
    return "cancelling";
  }
  if (c.subscription_status === "past_due" || c.gr_subscription_status === "past_due") {
    return "declined";
  }
  if (holdsAny) return "active";
  if (c.account_status === "invited") return "invited";
  if (c.account_status === "cancelled") return "cancelled";
  return "waitlisted";
}

/** "Management · Guaranteed Rent", or "" for a customer holding neither. */
export function portalProducts(c: PortalStatusFields): string {
  const out: string[] = [];
  if (holdsProduct(c, "management")) out.push("Management");
  if (holdsProduct(c, "guaranteed_rent")) out.push("Guaranteed Rent");
  return out.join(" · ");
}

/** Sort weight for the picker: the people most often looked up first. */
export const PORTAL_STATUS_ORDER: Record<PortalStatus, number> = {
  active: 0,
  paused: 1,
  cancelling: 2,
  declined: 3,
  invited: 4,
  waitlisted: 5,
  cancelled: 6,
};
