import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QualityClaimActions } from "@/components/admin/QualityClaimActions";
import { allowanceBudget } from "@/lib/quality/claimPolicy";
import { daysSince, extractCity, formatDate } from "@/lib/utils";
import type { Customer, Lead, LeadAssignment, LeadQualityClaim } from "@/lib/types";

export const dynamic = "force-dynamic";

const REASON_LABELS: Record<string, string> = {
  already_with_operator: "Already with another operator",
  no_longer_interested: "No longer interested",
  unreachable: "Could not reach",
};

/** Statuses that mean an operator got somewhere — mirrors claimPolicy. */
const ENGAGED_STATUSES = new Set(["in_discussion", "won"]);

type ClaimRow = LeadQualityClaim;

export default async function AdminQualityPage() {
  const admin = createAdminClient();

  const [
    { data: claimsRaw },
    { data: customersRaw },
    { data: leadsRaw },
    { data: assignmentsRaw },
  ] = await Promise.all([
    admin
      .from("lead_quality_claims")
      .select("*")
      .order("created_at", { ascending: false }),
    admin.from("customers").select("*"),
    admin.from("leads").select("*"),
    admin
      .from("lead_assignments")
      .select(
        "id, lead_id, customer_id, status, pipeline_stage, assigned_at, rejection_reason"
      ),
  ]);

  const claims = (claimsRaw ?? []) as ClaimRow[];
  const customers = (customersRaw ?? []) as Customer[];
  const leads = (leadsRaw ?? []) as Lead[];
  const assignments = (assignmentsRaw ?? []) as Pick<
    LeadAssignment,
    | "id"
    | "lead_id"
    | "customer_id"
    | "status"
    | "pipeline_stage"
    | "assigned_at"
    | "rejection_reason"
  >[];

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));

  const assignmentsByLead = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = assignmentsByLead.get(a.lead_id) ?? [];
    list.push(a);
    assignmentsByLead.set(a.lead_id, list);
  }

  const pending = claims.filter((c) => c.status === "under_review");
  const settled = claims.filter(
    (c) => c.status === "auto_upheld" || c.status === "upheld"
  );

  // ---------------------------------------------------------------------
  // Contention: the number that says whether three operators per lead is
  // right. On a lead where somebody reported "already with another operator",
  // did a co-assigned operator turn out to be the winner? That share is the
  // part of the complaint we generate ourselves.
  // ---------------------------------------------------------------------
  const withOperatorClaims = settled.filter(
    (c) => c.reason === "already_with_operator"
  );
  const selfInflicted = withOperatorClaims.filter((claim) => {
    const peers = (assignmentsByLead.get(claim.lead_id) ?? []).filter(
      (a) => a.customer_id !== claim.customer_id
    );
    return peers.some((p) => ENGAGED_STATUSES.has(p.status));
  }).length;

  const unanimousLeads = leads.filter((l) => l.quality_flag === "dead").length;

  // ---------------------------------------------------------------------
  // Supply quality: where the dead leads come from.
  // ---------------------------------------------------------------------
  const deadByCity = new Map<string, number>();
  const deadByProfile = new Map<string, number>();
  let ageSum = 0;
  let ageCount = 0;

  for (const claim of settled) {
    const lead = leadById.get(claim.lead_id);
    if (!lead) continue;

    const city = extractCity(lead.address) || "Unknown";
    deadByCity.set(city, (deadByCity.get(city) ?? 0) + 1);

    const profile = (lead.lead_profile ?? "").trim() || "Not set";
    deadByProfile.set(profile, (deadByProfile.get(profile) ?? 0) + 1);

    const assignment = assignmentById.get(claim.lead_assignment_id);
    const age = daysSince(lead.enquiry_date, new Date(assignment?.assigned_at ?? Date.now()));
    if (age !== null) {
      ageSum += age;
      ageCount += 1;
    }
  }

  // Lead age at assignment across everything, for comparison against the
  // dead-lead figure above. If the dead ones are consistently older, age is the
  // problem and no amount of crediting will fix it.
  let allAgeSum = 0;
  let allAgeCount = 0;
  for (const a of assignments) {
    const lead = leadById.get(a.lead_id);
    const age = daysSince(lead?.enquiry_date, new Date(a.assigned_at));
    if (age !== null) {
      allAgeSum += age;
      allAgeCount += 1;
    }
  }

  const openSlots = leads.filter(
    (l) => l.quality_flag === null && l.assignment_count < l.max_assignments
  );
  const staleOpenSlots = openSlots.filter(
    (l) => (daysSince(l.created_at) ?? 0) > 7
  ).length;

  const stats = [
    { label: "Awaiting review", value: String(pending.length) },
    { label: "Upheld claims", value: String(settled.length) },
    {
      label: "Avg age of a dead lead",
      value: ageCount ? `${Math.round(ageSum / ageCount)} days` : "—",
    },
    {
      label: "Avg age of any lead",
      value: allAgeCount ? `${Math.round(allAgeSum / allAgeCount)} days` : "—",
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Lead quality</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Claims that need a decision, and the numbers behind why leads go dead.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-2xl font-bold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Review queue */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Awaiting review</h2>
        {pending.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              Nothing waiting. Claims land here when a customer is over their
              allowance, is flagged for manual review, or when another operator
              has the same lead live.
            </CardContent>
          </Card>
        ) : (
          pending.map((claim) => {
            const customer = customerById.get(claim.customer_id);
            const lead = leadById.get(claim.lead_id);
            const peers = (assignmentsByLead.get(claim.lead_id) ?? []).filter(
              (a) => a.customer_id !== claim.customer_id
            );

            return (
              <Card key={claim.id}>
                <CardContent className="space-y-4 pt-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">
                        {lead ? (
                          <Link
                            href={`/admin/leads/${lead.id}`}
                            className="hover:underline"
                          >
                            {lead.lead_name}
                          </Link>
                        ) : (
                          "Lead removed"
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {customer ? (
                          <Link
                            href={`/admin/customers/${customer.id}`}
                            className="hover:underline"
                          >
                            {customer.business_name}
                          </Link>
                        ) : (
                          "Unknown customer"
                        )}{" "}
                        · reported {formatDate(claim.created_at)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">
                        {REASON_LABELS[claim.reason] ?? claim.reason}
                      </Badge>
                      {claim.corroboration === "peer_contradicts" && (
                        <Badge className="border-transparent bg-red-100 text-red-700">
                          Another operator has it live
                        </Badge>
                      )}
                      {customer?.quality_review_required && (
                        <Badge className="border-transparent bg-amber-100 text-amber-800">
                          Customer under manual review
                        </Badge>
                      )}
                    </div>
                  </div>

                  <blockquote className="rounded-md bg-muted/50 p-3 text-sm">
                    {claim.detail}
                    {claim.contacted_on && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Spoke to them {formatDate(claim.contacted_on)}
                      </span>
                    )}
                  </blockquote>

                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <p>
                      Lead was{" "}
                      {daysSince(lead?.enquiry_date) ?? "an unknown number of"}{" "}
                      days past enquiry today.
                    </p>
                    {customer && (
                      <p>
                        Claims this cycle: {customer.quality_claims_this_cycle} of{" "}
                        {allowanceBudget(customer)} · clean streak{" "}
                        {customer.clean_leads_streak}
                      </p>
                    )}
                  </div>

                  {peers.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      <p className="mb-1 font-medium text-foreground">
                        Other operators on this lead
                      </p>
                      <ul className="space-y-0.5">
                        {peers.map((p) => (
                          <li key={p.id}>
                            {customerById.get(p.customer_id)?.business_name ??
                              "Unknown"}{" "}
                            — {p.status} / {p.pipeline_stage}
                            {p.rejection_reason
                              ? ` (rejected: ${p.rejection_reason})`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <QualityClaimActions claimId={claim.id} />
                </CardContent>
              </Card>
            );
          })
        )}
      </section>

      {/* Contention */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Contention</h2>
        <Card>
          <CardContent className="space-y-3 pt-6 text-sm">
            <p className="text-muted-foreground">
              Leads go to three operators by default, so two of the three lose
              the landlord by construction. This is the number that says whether
              three is the right figure.
            </p>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">
                  &ldquo;Already with another operator&rdquo; claims
                </dt>
                <dd className="text-xl font-bold">
                  {withOperatorClaims.length}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  …where the winner was one of ours
                </dt>
                <dd className="text-xl font-bold">
                  {selfInflicted}
                  {withOperatorClaims.length > 0 && (
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      (
                      {Math.round(
                        (selfInflicted / withOperatorClaims.length) * 100
                      )}
                      %)
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Leads every operator wrote off
                </dt>
                <dd className="text-xl font-bold">{unanimousLeads}</dd>
              </div>
            </dl>
            {selfInflicted > 0 && (
              <p className="text-xs text-muted-foreground">
                That middle figure is the share of the complaint we generate
                ourselves. If it climbs, lower the default operators per lead.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Supply quality */}
      <section className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard
          title="Dead leads by city"
          empty="No upheld claims yet."
          rows={deadByCity}
        />
        <BreakdownCard
          title="Dead leads by lead profile"
          empty="No upheld claims yet."
          rows={deadByProfile}
        />
      </section>

      {/* Unassigned inventory */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Unassigned inventory</h2>
        <Card>
          <CardContent className="space-y-2 pt-6 text-sm">
            <p>
              <strong>{openSlots.length}</strong> lead
              {openSlots.length === 1 ? "" : "s"} still have an open slot,{" "}
              <strong>{staleOpenSlots}</strong> of them more than a week old.
            </p>
            <p className="text-xs text-muted-foreground">
              The backfill job at{" "}
              <code className="rounded bg-muted px-1">
                /api/cron/backfill-assignments
              </code>{" "}
              drains this queue oldest-first. A slot vacated by a rejection is
              not counted here and is never resold.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function BreakdownCard({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Map<string, number>;
}) {
  const sorted = Array.from(rows.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  return (
    <Card>
      <CardContent className="pt-6">
        <h3 className="mb-3 font-semibold">{title}</h3>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {sorted.map(([key, count]) => (
              <li key={key} className="flex justify-between gap-4">
                <span className="truncate text-muted-foreground">{key}</span>
                <span className="font-medium">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
