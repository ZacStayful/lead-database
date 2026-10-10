import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The dashboard gate's one read for the confirm-on-login screen (batch 04
 * Phase 3). Kept apart from briefAreaConfirm.ts so the dashboard layout, which
 * runs on every page, imports nothing else of it.
 *
 * Whether this customer has a pending version. NULL on a read error, which
 * the gate reads as "no" (needsAreaConfirmation fails open).
 */
export async function pendingAreaRead(admin: SupabaseClient, customerId: string): Promise<boolean | null> {
  const { data, error } = await admin
    .from("customer_lead_briefs")
    .select("id")
    .eq("customer_id", customerId)
    .eq("status", "pending_confirmation")
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[area-confirm] pending read failed; not gating", { customer: customerId, error: error.message });
    return null;
  }
  return Boolean(data);
}
