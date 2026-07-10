import { createAdminClient } from "@/lib/supabase/admin";
import { sendWelcomeEmail } from "@/lib/emails";
import type { Customer } from "@/lib/types";

/**
 * Detect a customer's first-ever portal sign-in and send a one-time welcome
 * email. Called from the dashboard layout — the first authenticated server
 * render after login — because sign-in itself is handled client-side by
 * Supabase and never touches our server.
 *
 * Exactly-once is enforced in the database, not here: the UPDATE only matches
 * while first_login_at IS NULL, so of any number of concurrent renders (repeat
 * navigations, multiple tabs) exactly one gets a row back and sends the email.
 * The rest find it already stamped and quietly do nothing.
 *
 * Best-effort: any failure (email or DB) is swallowed so it can never break the
 * dashboard from rendering. A failed send simply means no welcome email — the
 * flag is only stamped when the flip succeeds, but the email is fire-and-forget
 * after that, matching how the other notification emails behave.
 */
export async function markFirstLoginAndNotify(customer: Customer): Promise<void> {
  // Cheap early exit on the common path (already logged in before) — avoids an
  // UPDATE round-trip on every dashboard navigation once stamped.
  if (customer.first_login_at) return;

  try {
    const admin = createAdminClient();

    // Atomic claim: only the request that flips NULL -> now() gets a row back.
    const { data: flipped } = await admin
      .from("customers")
      .update({ first_login_at: new Date().toISOString() })
      .eq("id", customer.id)
      .is("first_login_at", null)
      .select("id")
      .maybeSingle();

    if (!flipped) return; // Another request already claimed the first login.

    await sendWelcomeEmail({
      to: customer.email,
      contactName: customer.contact_name,
    });
  } catch {
    // Never let onboarding side-effects block the dashboard render.
  }
}
