import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How a paid analysis batch is getting on.
 *
 * Read-only, scoped to the caller's own customer — a job id belonging to
 * somebody else returns the same 404 as one that does not exist, so the
 * endpoint cannot be used to discover which jobs are running.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: customerRow } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  const customer = customerRow as Pick<Customer, "id"> | null;
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: jobRow } = await admin
    .from("lead_analysis_jobs")
    .select(
      "id, status, row_count, amount_pence, succeeded_count, failed_count, refund_status, refund_pence, paused_reason, created_at, finished_at"
    )
    .eq("id", params.jobId)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!jobRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: rows } = await admin
    .from("lead_analysis_rows")
    .select("status")
    .eq("job_id", params.jobId);

  const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const r of (rows ?? []) as Array<{ status: keyof typeof counts | "claimed" }>) {
    // 'claimed' is a moment, not a state worth showing a customer — a row that
    // has been picked up but has not started is, to them, still running.
    const key = r.status === "claimed" ? "running" : r.status;
    if (key in counts) counts[key] += 1;
  }

  return NextResponse.json({ job: jobRow, counts });
}
