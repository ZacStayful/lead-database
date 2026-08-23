import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AdminCustomerForm } from "@/components/admin/AdminCustomerForm";
import { AdminAccessPanel } from "@/components/admin/AdminAccessPanel";
import { SwapLeadControl } from "@/components/admin/SwapLeadControl";
import { formatDate } from "@/lib/utils";
import {
  activeLeadFilters,
  bedroomPhrase,
  filterKindLabel,
  locationText,
  formatPence,
} from "@/lib/leadFilter";
import { computePacing, computeGrPacing } from "@/lib/pacing";
import {
  belowAllocation,
  fetchLeadVolumeAggregate,
  predictMonthlyVolume,
  type LeadVolumeAggregate,
} from "@/lib/filterPrediction";
import { offerState, formatRemaining, type PostCallOffer } from "@/lib/postCallOffers";
import { Download } from "lucide-react";
import type { AssignmentWithLead, Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const { data: customerRaw } = await admin
    .from("customers")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!customerRaw) notFound();
  const customer = customerRaw as Customer;

  const { data: assignmentsRaw } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false });
  const assignments = (assignmentsRaw ?? []) as AssignmentWithLead[];

  // Post-call offer for this customer — matched at redemption, or by email for a
  // still-pending offer created before signup. Most recent wins. Email is stored
  // lowercased by the offer route, so match it exactly (an .ilike here would treat
  // any `_`/`%` in the address as a wildcard).
  const { data: offerRaw } = await admin
    .from("post_call_offers")
    .select("*")
    .or(
      `matched_customer_id.eq.${customer.id},prospect_email.eq.${customer.email.toLowerCase()}`
    )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const offer = (offerRaw as PostCallOffer | null) ?? null;

  // Ingest-history aggregate for the filter card's predicted volume — the same
  // functions the customer's filtering panel runs. Best-effort: a failed fetch
  // costs the prediction row, never the page.
  let volumeAggregate: LeadVolumeAggregate | null = null;
  if (activeLeadFilters(customer).length > 0) {
    try {
      volumeAggregate = await fetchLeadVolumeAggregate(admin);
    } catch (err) {
      console.error("[admin/customer] filter volume prediction failed", err);
    }
  }

  // Settlement history. Without it, "you credited me two leads, why?" has no
  // answer anywhere in the product — the credit lands silently in a balance
  // and the reason lives only in a webhook log.
  const { data: settlementsRaw } = await admin
    .from("filter_guarantee_settlements")
    .select("id, lead_type, period_start, period_end, guaranteed, delivered, credited")
    .eq("customer_id", customer.id)
    .order("period_start", { ascending: false })
    .limit(12);
  const settlements = (settlementsRaw ?? []) as GuaranteeSettlement[];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/customers"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to customers
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{customer.business_name}</h1>
        <p className="text-sm text-muted-foreground">
          {customer.contact_name} · {customer.email}
          {customer.phone ? ` · ${customer.phone}` : ""}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Plan: <span className="font-medium text-foreground">{customer.monthly_allocation} leads / month</span>
          {customer.website_url ? (
            <>
              {" · "}
              <a
                href={customer.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:underline"
              >
                {customer.website_url}
              </a>
            </>
          ) : null}
          {customer.properties_managed
            ? ` · Manages ${customer.properties_managed} properties`
            : ""}
        </p>
        <div className="mt-2">
          <PostCallOfferBadge offer={offer} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Manage account</CardTitle>
            </CardHeader>
            <CardContent>
              <AdminCustomerForm customer={customer} />
            </CardContent>
          </Card>

          <AdminAccessPanel
            customerId={customer.id}
            email={customer.email}
            hasLogin={customer.user_id != null}
          />

          <GrSubscriptionCard customer={customer} />

          <FilterCard customer={customer} volumeAggregate={volumeAggregate} />

          <GuaranteeSettlementsCard settlements={settlements} />
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Leads assigned ({assignments.length})</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Lead</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="pr-6 text-right">Replace</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="pl-6 font-medium">
                        <Link
                          href={`/admin/assignments/${a.id}`}
                          className="text-brand hover:underline"
                        >
                          {a.lead?.lead_name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {a.viewed_at ? (
                          <Badge variant="muted">Viewed</Badge>
                        ) : (
                          <Badge variant="brand">New</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(a.assigned_at)}
                      </TableCell>
                      <TableCell>
                        {a.email_sent ? (
                          <Badge variant="brand">Sent</Badge>
                        ) : (
                          <Badge className="border-transparent bg-red-100 text-red-700">
                            Not sent
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="pr-6 text-right align-top">
                        <SwapLeadControl
                          assignmentId={a.id}
                          leadName={a.lead?.lead_name ?? null}
                          status={a.status ?? null}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {assignments.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-10 text-center text-muted-foreground"
                      >
                        No leads assigned yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}


/**
 * Admin-only view of a customer's lead filter(s), including the internal
 * priority_score (the deficit-formula value used to rank filtered candidates).
 * Never shown to the customer.
 */
interface GuaranteeSettlement {
  id: string;
  lead_type: string;
  period_start: string;
  period_end: string;
  guaranteed: number;
  delivered: number;
  credited: number;
}

/**
 * Every settled cycle, including the ones that owed nothing.
 *
 * A settlement row is written whether or not there was a shortfall, so "we
 * checked and you were fully served" is recorded rather than merely implied by
 * absence — which is what makes this table answerable when a customer asks why
 * a month was or was not credited.
 */
function GuaranteeSettlementsCard({
  settlements,
}: {
  settlements: GuaranteeSettlement[];
}) {
  if (settlements.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Guarantee settlements</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pb-1 font-normal">Cycle</th>
              <th className="pb-1 font-normal">Product</th>
              <th className="pb-1 text-right font-normal">Owed</th>
              <th className="pb-1 text-right font-normal">Got</th>
              <th className="pb-1 text-right font-normal">Credited</th>
            </tr>
          </thead>
          <tbody>
            {settlements.map((s) => (
              <tr key={s.id} className="border-t-[0.5px] border-border">
                <td className="py-1">{formatDate(s.period_start)}</td>
                <td className="py-1 text-xs text-muted-foreground">
                  {s.lead_type === "guaranteed_rent" ? "GR" : "Mgmt"}
                </td>
                <td className="py-1 text-right tabular-nums">{s.guaranteed}</td>
                <td className="py-1 text-right tabular-nums">{s.delivered}</td>
                <td
                  className={
                    "py-1 text-right tabular-nums " +
                    (s.credited > 0 ? "font-medium text-amber-700" : "text-muted-foreground")
                  }
                >
                  {s.credited > 0 ? `+${s.credited}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function FilterCard({
  customer,
  volumeAggregate,
}: {
  customer: Customer;
  volumeAggregate: LeadVolumeAggregate | null;
}) {
  const products = activeLeadFilters(customer).map((f) => {
    const allocation =
      f.leadType === "guaranteed_rent"
        ? (customer.gr_monthly_allocation ?? 0)
        : (customer.monthly_allocation ?? 0);
    const prediction = volumeAggregate
      ? predictMonthlyVolume(volumeAggregate[f.leadType], {
          areas: f.areas,
          minBedrooms: f.minBedrooms,
          maxBedrooms: f.maxBedrooms,
        })
      : null;
    const balance =
      f.leadType === "guaranteed_rent"
        ? (customer.gr_lead_balance ?? 0)
        : (customer.lead_balance ?? 0);
    return {
      ...f,
      priority:
        f.leadType === "guaranteed_rent"
          ? computeGrPacing(customer).deficit
          : computePacing(customer).deficit,
      prediction,
      allocation,
      balance,
      below: prediction ? belowAllocation(prediction, allocation) : false,
      unspendable:
        f.guaranteedLeads != null &&
        balance > allocation + f.guaranteedLeads,
    };
  });

  if (products.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead filter</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {products.map((p) => (
          <div key={p.label} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{p.label}</span>
              <Badge variant={p.status === "active" ? "brand" : "muted"}>
                {p.status === "pending_lift" ? "Lift scheduled" : "Active"}
              </Badge>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Filter type</dt>
                <dd className="mt-0.5 font-medium">{filterKindLabel(p)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Areas</dt>
                <dd className="mt-0.5 font-medium">
                  {locationText(p.areas)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Bedrooms</dt>
                <dd className="mt-0.5 font-medium">
                  {bedroomPhrase(p.minBedrooms, p.maxBedrooms)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Priority score
                </dt>
                <dd className="mt-0.5 font-medium">{p.priority}</dd>
              </div>
              {p.prediction && (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Predicted volume
                  </dt>
                  <dd className="mt-0.5 font-medium">
                    {p.prediction.reliable ? (
                      <>
                        ~{p.prediction.displayRate} leads/month{" "}
                        <span className="font-normal text-muted-foreground">
                          ({p.prediction.matchingLeads} matches since 1 Jul)
                        </span>
                        {p.below && p.guaranteedLeads == null && (
                          <span className="block text-xs font-normal text-amber-700">
                            Below plan of {p.allocation}/month — no guarantee
                            accepted
                          </span>
                        )}
                        {/* The drift between what was AGREED and what today's
                            volumes support is the leading indicator of an
                            accruing liability, so both are shown together
                            rather than one replacing the other. */}
                        {p.guaranteedLeads != null &&
                          p.prediction.displayRate < p.guaranteedLeads && (
                            <span className="block text-xs font-normal text-amber-700">
                              Now below the {p.guaranteedLeads}/month
                              guaranteed — shortfalls will accrue
                            </span>
                          )}
                      </>
                    ) : (
                      <span className="font-normal text-muted-foreground">
                        Too little data ({p.prediction.matchingLeads} match
                        {p.prediction.matchingLeads === 1 ? "" : "es"})
                      </span>
                    )}
                  </dd>
                </div>
              )}
              {p.guaranteedLeads != null &&
                p.guaranteeCostPerLeadPence != null && (
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Accepted guarantee
                    </dt>
                    <dd className="mt-0.5 font-medium">
                      {p.guaranteedLeads} leads/month at{" "}
                      {formatPence(p.guaranteeCostPerLeadPence)} a lead
                      {p.guaranteeLikelihoodPct != null && (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          ({p.guaranteeLikelihoodPct}% likely)
                        </span>
                      )}
                      {p.guaranteeAcceptedAt && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          Accepted {formatDate(p.guaranteeAcceptedAt)}
                        </span>
                      )}
                      {p.guaranteeCredit > 0 && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {p.guaranteeCredit} lead
                          {p.guaranteeCredit === 1 ? "" : "s"} credited for
                          shortfalls
                        </span>
                      )}
                      {/* Banking credits a filter cannot spend: the customer is
                          owed leads their own selection will not produce, and
                          the balance only grows. Widening the filter or moving
                          them down a plan is the fix, not more credit. */}
                      {p.unspendable && (
                        <span className="block text-xs font-normal text-red-600">
                          Balance {p.balance} exceeds allocation +
                          guarantee — credits are accruing faster than this
                          filter can spend them
                        </span>
                      )}
                    </dd>
                  </div>
                )}
              {p.status === "pending_lift" && p.liftDate && (
                <div>
                  <dt className="text-xs text-muted-foreground">Lifts on</dt>
                  <dd className="mt-0.5 font-medium">
                    {formatDate(p.liftDate)}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Post-call discount offer state — the redeemed state is deliberately distinct. */
function PostCallOfferBadge({ offer }: { offer: PostCallOffer | null }) {
  const state = offerState(offer);
  if (state.kind === "none") {
    return (
      <Badge variant="outline" className="border-transparent bg-gray-100 text-gray-500">
        No offer generated
      </Badge>
    );
  }
  if (state.kind === "redeemed") {
    return (
      <Badge className="border-transparent bg-emerald-600 text-white">
        Discount applied — {state.plan ?? "?"}-lead plan
      </Badge>
    );
  }
  if (state.kind === "active") {
    return (
      <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800">
        Offer active — expires in {formatRemaining(state.expiresAt)}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-transparent bg-gray-100 text-gray-600">
      Offer expired — unused
    </Badge>
  );
}

function GrSubscriptionCard({ customer }: { customer: Customer }) {
  const active = customer.gr_subscription_status === "active";
  const pacing = computeGrPacing(customer);
  const pacingLabel =
    pacing.status === "behind"
      ? "Behind"
      : pacing.status === "ahead"
        ? "Ahead"
        : "On track";
  const pacingClass =
    pacing.status === "behind"
      ? "bg-amber-100 text-amber-800"
      : pacing.status === "ahead"
        ? "bg-muted text-muted-foreground"
        : "bg-brand/10 text-brand";

  return (
    <Card className={active ? undefined : "opacity-60"}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Guaranteed Rent</CardTitle>
          {active ? (
            <Badge variant="brand">Active</Badge>
          ) : (
            <Badge variant="muted">No GR subscription</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {active ? (
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">This month</dt>
              <dd className="mt-0.5 font-medium">
                {customer.gr_leads_received_this_month} /{" "}
                {customer.gr_monthly_allocation}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Lead balance</dt>
              <dd className="mt-0.5 font-medium">
                {customer.gr_lead_balance} credit
                {customer.gr_lead_balance === 1 ? "" : "s"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pacing</dt>
              <dd className="mt-0.5">
                <span
                  className={
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
                    pacingClass
                  }
                >
                  {pacingLabel}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last GR lead</dt>
              <dd className="mt-0.5 font-medium">
                {customer.gr_last_assignment_at
                  ? formatDate(customer.gr_last_assignment_at)
                  : "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            This customer has no active Guaranteed Rent subscription.
          </p>
        )}

        <div className="mt-4 border-t border-border pt-4">
          <a
            href="/company-let-tenancy-agreement.docx"
            download
            className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline"
          >
            <Download className="h-4 w-4" />
            Download company let agreement
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
