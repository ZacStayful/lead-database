import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LeadFeed } from "@/components/dashboard/LeadFeed";
import { ExportButton } from "@/components/dashboard/ExportButton";
import { formatDate } from "@/lib/utils";
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
  const renewalDate = nextRenewalDate();

  const stats = [
    {
      label: "Subscription",
      value: isActive ? "Active" : titleCase(customer.subscription_status),
      accent: isActive,
    },
    {
      label: "Leads this month",
      value: `${customer.leads_received_this_month} of ${customer.monthly_allocation}`,
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
                <span className="text-2xl font-semibold">{s.value}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

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

function nextRenewalDate(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return formatDate(next.toISOString());
}
