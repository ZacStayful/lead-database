import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FUNNEL_FINISHED_AFTER_MS,
  FUNNEL_FINISHED_STEPS,
  FUNNEL_MONDAY_OUTCOMES,
  FUNNEL_MONDAY_RETRY_AFTER_MS,
  FUNNEL_MONDAY_TRANSITIONS,
  FUNNEL_MONDAY_WINDOW_MS,
  claimBlocks,
  funnelFinishedDue,
  funnelLabelAlreadySet,
  funnelStartedDue,
  funnelStatusLabelId,
  mayWriteFunnelLabel,
  signupRoute,
  signupSourceColumnId,
  signupSourceLabel,
  type FunnelMondayCandidate,
} from "@/lib/funnel/mondayFunnel";
import { FUNNEL_DISCOUNT_AFTER_MS, FUNNEL_DISCOUNT_STEPS, FUNNEL_DISCOUNT_WINDOW_MS } from "@/lib/funnel/discount";
import { INGESTABLE_STATUS_LABELS } from "@/lib/enquiry/enquiryItem";
import { ENQUIRY_FUNNEL_STATUS } from "@/lib/monday";

/**
 * The funnel's Monday rules (batch 03 Phase 2, §76). Pure, so every branch is
 * driven directly.
 */

const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Every label on the live Status column (board 18420649520, read 9 Oct 2026),
 * plus the two Part B step 1 adds. ⚠️ A literal list, so a label that is
 * accidentally allowed shows up here rather than being reasoned away.
 */
const BOARD_LABELS = [
  "Cancelled",
  "Management Customer",
  "Web meeting sat",
  "Wants to pay card declined",
  "Web meeting no show",
  "New Enquiries",
  "Web meeting booked",
  "In the future",
  "In the future due to call",
  "Guaranteed rent customer",
  "Paused",
  "Abandoned",
  "Cancelled due to contact",
  "Chasing to book",
  "Chased no booking",
  "Cancelling",
  "Funnel started",
  "Funnel finished, not paid",
];

const STARTED_MAY_OVERWRITE = ["", "New Enquiries", "Chasing to book", "Chased no booking"];
const FINISHED_MAY_OVERWRITE = [...STARTED_MAY_OVERWRITE, "Funnel started"];

describe("the vocabularies match 0166's CHECKs", () => {
  const sql = readFileSync("supabase/migrations/0166_funnel_routes.sql", "utf8");
  const listIn = (constraint: string) => {
    const m = sql.match(new RegExp(`constraint ${constraint} check \\(([\\s\\S]*?)\\)\\s*[,)]`));
    expect(m, constraint).not.toBeNull();
    return Array.from(m![1].matchAll(/'([a-z_]+)'/g)).map((x) => x[1]);
  };

  it("transitions", () => {
    expect([...FUNNEL_MONDAY_TRANSITIONS].sort()).toEqual(listIn("funnel_monday_writes_transition").sort());
  });

  it("outcomes", () => {
    expect([...FUNNEL_MONDAY_OUTCOMES].sort()).toEqual(listIn("funnel_monday_writes_outcome").sort());
  });
});

describe("label ids and the column id come from env (E10)", () => {
  it("reads each transition's own variable", () => {
    const env = { MONDAY_STATUS_FUNNEL_STARTED: "21", MONDAY_STATUS_FUNNEL_FINISHED: "22" };
    expect(funnelStatusLabelId("started", env)).toBe(21);
    expect(funnelStatusLabelId("finished", env)).toBe(22);
  });

  it("trims, and accepts id 0", () => {
    expect(funnelStatusLabelId("started", { MONDAY_STATUS_FUNNEL_STARTED: " 0 " })).toBe(0);
  });

  it("anything but a whole number is not configured, never a text fallback", () => {
    for (const v of [undefined, "", "  ", "abc", "21a", "-1", "1.5", "Funnel started", "1e3"]) {
      expect(funnelStatusLabelId("started", { MONDAY_STATUS_FUNNEL_STARTED: v }), String(v)).toBeNull();
    }
  });

  it("a column id is lower-case letters, digits and underscores, or nothing", () => {
    expect(signupSourceColumnId({ MONDAY_SIGNUP_SOURCE_COLUMN_ID: "color_mm7x1abc" })).toBe("color_mm7x1abc");
    for (const v of [undefined, "", "Color_x", "a b", 'x"]) { id', "1abc", "x;y"]) {
      expect(signupSourceColumnId({ MONDAY_SIGNUP_SOURCE_COLUMN_ID: v }), String(v)).toBeNull();
    }
  });
});

