import type { N8nLeadPayload } from "@/lib/types";

const MONDAY_API = "https://api.monday.com/v2";

/** Board 18420117742 "Management leads for sale". */
function boardId(): string {
  return process.env.MONDAY_LEAD_BOARD_ID ?? "18420117742";
}

/**
 * Column-id → lead-field mapping for the Monday board. If the board schema
 * changes, update these ids (from get_board_info).
 */
const COLUMN_MAP = {
  lead_profile: "text_mm1x8cgy", // "Lead Profile"
  email: "text_mkygb5xx", // "Email"
  phone: "phone_mm1hp0a8", // "Phone"
  address: "text6", // "Address"
  bedrooms: "text5", // "Bedrooms"
  enquiry_date: "date", // "Date added"
  status: "status5", // "Status"
} as const;

// Only items whose Status equals this label are sellable and get ingested.
const SELLABLE_STATUS = "Lead for sale";

interface MondayColumnValue {
  id: string;
  text: string | null;
}
interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
  /** Only requested by the management fetcher; see pickIncomeReportAsset. */
  assets?: MondayAsset[] | null;
}

/**
 * A file on a Monday item. `public_url` is a ONE-HOUR SIGNED S3 LINK: usable
 * immediately, worthless later, and never to be stored. See incomeReport.ts —
 * the analysis PDF is read for one number and discarded, and no report is ever
 * surfaced to a customer.
 */
export interface MondayAsset {
  id: string;
  name: string;
  public_url: string;
}

/** The analyser writes these; anything else on the item is somebody's upload. */
const INCOME_REPORT_PREFIX = "Stayful_Property_Analysis";

/** Monday's ceiling for one `items(ids:)` call. Its default is 25 — see below. */
const ITEMS_PER_CALL = 100;

/**
 * The income-analysis PDF on a Monday item, or null.
 *
 * Items accumulate files: a stale third-party valuation, a spreadsheet from
 * before the analyser existed, and occasionally two analyses where the address
 * was corrected and the report re-run. Highest asset id wins, because Monday
 * ids ascend with upload time and the newest analysis is the one that describes
 * the property as it was sold to us.
 *
 * Pure, so it can be exercised against the real shapes on the board without
 * touching the network.
 */
export function pickIncomeReportAsset(
  assets: MondayAsset[] | null | undefined
): MondayAsset | null {
  if (!assets?.length) return null;
  const pdfs = assets.filter((a) => a.name?.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) return null;

  const newest = (list: MondayAsset[]) =>
    list.reduce((best, a) => (Number(a.id) > Number(best.id) ? a : best));

  // Prefer a report the analyser generated. Falling back to any PDF keeps a
  // hand-attached analysis working; the parser's own cross-checks are what stop
  // an unrelated document producing a figure.
  const analyser = pdfs.filter((a) => a.name.startsWith(INCOME_REPORT_PREFIX));
  return newest(analyser.length ? analyser : pdfs);
}

function textFor(item: MondayItem, columnId: string): string {
  return item.column_values.find((c) => c.id === columnId)?.text ?? "";
}

/** One page of a cursor-paginated board read. */
interface MondayItemsPage {
  cursor: string | null;
  items: MondayItem[];
}
interface MondayPageData {
  next_items_page?: MondayItemsPage;
  boards?: { items_page: MondayItemsPage }[];
}

/** Board 18396542480 "Guaranteed rent leads". */
function grBoardId(): string {
  return process.env.MONDAY_GR_LEAD_BOARD_ID ?? "18396542480";
}

/**
 * GR board column-id → target leads field. Mirrors GR_COLUMN_MAP in ingest.ts.
 * The status column drives the sellable filter. The two banned columns
 * (text_mkzxkfns, text_mkztftwn) are never fetched or stored.
 */
const GR_COLUMN_MAP: Record<string, string> = {
  text_mkzxhyv9: "address",
  text_mkztq5xb: "phone",
  text_mkztseha: "email",
  text_mkzxxzjc: "bedrooms",
  date4: "enquiry_date",
  date_mkztg8w1: "last_contact",
  text_mkztg3z9: "desired_rent",
  file_mkzt6hf1: "pmi_analysis",
  file_mkzttt0h: "tenancy_agreement",
  file_mkzthq5b: "sourcing_agreement",
  formula_mm29p0r0: "formula",
};
const GR_STATUS_COLUMN = "status";
// Every GR item is sent to operators by default (all leads are sellable). Set
// MONDAY_GR_SELLABLE_STATUS to restrict to a single status label if that ever
// changes; when unset, no status filter is applied.
function grSellableStatus(): string | null {
  return process.env.MONDAY_GR_SELLABLE_STATUS ?? null;
}

/**
 * Board 5891626711 "Management Leads" — STAYFUL'S OWN sales pipeline (§64).
 * Not a lead source for the database: the one board a lead must NOT be on.
 */
export function pipelineBoardId(): string {
  return process.env.MONDAY_PIPELINE_BOARD_ID ?? "5891626711";
}

/**
 * The nine groups on that board that mean "Stayful is actively working, or has
 * signed, this landlord". A lead in the database that matches an item in any
 * of them is withdrawn from every operator (§64). Ids → titles, so the admin
 * panel can print the name and the guard test can count nine.
 *
 * ⚠️ NOT the whole board. "Leads that can be sold", "Cold Management Leads"
 * and the three Abandoned groups are deliberately absent: an abandoned or
 * cold Stayful lead may be sold.
 */
export const STAYFUL_PIPELINE_CONFLICT_GROUPS = {
  group_mm28ypgs: "Qualified Management Leads",
  group_mm1htyz7: "In the future Due to call",
  group_mkwthdxq: "In the future management leads",
  group_mksxb5m0: "Web meeting booked",
  group_mkwx4dhv: "Web meeting No show",
  group_mksx27r4: "Web meeting sat/warm",
  group_mm47p8js: "Warm due to call",
  group_mm16jhqm: "Special offer applied",
  group_mm1dtkdm: "Customer / signed",
} as const;

/** Pipeline board columns the conflict index reads. Both phone cells are read. */
const PIPELINE_COLUMNS = {
  email: "text_mkygb5xx",
  phone: "phone_mm1hp0a8",
  phoneText: "text_mm1jzzzc",
} as const;

/** One pipeline item reduced to what identity matching needs (§64). */
export interface StayfulPipelineItem {
  id: string;
  groupId: string;
  /** Every address in the Email cell, lowercased (`emailsFromCell`). */
  emails: string[];
  /** Last-9-digit keys from both phone cells, deduped, "" dropped. */
  phoneKeys: string[];
}

/**
 * Board 18420649520 "Stayful Lead database enquiries" (landing-page form).
 * Exported because the customer link columns (0086) store which board an item
 * lives on, and only this one carries the Status column.
 */
export function enquiryBoardId(): string {
  return process.env.MONDAY_ENQUIRY_BOARD_ID ?? "18420649520";
}

/*
 * Board 18420913271 "Stayful Guaranteed rent database enquiries" is RETIRED
 * (§47). Every enquiry now creates its item on the board above, whichever
 * service it is for, with "What kind of leads" saying which.
 *
 * It was always a dead end: it has no Status column, so an item there could
 * never carry a label, setEnquiryStatus refused the board outright, and §23.7
 * records that the one real GR customer had to be added to the management
 * board by hand. Its three existing items stay where they are; nothing new is
 * written there, so grEnquiryBoardId() and createGuaranteedRentEnquiryContact()
 * are gone rather than left as callable dead code.
 */

