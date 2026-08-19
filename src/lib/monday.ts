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
 * Board 18420649520 "Stayful Lead database enquiries" (landing-page form).
 * Exported because the customer link columns (0086) store which board an item
 * lives on, and only this one carries the Status column.
 */
export function enquiryBoardId(): string {
  return process.env.MONDAY_ENQUIRY_BOARD_ID ?? "18420649520";
}

/** Board 18420913271 "Stayful Guaranteed rent database enquiries". */
export function grEnquiryBoardId(): string {
  return process.env.MONDAY_GR_ENQUIRY_BOARD_ID ?? "18420913271";
}

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
 * Column-id → field mapping for the Guaranteed Rent enquiries board
 * (18420913271). That board only has name/email/mobile/properties/date — no
 * website or plan columns.
 */
const GR_ENQUIRY_COLUMN_MAP = {
  email: "text_mm50e3d7", // "Email"
  mobile: "text_mm50hfvg", // "Mobile"
  properties_managed: "text_mm50mt3h", // "Number of properties"
  current_lead_source: "text_mm515b3c", // "How do you currently get guaranteed rent leads"
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

/** "Customer start date" — stamped once, on first becoming a customer. */
const ENQUIRY_START_DATE_COLUMN = "date_mm5ft19y";
/** "Customer end date" — the real end of service, not the cancellation click. */
const ENQUIRY_END_DATE_COLUMN = "date_mm5fxrbn";

/**
 * The five Status labels this system owns.
 *
 * CASING IS EXACT AND INCONSISTENT between the two customer labels: capital C in
 * "Management Customer", lower-case r and c in "Guaranteed rent customer". A
 * mismatch is a hard ColumnValueException, which is the behaviour we want —
 * see setEnquiryStatus.
 *
 * The indexes in the comments are for reference only and must NEVER be used to
 * derive a value by position: index 5 is a deleted label and does not exist, so
 * position and index disagree. The remaining five labels on this column
 * (Web meeting sat/booked/no show, In the future, In the future due to call) are
 * the sales pipeline's and are never written from here.
 */
export const ENQUIRY_STATUS = {
  cancelled: "Cancelled", //                        index 0
  management_customer: "Management Customer", //     index 1  — capital C
  card_declined: "Wants to pay card declined", //    index 3
  guaranteed_rent_customer: "Guaranteed rent customer", // index 9 — lower r, c
  paused: "Paused", //                               index 10
} as const;

export type EnquiryStatusLabel =
  (typeof ENQUIRY_STATUS)[keyof typeof ENQUIRY_STATUS];

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
  skipped?: "not_configured" | "not_status_board";
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
export async function setEnquiryStatus(params: {
  itemId: string;
  label: EnquiryStatusLabel;
  boardId?: string | null;
  /** Only pass when the item's cell is empty — first write wins. */
  startDate?: string | null;
  /** Date to set, null to clear, undefined to leave alone. */
  endDate?: string | null;
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
 * Create a contact item on the management enquiries board from a landing-page
 * form submission. Returns the new Monday item id.
 */
export async function createEnquiryContact(input: {
  name: string;
  email: string;
  mobile: string;
  websiteUrl: string;
  propertiesManaged: string;
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
    [ENQUIRY_COLUMN_MAP.date_added]: { date: today },
  });
}

/**
 * Create a contact item on the Guaranteed Rent enquiries board (18420913271).
 * That board has no website/plan columns, so only name/email/mobile/properties
 * are sent.
 */
export async function createGuaranteedRentEnquiryContact(input: {
  name: string;
  email: string;
  mobile: string;
  propertiesManaged: string;
  currentLeadSource?: string;
}): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  return createBoardContact(grEnquiryBoardId(), input.name, {
    [GR_ENQUIRY_COLUMN_MAP.email]: input.email,
    [GR_ENQUIRY_COLUMN_MAP.mobile]: input.mobile,
    [GR_ENQUIRY_COLUMN_MAP.properties_managed]: input.propertiesManaged,
    [GR_ENQUIRY_COLUMN_MAP.current_lead_source]: input.currentLeadSource ?? "",
    [GR_ENQUIRY_COLUMN_MAP.date_added]: { date: today },
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

      const report = pickIncomeReportAsset(item.assets);

      leads.push({
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
      });
    }
  } while (cursor);

  return leads;
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
      const payload: N8nLeadPayload = {
        monday_item_id: item.id,
        lead_name: item.name,
        lead_type: "guaranteed_rent",
      };
      for (const columnId of Object.keys(GR_COLUMN_MAP)) {
        payload[columnId] = textFor(item, columnId);
      }
      leads.push(payload);
    }
  } while (cursor);

  return leads;
}
