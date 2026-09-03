import { normaliseEmail } from "@/lib/emailAddress";
import { isOwnerEmail } from "@/lib/owner";

/**
 * Deciding an admin email change (§43).
 *
 * Pure, because `vitest.config.mts` is pure-units-only and the repo has no
 * route-test harness — the same reason `matchItemForCustomer` was made pure so
 * the Monday matcher could be dry-run before it was trusted.
 *
 * Only the fields the decision actually needs, rather than the whole `Customer`
 * type: it keeps the tests honest and makes the dependency obvious.
 */
export type EmailChangeSubject = {
  email: string;
  user_id: string | null;
  stripe_customer_id: string | null;
  gr_stripe_customer_id: string | null;
};

export type EmailChangePlan =
  | {
      ok: true;
      email: string;
      /** Deduped; may be empty for a comped account that never reached Stripe. */
      stripeCustomerIds: string[];
      /** True when the change moves an owner off the OWNER_EMAILS allowlist. */
      ownerWarning: boolean;
    }
  | { ok: false; reason: "invalid" | "unchanged" | "no_login" };

export function planEmailChange(
  customer: EmailChangeSubject,
  raw: unknown
): EmailChangePlan {
  const email = normaliseEmail(raw);
  if (!email) return { ok: false, reason: "invalid" };

  // A no-op must not call Stripe or Supabase. Compared after normalising, so
  // re-submitting the same address in different case is correctly a no-op
  // rather than a write that leaves the two stores looking changed.
  if (normaliseEmail(customer.email) === email) {
    return { ok: false, reason: "unchanged" };
  }

  // No auth user means there is no login to move, and creating one is the
  // invite flow's job — the same reasoning the reset-password route already
  // applies. Fourteen active customers are in this state (waitlisted
  // prospects), so this is a real branch and not a defensive one.
  if (!customer.user_id) return { ok: false, reason: "no_login" };

  // ⚠️ BOTH Stripe ids, deduped. Management bills against `stripe_customer_id`
  // and GR may bill against `gr_stripe_customer_id` (§17), and the two are
  // frequently the SAME value — a customer who bought GR before the split, or
  // whose GR was provisioned against the shared customer. Deduping is what
  // stops a redundant second API call against the same object.
  const stripeCustomerIds = Array.from(
    new Set(
      [customer.stripe_customer_id, customer.gr_stripe_customer_id].filter(
        (id): id is string => typeof id === "string" && id.length > 0
      )
    )
  );

  // Moving an owner off the allowlist changes what /api/signup does if they
  // ever sign up again — it is the bypass that provisions an admin account.
  // WARN, do not block: their `admin` role lives in app_metadata and survives
  // the change, so this is a footnote rather than a reason to refuse.
  const ownerWarning = isOwnerEmail(customer.email) && !isOwnerEmail(email);

  return { ok: true, email, stripeCustomerIds, ownerWarning };
}

/** Human-readable refusal, so the route and the panel cannot word it differently. */
export function emailChangeRefusal(
  reason: "invalid" | "unchanged" | "no_login"
): string {
  switch (reason) {
    case "invalid":
      return "That is not a valid email address.";
    case "unchanged":
      return "That is already their email address.";
    case "no_login":
      return "This customer has no login yet. Use the invite action, which creates one.";
  }
}