/**
 * Column-id → enquiry-field mapping for the enquiries board. If the board
 * schema changes, update these ids (from get_board_info).
 */
const ENQUIRY_COLUMN_MAP = {
  email: "text_mm50e3d7", // "Email"
  mobile: "text_mm50hfvg", // "Mobile"
  website_url: "text_mm50y8an", // "Website URL"
  properties_managed: "text_mm50mt3h", // "Number of properties manage"
  preferred_plan: "text_mm50w01q", // "Preffered plan"
  current_lead_source: "text_mm51bgh6", // "How do you currently get management leads"
  date_added: "date_mm50brxt", // "Date added"
} as const;

/**
 * Status column on the management enquiries board (18420649520).
 *
 * The board is organised BY this column: every item sits in the group matching
 * its label, maintained by ten "when status changes to X, move item to group Y"
 * automations. So setting the label is all the code ever needs to do — the group
 * follows. Verified against the live board: an API-driven change to this column
 * does fire those automations.
 */
const ENQUIRY_STATUS_COLUMN = "color_mm5eda07";

/**
 * "What kind of leads" — which service this person came to us for.
 *
 * A TEXT column, so Monday validates nothing: unlike the Status column, a typo
 * here is accepted silently and simply produces a value that groups on its own.
 * LEAD_INTEREST below is the only thing keeping the form, the enquiry route,
 * the status sync and the admin backfill writing one set of strings.
 */
export const ENQUIRY_LEAD_INTEREST_COLUMN = "text_mm6c5qba";

/** "Customer start date" — stamped once, on first becoming a customer. */
const ENQUIRY_START_DATE_COLUMN = "date_mm5ft19y";
/** "Customer end date" — the real end of service, not the cancellation click. */
const ENQUIRY_END_DATE_COLUMN = "date_mm5fxrbn";

/**
 * The six Status labels this system owns.
 *
 * CASING IS EXACT AND INCONSISTENT between the two customer labels: capital C in
 * "Management Customer", lower-case r and c in "Guaranteed rent customer". A
 * mismatch is a hard ColumnValueException, which is the behaviour we want —
 * see setEnquiryStatus.
 *
 * The ids in the comments are for reference only and must NEVER be used to
 * derive a value by position: label id 5 was deleted, so id and display position
 * disagree. The column carries thirteen labels in total; the other seven
 * (Web meeting sat/booked/no show, In the future, In the future due to call,
 * Abandoned, Cancelled due to contact) are the sales pipeline's and are never
 * written from here.
 *
 * CANCELLING vs CANCELLED is the distinction this file exists to keep. A
 * customer who has ASKED to cancel is still paying and still owed leads until
 * their period ends — they read as Cancelling. Cancelled means the service has
 * actually stopped. Collapsing the two put still-paying customers in the
 * Cancelled group, which is what §23.6's original "show it at the moment it is
 * requested" rule got wrong. mondayStatusLabelFor() is where the two are told
 * apart.
 */
export const ENQUIRY_STATUS = {
  cancelled: "Cancelled", //                        label id 0
  management_customer: "Management Customer", //     label id 1  — capital C
  card_declined: "Wants to pay card declined", //    label id 3
  guaranteed_rent_customer: "Guaranteed rent customer", // label id 9 — lower r, c
  paused: "Paused", //                               label id 10
  cancelling: "Cancelling", //                       label id 19
} as const;

export type EnquiryStatusLabel =
  (typeof ENQUIRY_STATUS)[keyof typeof ENQUIRY_STATUS];

/**
 * The two Status labels the BOOKING CHASE owns (§55).
 *
 * ⚠️ A SEPARATE CONST FROM ENQUIRY_STATUS ON PURPOSE. That one is the
 * subscription state and is what mondayStatusLabelFor() returns; widening its
 * type would let a chase label leak into a function whose whole job is to be a
 * pure read of the customer row. These are a different vocabulary written by a
 * different job, and the types say so.
 *
 * ⚠️ NO PUNCTUATION IN EITHER LABEL, DELIBERATELY. These have to be typed by
 * hand into the board before the code ships, and setEnquiryStatus writes with
 * create_labels_if_missing: false — so a label that differs by one character
 * fails EVERY push, loudly, and an en dash typed where an em dash was meant is
 * invisible in the Monday UI. Plain words cannot be got subtly wrong.
 */
export const ENQUIRY_CHASE_STATUS = {
  chasing: "Chasing to book",
  chased_no_booking: "Chased no booking",
} as const;

export type EnquiryChaseLabel =
  (typeof ENQUIRY_CHASE_STATUS)[keyof typeof ENQUIRY_CHASE_STATUS];

/**
 * "New Enquiries" — label id 5, where a fresh enquirer sits.
 *
 * ⚠️ CLAUDE.md §23.1 SAYS THIS LABEL DOES NOT EXIST. Read live off board
 * 18420649520 on 2026-09-13 it does: id 5, "New Enquiries", and the column
 * carries FOURTEEN labels rather than the thirteen that section claims. It has
 * no `index`, so it is absent from the display order, which is most likely how
 * it came to be described as deleted. Do not restore that claim.
 */
export const ENQUIRY_NEW_LABEL = "New Enquiries";

/**
 * ⚠️ MAY THE CHASE WRITE OVER WHAT IS IN THE STATUS CELL RIGHT NOW?
 *
 * This column has TWO owners already and the chase is the third: code owns six
 * subscription labels, sales owns seven set by hand (§23.1). So this is the one
 * Monday write in the codebase that reads the cell before writing it — a
 * deliberate departure from §23.4, which says we never do that because it costs
 * round trips and makes our write conditional on somebody else's edit. Here
 * that conditionality is exactly the point: a human judgement outranks an
 * automated chase, every time.
 *
 * Allowed: an empty cell, "New Enquiries", or a chase label we wrote ourselves.
 * Everything else — "Web meeting booked", "In the future", "Abandoned", any
 * subscription label — means somebody or something else has said something
 * about this person, and the chase stays quiet. It still SENDS; it just does
 * not touch the cell.
 *
 * Pure, so the allow-list is testable without a board.
 */
export function mayWriteChaseLabel(current: string | null | undefined): boolean {
  const value = (current ?? "").trim();
  if (!value) return true;
  if (value === ENQUIRY_NEW_LABEL) return true;
  return (Object.values(ENQUIRY_CHASE_STATUS) as string[]).includes(value);
}

/**
 * The three values the "What kind of leads" cell may hold.
 *
 * ONE DEFINITION, FOUR WRITERS — the enquiry form, the enquiry route, the
 * status sync and the admin backfill. The same discipline as ENQUIRY_STATUS
 * above and cancelOptions.ts (§29), and it matters MORE here rather than less:
 * the Status column rejects an unknown label outright, where this one accepts
 * anything and the only symptom of a drift is a board that no longer groups.
 *
 * Casing follows the board's own vocabulary — ENQUIRY_STATUS already spells it
 * "Guaranteed rent customer" with a lower-case r.
 *
 * ⚠️ The CHECK constraint in 0134 lists these three strings and a unit test
 * asserts the two agree. A disagreement does not fail a write to Monday; it
 * fails the CACHE update, so the cell is rewritten on every subsequent event
 * for ever, in silence.
 */
