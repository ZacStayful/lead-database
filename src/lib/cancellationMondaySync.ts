import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadType } from "@/lib/types";
import { cancelReasonLabel } from "@/lib/cancelOptions";
import {
  enquiryBoardId,
  fetchEnquiryBoardIndex,
  setEnquiryCancellation,
} from "@/lib/monday";
import {
  buildCancelPush,
  pickCancelItem,
  resolveCancelSource,
  type MondayCancelLabel,
} from "@/lib/mondayCancel";

/**
 * Push a customer's cancellation reason and comment to the Monday enquiries
 * board (§72). Called from the in-app cancel route and the Stripe webhook.
 *
 * NEVER THROWS, and returns a result object: every caller runs after the
 * cancellation has already happened in Stripe, and the webhook's outer catch
 * would delete its stripe_events claim on an escaped exception (§23.6).
 *
 * RE-READS THE DATABASE rather than trusting the caller, so both triggers reach
 * the same answer whichever runs last — see resolveCancelSource.
 */
export interface CancellationPushResult {
  written: boolean;
  skipped?:
    | "not_configured"
    | "no_reason"
    | "no_email"
    | "no_match"
    | "ambiguous"
    | "unchanged"
    | "board_unreadable";
  error?: string;
  itemId?: string;
  label?: MondayCancelLabel;
}

export async function pushCancellationToMonday(
  admin: SupabaseClient,
  params: {
    customerId: string;
    leadType: LeadType;
    /**
     * Scopes the audit-row lookup to THIS subscription, so an un-reverted row
     * from an earlier episode can never be pushed for a new cancellation.
     */
    stripeSubscriptionId: string;
    source: string;
  }
): Promise<CancellationPushResult> {
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    console.error(`[monday-cancel] ${msg}`, {
      customer: params.customerId,
      source: params.source,
      ...extra,
    });

  try {
    if (!process.env.MONDAY_API_TOKEN) {
      return { written: false, skipped: "not_configured" };
    }

    const [{ data: auditRow, error: auditError }, { data: customer, error: customerError }] =
      await Promise.all([
        admin
          .from("subscription_cancellations")
          .select("reasons, note")
          .eq("customer_id", params.customerId)
          .eq("lead_type", params.leadType)
          .eq("stripe_subscription_id", params.stripeSubscriptionId)
          .is("reverted_at", null)
          .order("requested_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ reasons: string[] | null; note: string | null }>(),
        admin
          .from("customers")
          .select(
            "email, monday_item_id, monday_board_id, cancellation_feedback, cancellation_comment"
          )
          .eq("id", params.customerId)
          .maybeSingle<{
            email: string | null;
            monday_item_id: string | null;
            monday_board_id: string | null;
            cancellation_feedback: string | null;
            cancellation_comment: string | null;
          }>(),
      ]);

    if (auditError) log("audit read failed", { error: auditError.message });
    if (customerError || !customer) {
      log("customer read failed", { error: customerError?.message ?? "not found" });
      return { written: false, error: customerError?.message ?? "customer not found" };
    }

    const source = resolveCancelSource({
      leadType: params.leadType,
      auditRow: auditRow ?? null,
      customer,
      labelFor: cancelReasonLabel,
    });
    if (!source) return { written: false, skipped: "no_reason" };

    const push = buildCancelPush({
      reasons: source.reasons,
      comment: source.comment,
      leadType: params.leadType,
    });

    const board = await fetchEnquiryBoardIndex();
    if (!board.ok) {
      log("board unreadable", { error: board.error });
      return { written: false, skipped: "board_unreadable", error: board.error };
    }

    // The stored link is only trusted when it is on THIS board — a GR-form
    // enquirer's link can point at the status-less GR board (§23.7).
    const linkedItemId =
      customer.monday_item_id && customer.monday_board_id === enquiryBoardId()
        ? customer.monday_item_id
        : null;
    const pick = pickCancelItem(customer.email, linkedItemId, board.items);
    if (pick.itemId === null) {
      // Never create an item here — a cancellation with no board item is a
      // matching problem for a human, not something to paper over.
      log(`no board item written (${pick.reason})`, { email: customer.email });
      return { written: false, skipped: pick.reason };
    }

    const write = await setEnquiryCancellation({
      itemId: pick.itemId,
      label: push.label,
      comment: push.comment,
    });
    if (write.error) {
      log("write failed", { item: pick.itemId, error: write.error });
      return { written: false, error: write.error, itemId: pick.itemId, label: push.label };
    }
    return {
      written: write.written,
      skipped: write.skipped === "unchanged" ? "unchanged" : undefined,
      itemId: pick.itemId,
      label: push.label,
    };
  } catch (err) {
    log("threw", { error: err instanceof Error ? err.message : String(err) });
    return { written: false, error: err instanceof Error ? err.message : String(err) };
  }
}
