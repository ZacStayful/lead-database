/**
 * The Lead Brief questionnaire (Phase 3).
 *
 * OUTSIDE THE DASHBOARD CHROME on purpose, like src/app/oauth/authorize: the
 * customer is doing one thing, and the dashboard layout is what sends them
 * here, so the page must sit outside /dashboard or it would redirect to
 * itself.
 *
 * Only a customer who still needs a brief sees the questions
 * (`needsLeadBrief`). Everybody else, including every customer who existed
 * before the brief shipped, is sent to their dashboard.
 */
import { redirect } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Card, CardContent } from "@/components/ui/card";
import { BriefWizard } from "@/components/leadBrief/BriefWizard";
import { getCurrentCustomer } from "@/lib/auth";
import { needsLeadBrief } from "@/lib/leadBrief/gate";
import { BRIEF_COPY } from "@/lib/leadBrief/briefCopy";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-page px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div className="flex justify-center">
          <Logo />
        </div>
        {children}
      </div>
    </div>
  );
}

export default async function LeadBriefPage() {
  const { user, customer, viewAs } = await getCurrentCustomer();
  if (!user) redirect("/login?redirectedFrom=/onboarding/brief");
  if (!customer || !needsLeadBrief(customer)) redirect("/dashboard");

  // An admin viewing the customer (§62) sees that the brief is outstanding but
  // cannot fill it in: every write is refused in that mode anyway.
  if (viewAs) {
    return (
      <Shell>
        <Card>
          <CardContent className="space-y-2 pt-6 text-sm">
            <h1 className="text-lg font-semibold">{BRIEF_COPY.readOnlyTitle}</h1>
            <p className="text-muted-foreground">{BRIEF_COPY.readOnlyBody}</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const renewalIso = nextGrantDate({
    billing_cycle_anchor: customer.billing_cycle_anchor,
    created_at: customer.created_at,
  });

  return (
    <Shell>
      <BriefWizard
        renewalIso={renewalIso}
        switchPending={
          customer.pending_monthly_allocation === 10 && (customer.monthly_allocation ?? 0) > 10
        }
      />
    </Shell>
  );
}