describe("the guard: an allow-list, never a list of what is protected", () => {
  it("'started' writes over exactly an empty cell, New Enquiries and the two chase labels", () => {
    for (const label of BOARD_LABELS) {
      expect(mayWriteFunnelLabel("started", label), label).toBe(STARTED_MAY_OVERWRITE.includes(label));
    }
    expect(mayWriteFunnelLabel("started", "")).toBe(true);
    expect(mayWriteFunnelLabel("started", null)).toBe(true);
  });

  it("'finished' adds Funnel started, or it could never follow the first write (E2)", () => {
    for (const label of BOARD_LABELS) {
      expect(mayWriteFunnelLabel("finished", label), label).toBe(FINISHED_MAY_OVERWRITE.includes(label));
    }
  });

  it("never overwrites a status the batch doc names as protected", () => {
    for (const label of [
      "Web meeting booked",
      "Web meeting sat",
      "Management Customer",
      "Guaranteed rent customer",
      "Paused",
      "Cancelling",
      "Cancelled",
    ]) {
      expect(mayWriteFunnelLabel("started", label), label).toBe(false);
      expect(mayWriteFunnelLabel("finished", label), label).toBe(false);
    }
  });

  it("'started' never walks a finished session back", () => {
    expect(mayWriteFunnelLabel("started", "Funnel finished, not paid")).toBe(false);
  });

  it("a label that only differs by case or spacing is not the label", () => {
    expect(mayWriteFunnelLabel("finished", "funnel started")).toBe(false);
    expect(mayWriteFunnelLabel("started", "new enquiries")).toBe(false);
  });

  it("knows when the cell already says it", () => {
    expect(funnelLabelAlreadySet("started", "Funnel started")).toBe(true);
    expect(funnelLabelAlreadySet("started", " Funnel started ")).toBe(true);
    expect(funnelLabelAlreadySet("finished", "Funnel started")).toBe(false);
    expect(funnelLabelAlreadySet("finished", "Funnel finished, not paid")).toBe(true);
  });
});

describe("the enquiry sync still ingests a funnel-labelled item (E7)", () => {
  it("both funnel labels are on the ingest list, beside New Enquiries", () => {
    expect(INGESTABLE_STATUS_LABELS).toContain("New Enquiries");
    expect(INGESTABLE_STATUS_LABELS).toContain(ENQUIRY_FUNNEL_STATUS.started);
    expect(INGESTABLE_STATUS_LABELS).toContain(ENQUIRY_FUNNEL_STATUS.finished);
    expect(INGESTABLE_STATUS_LABELS).toHaveLength(3);
  });
});

function session(over: Partial<FunnelMondayCandidate> = {}): FunnelMondayCandidate {
  return {
    id: "s1",
    monday_item_id: "9876543210",
    step: "previewed",
    updated_at: ago(2 * HOUR),
    paid_at: null,
    first_answered_at: ago(3 * HOUR),
    ...over,
  };
}

