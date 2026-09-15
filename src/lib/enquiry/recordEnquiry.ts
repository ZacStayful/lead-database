/**
 * Recording an enquiry — ONE definition, shared by both doors (§57).
 *
 * An enquiry can now arrive two ways: somebody fills in the form on the site,
 * or a Facebook lead ad drops an item on the Monday enquiries board and the
 * sync picks it up. Both end in exactly the same place — a `waitlisted`
 * customer row and a `prospect_booking_nudges` ladder — so both go through
 * here. Two implementations of "record an enquiry" would drift, and the
 * failure is silent on both sides: a prospect recorded but never chased, or
 * chased twice.
 *
 * Lifted verbatim out of POST /api/enquiry, the extraction `releaseLeads.ts`
 * (§54) and `contact/dueAttempts.ts` (§42.9) already made.
 *
 * ⚠️ THE TWO CALLERS DIFFER ON THE MOBILE, DELIBERATELY. The website REFUSES a
 * number it cannot parse — a 400 with `UK_MOBILE_ERRORS` copy, so the person
 * can correct it while they are still on the page. The sync cannot refuse
 * anything: nobody is watching, and dropping the lead would lose it entirely,
 * so it stores the cell exactly as it arrived and lets the email half of the
 * chase carry it (§40.9A — a number the operator has to SEE to fix must not be
 * blanked). Do not "fix" either one to match the other; the fix is a
 * regression in both directions.
 *
 * NEVER THROWS. Returns a result object, the contract `setEnquiryStatus` holds
 * and for the same reason: a failure here must not cost the caller its
 * response, and on the sync side an exception would leave a claimed item with
 * no customer behind it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createEnquiryContact,
  enquiryBoardId,
  normaliseName,
  phoneMatchKey,
  type LeadInterestLabel,
} from "@/lib/monday";
import { PLANS, type PlanKey } from "@/lib/plans";

export type EnquirySource = "website" | "monday_sync";
export type EnquiryMatchSignal = "email" | "phone";

/**
 * ⚠️ A DISCRIMINATED UNION, NOT AN OPTIONAL ITEM ID. "Mint me a board item"
 * and "I already have one" are different acts, and the type should make it
 * impossible to ask for both or neither. The sync must never create a second
 * item for a lead that is already on the board — that is how the board ends up
 * with the duplicate sales then works instead of the original.
 */
export type EnquiryMondayLink =
  | { kind: "create"; currentLeadSource: string }
  | { kind: "existing"; itemId: string };

export interface RecordEnquiryInput {
  source: EnquirySource;
  name: string;
  /** Lowercased by the caller. `customers.email` is `unique` and case-sensitive. */
  email: string;
  /** E.164 where it resolved; the RAW cell verbatim where it did not. */
  phone: string | null;
  websiteUrl: string;
  propertiesManaged: string;
  leadInterest: LeadInterestLabel;
  planKey: PlanKey;
  monday: EnquiryMondayLink;
  /**
   * Which signals may identify an existing customer. Defaults to `["email"]`,
   * which is the website's behaviour today, byte for byte. The sync adds
   * `"phone"`.
   */
  matchBy?: readonly EnquiryMatchSignal[];
  /**
   * Suppress a new ladder when one was started for this customer within N
   * days. The sync passes 30; the website passes nothing and keeps today's
   * semantics (the partial unique index alone).
   */
  ladderCooldownDays?: number;
  /**
   * False creates the customer and starts NO chase — an item too old to be
   * worth messaging. Defaults true.
   */
  chase?: boolean;
}

export type RecordEnquiryCustomerOutcome =
  | "created"
  | "updated"
  | "left_alone"
  | "ambiguous"
  | "failed";

export type RecordEnquiryLadderOutcome =
  | "created"
  | "already_active"
  | "cooldown"
  | "not_waitlisted"
  | "not_chased"
  | "failed";

export interface RecordEnquiryResult {
  customerId: string | null;
  customer: RecordEnquiryCustomerOutcome;
  mondayItemId: string | null;
  ladder: RecordEnquiryLadderOutcome;
  /** True when a phone hit was rejected because the name disagreed. */
  phoneAmbiguous: boolean;
  errors: string[];
}

interface ExistingCustomer {
  id: string;
  account_status: string | null;
  monday_item_id: string | null;
  contact_name: string | null;
  business_name: string | null;
}

const MATCH_COLUMNS = "id, account_status, monday_item_id, contact_name, business_name";

