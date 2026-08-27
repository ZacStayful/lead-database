import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AdminLeadControls } from "@/components/admin/AdminLeadControls";
import { LeadQualityPanel } from "@/components/admin/LeadQualityPanel";
import { formatDate, formatGBP } from "@/lib/utils";
import { activeLeadFilters, filterSummary } from "@/lib/leadFilter";
import type { Customer, Lead } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminLeadDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();

  const { data: leadRaw } = await admin
    .from("leads")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!leadRaw) notFound();
  const lead = leadRaw as Lead;

  const { data: assignmentsRaw } = await admin
    .from("lead_assignments")
    .select(
      "id, assigned_at, customer_id, price_paid, reclaimed_at, is_reclaimed, customers(id, business_name, email)"
    )
    .eq("lead_id", lead.id)
    .order("assigned_at");

  const assignments = (assignmentsRaw ?? []) as unknown as {
    id: string;
    assigned_at: string;
    customer_id: string;
    price_paid: number;
    reclaimed_at: string | null;
    is_reclaimed: boolean;
    customers: { id: string; business_name: string; email: string } | null;
  }[];

  // Reclaim history: which recipient lost exclusivity and when, and which one
  // received the lead second-hand. Both sides matter when a customer queries a
  // charge or asks why someone else has "their" lead.
  const reclaimReleasedBy = assignments.filter((a) => a.reclaimed_at !== null);
  const reclaimReceivedBy = assignments.filter((a) => a.is_reclaimed);
  const assignedIds = new Set(assignments.map((a) => a.customer_id));

  const { data: customersRaw } = await admin
    .from("customers")
    .select("*")
    .eq("is_active", true)
    .order("business_name");
  // Who added it, when it is a customer's own lead.
  let ownerName: string | null = null;
  if (lead.owner_customer_id) {
    const { data: owner } = await admin
      .from("customers")
      .select("business_name")
      .eq("id", lead.owner_customer_id)
      .maybeSingle();
    ownerName = (owner as { business_name?: string } | null)?.business_name ?? null;
  }

  const isGuaranteedRent = lead.lead_type === "guaranteed_rent";
  const creditsOf = (c: Customer) =>
    isGuaranteedRent ? c.gr_lead_balance : c.lead_balance;

  const notAssigned = ((customersRaw ?? []) as Customer[]).filter(
    (c) => !assignedIds.has(c.id)
  );

  // Which of these customers' filters this lead actually reaches (0110).
  //
  // Answered in SQL by customers_matching_lead_filter, which delegates to
  // lead_matches_customer_filter — the same predicate allocation, the expired
  // pool and the swap use. Doing it in TypeScript here would be a fifth
  // hand-written copy of it.
  //
  // Fails CLOSED on an unreadable result: an id we get no verdict for is
  // treated as outside the filter, so the picker warns rather than quietly
  // offering something assign_lead_to_customer would then refuse. A customer
  // with no active filter on this product comes back true, so an unfiltered
  // book renders exactly as it did before this existed.
  const filterVerdicts = new Map<string, boolean>();
  if (notAssigned.length > 0) {
    const { data: verdicts, error: verdictError } = await admin.rpc(
      "customers_matching_lead_filter",
      { p_lead_id: lead.id, p_customer_ids: notAssigned.map((c) => c.id) }
    );
    if (verdictError) {
      console.error("lead filter verdicts lookup failed", verdictError);
    }
    for (const row of (verdicts ?? []) as {
      customer_id: string;
      matches: boolean;
    }[]) {
      filterVerdicts.set(row.customer_id, row.matches === true);
    }
  }
  const matchesFilter = (id: string) => filterVerdicts.get(id) === true;

  // The filter itself, in words, so the warning can name what is being
  // overridden rather than just saying "outside their filter".
  // activeLeadFilters/filterSummary are the existing admin-side readers — they
  // already know pending_lift counts as filtered and that an empty area list
  // means anywhere.
  const filterText = (c: Customer) => {
    const view = activeLeadFilters(c).find(
      (f) => f.leadType === lead.lead_type
    );
    return view ? filterSummary(view) : null;
  };

  // Normal pool: customers subscribed to this lead's product, so a GR lead is
  // never force-assigned to a management-only customer (and vice-versa).
  const availableCustomers = notAssigned
    .filter((c) =>
      isGuaranteedRent
        ? c.gr_subscription_status === "active"
        : c.subscription_status === "active"
    )
    .map((c) => ({
      id: c.id,
      business_name: c.business_name,
      credits: creditsOf(c),
      matches_filter: matchesFilter(c.id),
      filter_summary: filterText(c),
    }));

  // Override pool: any approved customer, regardless of subscription/credits,
  // for the admin override path (how GR leads get placed with no GR subscribers).
  // Approval means holding EITHER product — account_status is management-only, so
  // on its own it excluded every GR-only subscriber from the override pool.
  const overrideCustomers = notAssigned
    .filter(
      (c) =>
        c.account_status === "active" || c.gr_subscription_status === "active"
    )
    .map((c) => ({
      id: c.id,
      business_name: c.business_name,
      credits: creditsOf(c),
      matches_filter: matchesFilter(c.id),
      filter_summary: filterText(c),
    }));

  const fields: [string, string | null][] = [
    ["Lead name", lead.lead_name],
    [
      "Lead type",
      lead.lead_type === "guaranteed_rent" ? "Guaranteed Rent" : "Management",
    ],
    ["Email", lead.email],
    ["Phone", lead.phone],
    ["Address", lead.address],
    ["Bedrooms", lead.bedrooms],
    ["Lead profile", lead.lead_profile],
    // Enquiry date is deliberately not shown anywhere, admin included. It is a
    // free-text Monday field of uneven quality, and every question worth asking
    // ("how long has this been sitting with someone?") is answered by the
    // assignment date instead. Ingested is when it reached us.
    ["Ingested", formatDate(lead.created_at)],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/leads"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to leads
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-bold">{lead.lead_name}</h1>
          <Badge
            variant={
              lead.assignment_count >= lead.max_assignments ? "muted" : "brand"
            }
          >
            {lead.assignment_count} / {lead.max_assignments} assigned
          </Badge>
        </div>
      </div>

      {/* Above the fold and outside the two-column grid: a blocked lead is the
          first thing an admin opening this page needs to know, and burying it
          in a sidebar card is how it gets missed. */}
      <LeadQualityPanel
        leadId={lead.id}
        status={lead.lead_quality_status ?? "pending"}
        codes={lead.lead_quality_codes ?? []}
        checkedAt={lead.lead_quality_checked_at ?? null}
        overrideAt={lead.lead_quality_override_at ?? null}
        overrideBy={lead.lead_quality_override_by ?? null}
        overrideNote={lead.lead_quality_override_note ?? null}
        isOwnedLead={Boolean(lead.owner_customer_id)}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Lead details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {fields.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 text-sm">{value || "—"}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-6">
                <h3 className="mb-2 text-sm font-medium">Recipients</h3>
                {assignments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not yet assigned to any customer.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {assignments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
                      >
                        <span className="flex items-center gap-2 font-medium">
                          {/* Through to what this operator has actually done
                              with the lead — their notes, pipeline and contact
                              record. Each holder has their own. */}
                          <Link
                            href={`/admin/assignments/${a.id}`}
                            className="text-brand hover:underline"
                          >
                            {a.customers?.business_name ?? "Unknown"}
                          </Link>
                          {a.is_reclaimed && (
                            <Badge variant="muted">Reclaimed</Badge>
                          )}
                        </span>
                        <span className="text-muted-foreground">
                          {formatDate(a.assigned_at)} · {formatGBP(a.price_paid)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {(reclaimReleasedBy.length > 0 ||
                reclaimReceivedBy.length > 0) && (
                <div className="mt-6">
                  <h3 className="mb-2 text-sm font-medium">Reclaim history</h3>
                  <ul className="space-y-2 text-sm">
                    {reclaimReleasedBy.map((a) => (
                      <li
                        key={`rel-${a.id}`}
                        className="rounded-md border-[0.5px] border-border px-3 py-2"
                      >
                        <span className="font-medium">
                          {a.customers?.business_name ?? "Unknown"}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          did not action this lead — released to a second
                          operator on {formatDate(a.reclaimed_at)}. Assignment
                          kept, no refund.
                        </span>
                      </li>
                    ))}
                    {reclaimReceivedBy.map((a) => (
                      <li
                        key={`rec-${a.id}`}
                        className="rounded-md border-[0.5px] border-border px-3 py-2"
                      >
                        <span className="font-medium">
                          {a.customers?.business_name ?? "Unknown"}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          received it as a reclaimed lead on{" "}
                          {formatDate(a.assigned_at)} at{" "}
                          {formatGBP(a.price_paid)}.
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>
                {lead.owner_customer_id ? "Customer's own lead" : "Override controls"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {lead.owner_customer_id ? (
                // No controls at all. admin_assign_lead refuses an owned lead
                // (0102), so a form here could only produce an error — and the
                // lead is not ours to place in the first place.
                <p className="text-sm text-muted-foreground">
                  {ownerName ?? "A customer"} added this lead themselves
                  {lead.owner_source === "manual"
                    ? " by hand"
                    : " by importing a spreadsheet"}
                  . It is visible only to them, is never pooled or escalated,
                  and cannot be assigned to anyone else.
                </p>
              ) : (
                <AdminLeadControls
                  leadId={lead.id}
                  maxAssignments={lead.max_assignments}
                  assignmentCount={lead.assignment_count}
                  customers={availableCustomers}
                  overrideCustomers={overrideCustomers}
                  leadType={lead.lead_type}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
