import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LeadFeed } from "@/components/dashboard/LeadFeed";
import { ExportButton } from "@/components/dashboard/ExportButton";
import { CompanyLetAgreement } from "@/components/dashboard/CompanyLetAgreement";
import { formatDate } from "@/lib/utils";
import { computePacing, pacingMessage } from "@/lib/pacing";
import type { AssignmentWithLead } from "@/lib/types";

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

  const stats: {
    label: string;
    value: string;
    accent?: boolean;
    valueClass?: string;
    secondary?: string;
  }[] = [
    {
      label: "Subscription",
      value: isActive ? "Active" : titleCase(customer.subscription_status),
      accent: isActive,
    },
    {
      label: "Leads remaining",
      value: String(customer.lead_balance),
      valueClass: exhausted ? "text-amber-600" : undefined,
      secondary:
        carriedForward > 0
          ? `includes ${carriedForward} carried forward`
          : undefined,
    },
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

      {exhausted ? (
        <p className="text-sm font-medium text-amber-600">
          You have no remaining lead credit. Your balance will update when your
          next payment is processed on {renewalDate}.
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
          {pacingMessage(pacing.deficit)}
        </p>
      )}

      {hasGuaranteedRent && <CompanyLetAgreement compact />}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Your leads</h2>
        <LeadFeed customerId={customer.id} assignments={assignments} />
      </div>
    </div>
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
