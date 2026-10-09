import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductCustomerFields } from "@/lib/products";
import { funnelEnabledFrom, type FunnelStep } from "@/lib/funnel/session";
import { hashFunnelToken, looksLikeFunnelToken } from "@/lib/funnel/token";

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
  "id, name, email, phone, monday_item_id, answers, base_postcode_locked, preview_snapshot, plan_selected, step, customer_id, paid_at";

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
