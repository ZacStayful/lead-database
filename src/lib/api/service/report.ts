/**
 * The stored property-analysis PDF for a lead.
 *
 * THIS STREAMS THE BYTES. It must never return the Supabase signed URL, which
 * is what the browser-facing route redirects to.
 *
 * That URL reads
 * `https://<project-ref>.supabase.co/storage/v1/object/sign/lead-reports/<lead_id>/analysis.pdf`,
 * so handing it to an API client publishes our storage provider, the project
 * reference, the bucket name and the object-path convention. None of that is a
 * credential, and all of it is already visible to anybody who opens the network
 * tab in the dashboard — but a browser network tab is a person looking once,
 * whereas an API response is a machine-readable fact that ends up in somebody's
 * logs. Signing internally and returning the bytes costs one server-side fetch
 * and says nothing about where the file lives.
 *
 * ASSIGNMENT ONLY. The browser route also admits anybody who can see the lead
 * in the expired-leads pool, which is a deliberate commercial decision there.
 * This surface does not extend it: an integration reading pooled leads' full
 * analyses in bulk is a different thing from an operator reading one before
 * deciding whether to ring.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { LEAD_REPORTS_BUCKET } from "@/lib/incomeReportStorage";
import { internal, notFound, ok, type ApiResult } from "@/lib/api/errors";
import { REPORT_SIGNED_URL_TTL_SECONDS } from "@/lib/api/limits";
import type { Caller } from "@/lib/api/caller";

type Admin = ReturnType<typeof createAdminClient>;

export interface ReportPayload {
  bytes: Uint8Array;
  filename: string;
}

export async function getReport(
  caller: Caller,
  assignmentId: string,
  adminClient?: Admin
): Promise<ApiResult<ReportPayload>> {
  const admin = adminClient ?? createAdminClient();

  const { data, error } = await admin
    .from("lead_assignments")
    .select("id, lead:leads(id, income_report_path)")
    .eq("id", assignmentId)
    .eq("customer_id", caller.customerId)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return notFound();
    return internal("getReport lookup", error);
  }
  if (!data) return notFound();

  const lead = (data as unknown as {
    lead: { id: string; income_report_path: string | null } | null;
  }).lead;

  // "No report stored" and "not your lead" are the SAME 404 with the same body.
  // Distinguishing them would confirm which leads exist and which of those
  // carry an analysis.
  if (!lead?.income_report_path) return notFound();

  const { data: signed, error: signError } = await admin.storage
    .from(LEAD_REPORTS_BUCKET)
    .createSignedUrl(lead.income_report_path, REPORT_SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    return internal("getReport signing", signError);
  }

  let response: Response;
  try {
    response = await fetch(signed.signedUrl);
  } catch (err) {
    return internal("getReport fetch", err);
  }

  if (!response.ok) {
    return internal("getReport fetch status", response.status);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  // A zero-length body is never a legitimate report. The income-report work
  // shipped 159 empty PDFs once because a parser detached the buffer it was
  // handed, and the failure was invisible precisely because the figures were
  // all correct. Refusing here keeps that class of fault loud.
  if (bytes.byteLength === 0) {
    return internal("getReport empty body", lead.id);
  }

  return ok({ bytes, filename: `stayful-analysis-${lead.id}.pdf` });
}


/**
 * Whether a report exists for one assignment, and how big it is.
 *
 * Deliberately does NOT go through getReport(). That signs a URL and pulls the
 * whole PDF through the lambda, which is the right thing when the caller wants
 * the bytes and pure waste when it wants a boolean and an integer — the size is
 * already a column. Same assignment predicate and the same indistinguishable
 * 404, so this is cheaper without being more permissive.
 */
export async function getReportSummary(
  caller: Caller,
  assignmentId: string,
  adminClient?: Admin
): Promise<ApiResult<{ available: true; size_bytes: number | null }>> {
  const admin = adminClient ?? createAdminClient();

  const { data, error } = await admin
    .from("lead_assignments")
    .select("id, lead:leads!inner(id, income_report_path, income_report_size_bytes)")
    .eq("id", assignmentId)
    .eq("customer_id", caller.customerId)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return notFound();
    return internal("getReportSummary", error);
  }
  if (!data) return notFound();

  const lead = (data as unknown as {
    lead: {
      income_report_path: string | null;
      income_report_size_bytes: number | null;
    } | null;
  }).lead;

  if (!lead?.income_report_path) return notFound();

  return ok({ available: true, size_bytes: lead.income_report_size_bytes ?? null });
}
