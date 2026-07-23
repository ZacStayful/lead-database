import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LeadFeed } from "@/components/dashboard/LeadFeed";
import { ConversionFunnel } from "@/components/dashboard/ConversionFunnel";
import { ExportButton } from "@/components/dashboard/ExportButton";
import { CompanyLetAgreement } from "@/components/dashboard/CompanyLetAgreement";
import { formatDate } from "@/lib/utils";
import { cityForArea } from "@/lib/postcode";
import { computePacing, pacingMessage } from "@/lib/pacing";
import type { AssignmentWithLead, Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");

  if (!customer) {
    return (
      <div className="mx-auto max-w-lg text-center">
        <Card>
          <CardContent className="pt-8">
            <h1 className="text-lg font-semibold">Finishing setup…</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We couldn’t find your customer record yet. If you’ve just paid,
              give it a moment and refresh. Otherwise complete your subscription
              to start receiving leads.
            </p>
            <Button className="mt-6" asChild>
              <Link href="/signup">Complete subscription</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const admin = createAdminClient();
  const { data: assignmentsRaw } = await admin
    .from("lead_assignments")
    .select("*, lead:leads(*)")
    .eq("customer_id", customer.id)
    .order("assigned_at", { ascending: false });

  const assignments = (assignmentsRaw ?? []) as AssignmentWithLead[];
  const unreadLeads = assignments.filter((a) => !a.viewed_at).length;

  const isActive = customer.subscription_status === "active";
  const hasGuaranteedRent = customer.gr_subscription_status === "active";
  const renewalDate = nextRenewalDate(customer.billing_cycle_anchor);
  const pacing = computePacing(customer);
  const exhausted = customer.lead_balance === 0;
  const carriedForward = customer.lead_balance - customer.monthly_allocation;
  const filterActive =
    customer.filter_status === "active" ||
    customer.filter_status === "pending_lift";

  // Split what the customer has received by product so management and
  // guaranteed rent are kept clearly separate. Every delivered lead counts
  // (including rejected ones — rejection no longer refunds or replaces).
  const grReceived = assignments.filter(
    (a) => a.lead?.lead_type === "guaranteed_rent"
  ).length;
  const managementReceived = assignments.length - grReceived;

  // Conversion funnel: of the leads delivered, how many were worked and how many
  // were signed. 'won' is the terminal conversion signal set from the lead
  // detail page; 'contacted' counts any lead advanced past 'new'.
  const contactedCount = assignments.filter((a) =>
    ["contacted", "in_discussion", "won"].includes(a.status)
  ).length;
  const signedCount = assignments.filter((a) => a.status === "won").length;

  // Median speed-to-lead (delivery → first contact), in minutes. Null until at
  // least one lead has a first_contacted_at stamp.
  const responseMins = assignments
    .filter((a) => a.first_contacted_at)
    .map(
      (a) =>
        (new Date(a.first_contacted_at as string).getTime() -
          new Date(a.assigned_at).getTime()) /
        60000
    )
    .filter((m) => m >= 0)
    .sort((x, y) => x - y);
  const medianResponseMinutes =
    responseMins.length === 0
      ? null
      : responseMins.length % 2 === 1
        ? responseMins[(responseMins.length - 1) / 2]
        : (responseMins[responseMins.length / 2 - 1] +
            responseMins[responseMins.length / 2]) /
          2;

  // Which products this customer actually holds (active sub or leads received).
  const hasManagement = isActive || managementReceived > 0;
  const hasGr = hasGuaranteedRent || grReceived > 0;
  const showProductSplit = hasGr;
  const anySubActive = isActive || hasGuaranteedRent;

  const stats: {
    label: string;
    value: string;
    accent?: boolean;
    valueClass?: string;
    secondary?: string;
  }[] = [
    {
      label: "Subscription",
      value: anySubActive ? "Active" : titleCase(customer.subscription_status),
      accent: anySubActive,
    },
    // Single-product customers keep the simple remaining card; dual-product
    // customers see the per-product split card below instead.
    ...(showProductSplit
      ? []
      : [
          {
            label: "Leads remaining",
            value: String(customer.lead_balance),
            valueClass: exhausted ? "text-amber-600" : undefined,
            secondary:
              carriedForward > 0
                ? `includes ${carriedForward} carried forward`
                : undefined,
          },
        ]),
    {
      label: "Unread new leads",
      value: String(unreadLeads),
    },
    {
      label: "Next renewal",
      value: renewalDate,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            Welcome back, {customer.contact_name.split(" ")[0]}
          </h1>
          <p className="text-sm text-muted-foreground">{customer.business_name}</p>
        </div>
        <ExportButton />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{s.label}</p>
              <div className="mt-1 flex items-center gap-2">
                {s.accent && (
                  <span className="h-2 w-2 rounded-full bg-brand" />
                )}
                <span
                  className={"text-2xl font-semibold " + (s.valueClass ?? "")}
                >
                  {s.value}
                </span>
              </div>
              {s.secondary && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.secondary}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {showProductSplit && (
        <LeadsByProduct
          showManagement={hasManagement}
          showGr={hasGr}
          managementReceived={managementReceived}
          managementRemaining={customer.lead_balance}
          grReceived={grReceived}
          grRemaining={customer.gr_lead_balance}
        />
      )}

      {/* Management pacing/credit message — only for customers who hold the
          management product (GR uses the per-product card above). A customer
          with an active or pending-lift filter sees the filter message instead
          of the standard pacing sentence. */}
      {hasManagement &&
        (filterActive ? (
          <p className="text-sm font-medium text-brand">
            {filterMessage(customer)}
          </p>
        ) : exhausted ? (
          <p className="text-sm font-medium text-amber-600">
            You have no remaining {showProductSplit ? "management " : ""}lead
            credit. Your balance will update when your next payment is processed
            on {renewalDate}.
          </p>
        ) : (
          <p
            className={
              "text-sm font-medium " +
              (pacing.status === "behind"
                ? "text-amber-600"
                : pacing.status === "ahead"
                  ? "text-muted-foreground"
                  : "text-brand")
            }
          >
            {pacingMessage(pacing.deficit, customer.monthly_allocation)}
          </p>
        ))}

      {hasGuaranteedRent && <CompanyLetAgreement compact />}

      <ConversionFunnel
        received={assignments.length}
        contacted={contactedCount}
        signed={signedCount}
        medianResponseMinutes={medianResponseMinutes}
      />

      <div>
        <h2 className="mb-3 text-lg font-semibold">Your leads</h2>
        <LeadFeed customerId={customer.id} assignments={assignments} />
      </div>
    </div>
  );
}

function LeadsByProduct({
  showManagement,
  showGr,
  managementReceived,
  managementRemaining,
  grReceived,
  grRemaining,
}: {
  showManagement: boolean;
  showGr: boolean;
  managementReceived: number;
  managementRemaining: number;
  grReceived: number;
  grRemaining: number;
}) {
  const rows = [
    showManagement && {
      label: "Management",
      badge: "bg-[#EAF3DE] text-[#3B6D11]",
      received: managementReceived,
      remaining: managementRemaining,
    },
    showGr && {
      label: "Guaranteed Rent",
      badge: "bg-blue-50 text-blue-700",
      received: grReceived,
      remaining: grRemaining,
    },
  ].filter(Boolean) as {
    label: string;
    badge: string;
    received: number;
    remaining: number;
  }[];

  return (
    <Card>
      <CardContent className="pt-6">
        <p className="mb-3 text-sm font-medium">Leads by product</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pb-2 text-left font-medium">Product</th>
                <th className="pb-2 text-right font-medium">Leads received</th>
                <th className="pb-2 text-right font-medium">Leads remaining</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-border">
                  <td className="py-2.5">
                    <span
                      className={
                        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium " +
                        r.badge
                      }
                    >
                      {r.label}
                    </span>
                  </td>
                  <td className="py-2.5 text-right text-base font-semibold">
                    {r.received}
                  </td>
                  <td
                    className={
                      "py-2.5 text-right text-base font-semibold " +
                      (r.remaining === 0 ? "text-amber-600" : "")
                    }
                  >
                    {r.remaining}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Received is the total leads assigned to you. Remaining is the lead
          credit still owed to you for each product.
        </p>
      </CardContent>
    </Card>
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Dashboard sentence shown to a customer with an active/pending-lift filter. */
function filterMessage(customer: Customer): string {
  const areas =
    customer.filter_areas && customer.filter_areas.length > 0
      ? customer.filter_areas.map((a) => cityForArea(a) || a).join(", ")
      : "any location";
  const beds = bedroomPhrase(
    customer.filter_min_bedrooms,
    customer.filter_max_bedrooms
  );
  let msg = `Your filter is active — you'll receive leads matching ${areas} and ${beds} as they become available. Volume varies based on how many matching leads come through the marketplace each month.`;
  if (
    customer.filter_status === "pending_lift" &&
    customer.filter_lift_effective_date
  ) {
    msg += ` Your filter is scheduled to lift on ${formatDate(
      customer.filter_lift_effective_date
    )}.`;
  }
  return msg;
}

function bedroomPhrase(min: number | null, max: number | null): string {
  if (min == null && max == null) return "any bedroom size";
  if (min != null && max != null) {
    return min === max
      ? `exactly ${min} bedroom${min === 1 ? "" : "s"}`
      : `${min}–${max} bedrooms`;
  }
  if (min != null) return `${min}+ bedrooms`;
  return `up to ${max} bedrooms`;
}

function nextRenewalDate(anchor: string | null): string {
  // The anchor is re-set to the current period start on every invoice.paid,
  // so the next renewal is one month after it. Fall back to the 1st of next
  // month for accounts with no Stripe billing anchor yet.
  if (anchor) {
    const a = new Date(anchor);
    if (!isNaN(a.getTime())) {
      const next = new Date(a);
      next.setMonth(next.getMonth() + 1);
      return formatDate(next.toISOString());
    }
  }
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return formatDate(next.toISOString());
}
