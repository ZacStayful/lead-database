import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductCustomerFields } from "@/lib/products";
import { funnelEnabledFrom, isAlreadySetUp, type FunnelStep } from "@/lib/funnel/session";
import { alreadySetUpLoginUrl, hashFunnelToken, looksLikeFunnelToken } from "@/lib/funnel/token";

/**
 * The funnel's reads (batch 02 Phase 2). SERVER-SIDE ONLY: every caller holds
 * the service-role client, because funnel_sessions is RLS-on with no policies
 * (0165) and the visitor has no session at all.
 */

/**
 * Whether the funnel is on. FAILS CLOSED: an unreadable switch is off, and is
 * logged. The funnel ends in a payment, so "the database was briefly
 * unreachable" must never read as "on" (§18.3's argument, the other way round
 * from a cron that merely skips).
 */
export async function readFunnelEnabled(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "funnel_enabled")
    .maybeSingle();
  if (error) {
    console.error("[funnel] funnel_enabled read failed, treating as off", error.message);
    return false;
  }
  return funnelEnabledFrom((data as { value?: string } | null)?.value);
}

export const FUNNEL_SESSION_COLUMNS =
  "id, name, email, phone, monday_item_id, answers, base_postcode_locked, preview_snapshot, plan_selected, step, customer_id, discount_offer_id, paid_at";

export interface FunnelSessionRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  monday_item_id: string | null;
  answers: Record<string, unknown>;
  base_postcode_locked: string | null;
  preview_snapshot: Record<string, unknown> | null;
  plan_selected: number | null;
  step: FunnelStep;
  customer_id: string | null;
  discount_offer_id: string | null;
  paid_at: string | null;
}

export type SessionLookup =
  | { ok: true; session: FunnelSessionRow | null }
  | { ok: false; message: string };

/**
 * The session a raw token opens, or null. A malformed token never reaches the
 * database, and "no such session" and "not a token of ours" look the same to
 * the caller (one 404, so the route cannot be used to probe).
 */
export async function loadSessionByToken(admin: SupabaseClient, raw: string): Promise<SessionLookup> {
  if (!looksLikeFunnelToken(raw)) return { ok: true, session: null };
  const { data, error } = await admin
    .from("funnel_sessions")
    .select(FUNNEL_SESSION_COLUMNS)
    .eq("token_hash", hashFunnelToken(raw))
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  return { ok: true, session: (data as FunnelSessionRow | null) ?? null };
}

/**
 * The funnel session an offer was issued to (Phase 5's discount), if any.
 * `/pay` sends that offer's payment through the funnel's own checkout, so the
 * payer is set up as a funnel customer (sign-in link, brief) rather than a
 * call customer. Newest first: a session is linked to at most one offer, but
 * an offer row is reused in place when it expires (postCallOfferIssue.ts).
 */
export async function funnelSessionForOffer(
  admin: SupabaseClient,
  offerId: string
): Promise<{ ok: true; session: FunnelSessionRow | null } | { ok: false; message: string }> {
  const { data, error } = await admin
    .from("funnel_sessions")
    .select(FUNNEL_SESSION_COLUMNS)
    .eq("discount_offer_id", offerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  return { ok: true, session: (data as FunnelSessionRow | null) ?? null };
}

export type CustomerLookup =
  | { ok: true; customers: (ProductCustomerFields & { id: string })[] }
  | { ok: false; message: string };

/**
 * Every customer row carrying this email. `.eq`, never `.ilike` (§43.1: an
 * address may contain `_`, an ilike wildcard). The email is already
 * lower-cased (normaliseEmail), and §43.1 measured no mixed-case rows.
 *
 * A list, not maybeSingle: an archived duplicate can share the address (§18D),
 * and a second row must not turn the lookup into an error that reads as "no
 * customer".
 */
export async function customersByEmail(admin: SupabaseClient, email: string): Promise<CustomerLookup> {
  const { data, error } = await admin
    .from("customers")
    .select("id, account_status, subscription_status, gr_subscription_status")
    .eq("email", email)
    .limit(5);
  if (error) return { ok: false, message: error.message };
  return { ok: true, customers: (data ?? []) as (ProductCustomerFields & { id: string })[] };
}

/** Every funnel API response: per visitor, never cached anywhere. */
export const FUNNEL_NO_STORE = { "Cache-Control": "no-store, private" } as const;

export type FunnelGate =
  | { ok: true; session: FunnelSessionRow }
  | { ok: false; response: NextResponse };

/**
 * The checks every token-holding funnel route makes first, in one place so
 * the routes cannot drift apart (02 Phases 2 and 3):
 *
 *   1. the switch: off is a 403, and an unreadable switch is off;
 *   2. the token: an unknown session is a 404, a failed lookup a 503;
 *   3. "already set up": a paid session, or somebody who already holds
 *      Management, gets a 409 carrying the login link. An unreadable
 *      customer list refuses (503) rather than guessing "not a customer".
 */
export async function funnelGate(admin: SupabaseClient, rawToken: string, tag: string): Promise<FunnelGate> {
  const refuse = (body: Record<string, unknown>, status: number): FunnelGate => ({
    ok: false,
    response: NextResponse.json(body, { status, headers: FUNNEL_NO_STORE }),
  });

  if (!(await readFunnelEnabled(admin))) return refuse({ code: "funnel_disabled" }, 403);

  const lookup = await loadSessionByToken(admin, rawToken);
  if (!lookup.ok) {
    console.error(`[funnel/${tag}] session lookup failed`, lookup.message);
    return refuse({ code: "unavailable" }, 503);
  }
  const session = lookup.session;
  if (!session) return refuse({ code: "not_found" }, 404);

  const alreadySetUp = () => refuse({ code: "already_set_up", loginUrl: alreadySetUpLoginUrl() }, 409);
  if (session.step === "paid") return alreadySetUp();
  const customers = await customersByEmail(admin, session.email);
  if (!customers.ok) {
    console.error(`[funnel/${tag}] customer lookup failed`, customers.message);
    return refuse({ code: "unavailable" }, 503);
  }
  if (customers.customers.some(isAlreadySetUp)) return alreadySetUp();

  return { ok: true, session };
}
