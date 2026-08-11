import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { statusBadge } from "@/components/dashboard/leadStatus";
import { pipelineBadgeClass, pipelineLabel } from "@/components/dashboard/pipelineStage";
import { formatDate, formatDateTime, formatGBP } from "@/lib/utils";
import type { Customer, Lead, LeadAssignment, LeadEvent, LeadFile, LeadNote } from "@/lib/types";

export const dynamic = "force-dynamic";

const FILES_BUCKET = "lead-files";

/** How long the file links on this page stay good. One admin sitting. */
const FILE_URL_TTL_SECONDS = 60 * 60;

/**
 * What each telemetry event means in words.
 *
 * `nudge_sent` is system-generated and the rest are operator-generated — the
 * distinction matters when reading this list, because our own nudges would
 * otherwise look like customer activity (§3).
 */
const EVENT_LABEL: Record<string, string> = {
  detail_opened: "Opened the lead",
  tel_click: "Clicked the phone number",
  mailto_click: "Clicked the email address",
  note_added: "Added a note",
  file_added: "Attached a file",
  stage_changed: "Changed the pipeline stage",
  nudge_sent: "We sent a nudge",
};

const SYSTEM_EVENTS = new Set(["nudge_sent"]);

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{children ?? "—"}</dd>
    </div>
  );
}

function humanSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One customer's copy of one lead, as they see it.
 *
 * Deliberately read-only. Everything here belongs to the customer — their
 * notes, their pipeline, their record of who they rang — and an admin editing
 * it would be rewriting somebody's own account of their work. Reassignment,
 * swapping and capacity live on the lead and customer pages, which is where a
 * change to an assignment ought to be made.
 *
 * The point of the page is answering "what has this customer actually done
 * with this lead" without asking them: when a customer queries a charge,
 * disputes a lead's quality, or asks why they were nudged, the answer is here.
 *
 * Keyed on the assignment rather than (customer, lead) because an assignment
 * is the thing that is unique. The same lead sits with up to three operators
 * as separate rows with their own status, notes and files (§6A), and this page
 * shows exactly one of them.
 */
