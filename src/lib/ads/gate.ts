import type { Customer } from "@/lib/types";
import { isOwnerEmail } from "@/lib/owner";

/**
 * Who may reach the ad builder (§65).
 *
 * ⚠️ ONE FUNCTION, CALLED EVERYWHERE. The gate would otherwise sit at a dozen
 * call sites, and the day a second customer is let in that is a dozen edits
 * with any miss producing a 404 on a feature you have just enabled.
 * `messagingActiveFor` is this codebase's answer to exactly that shape.
 *
 * ⚠️ IT KEYS ON THE SIGNED-IN USER'S EMAIL, NEVER THE CUSTOMER'S.
 * `VIEW_AS_MAX_AGE` is eight hours, and while that cookie is set
 * `getCurrentCustomer()` returns the VIEWED customer (§62) — so a
 * customer-keyed gate locks Zac out of his own ad builder, unable even to read
 * his own drafts, for eight hours after looking at somebody else's account.
 * Keying on the authenticated identity keeps it reachable, and §62's
 * middleware already makes everything read-only while that cookie is set.
 *
 * ⚠️ AND THERE IS DELIBERATELY NO `is_active` GUARD. §27.3 sets the precedent
 * and the OAuth routes enforce it — but the zac@stayful.co.uk row is
 * `is_active = false` (§18D, an archived duplicate), so following that
 * precedent here would silently kill the demo this whole build exists to be.
 */
export function adsEnabledFor(
  user: { email?: string | null } | null,
  customer: Pick<Customer, "id"> | null
): boolean {
  if (!user?.email) return false;
  if (!customer) return false;
  return isOwnerEmail(user.email);
}