export async function recordEnquiry(
  admin: SupabaseClient,
  input: RecordEnquiryInput
): Promise<RecordEnquiryResult> {
  const errors: string[] = [];
  const matchBy = input.matchBy ?? (["email"] as const);
  const chase = input.chase ?? true;

  const plan = PLANS[input.planKey];
  const monthlyAllocation = plan.leads;
  const preferredPlan = `£${plan.priceGbp}/mo — ${plan.leads} leads`;

  // -------------------------------------------------------------------------
  // 1. The Monday item.
  //
  //    Creating one is non-fatal — we still create the account if it fails.
  //    ONE BOARD whichever service they asked for, with the "What kind of
  //    leads" cell saying which (§47).
  // -------------------------------------------------------------------------
  let mondayItemId: string | null = null;
  let mondayMatchedBy: string | null = null;

  if (input.monday.kind === "create") {
    try {
      mondayItemId = await createEnquiryContact({
        name: input.name,
        email: input.email,
        mobile: input.phone ?? "",
        websiteUrl: input.websiteUrl,
        propertiesManaged: input.propertiesManaged,
        leadInterest: input.leadInterest,
        preferredPlan,
        currentLeadSource: input.monday.currentLeadSource,
      });
      mondayMatchedBy = "created";
    } catch (err) {
      console.error("Monday enquiry push failed", err);
      errors.push("monday_push_failed");
    }
  } else {
    mondayItemId = input.monday.itemId;
    // ⚠️ NOT "created" — we neither made this item nor guessed at it, and
    // /api/admin/monday-status-check reports "created" as a high-confidence
    // link. 0151 widened the CHECK and the TS union together for this value.
    mondayMatchedBy = "monday_sync";
  }

  const mondayLink =
    mondayItemId && mondayMatchedBy
      ? {
          monday_item_id: mondayItemId,
          monday_board_id: enquiryBoardId(),
          monday_link_state: "linked",
          monday_link_matched_by: mondayMatchedBy,
        }
      : {};

  // -------------------------------------------------------------------------
  // 2. Find them, or create them.
  // -------------------------------------------------------------------------
  let customer: RecordEnquiryCustomerOutcome = "failed";
  let customerId: string | null = null;
  let phoneAmbiguous = false;

  try {
    // ⚠️ `.eq` ON THE LOWERCASED VALUE, NEVER `.ilike`. An address may
    // legitimately contain "_", which ilike treats as a single-character
    // wildcard — so an ilike lookup can match a DIFFERENT customer's row
    // (§43.1, measured before that route chose `.eq`).
    const { data: byEmail } = await admin
      .from("customers")
      .select(MATCH_COLUMNS)
      .eq("email", input.email)
      .maybeSingle();

    let existing = (byEmail as ExistingCustomer | null) ?? null;

    // ---------------------------------------------------------------------
    // ⚠️ THE PHONE TIER NEEDS THE NAME TO AGREE, AND THIS IS THE SHARPEST
    // EDGE IN THE WHOLE FEATURE.
    //
    // A phone match on its own merges two genuinely different people who share
    // an office number — entirely plausible among property companies — and the
    // second one is then NEVER CREATED AND NEVER CHASED. A lost lead is
    // exactly what this feature exists to prevent, and it would be invisible.
    //
    // §18 already settled the shape of this call for duplicate landlords:
    // "Strict on purpose and FAILS OPEN: under-matching costs a duplicate,
    // over-matching silently discards a real enquiry." So a phone hit whose
    // name disagrees is reported and the customer is created anyway. A
    // duplicate is recoverable; a lost lead is not.
    // ---------------------------------------------------------------------
    if (!existing && matchBy.includes("phone")) {
      const last9 = phoneMatchKey(input.phone);
      if (last9) {
        const { data: phoneHits } = await admin
          .from("customers")
          .select(MATCH_COLUMNS + ", phone")
          .ilike("phone", `%${last9}`);

        const hits = (phoneHits as (ExistingCustomer & { phone: string })[] | null) ?? [];
        // Exactly one, or nothing — §23.5's rule. Two hits is not a tie to be
        // broken, it is a question we cannot answer.
        if (hits.length === 1) {
          const wanted = normaliseName(input.name);
          const theirs = [
            normaliseName(hits[0].contact_name),
            normaliseName(hits[0].business_name),
          ].filter((n): n is string => Boolean(n));

          if (wanted && theirs.includes(wanted)) {
            existing = hits[0];
          } else {
            phoneAmbiguous = true;
          }
        } else if (hits.length > 1) {
          phoneAmbiguous = true;
        }
      }
    }

    if (existing) {
      customerId = existing.id;
      // Only refresh prospect data while still waitlisted; never touch an
      // already-invited/active/cancelled account from a public form, or from
      // an ad lead who happens to already be a customer.
      if (existing.account_status === "waitlisted") {
        const { error: updateError } = await admin
          .from("customers")
          .update({
            contact_name: input.name,
            business_name: input.name,
            phone: input.phone,
            monthly_allocation: monthlyAllocation,
            website_url: input.websiteUrl || null,
            properties_managed: input.propertiesManaged || null,
            // Only when the row has no link yet. Both doors can produce a
            // second board item for one person — the website creates a new
            // item on every submission, and Monday's own "Duplicate item"
            // mints a fresh id — and repointing the link at the newer one
            // would send status writes to the duplicate while sales works the
            // original. First item wins.
            ...(existing.monday_item_id ? {} : mondayLink),
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
        if (updateError) {
          console.error("Enquiry customer update failed", updateError);
          errors.push("customer_update_failed");
          customer = "failed";
        } else {
          customer = "updated";
        }
      } else {
        customer = "left_alone";
      }
    } else {
      // New prospect: the waitlisted customer row only (`user_id` stays null).
      // The Supabase auth user is created later, at admin invite time — so
      // neither a public form nor an ad ever provisions a confirmed login for
      // an arbitrary email.
      const { data: inserted, error: customerError } = await admin
        .from("customers")
        .insert({
          business_name: input.name,
          contact_name: input.name,
          email: input.email,
          phone: input.phone,
          monthly_allocation: monthlyAllocation,
          subscription_status: "inactive",
          account_status: "waitlisted",
          website_url: input.websiteUrl || null,
          properties_managed: input.propertiesManaged || null,
          ...mondayLink,
        })
        .select("id")
        .maybeSingle();

      if (customerError) {
        // ⚠️ 23505 is a RACE, not a failure: the website route and the sync can
        // both reach this line for one person inside the same second. Re-read
        // and carry on rather than reporting a failure that did not happen.
        if (customerError.code === "23505") {
          const { data: raced } = await admin
            .from("customers")
            .select(MATCH_COLUMNS)
            .eq("email", input.email)
            .maybeSingle();
          customerId = (raced as ExistingCustomer | null)?.id ?? null;
          customer = customerId ? "left_alone" : "failed";
        } else {
          console.error("Enquiry customer insert failed", customerError);
          errors.push("customer_insert_failed");
          customer = "failed";
        }
      } else {
        customerId = inserted?.id ?? null;
        customer = "created";
      }
    }
  } catch (err) {
    console.error("Enquiry account creation error", err);
    errors.push("customer_error");
    customer = "failed";
  }

  if (phoneAmbiguous) {
    // Reported, never silent: this is the case a human has to look at.
    customer = customer === "created" ? "ambiguous" : customer;
  }

  // -------------------------------------------------------------------------
  // 3. Start the booking chase (§55).
  //
  //    They are about to be sent the Calendly link, and most of them will not
  //    book. This row is the ladder that chases them: WhatsApp and email about
  //    two minutes from now, another at 24 hours, a third at 48, stopping the
  //    moment Calendly says they booked.
  //
  //    ⚠️ NON-FATAL, exactly like the Monday push above. A failed ladder must
  //    never cost us the enquiry itself, which is the thing we cannot
  //    recreate. The partial unique index does the rest: a prospect who
  //    enquires twice while still waitlisted collides on 23505 and keeps the
  //    ladder they already have, rather than being chased twice over.
  // -------------------------------------------------------------------------
  let ladder: RecordEnquiryLadderOutcome = "failed";

  try {
    const { data: prospect } = await admin
      .from("customers")
      .select("id, account_status")
      .eq("email", input.email)
      .maybeSingle();

    if (!prospect || prospect.account_status !== "waitlisted") {
      ladder = "not_waitlisted";
    } else if (!chase) {
      ladder = "not_chased";
    } else {
      let onCooldown = false;
      if (input.ladderCooldownDays && input.ladderCooldownDays > 0) {
        // ⚠️ The partial unique index only covers a LIVE ladder. Monday's
        // "Duplicate item" mints a new item id, so the claims table cannot see
        // it — and if the earlier ladder has since COMPLETED, nothing else
        // stops the same person being chased all over again.
        const since = new Date(
          Date.now() - input.ladderCooldownDays * 24 * 60 * 60 * 1000
        ).toISOString();
        const { data: recent } = await admin
          .from("prospect_booking_nudges")
          .select("id")
          .eq("customer_id", prospect.id)
          .gte("enquired_at", since)
          .limit(1);
        onCooldown = Boolean(recent && recent.length > 0);
      }

      if (onCooldown) {
        ladder = "cooldown";
      } else {
        // ⚠️ `enquired_at` is left to its `now()` default and must NEVER be
        // backdated to the board item's creation time. `prospectWork` returns
        // the earliest unfinished step and the cron claims one step per tick,
        // so a ladder seeded three days in the past fires steps 1, 2 and 3 on
        // three consecutive MINUTES. The chase starts when we noticed, which
        // is also the honest reading.
        const { error: ladderError } = await admin
          .from("prospect_booking_nudges")
          .insert({ customer_id: prospect.id, source: input.source });

        if (!ladderError) {
          ladder = "created";
        } else if (ladderError.code === "23505") {
          // The ordinary case — they already have a live ladder.
          ladder = "already_active";
        } else {
          console.error("Enquiry booking-chase insert failed", ladderError);
          errors.push("ladder_insert_failed");
          ladder = "failed";
        }
      }
    }
  } catch (err) {
    console.error("Enquiry booking-chase error", err);
    errors.push("ladder_error");
    ladder = "failed";
  }

  return { customerId, customer, mondayItemId, ladder, phoneAmbiguous, errors };
}
