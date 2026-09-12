import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { releasePendingLeads } from "@/lib/releaseLeads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The morning release (§54). Weekdays at 07:30 UTC — 07:30 GMT / 08:30 BST —
 * so each customer's lead for the day is in their inbox BEFORE the 08:15 UTC
 * daily follow-up email, which can then say "your lead for today is in".
 *
 * It is the same pass as the admin "Assign pending" button
 * (src/lib/releaseLeads.ts): every under-assigned lead, oldest first, through
 * autoAssignLead, whose candidate RPCs carry the one-a-working-day rule. With
 * `release_enabled` off it is simply a scheduled backstop for banked leads.
 *
 * ⚠️ THREE THINGS ASSIGN, NOT ONE. The n8n webhook still assigns a lead the
 * moment it arrives (a customer with allowance left gets it at 14:00 rather
 * than tomorrow), and both 09:00 Monday syncs still re-offer every banked
 * lead. This cron adds the morning pass; it does not replace either.
 *
 * `?dryRun=true` lists what would be offered and assigns nothing.
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

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const result = await releasePendingLeads(createAdminClient(), { dryRun });
  if ("error" in result) {
    console.error("release-leads failed", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  console.log("release-leads", JSON.stringify(result));
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
