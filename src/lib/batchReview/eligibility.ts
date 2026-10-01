/**
 * Who is still sent a batch review (§73). Server-side; reads products.ts.
 */
import { holdsProduct } from "@/lib/products";
import type { Customer, LeadType } from "@/lib/types";

export type CustomerRow = Pick<
  Customer,
  | "id"
  | "email"
  | "contact_name"
  | "is_active"
  | "account_status"
  | "subscription_status"
  | "gr_subscription_status"
  | "paused_at"
  | "lapsed_at"
  | "gr_lapsed_at"
  | "notification_preferences"
>;

export const CUSTOMER_SELECT =
  "id, email, contact_name, is_active, account_status, subscription_status, gr_subscription_status, paused_at, lapsed_at, gr_lapsed_at, notification_preferences";

/**
 * Still a live holder of THIS product, per product (invariant 6). A customer
 * who has since left, paused management, or been written off is not asked
 * about a batch they are no longer paying for.
 */
export function stillHolds(c: CustomerRow, leadType: LeadType): boolean {
  if (!c.is_active) return false;
  if (!holdsProduct(c as Customer, leadType)) return false;
  if (leadType === "management") return c.paused_at == null && c.lapsed_at == null;
  return c.gr_lapsed_at == null;
}

/** Opt-out only; a missing key reads as true (§21.7). */
export function wantsReview(c: CustomerRow): boolean {
  return c.notification_preferences?.monthly_review !== false;
}