export const LEAD_INTEREST = {
  management: "Management",
  guaranteed_rent: "Guaranteed rent",
  both: "Both",
} as const;

export type LeadInterestLabel =
  (typeof LEAD_INTEREST)[keyof typeof LEAD_INTEREST];

/**
 * Narrow whatever arrived on the wire to one of the three values, or null.
 *
 * Accepts the hyphenated marketing spelling for the same reason toLeadType()
 * does (products.ts): every link into the enquiry form writes
 * `?product=guaranteed-rent`, and the form posts the choice back in the same
 * vocabulary. Also accepts the labels themselves so a value read back off the
 * board round-trips.
 */
export function toLeadInterest(value: unknown): LeadInterestLabel | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "management":
      return LEAD_INTEREST.management;
    case "guaranteed-rent":
    case "guaranteed_rent":
    case "guaranteed rent":
      return LEAD_INTEREST.guaranteed_rent;
    case "both":
      return LEAD_INTEREST.both;
    default:
      return null;
  }
}

/**
 * Timeout for the status write. The two board-sync fetchers below deliberately
 * do NOT get this in the same change — giving the daily crons a timeout they
 * have never had is a behaviour change that belongs in its own commit. Matches
 * the 8s used by sms.ts and businessTime.ts.
 */
const MONDAY_TIMEOUT_MS = 8000;

/**
 * Low-level GraphQL call with a timeout. Used by the status write only; the
 * pre-existing callers keep their own inline fetches (see MONDAY_TIMEOUT_MS).
 *
 * Throws on transport failure, non-200 and GraphQL errors — the callers in this
 * file decide whether that becomes an exception or a result object.
 */
