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
 *
 * A funnel payer (batch 02 Phase 5, C1) lands here from their sign-in email
 * and is shown a CONFIRMATION: the wizard opens on the preview they paid
 * against, worked out again. The answers are read from their paid funnel
 * session, never from the browser. An unreadable session is no prefill, and
 * the questions start empty as for any brief customer.
 */
import { redirect } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Card, CardContent } from "@/components/ui/card";
import { BriefWizard } from "@/components/leadBrief/BriefWizard";
import { getCurrentCustomer } from "@/lib/auth";
import { briefPlanFor, needsLeadBrief } from "@/lib/leadBrief/gate";
import { createAdminClient } from "@/lib/supabase/admin";
import { funnelConfirmationInitial, type BriefConfirmationInitial } from "@/lib/funnel/confirmation";
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

/** The answers from this customer's paid funnel session, if they came that way. */
async function funnelInitial(customer: Parameters<typeof briefPlanFor>[0] & { id: string }): Promise<BriefConfirmationInitial | null> {
  const { data, error } = await createAdminClient()
    .from("funnel_sessions")
    .select("answers, preview_snapshot")
    .eq("customer_id", customer.id)
    .eq("step", "paid")
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[onboarding/brief] funnel session read failed, opening the questions", error.message);
    return null;
  }
  if (!data) return null;
  const row = data as { answers: unknown; preview_snapshot: unknown };
  return funnelConfirmationInitial(row.answers, row.preview_snapshot, briefPlanFor(customer));
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

  const initial = await funnelInitial(customer);

  return (
    <Shell>
      <BriefWizard
        initial={initial}
        renewalIso={renewalIso}
        switchPending={
          customer.pending_monthly_allocation === 10 && (customer.monthly_allocation ?? 0) > 10
        }
      />
    </Shell>
  );
}
