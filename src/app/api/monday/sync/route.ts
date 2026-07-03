import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { fetchMondayLeads } from "@/lib/monday";
import { ingestLead } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Pull sellable leads from the Monday board and ingest them (idempotent).
 * Authorised by EITHER an admin session (the admin "Sync from Monday" button)
 * OR a bearer token matching CRON_SECRET (Vercel Cron / external scheduler).
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  if (!viaCron) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let leads;
  try {
    leads = await fetchMondayLeads();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Monday fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  let created = 0;
  let duplicates = 0;
  let assignments = 0;
  const errors: string[] = [];

  for (const lead of leads) {
    const result = await ingestLead(lead);
    if (result.status === "created") {
      created += 1;
      assignments += result.assignments_made;
    } else if (result.status === "duplicate") {
      duplicates += 1;
    } else if (result.error) {
      errors.push(`${lead.lead_name}: ${result.error}`);
    }
  }

  return NextResponse.json({
    status: "ok",
    fetched: leads.length,
    created,
    duplicates,
    assignments,
    errors,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