async function mondayGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MONDAY_TIMEOUT_MS);
  try {
    const res = await fetch(MONDAY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        "API-Version": "2024-10",
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Monday API HTTP ${res.status}`);

    const json: { data?: T; errors?: { message: string }[] } = await res.json();
    if (json.errors?.length) {
      throw new Error(
        `Monday API error: ${json.errors.map((e) => e.message).join("; ")}`
      );
    }
    if (!json.data) throw new Error("Monday API returned no data");
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}

export interface MondayStatusWriteResult {
  written: boolean;
  /**
   * `unchanged` is `setEnquiryMobile` only: the cell already reads what we
   * would write, so no request was made. Reported rather than folded into
   * `written: false` so the sync can say "nothing to tidy" separately from
   * "we could not tidy it" (§23.4's endDateNeedsWrite suppression).
   */
  skipped?: "not_configured" | "not_status_board" | "unchanged";
  error?: string;
}

/**
 * Set the Status cell — and optionally the two customer date cells — on one item
 * of the management enquiries board.
 *
 * NEVER THROWS. Returns a result object, the same contract as sendNewLeadSms and
 * the sendEmail wrappers, because every caller is a non-critical side effect
 * running beside money-moving work. This matters most in the Stripe webhook: that
 * handler deletes its stripe_events idempotency claim on any throw so Stripe
 * retries, meaning an exception escaping from here would make Stripe redeliver an
 * invoice that has already been credited.
 *
 * Inert until configured — a missing MONDAY_API_TOKEN returns
 * skipped: "not_configured" rather than throwing (the sms.ts precedent). Note
 * createBoardContact below does the opposite; that is safe only because its
 * callers are an admin-triggered sync and a try/catch-wrapped form post.
 *
 * The dates are a three-way choice, which is why endDate is
 * `string | null | undefined`:
 *   - a date string sets the cell
 *   - null CLEARS it (Monday takes `{}` for an empty date)
 *   - undefined leaves it untouched
 *
 * Both dates are code-owned rather than automation-owned, deliberately. The
 * board's own automations used to stamp them, but "set Customer start date = Now"
 * fires on EVERY entry into Management Customer — verified live — so once the
 * label is written by code it would reset the start date of every customer who
 * resumes from a pause, recovers a failed payment or re-subscribes. Those two
 * automation actions are removed; the group moves stay.
 */
/**
 * One item on the enquiries board, with everything an enquiry needs (§57).
 *
 * ⚠️ A SEPARATE SHAPE FROM `EnquiryBoardItem`, NOT A WIDENING OF IT. That one
 * is projected down to what customer MATCHING needs and has four callers tuned
 * to it; this one carries the seven form cells plus the item's creation time.
 * Widening the shared shape would make every one of those callers pay for
 * fields they never read.
 */
export interface EnquiryIntakeItem {
  id: string;
  name: string;
  email: string;
  mobile: string;
  /** The board's separate `phone` column. Empty on Facebook-created items. */
  phoneCell: string;
  websiteUrl: string;
  propertiesManaged: string;
  preferredPlan: string;
  currentLeadSource: string;
  leadInterest: string;
  statusLabel: string;
  /** ⚠️ The API's own timestamp. NEVER the board's "Date added" cell. */
  createdAt: string;
}

/** The board's `phone`-type column, beside the text one the app writes. */
const ENQUIRY_PHONE_COLUMN = "phone_mm6c5qkc";

/** The group Facebook lead ads and the website form both land in. */
const ENQUIRY_NEW_GROUP = "topics";

/**
 * The newest items in the "New enquiries" group, for the enquiry sync.
 *
 * NEVER THROWS — a result object, as `fetchEnquiryBoardIndex` returns, because
 * the caller is a cron that must report a Monday outage rather than die of it.
 *
 * ⚠️ ORDERED NEWEST-FIRST AND FILTERED SERVER-SIDE. Both were checked against
 * the live board. Without the ordering a busy group could hide a fresh lead
 * behind the page boundary — and this reads ONE page, deliberately, because it
 * runs every minute and the group only holds what nobody has worked yet.
 */
export async function fetchNewEnquiryItems(
  limit = 50
): Promise<{ ok: true; items: EnquiryIntakeItem[] } | { ok: false; error: string }> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { ok: false, error: "not_configured" };

  const columnIds = [
    ENQUIRY_COLUMN_MAP.email,
    ENQUIRY_COLUMN_MAP.mobile,
    ENQUIRY_COLUMN_MAP.website_url,
    ENQUIRY_COLUMN_MAP.properties_managed,
    ENQUIRY_COLUMN_MAP.preferred_plan,
    ENQUIRY_COLUMN_MAP.current_lead_source,
    ENQUIRY_LEAD_INTEREST_COLUMN,
    ENQUIRY_STATUS_COLUMN,
    ENQUIRY_PHONE_COLUMN,
  ];

  const query = `query ($limit: Int!) {
    boards(ids: ${enquiryBoardId()}) {
      items_page(
        limit: $limit
        query_params: {
          rules: [{ column_id: "group", compare_value: ["${ENQUIRY_NEW_GROUP}"], operator: any_of }]
          order_by: [{ column_id: "__creation_log__", direction: desc }]
        }
      ) {
        items {
          id
          name
          created_at
          column_values(ids: ${JSON.stringify(columnIds)}) { id text }
        }
      }
    }
  }`;

  try {
    const data = await mondayGraphql<{
      boards?: { items_page: { items: (MondayItem & { created_at?: string })[] } }[];
    }>(token, query, { limit });

    const page = data.boards?.[0]?.items_page;
    // ⚠️ A MISSING BOARD IS NOT AN EMPTY BOARD. Monday returns `boards: []` for
    // an id it cannot see, which would otherwise read as "nothing new today"
    // for ever — silent, plausible, and indistinguishable from a quiet week.
    if (!page) {
      return {
        ok: false,
        error: `Board ${enquiryBoardId()} returned no data — check the board id and the token's access to it`,
      };
    }

    return {
      ok: true,
      items: (page.items ?? []).map((item) => ({
        id: String(item.id),
        name: item.name ?? "",
        email: textFor(item, ENQUIRY_COLUMN_MAP.email),
        mobile: textFor(item, ENQUIRY_COLUMN_MAP.mobile),
        phoneCell: textFor(item, ENQUIRY_PHONE_COLUMN),
        websiteUrl: textFor(item, ENQUIRY_COLUMN_MAP.website_url),
        propertiesManaged: textFor(item, ENQUIRY_COLUMN_MAP.properties_managed),
        preferredPlan: textFor(item, ENQUIRY_COLUMN_MAP.preferred_plan),
        currentLeadSource: textFor(item, ENQUIRY_COLUMN_MAP.current_lead_source),
        leadInterest: textFor(item, ENQUIRY_LEAD_INTEREST_COLUMN),
        statusLabel: textFor(item, ENQUIRY_STATUS_COLUMN),
        createdAt: item.created_at ?? "",
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Monday read failed" };
  }
}

/**
 * Tidy the Mobile cell to the E.164 form we store (§57).
 *
 * The board is a mix — Facebook sends whatever the lead typed, and one live
 * row reads `07401402448` where every other reads `+447…`. Writing the
 * resolved form back keeps the board consistent with the database and gives
 * the customer matcher a cleaner signal.
 *
 * ⚠️ WRITES `text_mm50hfvg` ONLY, NEVER `phone_mm6c5qkc`. Nothing in this app
 * has ever written that second column, and §23.1's rule about the board's
 * duplicate date columns applies: a cell we do not own is a cell we do not
 * touch.
 *
 * ⚠️ SUPPRESSED WHEN IT WOULD CHANGE NOTHING — the `endDateNeedsWrite`
 * discipline (§23.4). Facebook usually sends `+447…` already, so most items
 * need no write at all and the sync should cost no Monday HTTP for them.
 *
 * NEVER THROWS, and cosmetic by design: it runs after the customer and the
 * ladder are recorded, so a Monday failure can never cost us the enquiry.
 */
export async function setEnquiryMobile(params: {
  itemId: string;
  mobile: string;
  currentCell: string;
  boardId?: string | null;
}): Promise<MondayStatusWriteResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { written: false, skipped: "not_configured" };

  const targetBoard = params.boardId ?? enquiryBoardId();
  if (targetBoard !== enquiryBoardId()) {
    return { written: false, skipped: "not_status_board" };
  }

  const next = params.mobile.trim();
  if (!next || next === params.currentCell.trim()) {
    return { written: false, skipped: "unchanged" };
  }

  const query = `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
    change_multiple_column_values(
      board_id: $boardId
      item_id: $itemId
      column_values: $values
      create_labels_if_missing: false
    ) { id }
  }`;

  try {
    await mondayGraphql(token, query, {
      boardId: enquiryBoardId(),
      itemId: params.itemId,
      values: JSON.stringify({ [ENQUIRY_COLUMN_MAP.mobile]: next }),
    });
    return { written: true };
  } catch (err) {
    return {
      written: false,
      error: err instanceof Error ? err.message : "Monday mobile write failed",
    };
  }
}

export async function setEnquiryStatus(params: {
  itemId: string;
  label: EnquiryStatusLabel | EnquiryChaseLabel;
  boardId?: string | null;
  /** Only pass when the item's cell is empty — first write wins. */
  startDate?: string | null;
  /** Date to set, null to clear, undefined to leave alone. */
  endDate?: string | null;
  /**
   * "What kind of leads". Undefined leaves the cell alone, which is what the
   * caller passes for anybody holding neither product — there is deliberately
   * no way to CLEAR this cell from here, because the value it would erase is
   * the only record of what a prospect asked for.
   */
  leadInterest?: LeadInterestLabel;
}): Promise<MondayStatusWriteResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { written: false, skipped: "not_configured" };

  // Only the management enquiries board has this column. The GR enquiries board
  // (18420913271) has no status column at all, so an item that lives there can
  // never carry a label — refuse rather than erroring at Monday.
  const targetBoard = params.boardId ?? enquiryBoardId();
  if (targetBoard !== enquiryBoardId()) {
    return { written: false, skipped: "not_status_board" };
  }

  const values: Record<string, unknown> = {
    [ENQUIRY_STATUS_COLUMN]: { label: params.label },
  };
  if (params.startDate) {
    values[ENQUIRY_START_DATE_COLUMN] = { date: params.startDate };
  }
  if (params.endDate !== undefined) {
    values[ENQUIRY_END_DATE_COLUMN] = params.endDate
      ? { date: params.endDate }
      : {};
  }
  // A text column takes a plain string. It rides the same mutation as the label
  // and the dates, so the four can never be half applied.
  if (params.leadInterest !== undefined) {
    values[ENQUIRY_LEAD_INTEREST_COLUMN] = params.leadInterest;
  }

  // One request for the label and both dates, so they can never be half applied.
  //
  // create_labels_if_missing stays FALSE on purpose: an unknown or mis-cased
  // label then fails loudly (ColumnValueException / missingLabel) instead of
  // silently adding an eleventh label to a column the board's grouping depends
  // on. Verified: "Guaranteed Rent Customer" is rejected and creates nothing.
  const query = `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
    change_multiple_column_values(
      board_id: $boardId
      item_id: $itemId
      column_values: $values
      create_labels_if_missing: false
    ) { id }
  }`;

  try {
    await mondayGraphql<{ change_multiple_column_values?: { id: string } }>(
      token,
      query,
      {
        boardId: targetBoard,
        itemId: params.itemId,
        values: JSON.stringify(values),
      }
    );
    return { written: true };
  } catch (err) {
    return {
      written: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Post an update (a comment) on one enquiries-board item.
 *
 * The "what was actually said" record for the booking chase (§55): the column
 * tells you the state, this tells you which message went out, on which channel,
 * and whether it landed. Monday shows an update badge on the item, which is the
 * at-a-glance signal that something happened.
 *
 * NEVER THROWS — same contract as setEnquiryStatus above, and for the same
 * reason: every caller is a side effect running beside work that must not be
 * repeated. An exception escaping here would, in the chase's case, abort a run
 * AFTER the message had already gone out.
 *
 * ⚠️ `body` is sent as TEXT, not HTML. Monday renders updates as rich text and
 * will interpret markup, so anything interpolated in here is escaped by the
 * caller or, better, is not user-supplied at all. The chase passes its own
 * copy plus a provider id.
 */
export async function createEnquiryUpdate(
  itemId: string,
  body: string
): Promise<MondayStatusWriteResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { written: false, skipped: "not_configured" };

  const query = `mutation ($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) { id }
  }`;

  try {
    await mondayGraphql<{ create_update?: { id: string } }>(token, query, {
      itemId,
      body,
    });
    return { written: true };
  } catch (err) {
    return {
      written: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One row of the enquiries board, reduced to what customer matching needs. */
export interface EnquiryBoardItem {
  id: string;
  name: string;
  /**
   * Every address found in the Email cell, lowercased. The cell is free text and
   * at least one live item holds TWO addresses separated by a space, so this is
   * a list rather than a string.
   */
  emails: string[];
  /**
   * Last 9 digits of the Mobile cell, or "". Same comparison rule as the
   * duplicate-lead detection in 0070, and "0000 0000000" is treated as missing.
   */
  phoneKey: string;
  /** Current Status label text, or "" when unset. */
  statusLabel: string;
  /** Customer start date cell, or "" — drives the first-write-wins rule. */
  startDate: string;
  /**
   * Customer end date cell, or "". Needed so "clear the end date" can be
   * recognised as a no-op when the cell is already empty — otherwise every
   * customer.subscription.updated event would issue a pointless write.
   */
  endDate: string;
  /**
   * "What kind of leads" cell as the board currently has it, or "". Read for
   * reporting and for the check tool's cache fill only — the value to WRITE is
   * decided by mondayLeadInterestFor() from the customer row, never from here.
   */
  leadInterest: string;
}

/**
 * Split a free-text email cell into the addresses it actually contains.
 *
 * Exported so the matching rule can be exercised against real board data without
 * calling Monday. The cell is hand-typed: at least one live item holds two
 * addresses separated by a space, and one differs from the customer row only by
 * capitalisation.
 */
export function emailsFromCell(cell: string): string[] {
  return cell
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((part) => part.includes("@"));
}

/**
 * Reduce a phone number to its last 9 digits for comparison, or "" when there is
 * nothing usable. Mirrors 0070's normalisation so the two never disagree about
 * whether a number matches.
 */
/**
 * Lower-case, collapse whitespace — enough to match "Olly  Pearce".
 *
 * Lives here beside `phoneMatchKey` and `emailsFromCell` because all three are
 * the primitives for deciding whether two records describe the same person,
 * and two of the three already did. §57 gave it a second caller (the enquiry
 * sync's name-corroborated phone tier), and one definition is the whole point
 * — the alternative is the "one thing written twice" problem §20 and §26.7
 * both record.
 */
export function normaliseName(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return trimmed || null;
}

export function phoneMatchKey(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  // The placeholder Monday sometimes carries for "no number given".
  if (!digits || /^0+$/.test(digits)) return "";
  if (digits.length < 9) return "";
  return digits.slice(-9);
}

/**
 * Read the whole enquiries board, reduced to the fields customer matching and
 * drift reporting need. NEVER THROWS — returns a result object, for the same
 * reason setEnquiryStatus does.
 *
 * One request today (34 items), but paginated because that is the pattern the
 * two lead syncs already use and the board only grows.
 */
export async function fetchEnquiryBoardIndex(): Promise<
  { ok: true; items: EnquiryBoardItem[] } | { ok: false; error: string }
> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { ok: false, error: "not_configured" };

  const columnIds = [
    ENQUIRY_COLUMN_MAP.email,
    ENQUIRY_COLUMN_MAP.mobile,
    ENQUIRY_STATUS_COLUMN,
    ENQUIRY_START_DATE_COLUMN,
    ENQUIRY_END_DATE_COLUMN,
    ENQUIRY_LEAD_INTEREST_COLUMN,
  ];

  const items: EnquiryBoardItem[] = [];
  let cursor: string | null = null;

  try {
    do {
      const query: string = cursor
        ? `query ($cursor: String!) { next_items_page(limit: 100, cursor: $cursor) { cursor items { id name column_values(ids: ${JSON.stringify(
            columnIds
          )}) { id text } } } }`
        : `query { boards(ids: ${enquiryBoardId()}) { items_page(limit: 100) { cursor items { id name column_values(ids: ${JSON.stringify(
            columnIds
          )}) { id text } } } } }`;

      // Both of these are annotated rather than inferred: `cursor` is assigned
      // from `page.cursor`, `page` is picked using `cursor`, and `data` is fetched
      // with `cursor` in its variables — which TypeScript reads as a circular
      // initializer (TS7022). Annotating breaks the cycle; fetchMondayLeads
      // annotates its own page for the same reason.
      const variables: Record<string, unknown> = cursor ? { cursor } : {};
      const data: MondayPageData = await mondayGraphql<MondayPageData>(
        token,
        query,
        variables
      );

      const page: MondayItemsPage | undefined = cursor
        ? data.next_items_page
        : data.boards?.[0]?.items_page;

      // A missing board is NOT an empty board, and conflating them is dangerous
      // here. Monday returns `boards: []` for an id that does not exist or that the
      // token cannot see, which without this check yields ok:true with zero items —
      // so a mistyped MONDAY_ENQUIRY_BOARD_ID would report that no customer has a
      // board item, and the check tool would mark the entire book `not_found`.
      if (!cursor && !page) {
        return {
          ok: false,
          error: `Board ${enquiryBoardId()} returned no data — check the board id and the token's access to it`,
        };
      }

      cursor = page?.cursor ?? null;

      for (const item of page?.items ?? []) {
        items.push({
          id: item.id,
          name: item.name,
          emails: emailsFromCell(textFor(item, ENQUIRY_COLUMN_MAP.email)),
          phoneKey: phoneMatchKey(textFor(item, ENQUIRY_COLUMN_MAP.mobile)),
          statusLabel: textFor(item, ENQUIRY_STATUS_COLUMN),
          startDate: textFor(item, ENQUIRY_START_DATE_COLUMN),
          endDate: textFor(item, ENQUIRY_END_DATE_COLUMN),
          leadInterest: textFor(item, ENQUIRY_LEAD_INTEREST_COLUMN),
        });
      }
    } while (cursor);

    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read the nine conflict groups of Stayful's own pipeline board (§64), reduced
 * to what identity matching needs. NEVER THROWS — a result object, like
 * fetchEnquiryBoardIndex.
 *
 * One `query_params` rule on the virtual "group" column — which takes group id
 * STRINGS, unlike a status rule, which takes label indexes (§63.2) — then the
 * ordinary cursor loop. ~180 items today, two pages at 100.
 *
 * Two refusals that look like paranoia and are not:
 *   - a missing board is NOT an empty board (`boards: []` → ok:false);
 *   - ⚠️ ZERO ITEMS IS A FAILURE, not an empty index. 179 items sit in those
 *     groups today, and an empty page is exactly what a renamed or deleted
 *     group would produce, silently, for ever — the feature would switch
 *     itself off with nothing to say so.
 * Every item is also re-checked client-side against the group set, so a
 * mistyped rule can never index the other thousand items on the board.
 */
export async function fetchStayfulPipelineIndex(): Promise<
  | { ok: true; items: StayfulPipelineItem[]; pages: number }
  | { ok: false; error: string }
> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { ok: false, error: "not_configured" };

  const groupIds = Object.keys(STAYFUL_PIPELINE_CONFLICT_GROUPS);
  const groupSet = new Set<string>(groupIds);
  const columnIds = [
    PIPELINE_COLUMNS.email,
    PIPELINE_COLUMNS.phone,
    PIPELINE_COLUMNS.phoneText,
  ];
  const fields = `cursor items { id name group { id } column_values(ids: ${JSON.stringify(
    columnIds
  )}) { id text } }`;

  const items: StayfulPipelineItem[] = [];
  let cursor: string | null = null;
  let pages = 0;

  try {
    do {
      const query: string = cursor
        ? `query ($cursor: String!) { next_items_page(limit: 100, cursor: $cursor) { ${fields} } }`
        : `query { boards(ids: ${pipelineBoardId()}) { items_page(limit: 100, query_params: { rules: [{ column_id: "group", compare_value: ${JSON.stringify(
            groupIds
          )}, operator: any_of }] }) { ${fields} } } }`;

      const variables: Record<string, unknown> = cursor ? { cursor } : {};
      const data: MondayPageData = await mondayGraphql<MondayPageData>(
        token,
        query,
        variables
      );

      const page: MondayItemsPage | undefined = cursor
        ? data.next_items_page
        : data.boards?.[0]?.items_page;

      if (!cursor && !page) {
        return {
          ok: false,
          error: `Board ${pipelineBoardId()} returned no data — check the board id and the token's access to it`,
        };
      }

      pages += 1;
      cursor = page?.cursor ?? null;

      for (const item of page?.items ?? []) {
        const groupId = (item as MondayItem & { group?: { id?: string } }).group?.id ?? "";
        if (!groupSet.has(groupId)) continue;
        const phoneKeys = Array.from(
          new Set(
            [
              phoneMatchKey(textFor(item, PIPELINE_COLUMNS.phone)),
              phoneMatchKey(textFor(item, PIPELINE_COLUMNS.phoneText)),
            ].filter(Boolean)
          )
        );
        items.push({
          id: String(item.id),
          groupId,
          emails: emailsFromCell(textFor(item, PIPELINE_COLUMNS.email)),
          phoneKeys,
        });
      }
    } while (cursor);

    if (items.length === 0) {
      return {
        ok: false,
        error: `Board ${pipelineBoardId()} returned no items in the nine pipeline groups — a group id has probably changed`,
      };
    }

    return { ok: true, items, pages };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read one item's status and dates, for the case where the customer already has a
 * stored monday_item_id and a whole-board read would be waste. NEVER THROWS.
 *
 * `boardId` comes back because `items(ids:)` is NOT board-scoped — Monday resolves
 * an item id against the whole account. So "this id exists" says nothing about it
 * being on the enquiries board, and a caller storing a link must check. Without it
 * a mistyped id belonging to some other board validates happily and then fails on
 * every push.
 */
export async function fetchEnquiryItem(
  itemId: string
): Promise<
  | { ok: true; item: (EnquiryBoardItem & { boardId: string }) | null }
  | { ok: false; error: string }
> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { ok: false, error: "not_configured" };

  const columnIds = [
    ENQUIRY_COLUMN_MAP.email,
    ENQUIRY_COLUMN_MAP.mobile,
    ENQUIRY_STATUS_COLUMN,
    ENQUIRY_START_DATE_COLUMN,
    ENQUIRY_END_DATE_COLUMN,
    ENQUIRY_LEAD_INTEREST_COLUMN,
  ];

  try {
    const data = await mondayGraphql<{
      items?: (MondayItem & { board?: { id: string } })[];
    }>(
      token,
      `query ($ids: [ID!]) { items(ids: $ids) { id name board { id } column_values(ids: ${JSON.stringify(
        columnIds
      )}) { id text } } }`,
      { ids: [itemId] }
    );
    const item = data.items?.[0];
    if (!item) return { ok: true, item: null };
    return {
      ok: true,
      item: {
        id: item.id,
        name: item.name,
        boardId: item.board?.id ?? "",
        emails: emailsFromCell(textFor(item, ENQUIRY_COLUMN_MAP.email)),
        phoneKey: phoneMatchKey(textFor(item, ENQUIRY_COLUMN_MAP.mobile)),
        statusLabel: textFor(item, ENQUIRY_STATUS_COLUMN),
        startDate: textFor(item, ENQUIRY_START_DATE_COLUMN),
        endDate: textFor(item, ENQUIRY_END_DATE_COLUMN),
        leadInterest: textFor(item, ENQUIRY_LEAD_INTEREST_COLUMN),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Low-level: create a contact item on a given enquiries board. Returns the new
 * Monday item id. Requires MONDAY_API_TOKEN.
 */
async function createBoardContact(
  boardId: string,
  itemName: string,
  columnValues: Record<string, unknown>
): Promise<string> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing MONDAY_API_TOKEN. Add it in Vercel → Settings → Environment Variables."
    );
  }

  // Monday's create_item takes column_values as a JSON string, and because it
  // is passed as a GraphQL variable we don't need to escape it by hand.
  const query = `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
    create_item(board_id: $boardId, group_id: "topics", item_name: $itemName, column_values: $columnValues) { id }
  }`;

  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({
      query,
      variables: {
        boardId,
        itemName,
        columnValues: JSON.stringify(columnValues),
      },
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Monday API HTTP ${res.status}`);
  }

  const json: {
    data?: { create_item?: { id: string } };
    errors?: { message: string }[];
  } = await res.json();

  if (json.errors) {
    throw new Error(
      `Monday API error: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }

  const id = json.data?.create_item?.id;
  if (!id) throw new Error("Monday create_item returned no item id");
  return id;
}

/**
 * Create a contact item on the enquiries board from a landing-page form
 * submission. Returns the new Monday item id.
 *
 * EVERY enquiry lands here now, whichever service it is for, with leadInterest
 * saying which (§47). That is what makes the board one pipeline: the Status
 * column, its ten group-moving automations and the whole customer sync only
 * exist on this board, so a GR enquirer sent anywhere else could never carry a
 * label and had to be re-created by hand.
 *
 * leadInterest is REQUIRED rather than optional. It is the one fact this
 * function exists to record and there is no sensible default: guessing
 * Management is exactly the bug being fixed.
 */
export async function createEnquiryContact(input: {
  name: string;
  email: string;
  mobile: string;
  websiteUrl: string;
  propertiesManaged: string;
  leadInterest: LeadInterestLabel;
  preferredPlan?: string;
  currentLeadSource?: string;
}): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  return createBoardContact(enquiryBoardId(), input.name, {
    [ENQUIRY_COLUMN_MAP.email]: input.email,
    [ENQUIRY_COLUMN_MAP.mobile]: input.mobile,
    [ENQUIRY_COLUMN_MAP.website_url]: input.websiteUrl,
    [ENQUIRY_COLUMN_MAP.properties_managed]: input.propertiesManaged,
    [ENQUIRY_COLUMN_MAP.preferred_plan]: input.preferredPlan ?? "",
    [ENQUIRY_COLUMN_MAP.current_lead_source]: input.currentLeadSource ?? "",
    [ENQUIRY_LEAD_INTEREST_COLUMN]: input.leadInterest,
    [ENQUIRY_COLUMN_MAP.date_added]: { date: today },
  });
}

/**
 * Pull every sellable lead from the Monday board and map each to the same
 * payload shape the n8n webhook receives. Requires MONDAY_API_TOKEN.
 */
export async function fetchMondayLeads(): Promise<N8nLeadPayload[]> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing MONDAY_API_TOKEN. Add it in Vercel → Settings → Environment Variables."
    );
  }

  const columnIds = Object.values(COLUMN_MAP);
  const leads: N8nLeadPayload[] = [];
  let cursor: string | null = null;

  // Paginate through the board (100 items/page) until exhausted.
  do {
    // `assets` rides along on the page read the sync already does, so the
    // income report costs no extra HTTP. public_url is signed for an hour and
    // is used immediately by ingest; it is never stored.
    const query = cursor
      ? `query { next_items_page(limit: 100, cursor: "${cursor}") { cursor items { id name assets { id name public_url } column_values(ids: ${JSON.stringify(
          columnIds
        )}) { id text } } } }`
      : `query { boards(ids: ${boardId()}) { items_page(limit: 100) { cursor items { id name assets { id name public_url } column_values(ids: ${JSON.stringify(
          columnIds
        )}) { id text } } } } }`;

    const res = await fetch(MONDAY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        "API-Version": "2024-10",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Monday API HTTP ${res.status}`);
    }

    const json: {
      data?: {
        next_items_page?: { cursor: string | null; items: MondayItem[] };
        boards?: { items_page: { cursor: string | null; items: MondayItem[] } }[];
      };
      errors?: { message: string }[];
    } = await res.json();

    if (json.errors) {
      throw new Error(
        `Monday API error: ${json.errors.map((e) => e.message).join("; ")}`
      );
    }

    const page: { cursor: string | null; items: MondayItem[] } | undefined =
      cursor ? json.data?.next_items_page : json.data?.boards?.[0]?.items_page;
    const items: MondayItem[] = page?.items ?? [];
    cursor = page?.cursor ?? null;

    for (const item of items) {
      // Only ingest items marked as sellable.
      if (textFor(item, COLUMN_MAP.status) !== SELLABLE_STATUS) continue;
      leads.push(mapManagementItem(item));
    }
  } while (cursor);

  return leads;
}

/**
 * One management board item → the payload shape ingest takes. Shared by the
 * daily walker above and the five-minute poll below (§63.1), so the two cannot
 * drift on which cell feeds which field.
 */
function mapManagementItem(item: MondayItem): N8nLeadPayload {
  const report = pickIncomeReportAsset(item.assets);
  return {
    monday_item_id: item.id,
    lead_name: item.name,
    lead_profile: textFor(item, COLUMN_MAP.lead_profile),
    email: textFor(item, COLUMN_MAP.email),
    phone: textFor(item, COLUMN_MAP.phone),
    address: textFor(item, COLUMN_MAP.address),
    bedrooms: textFor(item, COLUMN_MAP.bedrooms),
    enquiry_date: textFor(item, COLUMN_MAP.enquiry_date),
    income_report_asset_id: report?.id,
    income_report_url: report?.public_url,
  };
}

/** One GR board item → the payload shape, keyed by Monday column id. */
function mapGuaranteedRentItem(item: MondayItem): N8nLeadPayload {
  const payload: N8nLeadPayload = {
    monday_item_id: item.id,
    lead_name: item.name,
    lead_type: "guaranteed_rent",
  };
  for (const columnId of Object.keys(GR_COLUMN_MAP)) {
    payload[columnId] = textFor(item, columnId);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// The five-minute poll (§63.1): ONE page per board, newest-updated first.
// ---------------------------------------------------------------------------

/** Monday's virtual column for "order by last change". */
const MONDAY_LAST_UPDATED_COLUMN = "__last_updated__";

/**
 * The status column's label INDEX for a given label text, from the column's
 * `settings_str`.
 *
 * ⚠️ A `query_params` rule on a status column takes label INDEXES, not text.
 * `compare_value: ["Lead for sale"]` does not error — it returns an EMPTY page,
 * silently, for ever. Measured against the live board while building §63:
 * the text form returned nothing and `[16]` returned the sellable items. So
 * the index is resolved at runtime from the column settings, and a label that
 * cannot be found is reported as a failure rather than read as a quiet board.
 *
 * Pure. Accepts both shapes Monday has returned for `labels` — an id→text map
 * and an array of `{ id, label }` — so a settings format change fails loudly
 * in the unit test rather than quietly on the board.
 */
export function sellableStatusIndex(settingsStr: string, label: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsStr);
  } catch {
    return null;
  }
  const labels = (parsed as { labels?: unknown } | null)?.labels;
  if (!labels) return null;
  if (Array.isArray(labels)) {
    const hit = labels.find(
      (l) => l && typeof l === "object" && (l as { label?: unknown }).label === label
    ) as { id?: unknown } | undefined;
    const id = Number(hit?.id);
    return hit && Number.isInteger(id) ? id : null;
  }
  if (typeof labels === "object") {
    for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
      if (value === label) {
        const id = Number(key);
        return Number.isInteger(id) ? id : null;
      }
    }
  }
  return null;
}

/** A lead item as the poll sees it: the ingest payload plus Monday's clocks. */
export interface RecentLeadItem {
  payload: N8nLeadPayload;
  /** The API's own timestamp — never the board's "Date added" cell (§57.5). */
  createdAt: string;
  updatedAt: string;
}

export type RecentLeadsResult =
  | { ok: true; items: RecentLeadItem[] }
  | { ok: false; error: string };

type RecentPageItem = MondayItem & { created_at?: string; updated_at?: string };

/** Resolved once per process; the column settings change by hand, rarely. */
let sellableIndexCache: number | null = null;

/**
 * The most recently changed sellable items on the management board (§63.1).
 *
 * NEVER THROWS — a result object, the `fetchNewEnquiryItems` contract, because
 * the caller is a cron that must report a Monday outage rather than die of it.
 *
 * ⚠️ ORDERED BY LAST UPDATE, not creation: an item created weeks ago and moved
 * to "Lead for sale" today is exactly the lead the poll exists to catch, and
 * a creation-ordered page would never see it. Filtered server-side on the
 * status INDEX (see sellableStatusIndex) and again client-side on the label
 * text, so a resolved-but-wrong index can never sell the wrong items.
 */
export async function fetchRecentManagementLeads(limit = 30): Promise<RecentLeadsResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { ok: false, error: "not_configured" };

  try {
    if (sellableIndexCache === null) {
      const settings = await mondayGraphql<{
        boards?: { columns?: { id: string; settings_str?: string | null }[] }[];
      }>(
        token,
        `query ($board: [ID!], $col: [String!]) { boards(ids: $board) { columns(ids: $col) { id settings_str } } }`,
        { board: [boardId()], col: [COLUMN_MAP.status] }
      );
      const board = settings.boards?.[0];
      if (!board) {
        return {
          ok: false,
          error: `Board ${boardId()} returned no data — check the board id and the token's access to it`,
        };
      }
      const col = board.columns?.find((c) => c.id === COLUMN_MAP.status);
      const idx = sellableStatusIndex(col?.settings_str ?? "", SELLABLE_STATUS);
      if (idx === null) {
        return {
          ok: false,
          error: `Status label "${SELLABLE_STATUS}" not found on column ${COLUMN_MAP.status} — the poll cannot filter the board`,
        };
      }
      sellableIndexCache = idx;
    }

    const columnIds = Object.values(COLUMN_MAP);
    const data = await mondayGraphql<{
      boards?: { items_page: { items: RecentPageItem[] } }[];
    }>(
      token,
      `query ($board: [ID!], $limit: Int!, $cols: [String!]) {
        boards(ids: $board) {
          items_page(
            limit: $limit
            query_params: {
              rules: [{ column_id: "${COLUMN_MAP.status}", compare_value: [${sellableIndexCache}], operator: any_of }]
              order_by: [{ column_id: "${MONDAY_LAST_UPDATED_COLUMN}", direction: desc }]
            }
          ) {
            items {
              id name created_at updated_at
              assets { id name public_url }
              column_values(ids: $cols) { id text }
            }
          }
        }
      }`,
      { board: [boardId()], limit, cols: columnIds }
    );

    const page = data.boards?.[0]?.items_page;
    // ⚠️ A MISSING BOARD IS NOT AN EMPTY BOARD (§57's rule).
    if (!page) {
      return {
        ok: false,
        error: `Board ${boardId()} returned no data — check the board id and the token's access to it`,
      };
    }

    const items: RecentLeadItem[] = [];
    for (const item of page.items ?? []) {
      // The second line: the index filter is trusted only as far as the text agrees.
      if (textFor(item, COLUMN_MAP.status) !== SELLABLE_STATUS) continue;
      items.push({
        payload: mapManagementItem(item),
        createdAt: item.created_at ?? "",
        updatedAt: item.updated_at ?? "",
      });
    }
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Monday read failed" };
  }
}

/**
 * The GR mirror. No server-side status rule — every GR item is sellable unless
 * MONDAY_GR_SELLABLE_STATUS narrows it, and that is applied client-side exactly
 * as the daily walker applies it.
 */
export async function fetchRecentGuaranteedRentLeads(limit = 30): Promise<RecentLeadsResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { ok: false, error: "not_configured" };

  const columnIds = [...Object.keys(GR_COLUMN_MAP), GR_STATUS_COLUMN];
  const sellable = grSellableStatus();

  try {
    const data = await mondayGraphql<{
      boards?: { items_page: { items: RecentPageItem[] } }[];
    }>(
      token,
      `query ($board: [ID!], $limit: Int!, $cols: [String!]) {
        boards(ids: $board) {
          items_page(
            limit: $limit
            query_params: {
              order_by: [{ column_id: "${MONDAY_LAST_UPDATED_COLUMN}", direction: desc }]
            }
          ) {
            items {
              id name created_at updated_at
              column_values(ids: $cols) { id text }
            }
          }
        }
      }`,
      { board: [grBoardId()], limit, cols: columnIds }
    );

    const page = data.boards?.[0]?.items_page;
    if (!page) {
      return {
        ok: false,
        error: `Board ${grBoardId()} returned no data — check the board id and the token's access to it`,
      };
    }

    const items: RecentLeadItem[] = [];
    for (const item of page.items ?? []) {
      if (sellable !== null && textFor(item, GR_STATUS_COLUMN) !== sellable) continue;
      items.push({
        payload: mapGuaranteedRentItem(item),
        createdAt: item.created_at ?? "",
        updatedAt: item.updated_at ?? "",
      });
    }
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Monday read failed" };
  }
}

/**
 * The current income-analysis PDF for each of a batch of Monday items.
 *
 * For the sweep (/api/cron/parse-income-reports), which works from leads
 * already in the database and so has no board page to ride along on. Missing
 * items map to null rather than being absent, so the caller can record
 * "no report" for an item that has been deleted from the board without
 * treating it as a transient failure.
 *
 * Built on mondayGraphql, so it inherits the 8s timeout — the sweep runs under
 * a wall-clock budget and must not be able to hang on one bad batch. Throws on
 * transport, HTTP and GraphQL failures; the caller decides what that means.
 */
export async function fetchIncomeReportAssets(
  itemIds: string[]
): Promise<Map<string, MondayAsset | null>> {
  const out = new Map<string, MondayAsset | null>();
  if (!itemIds.length) return out;

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("Missing MONDAY_API_TOKEN");

  for (const id of itemIds) out.set(id, null);

  // `items(ids:)` PAGINATES, and its default limit is 25 — asking for 40 ids
  // returns the first 25 and says nothing about the rest. Left unset, the sweep
  // would read every lead past the 25th as having no report and permanently
  // mark it no_report, which is the one failure mode that looks like success.
  // ITEMS_PER_CALL is Monday's own ceiling for this query.
  for (let i = 0; i < itemIds.length; i += ITEMS_PER_CALL) {
    const chunk = itemIds.slice(i, i + ITEMS_PER_CALL);
    const data = await mondayGraphql<{
      items?: { id: string; assets?: MondayAsset[] | null }[] | null;
    }>(
      token,
      `query ($ids: [ID!], $limit: Int!) { items(ids: $ids, limit: $limit) { id assets { id name public_url } } }`,
      { ids: chunk, limit: chunk.length }
    );

    for (const item of data.items ?? []) {
      out.set(String(item.id), pickIncomeReportAsset(item.assets));
    }
  }

  return out;
}


/**
 * Pull sellable guaranteed-rent leads from the GR Monday board and map each to
 * the webhook payload shape, keyed by Monday column id so ingest's GR mapping
 * applies. Sets lead_type = "guaranteed_rent". Mirrors fetchMondayLeads so the
 * GR pull-sync behaves identically to the management one. Requires
 * MONDAY_API_TOKEN.
 */
export async function fetchGuaranteedRentLeads(): Promise<N8nLeadPayload[]> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing MONDAY_API_TOKEN. Add it in Vercel → Settings → Environment Variables."
    );
  }

  const columnIds = [...Object.keys(GR_COLUMN_MAP), GR_STATUS_COLUMN];
  const sellable = grSellableStatus();
  const leads: N8nLeadPayload[] = [];
  let cursor: string | null = null;

  do {
    const query = cursor
      ? `query { next_items_page(limit: 100, cursor: "${cursor}") { cursor items { id name column_values(ids: ${JSON.stringify(
          columnIds
        )}) { id text } } } }`
      : `query { boards(ids: ${grBoardId()}) { items_page(limit: 100) { cursor items { id name column_values(ids: ${JSON.stringify(
          columnIds
        )}) { id text } } } } }`;

    const res = await fetch(MONDAY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        "API-Version": "2024-10",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Monday API HTTP ${res.status}`);
    }

    const json: {
      data?: {
        next_items_page?: { cursor: string | null; items: MondayItem[] };
        boards?: { items_page: { cursor: string | null; items: MondayItem[] } }[];
      };
      errors?: { message: string }[];
    } = await res.json();

    if (json.errors) {
      throw new Error(
        `Monday API error: ${json.errors.map((e) => e.message).join("; ")}`
      );
    }

    const page: { cursor: string | null; items: MondayItem[] } | undefined =
      cursor ? json.data?.next_items_page : json.data?.boards?.[0]?.items_page;
    const items: MondayItem[] = page?.items ?? [];
    cursor = page?.cursor ?? null;

    for (const item of items) {
      // No status filter by default — all GR leads are sellable. Only skip when
      // an explicit sellable status is configured and the item doesn't match.
      if (sellable !== null && textFor(item, GR_STATUS_COLUMN) !== sellable) {
        continue;
      }
      // Key by Monday column id so ingest's GR column map applies directly.
      leads.push(mapGuaranteedRentItem(item));
    }
  } while (cursor);

  return leads;
}