describe("who is due", () => {
  it("'finished' shares the discount's selector (E3)", () => {
    expect([...FUNNEL_FINISHED_STEPS]).toEqual([...FUNNEL_DISCOUNT_STEPS]);
    expect(FUNNEL_FINISHED_AFTER_MS).toBe(FUNNEL_DISCOUNT_AFTER_MS);
    expect(FUNNEL_MONDAY_WINDOW_MS).toBe(FUNNEL_DISCOUNT_WINDOW_MS);
  });

  it("pins the timings to literals, so they cannot move together unseen", () => {
    expect(FUNNEL_FINISHED_AFTER_MS).toBe(HOUR);
    expect(FUNNEL_MONDAY_WINDOW_MS).toBe(7 * DAY);
    expect(FUNNEL_MONDAY_RETRY_AFTER_MS).toBe(HOUR);
  });

  it("'started': answered, unpaid, on an item, inside the week", () => {
    expect(funnelStartedDue(session(), NOW)).toBe(true);
    expect(funnelStartedDue(session({ step: "started", first_answered_at: ago(MIN) }), NOW)).toBe(true);
    expect(funnelStartedDue(session({ first_answered_at: null }), NOW)).toBe(false);
    expect(funnelStartedDue(session({ paid_at: ago(MIN) }), NOW)).toBe(false);
    expect(funnelStartedDue(session({ step: "paid" }), NOW)).toBe(false);
    expect(funnelStartedDue(session({ monday_item_id: null }), NOW)).toBe(false);
    expect(funnelStartedDue(session({ first_answered_at: ago(7 * DAY) }), NOW)).toBe(true);
    expect(funnelStartedDue(session({ first_answered_at: ago(7 * DAY + 1) }), NOW)).toBe(false);
  });

  it("'finished': previewed or at checkout, quiet an hour, unpaid, on an item", () => {
    expect(funnelFinishedDue(session({ updated_at: ago(HOUR) }), NOW)).toBe(true);
    expect(funnelFinishedDue(session({ updated_at: ago(HOUR - 1) }), NOW)).toBe(false);
    expect(funnelFinishedDue(session({ step: "checkout_started" }), NOW)).toBe(true);
    for (const step of ["started", "questions_done", "paid"]) {
      expect(funnelFinishedDue(session({ step }), NOW), step).toBe(false);
    }
    expect(funnelFinishedDue(session({ paid_at: ago(MIN) }), NOW)).toBe(false);
    expect(funnelFinishedDue(session({ monday_item_id: null }), NOW)).toBe(false);
    expect(funnelFinishedDue(session({ updated_at: ago(7 * DAY + 1) }), NOW)).toBe(false);
  });
});

describe("claims: written once, a failure retried after an hour", () => {
  const claim = (outcome: string | null, claimedAgo: number) => ({
    session_id: "s1",
    transition: "started",
    claimed_at: ago(claimedAgo),
    outcome,
  });

  it("no claim, no block", () => {
    expect(claimBlocks(undefined, NOW)).toBe(false);
  });

  it("a written or skipped claim blocks for good", () => {
    expect(claimBlocks(claim("written", 30 * DAY), NOW)).toBe(true);
    expect(claimBlocks(claim("skipped", 30 * DAY), NOW)).toBe(true);
  });

  it("a failed or abandoned claim blocks for an hour, then is retried", () => {
    for (const outcome of ["failed", null]) {
      expect(claimBlocks(claim(outcome, HOUR - 1), NOW), String(outcome)).toBe(true);
      expect(claimBlocks(claim(outcome, HOUR), NOW), String(outcome)).toBe(false);
    }
  });
});

describe("signupRoute (E4)", () => {
  it("a call sign-up is call, whatever the session says", () => {
    expect(signupRoute("call", null)).toBe("call");
    expect(signupRoute("call", "instant")).toBe("call");
  });

  it("a funnel sign-up is funnel, unless they paid on the post-call recap", () => {
    expect(signupRoute("funnel", "instant")).toBe("funnel");
    expect(signupRoute("funnel", "chase")).toBe("funnel");
    expect(signupRoute("funnel", "no_show")).toBe("funnel");
    expect(signupRoute("funnel", null)).toBe("funnel");
    expect(signupRoute("funnel", "post_call")).toBe("call");
  });

  it("writes the board's own label text", () => {
    expect(signupSourceLabel("call")).toBe("Call");
    expect(signupSourceLabel("funnel")).toBe("Funnel");
  });
});
