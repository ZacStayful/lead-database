import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import {
  NUDGE_CUSTOMER_COLUMNS,
  sendFollowUpReminder,
  skipMessage,
  type NudgeCustomer,
  type ReminderResult,
} from "@/lib/followUp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One request may cover a screenful of selected customers, but not the whole
// database: at roughly a second and a half per recipient (queries + the throttled
// send) a larger batch risks hitting the 60s function limit mid-run, which would
// leave some reminders sent and no response to say which. The admin table
// chunks bigger selections into requests of this size.
const MAX_RECIPIENTS = 25;
// Resend allows 2 requests/second; space the sends so a bulk run cannot trip it.
const SEND_GAP_MS = 550;

type ReminderCustomer = NudgeCustomer & {
  user_id: string | null;
  business_name: string;
};

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send the "log in and follow up your leads" reminder to one or more customers.
 *
 * Powers both the per-row action and the bulk send on the admin customers table
 * — the single case is just a one-element `ids` array, so there is one code path
 * and one set of rules. Each recipient is reported individually: a customer who
 * has opted out, has no portal login, or is no longer live on either product is
 * skipped with a reason rather than failing the whole request.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? Array.from(
        new Set(
          body.ids.filter(
            (id): id is string => typeof id === "string" && id.length > 0
          )
        )
      )
    : [];

  if (ids.length === 0) {
    return NextResponse.json(
      { error: "Provide at least one customer id" },
      { status: 400 }
    );
  }
  if (ids.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      {
        error: `Too many customers in one request (max ${MAX_RECIPIENTS}) — send in smaller batches`,
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("customers")
    .select(`${NUDGE_CUSTOMER_COLUMNS}, user_id, business_name`)
    .in("id", ids);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const customers = (rows ?? []) as unknown as ReminderCustomer[];
  if (customers.length === 0) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const now = new Date();
  const results: ReminderResult[] = [];
  for (const customer of customers) {
    if (results.length > 0) await sleep(SEND_GAP_MS);
    results.push(await sendFollowUpReminder(admin, customer, now));
  }

  const sent = results.filter((r) => r.sent);
  return NextResponse.json({
    status: "ok",
    // The reason a recipient was skipped is explained here rather than in the
    // browser, so the admin UI never has to keep its own copy of the rules.
    results: results.map((r) => ({
      ...r,
      skippedMessage: r.skipped ? skipMessage(r.skipped) : undefined,
    })),
    summary: {
      sent: sent.length,
      skipped: results.filter((r) => !r.sent && r.skipped).length,
      failed: results.filter((r) => !r.sent && !r.skipped).length,
      // Total leads named across every reminder that went out.
      leads: sent.reduce((total, r) => total + r.leadCount, 0),
    },
  });
}
