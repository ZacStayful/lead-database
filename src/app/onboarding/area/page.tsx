/**
 * The confirm-on-login screen (batch 04 Phase 3, locked decision 4).
 *
 * OUTSIDE THE DASHBOARD CHROME on purpose, like /onboarding/brief: the
 * dashboard layout is what sends the customer here, so the page must sit
 * outside /dashboard or it would redirect to itself.
 *
 * Only a customer who has confirmed a brief and has a `pending_confirmation`
 * version sees it (needsAreaConfirmation, the gate's own test). Everybody
 * else, including every customer who existed before the brief shipped, is
 * sent to their dashboard.
 */
import { redirect } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Card, CardContent } from "@/components/ui/card";
import { AreaConfirmScreen } from "@/components/leadBrief/AreaConfirmScreen";
import { getCurrentCustomer } from "@/lib/auth";
import { longDate } from "@/lib/briefPause";
import { loadAreaConfirmation, type AreaConfirmCustomer } from "@/lib/briefAreaConfirm";
import { AREA_CONFIRM_COPY } from "@/lib/leadBrief/areaConfirmCopy";
import { AREA_CONFIRM_PATH, canEditLeadBrief } from "@/lib/leadBrief/gate";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

export default async function AreaConfirmPage() {
  const { user, customer, viewAs } = await getCurrentCustomer();
  if (!user) redirect(`/login?redirectedFrom=${AREA_CONFIRM_PATH}`);
  if (!customer || !canEditLeadBrief(customer)) redirect("/dashboard");

  const load = await loadAreaConfirmation(
    createAdminClient(),
    customer as AreaConfirmCustomer,
    new Date()
  );
  // Nothing waiting (confirmed in another tab, or never), or the versions
  // cannot be read: the dashboard. The gate fails open the same way.
  if (load.kind !== "view") redirect("/dashboard");
  const view = load.view;

  // An admin viewing the customer (§62) sees that an area is waiting but
  // cannot confirm it: every write is refused in that mode anyway.
  if (viewAs) {
    return (
      <Shell>
        <Card>
          <CardContent className="space-y-2 pt-6 text-sm">
            <h1 className="text-lg font-semibold">{AREA_CONFIRM_COPY.readOnlyTitle}</h1>
            <p className="text-muted-foreground">{AREA_CONFIRM_COPY.readOnlyBody}</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <AreaConfirmScreen
        pendingId={view.pendingId}
        isReturn={view.isReturn}
        beforeReturn={view.beforeReturn}
        firstName={view.firstName}
        basePostcode={view.basePostcode}
        otherAreas={view.otherAreas}
        newMiles={view.newMiles}
        oldMiles={view.oldMiles}
        tighterMiles={view.tighterMiles}
        canSwitch={view.canSwitch}
        centre={view.centre}
        returnLabel={view.returnYmd ? longDate(view.returnYmd) : null}
        extend={view.extend}
      />
    </Shell>
  );
}
