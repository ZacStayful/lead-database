/**
 * How many leads a paid invoice buys — decided from the money, not from a note.
 *
 * THE BUG THIS EXISTS TO CLOSE. `/api/customer/subscribe` writes
 * `monthly_allocation` into the customer row BEFORE creating the Stripe Checkout
 * Session (CLAUDE.md §17 calls this "the one trap"), and `invoice.paid` then
 * credits from that row rather than from the invoice. The row is a note about
 * what somebody was ABOUT to buy; the invoice is what they actually bought. When
 * the two disagree, the note used to win.
 *
 * Nobody has to be scheming for them to disagree. Anyone who looks at both plans
 * before buying leaves the note on whichever they clicked LAST, not on what they
 * paid for — so a customer who considers the £300/20 plan, thinks better of it,
 * and buys the £150/10 plan was credited 20 leads a month, indefinitely. And it
 * was invisible, because the admin MRR figure reads the same note: they showed up
 * as £300 of revenue while paying £150, so the two errors concealed each other.
 *
 * Guaranteed Rent has had the price-keyed half of this since its £300/20 plan
 * launched. Management was deliberately left without it, and this is that gap.
 *
 * ── WHY "THE PRICE CHANGED" AND NOT "THE PRICE DISAGREES" ──────────────
 *
 * The obvious rule is "always credit the price". It is airtight and it is wrong,
 * because it silently withdraws a COMP: an admin who deliberately sets a
 * customer to 20 leads on a £150 subscription means it, and §17 and §24 both
 * declined to introduce a re-size that would undo that.
 *
 * So this function overrules the row in exactly one circumstance: a
 * subscription's ACTIVATING invoice — the first invoice for a Stripe
 * subscription we have not recorded yet. That is the only moment the row can be
 * stale, and the only moment at which no comp can exist, because that
 * subscription has never been billed to comp against. A cancel-and-return
 * (§32.3) is a new subscription and so is covered.
 *
 * Everywhere else the row wins and the disagreement is merely logged. Keeping
 * the row honest after activation is the subscription branch's job, and it is
 * better placed for it: it reads the subscription's CURRENT price, where an
 * invoice may carry a proration line from an upgrade, or be a stale past_due
 * charge at a price the customer has since left.
 */

/** What the decision needs to know. All of it is already to hand at both sites. */
export interface CreditAllocationInput {
  /**
   * The allocation the invoice's own price implies, or null when the price is
   * not one we recognise. MUST come from the strict `allocationForPriceIds` /
   * `grAllocationForPriceIds`, never from the subtotal-guessing
   * `allocationFromPrices` — see the warning on the strict helper.
   */
  invoiceAllocation: number | null;
  /** The allocation stored on the customer row. */
  rowAllocation: number;
  /**
   * Whether this invoice belongs to a subscription we have not recorded against
   * the customer yet — i.e. this is that subscription's ACTIVATING invoice.
   *
   * ⚠️ THE ONLY CASE THIS FUNCTION MAY OVERRULE THE ROW, and the narrowness is
   * deliberate. The row is stale at exactly one moment — activation, before
   * `customer.subscription.*` has landed and corrected it — and that is where
   * the bug lives. Afterwards the subscription branch owns the row: it sees the
   * subscription's CURRENT price, where an invoice may carry a proration line or
   * be a stale past_due charge at a price the customer has already left. Acting
   * on those would downgrade somebody permanently.
   *
   * ⚠️ PER SUBSCRIPTION, NOT PER CUSTOMER. "Has this customer ever paid us" is
   * the wrong question: a customer who cancels and re-subscribes (§32.3) has
   * paid before, and if they return to the tier they previously held the
   * subscription branch sees no price change either — so the bug would survive
   * untouched for exactly the population that flow was built for. A
   * re-subscription is a NEW Stripe subscription id, so comparing against the
   * recorded one catches it.
   *
   * Not inferred from a null `stripe_price_id`: that column arrived in 0088 with
   * no backfill, so a long-standing comped customer can still be carrying null.
   * `stripe_subscription_id` has been written since 0001.
   */
  isActivatingInvoice: boolean;
  /**
   * A self-serve tier change awaiting its next invoice (§24). When the invoice's
   * price is the one that change is FOR, the change is being applied by
   * `applyPendingPlanChange` and this must stand down rather than race it.
   */
  pendingAllocation: number | null;
}

