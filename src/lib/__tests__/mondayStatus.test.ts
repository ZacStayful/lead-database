import { describe, expect, it } from "vitest";
import { mondayStatusLabelFor, type MondayStatusCandidate } from "../mondayStatus";
import { ENQUIRY_STATUS } from "../monday";

/**
 * The first checked-in tests for the Monday label rule.
 *
 * CLAUDE.md §23 records that this rule was driven through 26 cases by hand and
 * that none of them were committed — which is how the pending-cancellation
 * defect below survived a review that "passed a thorough label-rule suite".
 * These exist so the ordered branches, and above all the Cancelling/Cancelled
 * split, cannot be undone silently.
 *
 * Defaults are a waitlisted prospect who has never paid for anything: the case
 * rule 7 protects, and the one where a wrong answer would overwrite a sales
 * label. Every test therefore states exactly what it changes.
 */
function customer(over: Partial<MondayStatusCandidate> = {}): MondayStatusCandidate {
  return {
    is_active: true,
    paused_at: null,
    account_status: "waitlisted",
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    cancel_at_period_end: false,
    gr_cancel_at_period_end: false,
    ...over,
  };
}

/** A paying management subscriber. */
const MANAGEMENT: Partial<MondayStatusCandidate> = {
  account_status: "active",
  subscription_status: "active",
};

/** A paying Guaranteed Rent subscriber — management deliberately untouched. */
const GR: Partial<MondayStatusCandidate> = {
  account_status: "waitlisted",
  subscription_status: "inactive",
  gr_subscription_status: "active",
};

describe("mondayStatusLabelFor — who gets no label at all", () => {
  it("leaves an archived row alone even when it looks like a customer", () => {
    // Rule 0. §18D: the superseded duplicate is the row carrying the board's
    // stale email, so without this it would fight the live row for one cell.
    expect(
      mondayStatusLabelFor(customer({ ...MANAGEMENT, is_active: false }))
    ).toBeNull();
  });

  it("leaves a waitlisted prospect's hand-set sales label alone", () => {
    // Rule 7 is the safety mechanism for the whole feature, not a fallthrough.
    expect(mondayStatusLabelFor(customer())).toBeNull();
    expect(mondayStatusLabelFor(customer({ account_status: "invited" }))).toBeNull();
  });
});

describe("mondayStatusLabelFor — customers who are staying", () => {
  it("labels a paying management subscriber", () => {
    expect(mondayStatusLabelFor(customer(MANAGEMENT))).toBe(
      ENQUIRY_STATUS.management_customer
    );
  });

  it("labels a paying GR subscriber without reading account_status", () => {
    // Invariant 6. A GR-only customer sits at account_status = 'waitlisted'
    // for ever (§18A), so reading it here would report them as a prospect.
    expect(mondayStatusLabelFor(customer(GR))).toBe(
      ENQUIRY_STATUS.guaranteed_rent_customer
    );
  });

  it("puts a paused customer on Paused, not Management Customer", () => {
    // Rule 2 before rule 4: a paused customer is active on both columns.
    expect(
      mondayStatusLabelFor(customer({ ...MANAGEMENT, paused_at: "2026-08-01T00:00:00Z" }))
    ).toBe(ENQUIRY_STATUS.paused);
  });

  it("puts a failed payment on the card-declined label, either product", () => {
    // Rule 3 before rule 4, because holdsProduct() counts past_due as held.
    expect(
      mondayStatusLabelFor(customer({ ...MANAGEMENT, subscription_status: "past_due" }))
    ).toBe(ENQUIRY_STATUS.card_declined);
    expect(
      mondayStatusLabelFor(customer({ ...GR, gr_subscription_status: "past_due" }))
    ).toBe(ENQUIRY_STATUS.card_declined);
  });
});

describe("mondayStatusLabelFor — Cancelling means still paying", () => {
  // The defect this split exists to fix. Both live cases at the time of writing
  // (james hoare, management, ends 13 Sep; Karey Summers, GR, ends 10 Sep) had
  // paid, were still being delivered leads, and read as Cancelled on the board.

  it("reports a scheduled management cancellation as Cancelling", () => {
    expect(
      mondayStatusLabelFor(customer({ ...MANAGEMENT, cancel_at_period_end: true }))
    ).toBe(ENQUIRY_STATUS.cancelling);
  });

  it("reports a scheduled GR cancellation as Cancelling", () => {
    expect(
      mondayStatusLabelFor(customer({ ...GR, gr_cancel_at_period_end: true }))
    ).toBe(ENQUIRY_STATUS.cancelling);
  });

  it("keeps Cancelling above Paused when a paused customer cancels", () => {
    // Rule 1 still outranks rule 2 — but it must no longer claim they have gone.
    expect(
      mondayStatusLabelFor(
        customer({
          ...MANAGEMENT,
          paused_at: "2026-08-01T00:00:00Z",
          cancel_at_period_end: true,
        })
      )
    ).toBe(ENQUIRY_STATUS.cancelling);
  });

  it("still reads as a GR customer when management is dropped but GR is live", () => {
    // grStillThere outranks the management cancellation: they are a paying
    // customer, not somebody leaving.
    expect(
      mondayStatusLabelFor(
        customer({
          ...MANAGEMENT,
          gr_subscription_status: "active",
          cancel_at_period_end: true,
        })
      )
    ).toBe(ENQUIRY_STATUS.guaranteed_rent_customer);
  });
});

