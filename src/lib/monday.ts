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
}

function textFor(item: MondayItem, columnId: string): string {
  return item.column_values.find((c) => c.id === columnId)?.text ?? "";
}

/** Board 18420649520 "Stayful Lead database enquiries" (landing-page form). */
function enquiryBoardId(): string {
  return process.env.MONDAY_ENQUIRY_BOARD_ID ?? "18420649520";
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
  date_added: "date_mm50brxt", // "Date added"
} as const;

/**
 * Create a contact item on the enquiries board from a landing-page form
 * submission. Returns the new Monday item id. Requires MONDAY_API_TOKEN.
 */
export async function createEnquiryContact(input: {
  name: string;
  email: string;
  mobile: string;
  websiteUrl: string;
  propertiesManaged: string;
}): Promise<string> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing MONDAY_API_TOKEN. Add it in Vercel → Settings → Environment Variables."
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const columnValues: Record<string, unknown> = {
    [ENQUIRY_COLUMN_MAP.email]: input.email,
    [ENQUIRY_COLUMN_MAP.mobile]: input.mobile,
    [ENQUIRY_COLUMN_MAP.website_url]: input.websiteUrl,
    [ENQUIRY_COLUMN_MAP.properties_managed]: input.propertiesManaged,
    [ENQUIRY_COLUMN_MAP.date_added]: { date: today },
  };

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
        boardId: enquiryBoardId(),
        itemName: input.name,
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
    const query = cursor
      ? `query { next_items_page(limit: 100, cursor: "${cursor}") { cursor items { id name column_values(ids: ${JSON.stringify(
          columnIds
        )}) { id text } } } }`
      : `query { boards(ids: ${boardId()}) { items_page(limit: 100) { cursor items { id name column_values(ids: ${JSON.stringify(
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

      leads.push({
        monday_item_id: item.id,
        lead_name: item.name,
        lead_profile: textFor(item, COLUMN_MAP.lead_profile),
        email: textFor(item, COLUMN_MAP.email),
        phone: textFor(item, COLUMN_MAP.phone),
        address: textFor(item, COLUMN_MAP.address),
        bedrooms: textFor(item, COLUMN_MAP.bedrooms),
        enquiry_date: textFor(item, COLUMN_MAP.enquiry_date),
      });
    }
  } while (cursor);

  return leads;
}