export interface CreditAllocationDecision {
  /** The allocation to credit from. */
  allocation: number;
  /** Whether it came from the invoice's price rather than the row. */
  fromInvoice: boolean;
  /**
   * True when the invoice's price implies something other than what we are
   * crediting. Worth logging either way — if the row won, this is a comp or a
   * mistake, and only a human can tell which.
   */
  drift: boolean;
}

/**
 * Decide what a paid invoice credits.
 *
 * Pure, and deliberately so: the Stripe webhook is the least testable file in
 * the repo, and this is the part of it that decides money.
 */
export function resolveCreditAllocation(
  input: CreditAllocationInput
): CreditAllocationDecision {
  const { invoiceAllocation, rowAllocation, isActivatingInvoice } = input;

  // An unrecognised — or AMBIGUOUS — price tells us nothing, so it cannot
  // overrule anything. A Payment Link on a price object that is not in env
  // lands here, and so does an invoice carrying two tiers because of a
  // proration line. The right answer for both is the behaviour that existed
  // before this function.
  if (invoiceAllocation == null) {
    return { allocation: rowAllocation, fromInvoice: false, drift: false };
  }

  const drift = invoiceAllocation !== rowAllocation;

  // §24 stand-down. The pending change is applied by applyPendingPlanChange at
  // this same moment, and it applies precisely when the invoice's price agrees
  // with the pending figure — so the row is about to become the invoice's
  // allocation anyway. Stepping in here would be two writers for one decision.
  if (input.pendingAllocation != null && input.pendingAllocation === invoiceAllocation) {
    return { allocation: rowAllocation, fromInvoice: false, drift: false };
  }

  // Activation only. The row can be stale here because nothing has corrected it
  // yet, and no comp can exist against a subscription that has never been
  // billed — so the money is unambiguously the better authority.
  //
  // On every later invoice for that subscription the row wins, even when it
  // disagrees. The subscription branch keeps it honest from the subscription's
  // CURRENT price, which an invoice does not reliably report: a proration line,
  // or a stale past_due charge settled after an upgrade, would otherwise
  // downgrade a customer permanently — and permanently is right, because from
  // the next renewal the two agree and nothing re-examines it.
  if (drift && isActivatingInvoice) {
    return { allocation: invoiceAllocation, fromInvoice: true, drift: true };
  }

  return { allocation: rowAllocation, fromInvoice: false, drift };
}

/**
 * The line written when the invoice's price and the row disagree.
 *
 * Deliberately worded the same for both products, so drift reads identically in
 * the logs. It names what was credited and why, because "20 vs 10" without the
 * reason is not actionable — a deliberate allocation and a mistake look
 * identical until you know which side won and on what grounds.
 *
 * ⚠️ The activating-invoice arm says the subscription is new, NOT that the price
 * changed. At activation there may be no previous price at all, and a comp that
 * survived a cancellation is reset here — correctly, since it was attached to a
 * subscription that no longer exists — so the line has to tell an admin to
 * re-apply it rather than imply a change they did not make.
 */
export function driftMessage(
  customerId: string,
  product: "management" | "guaranteed rent",
  decision: CreditAllocationDecision,
  invoiceAllocation: number,
  rowAllocation: number
): string {
  return decision.fromInvoice
    ? `${product} allocation drift for customer ${customerId}: invoice price implies ${invoiceAllocation} leads but the row said ${rowAllocation}. This is a new subscription's first invoice, so crediting ${decision.allocation} from the price and re-sizing the row. If ${rowAllocation} was a deliberate allocation, re-apply it in admin — a comp does not survive a re-subscription.`
    : `${product} allocation drift for customer ${customerId}: invoice price implies ${invoiceAllocation} leads but the row credits ${rowAllocation}. This is an established subscription, so the row stands — a deliberate allocation, or a mistake. Crediting ${decision.allocation}. Correct it in admin if it is a mistake.`;
}
