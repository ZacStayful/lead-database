import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import { planEmailChange, emailChangeRefusal } from "@/lib/customerEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change a customer's email — the login, the row, and Stripe (§43).
 *
 * WHY THIS EXISTS
 * ---------------
 * There was no way to do this at all. A customer who signed up with a personal
 * address but works from a business one had to be moved by hand-written SQL
 * across `customers` and `auth.users`, which nobody was going to do safely at
 * five to six on a Friday.
 *
 * ⚠️ WHY STRIPE IS NOT OPTIONAL
 * -----------------------------
 * `provisionPaidSubscriber` falls back to matching on `.eq("email", …)` when the
 * by-Stripe-id lookup misses, using the address off `stripe.customers.retrieve`.
 * So if `customers.email` moves and Stripe keeps the old one, the next invoice
 * that misses the id lookup PROVISIONS A DUPLICATE customers row and a second
 * auth user — and can repoint `stripe_customer_id` on the way through. Updating
 * our side alone plants that landmine and walks away.
 *
 * The primary webhook path is safe either way: `customerMatchFilter()` matches
 * on the Stripe id, not the address.
 *
 * ORDERING, AND WHY IT IS NOT THE ONE THE OTHER ROUTES USE
 * -------------------------------------------------------
 * /api/customer/subscription/plan calls Stripe first and rolls the price back if
 * the database write fails. /api/customer/subscription/cancel calls Stripe first
 * and deliberately does not roll back. Neither fits, so:
 *
 *   1. auth.users   — the only cheaply reversible step, and the likeliest to
 *                     fail (auth enforces its own uniqueness on email). Fail
 *                     here and nothing has moved.
 *   2. customers    — on a 23505 the address is already taken, so RESTORE the
 *                     auth email before returning. Leaving the two stores
 *                     disagreeing is worse than either outcome.
 *   3. Stripe       — failures here do NOT roll back 1 and 2. The login is what
 *                     the customer is waiting on and it now works; a stale
 *                     billing address is a hand-fixable annoyance. It is
 *                     reported in the response rather than swallowed.
 *
 * Sends no email, in either direction. The admin who made the change tells the
 * customer, as with the generated password.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Session only — deliberately NOT the x-admin-key fallback that reset-password
  // and invite carry. That header exists so crons and scripts can call in, and
  // repointing a customer's login should need a real admin session.
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: customer, error: fetchError } = await admin
    .from("customers")
    .select("id, email, contact_name, user_id, stripe_customer_id, gr_stripe_customer_id")
    .eq("id", params.id)
    .single();

  if (fetchError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const plan = planEmailChange(customer, body.email);
  if (!plan.ok) {
    return NextResponse.json(
      { error: emailChangeRefusal(plan.reason) },
      { status: plan.reason === "invalid" ? 400 : 409 }
    );
  }

  const previousEmail = customer.email;
  const userId = customer.user_id!;

  // 1 — the login.
  //
  // ⚠️ `email_confirm: true` is mandatory. Without it GoTrue treats this as a
  // pending change and sends a confirmation through SUPABASE'S BUILT-IN MAILER —
  // the shared test relay capped at roughly two emails an hour for the whole
  // project, which once locked a paying customer out for a week (§15). Every
  // email this codebase sends leaves through Resend, and this route sends none.
  const { error: authError } = await admin.auth.admin.updateUserById(userId, {
    email: plan.email,
    email_confirm: true,
  });

  if (authError) {
    console.error("admin email change: updateUserById failed", authError);
    const taken = /already|exists|registered|duplicate/i.test(
      authError.message ?? ""
    );
    return NextResponse.json(
      {
        error: taken
          ? "Another login already uses that address."
          : "Could not change the login email. Nothing has been changed.",
      },
      { status: taken ? 409 : 500 }
    );
  }

  // 2 — the row.
  const { error: rowError } = await admin
    .from("customers")
    .update({ email: plan.email, updated_at: new Date().toISOString() })
    .eq("id", customer.id);

  if (rowError) {
    // Put the login back so the two stores agree. `customers.email` is unique
    // and case-sensitive, so 23505 here means another customer row holds it.
    const { error: restoreError } = await admin.auth.admin.updateUserById(userId, {
      email: previousEmail,
      email_confirm: true,
    });
    if (restoreError) {
      // Both writes failed, which leaves auth ahead of the row — the one state
      // this route tries hardest to avoid, so it is named explicitly rather
      // than reported as a generic failure.
      console.error(
        "admin email change: row update failed AND auth restore failed",
        { rowError, restoreError }
      );
      return NextResponse.json(
        {
          error:
            "The login was changed but the customer record was not, and the login could not be put back. " +
            `Their login is now ${plan.email} and their record still says ${previousEmail}. Fix this before doing anything else.`,
        },
        { status: 500 }
      );
    }

    console.error("admin email change: row update failed, auth restored", rowError);
    const taken = rowError.code === "23505";
    return NextResponse.json(
      {
        error: taken
          ? "Another customer already has that email address. Nothing has been changed."
          : "Could not update the customer record. Nothing has been changed.",
      },
      { status: taken ? 409 : 500 }
    );
  }

  // 3 — Stripe. Best effort: never unwinds steps 1 and 2.
  let stripeResult: "updated" | "failed" | "none" =
    plan.stripeCustomerIds.length === 0 ? "none" : "updated";
  if (plan.stripeCustomerIds.length > 0) {
    try {
      const stripe = getStripe();
      for (const id of plan.stripeCustomerIds) {
        await stripe.customers.update(id, { email: plan.email });
      }
    } catch (err) {
      console.error("admin email change: Stripe update failed", err);
      stripeResult = "failed";
    }
  }

  // ⚠️ auth.identities carries its OWN copy of the address, and whether
  // updateUserById syncs it is GoTrue-version-dependent. Nothing in this repo
  // had ever changed an auth email, so there was no precedent to rely on —
  // report what actually happened rather than assuming. A stale identity is not
  // silently patched from here: it is GoTrue's table.
  let identityResult: "updated" | "stale" | "unknown" = "unknown";
  try {
    const { data: fresh } = await admin.auth.admin.getUserById(userId);
    const identityEmail = fresh?.user?.identities?.find(
      (i) => i.provider === "email"
    )?.identity_data?.email;
    if (typeof identityEmail === "string") {
      identityResult = identityEmail.toLowerCase() === plan.email ? "updated" : "stale";
    }
  } catch (err) {
    console.error("admin email change: identity read-back failed", err);
  }

  return NextResponse.json({
    ok: true,
    email: plan.email,
    previousEmail,
    stripe: stripeResult,
    identity: identityResult,
    ownerWarning: plan.ownerWarning,
  });
}