describe("mondayStatusLabelFor — Cancelled means the service has stopped", () => {
  it("reports an ended management subscription as Cancelled", () => {
    expect(
      mondayStatusLabelFor(
        customer({ account_status: "cancelled", subscription_status: "canceled" })
      )
    ).toBe(ENQUIRY_STATUS.cancelled);
  });

  it("reports an ended GR subscription as Cancelled", () => {
    expect(
      mondayStatusLabelFor(customer({ gr_subscription_status: "canceled" }))
    ).toBe(ENQUIRY_STATUS.cancelled);
  });

  it("reports a cancelled account whose subscription_status lags as Cancelled", () => {
    // The third disjunct of managementEnded — account_status says cancelled and
    // subscription_status is neither active nor past_due.
    expect(
      mondayStatusLabelFor(
        customer({ account_status: "cancelled", subscription_status: "inactive" })
      )
    ).toBe(ENQUIRY_STATUS.cancelled);
  });

  it("flips Cancelling to Cancelled when the period actually ends", () => {
    // What customer.subscription.deleted produces: status canceled AND the
    // pending flag cleared. This is the transition nothing else drives.
    const pending = customer({ ...MANAGEMENT, cancel_at_period_end: true });
    expect(mondayStatusLabelFor(pending)).toBe(ENQUIRY_STATUS.cancelling);

    const ended = customer({
      account_status: "cancelled",
      subscription_status: "canceled",
      cancel_at_period_end: false,
    });
    expect(mondayStatusLabelFor(ended)).toBe(ENQUIRY_STATUS.cancelled);
  });
});

describe("mondayStatusLabelFor — the two products disagreeing", () => {
  it("is Cancelling when management has ended but GR is still serving", () => {
    // THE case a per-branch ended/pending test gets wrong. Management is over,
    // so rule 1 fires; but GR is still delivering leads against a paid period,
    // so the customer has not left and must not read as Cancelled.
    expect(
      mondayStatusLabelFor(
        customer({
          account_status: "cancelled",
          subscription_status: "canceled",
          gr_subscription_status: "active",
          gr_cancel_at_period_end: true,
        })
      )
    ).toBe(ENQUIRY_STATUS.cancelling);
  });

  it("is Cancelling when both products are scheduled to end", () => {
    expect(
      mondayStatusLabelFor(
        customer({
          ...MANAGEMENT,
          gr_subscription_status: "active",
          cancel_at_period_end: true,
          gr_cancel_at_period_end: true,
        })
      )
    ).toBe(ENQUIRY_STATUS.cancelling);
  });

  it("is Cancelled only once both products have actually ended", () => {
    expect(
      mondayStatusLabelFor(
        customer({
          account_status: "cancelled",
          subscription_status: "canceled",
          gr_subscription_status: "canceled",
        })
      )
    ).toBe(ENQUIRY_STATUS.cancelled);
  });

  it("distinguishes a GR customer who is leaving from one who merely owes money", () => {
    expect(
      mondayStatusLabelFor(
        customer({ gr_subscription_status: "past_due", gr_cancel_at_period_end: true })
      )
    ).toBe(ENQUIRY_STATUS.cancelling);
    expect(
      mondayStatusLabelFor(customer({ gr_subscription_status: "past_due" }))
    ).toBe(ENQUIRY_STATUS.card_declined);
  });
});

describe("mondayStatusLabelFor — the live rows this change was made for", () => {
  it("moves james hoare off Cancelled", () => {
    // Management, paid 13 Aug, cancelled 24 Aug, service runs to 13 Sep.
    expect(
      mondayStatusLabelFor(
        customer({
          account_status: "active",
          subscription_status: "active",
          cancel_at_period_end: true,
        })
      )
    ).toBe(ENQUIRY_STATUS.cancelling);
  });

  it("moves Karey Summers off Cancelled", () => {
    // GR only, paid 10 Aug, cancelled 27 Aug, service runs to 10 Sep. Still
    // account_status = 'waitlisted', which is why rule 6 is the one that fires.
    expect(
      mondayStatusLabelFor(
        customer({
          account_status: "waitlisted",
          subscription_status: "inactive",
          gr_subscription_status: "active",
          gr_cancel_at_period_end: true,
        })
      )
    ).toBe(ENQUIRY_STATUS.cancelling);
  });
});