export default async function AdminAssignmentDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  const { data: assignmentRaw } = await admin
    .from("lead_assignments")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!assignmentRaw) notFound();
  const assignment = assignmentRaw as LeadAssignment;

  const [{ data: leadRaw }, { data: customerRaw }] = await Promise.all([
    admin.from("leads").select("*").eq("id", assignment.lead_id).maybeSingle(),
    admin
      .from("customers")
      .select("*")
      .eq("id", assignment.customer_id)
      .maybeSingle(),
  ]);

  if (!leadRaw || !customerRaw) notFound();
  const lead = leadRaw as Lead;
  const customer = customerRaw as Customer;

  const [{ data: noteRows }, { data: fileRows }, { data: eventRows }] =
    await Promise.all([
      admin
        .from("lead_notes")
        .select("*")
        .eq("lead_assignment_id", assignment.id)
        .order("created_at", { ascending: false }),
      admin
        .from("lead_files")
        .select("*")
        .eq("lead_assignment_id", assignment.id)
        .order("created_at", { ascending: false }),
      admin
        .from("lead_events")
        .select("*")
        .eq("assignment_id", assignment.id)
        .order("created_at", { ascending: false }),
    ]);

  const notes = (noteRows ?? []) as LeadNote[];
  const files = (fileRows ?? []) as LeadFile[];
  const events = (eventRows ?? []) as LeadEvent[];

  // Signed at render on the service role. The customer download route is
  // scoped to the file's owner, which an admin is not, so reusing it here
  // would 404 on every row.
  const fileUrls = new Map<string, string>();
  if (files.length > 0) {
    const { data: signed } = await admin.storage
      .from(FILES_BUCKET)
      .createSignedUrls(
        files.map((f) => f.storage_path),
        FILE_URL_TTL_SECONDS
      );
    files.forEach((f, i) => {
      const url = signed?.[i]?.signedUrl;
      if (url) fileUrls.set(f.id, url);
    });
  }

  const status = statusBadge(assignment.status);
  const isGuaranteedRent = lead.lead_type === "guaranteed_rent";

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/admin/customers/${customer.id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to {customer.business_name}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{lead.lead_name}</h1>
        <p className="text-sm text-muted-foreground">
          What {customer.business_name} has on this lead. Read-only —{" "}
          <Link
            href={`/admin/leads/${lead.id}`}
            className="text-brand hover:underline"
          >
            the lead itself
          </Link>{" "}
          is where assignment is managed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge className={status.className}>{status.label}</Badge>
        <Badge className={pipelineBadgeClass(assignment.pipeline_stage)}>
          {pipelineLabel(assignment.pipeline_stage)}
        </Badge>
        <Badge variant="muted">
          {isGuaranteedRent ? "Guaranteed Rent" : "Management"}
        </Badge>
        {assignment.is_reclaimed && (
          <Badge className="border-transparent bg-amber-100 text-amber-800">
            Received via reclaim
          </Badge>
        )}
        {assignment.reclaimed_at && (
          <Badge className="border-transparent bg-amber-100 text-amber-800">
            Released by reclaim {formatDate(assignment.reclaimed_at)}
          </Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lead details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Name">{lead.lead_name}</Field>
            <Field label="Phone">{lead.phone}</Field>
            <Field label="Email">{lead.email}</Field>
            <Field label="Address">{lead.address}</Field>
            <Field label="Postcode">{lead.postcode}</Field>
            <Field label="Bedrooms">{lead.bedrooms}</Field>
            <Field label="Enquiry date">
              {lead.enquiry_date ? formatDate(lead.enquiry_date) : null}
            </Field>
            <Field label="Reached">
              {lead.assignment_count} of {lead.max_assignments} operators
            </Field>
            {isGuaranteedRent && (
              <>
                <Field label="Desired rent">{lead.desired_rent}</Field>
                <Field label="Last contact">{lead.last_contact}</Field>
              </>
            )}
          </dl>
          {lead.lead_profile && (
            <div className="mt-4 border-t-[0.5px] border-border pt-4">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Lead profile
              </dt>
              <dd className="mt-1 whitespace-pre-line text-sm">
                {lead.lead_profile}
              </dd>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>This customer&apos;s progress</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Received">{formatDateTime(assignment.assigned_at)}</Field>
            <Field label="Charged">{formatGBP(assignment.price_paid)}</Field>
            <Field label="Email sent">
              {assignment.email_sent ? "Yes" : "No"}
            </Field>
            {/*
              viewed_at is set ONLY by expanding the card in the feed, so a lead
              read end-to-end from a direct link leaves it null forever. The
              detail_opened event below is the honest "this was read" signal
              (§11) — labelled so nobody reads a blank here as inactivity.
            */}
            <Field label="Card expanded in feed">
              {assignment.viewed_at ? formatDateTime(assignment.viewed_at) : "Never"}
            </Field>
            <Field label="First contact attempt">
              {assignment.first_contacted_at
                ? formatDateTime(assignment.first_contacted_at)
                : "None recorded"}
            </Field>
            <Field label="Status last changed">
              {formatDateTime(assignment.last_status_change_at)}
            </Field>
            <Field label="Due to call">
              {assignment.due_to_call_date
                ? formatDate(assignment.due_to_call_date)
                : null}
            </Field>
            <Field label="Income estimate">
              {assignment.income_estimate !== null
                ? formatGBP(assignment.income_estimate)
                : null}
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes ({notes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notes written on this lead.
            </p>
          ) : (
            <ul className="space-y-3">
              {notes.map((n) => (
                <li
                  key={n.id}
                  className="rounded-md border-[0.5px] border-border p-3"
                >
                  <p className="whitespace-pre-line text-sm">{n.body}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatDateTime(n.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Files ({files.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No files attached to this lead.
            </p>
          ) : (
            <ul className="space-y-2">
              {files.map((f) => {
                const url = fileUrls.get(f.id);
                return (
                  <li
                    key={f.id}
                    className="flex items-center justify-between gap-3 rounded-md border-[0.5px] border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-sm text-brand hover:underline"
                        >
                          {f.file_name}
                        </a>
                      ) : (
                        <span className="block truncate text-sm">
                          {f.file_name}
                        </span>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {[humanSize(f.size_bytes), formatDateTime(f.created_at)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity ({events.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded. Telemetry starts at the point a lead is opened,
              so an older lead can legitimately show nothing here.
            </p>
          ) : (
            <ul className="space-y-2">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="flex items-baseline justify-between gap-3 border-b-[0.5px] border-border pb-2 last:border-0"
                >
                  <span
                    className={
                      "text-sm " +
                      (SYSTEM_EVENTS.has(e.event_type)
                        ? "text-muted-foreground italic"
                        : "")
                    }
                  >
                    {EVENT_LABEL[e.event_type] ?? e.event_type}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDateTime(e.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
