/**
 * Turning new Monday enquiries-board items into enquiries (§57).
 *
 * Facebook lead ads write into board 18420649520, group "New enquiries" — the
 * same board, group and column ids the website form writes to — and until this
 * existed nothing noticed. A Facebook lead became a row on a board and stopped
 * there.
 *
 * Shared by the cron and an admin button, the `releaseLeads.ts` two-caller
 * shape (§54). The admin caller is also the only way to run the dry run at
 * all, since a Vercel preview answers 302 to vercel.com/sso-api (§1.1, §45).
 *
 * ⚠️ THE ORDER OF THE PER-ITEM STEPS IS THE RULE. Everything that can decide
 * "not this one" is answered BEFORE the claim, because claiming a
 * half-populated item would bar it from ever being ingested — worse than the
 * duplicate a claim prevents. See `decideEnquiryItem`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchNewEnquiryItems,
  setEnquiryMobile,
  enquiryBoardId,
  toLeadInterest,
  LEAD_INTEREST,
  type EnquiryIntakeItem,
} from "@/lib/monday";
import { ukMobileE164 } from "@/lib/leadQuality";
import { planKeyFromPreferredPlan } from "@/lib/plans";
import { decideEnquiryItem, type EnquiryItemFields } from "./enquiryItem";
import { recordEnquiry } from "./recordEnquiry";

/** Mirrors the `outcome` CHECK in 0151. Asserted against it in vitest. */
export type EnquiryClaimOutcome =
  | "customer_created"
  | "customer_matched"
  | "already_linked"
  | "ambiguous_phone"
  | "junk"
  | "bad_email"
  | "stale_incomplete"
  | "error";

export interface SyncMondayEnquiriesOptions {
  dryRun?: boolean;
  /**
   * Overrides `enquiry_sync_from`. ⚠️ DRY RUN ONLY — the caller must refuse it
   * otherwise. It exists because the cutoff is seeded at apply time, so the
   * items already on the board are all pre-cutoff and a plain dry run can only
   * ever report "nothing to do", which proves nothing about the classifier.
   */
  since?: Date | null;
  limit?: number;
  now?: Date;
}

export interface SyncMondayEnquiriesResult {
  ok: boolean;
  dryRun: boolean;
  /** ⚠️ A permanent zero means Facebook moved group and this is silently dead. */
  fetched: number;
  created: number;
  matched: number;
  deferred: Record<string, number>;
  skipped: Record<string, number>;
  /** Claims left pending past the retry window — each one a lost lead. */
  stuck: string[];
  errors: string[];
}

/** 10 minutes: long enough that an in-flight run is not treated as crashed. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
/** After 2 hours a pending claim is reported rather than retried for ever. */
const RETRY_GIVE_UP_MS = 2 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function bump(into: Record<string, number>, key: string) {
  into[key] = (into[key] ?? 0) + 1;
}

function fieldsOf(item: EnquiryIntakeItem): EnquiryItemFields {
  return {
    name: item.name,
    email: item.email,
    mobile: item.mobile,
    websiteUrl: item.websiteUrl,
    propertiesManaged: item.propertiesManaged,
    preferredPlan: item.preferredPlan,
    currentLeadSource: item.currentLeadSource,
  };
}

/**
 * The website normalises its URL inline; this does the same so a Facebook
 * "wyndale.uk" becomes a link rather than a broken relative path.
 */
function normaliseWebsiteUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function syncMondayEnquiries(
  admin: SupabaseClient,
  cutoff: Date | null,
  options: SyncMondayEnquiriesOptions = {}
): Promise<SyncMondayEnquiriesResult> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const effectiveCutoff = options.since ?? cutoff;

  const result: SyncMondayEnquiriesResult = {
    ok: true,
    dryRun,
    fetched: 0,
    created: 0,
    matched: 0,
    deferred: {},
    skipped: {},
    stuck: [],
    errors: [],
  };

  const read = await fetchNewEnquiryItems(options.limit ?? 50);
  if (!read.ok) {
    result.ok = false;
    result.errors.push(read.error);
    return result;
  }
  result.fetched = read.items.length;

  // Which items have we already decided about? Read in one go rather than per
  // item — this runs every minute and the group is small.
  const ids = read.items.map((i) => i.id);
  const claimsById = new Map<
    string,
    { id: string; status: string; attempts: number; claimed_at: string }
  >();
  if (ids.length > 0) {
    const { data, error } = await admin
      .from("monday_enquiry_claims")
      .select("id, monday_item_id, status, attempts, claimed_at")
      .in("monday_item_id", ids);
    if (error) {
      // ⚠️ FAILS CLOSED. Without the claim ledger we cannot tell a new item
      // from one already handled, and guessing would re-create customers and
      // re-chase people.
      result.ok = false;
      result.errors.push(`claims_read_failed: ${error.message}`);
      return result;
    }
    for (const row of data ?? []) {
      claimsById.set(String(row.monday_item_id), row as never);
    }
  }

  for (const item of read.items) {
    const decision = decideEnquiryItem({
      fields: fieldsOf(item),
      statusLabel: item.statusLabel,
      createdAt: item.createdAt ? new Date(item.createdAt) : null,
      cutoff: effectiveCutoff,
      now,
    });

    if (decision.action === "defer") {
      bump(result.deferred, decision.defer ?? "unknown");
      continue;
    }

    const existingClaim = claimsById.get(item.id);

    if (decision.action === "skip") {
      // A skip still claims, when the reason is about the ITEM rather than the
      // clock — otherwise every tick re-reads the same junk for ever. But a
      // cutoff skip must NOT claim: it is a filter, and the item may become
      // ingestable if the cutoff ever moves.
      const reason = decision.skip ?? "unknown";
      bump(result.skipped, reason);
      if (reason === "no_cutoff" || reason === "before_cutoff") continue;
      if (existingClaim || dryRun) continue;

      const outcome: EnquiryClaimOutcome =
        reason === "bad_email"
          ? "bad_email"
          : reason === "stale_incomplete"
            ? "stale_incomplete"
            : reason === "not_new_status"
              ? "already_linked"
              : "junk";
      await settleFresh(admin, item, outcome, reason, result);
      continue;
    }

    // ---- ingest ----------------------------------------------------------
    if (existingClaim) {
      if (existingClaim.status !== "pending") continue;

      // ⚠️ A PENDING CLAIM IS A LOST LEAD UNLESS SOMETHING RETRIES IT. The row
      // is written before the customer, so a crash in between leaves an item
      // claimed with nothing behind it — and nothing would ever look at it
      // again. Bounded: retried between 10 minutes and 2 hours, then reported.
      const age = now.getTime() - new Date(existingClaim.claimed_at).getTime();
      if (age < RETRY_AFTER_MS) continue;
      if (age > RETRY_GIVE_UP_MS || existingClaim.attempts >= MAX_ATTEMPTS) {
        result.stuck.push(item.id);
        continue;
      }
      if (dryRun) {
        bump(result.skipped, "pending_retry");
        continue;
      }
      await admin
        .from("monday_enquiry_claims")
        .update({ attempts: existingClaim.attempts + 1, updated_at: new Date().toISOString() })
        .eq("id", existingClaim.id);
    }

    if (dryRun) {
      result.created += 1;
      continue;
    }

    // ---- 6. CLAIM BY INSERT, then act ------------------------------------
    let claimId = existingClaim?.id ?? null;
    if (!claimId) {
      const { data: claim, error: claimError } = await admin
        .from("monday_enquiry_claims")
        .insert({
          monday_item_id: item.id,
          monday_board_id: enquiryBoardId(),
          item_created_at: item.createdAt || null,
        })
        .select("id")
        .maybeSingle();

      if (claimError) {
        // 23505 means another run claimed it between our read and this insert.
        // Ordinary at a once-a-minute cadence, and the right answer is to do
        // nothing at all.
        if (claimError.code !== "23505") {
          result.errors.push(`claim_failed ${item.id}: ${claimError.message}`);
        }
        continue;
      }
      claimId = claim?.id ?? null;
    }

    // ---- 7. Already linked to a customer? --------------------------------
    const { data: linked } = await admin
      .from("customers")
      .select("id")
      .eq("monday_item_id", item.id)
      .maybeSingle();

    if (linked) {
      result.matched += 1;
      bump(result.skipped, "already_linked");
      await settle(admin, claimId, "already_linked", linked.id, null);
      continue;
    }

    // ---- 8. Record it ----------------------------------------------------
    //
    // ⚠️ The mobile is normalised but NEVER blanked. `07…`, `+447…` and
    // `+4407…` all resolve to `+447…`; anything else is stored exactly as it
    // arrived so the operator can see and fix it (§40.9A), and the email half
    // of the chase still runs.
    const rawMobile = item.mobile.trim() || item.phoneCell.trim();
    const uk = ukMobileE164(rawMobile);
    const phone = uk.ok ? uk.value : rawMobile || null;

    const recorded = await recordEnquiry(admin, {
      source: "monday_sync",
      name: item.name.trim(),
      email: item.email.trim().toLowerCase(),
      phone,
      websiteUrl: normaliseWebsiteUrl(item.websiteUrl),
      propertiesManaged: item.propertiesManaged.trim(),
      leadInterest: toLeadInterest(item.leadInterest) ?? LEAD_INTEREST.management,
      planKey: planKeyFromPreferredPlan(item.preferredPlan),
      monday: { kind: "existing", itemId: item.id },
      // The extra tier the website does not use — and it needs the name to
      // agree before it merges anybody. See recordEnquiry.
      matchBy: ["email", "phone"],
      // Monday's own "Duplicate item" mints a NEW item id, so the claims table
      // cannot see it. Without this a completed earlier ladder is restarted
      // and the same person is chased all over again.
      ladderCooldownDays: 30,
      chase: decision.chase,
    });

    if (recorded.customer === "failed") {
      result.errors.push(`record_failed ${item.id}: ${recorded.errors.join(",")}`);
      await settle(admin, claimId, "error", recorded.customerId, recorded.errors.join(","));
      continue;
    }

    if (recorded.customer === "created" || recorded.customer === "ambiguous") {
      result.created += 1;
    } else {
      result.matched += 1;
    }
    if (recorded.phoneAmbiguous) bump(result.skipped, "ambiguous_phone");

    const outcome: EnquiryClaimOutcome = recorded.phoneAmbiguous
      ? "ambiguous_phone"
      : recorded.customer === "created"
        ? "customer_created"
        : "customer_matched";
    await settle(admin, claimId, outcome, recorded.customerId, null);

    // ---- 9. Tidy the board, last -----------------------------------------
    //
    // ⚠️ AFTER the customer and the ladder, never before. This is cosmetic and
    // a Monday failure must not cost us the enquiry (§23.6's "Monday last").
    if (uk.ok) {
      const write = await setEnquiryMobile({
        itemId: item.id,
        mobile: uk.value,
        currentCell: item.mobile,
      });
      if (write.error) result.errors.push(`mobile_write ${item.id}: ${write.error}`);
    }
  }

  return result;
}

async function settle(
  admin: SupabaseClient,
  claimId: string | null,
  outcome: EnquiryClaimOutcome,
  customerId: string | null,
  error: string | null
) {
  if (!claimId) return;
  await admin
    .from("monday_enquiry_claims")
    .update({
      status: "settled",
      outcome,
      customer_id: customerId,
      error,
      settled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);
}

/** Claim and settle in one go, for an item we decided about without writing. */
async function settleFresh(
  admin: SupabaseClient,
  item: EnquiryIntakeItem,
  outcome: EnquiryClaimOutcome,
  detail: string,
  result: SyncMondayEnquiriesResult
) {
  const { error } = await admin.from("monday_enquiry_claims").insert({
    monday_item_id: item.id,
    monday_board_id: enquiryBoardId(),
    item_created_at: item.createdAt || null,
    status: "skipped",
    outcome,
    error: detail,
    settled_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") {
    result.errors.push(`skip_claim_failed ${item.id}: ${error.message}`);
  }
}
