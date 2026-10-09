/**
 * "Your brief" (Lead Brief Phase 5): the customer's current brief, a pending
 * area change if one is saved, and the two editors.
 *
 *   - Priorities (ranking, and the levels of non-essential priorities) apply
 *     to the next leads.
 *   - The area (Q1–Q3, similar areas) starts at the next renewal, the date
 *     every renewal message prints (`nextGrantDate`).
 *
 * Only a customer who has confirmed a brief and holds Management
 * (`canEditLeadBrief`); everyone else is sent to their leads, and the routes
 * refuse them too. An admin viewing as the customer (§62) sees it read-only.
 *
 * ⚠️ THE OUTCODE LISTS NEVER REACH THE BROWSER (A4). The page reads the
 * version rows on the server and hands the client components only what they
 * render: answers, the radius, and the priorities.
 */
import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent } from "@/components/ui/card";
import { BriefAreaEditor } from "@/components/leadBrief/BriefAreaEditor";
import { BriefPendingChange } from "@/components/leadBrief/BriefPendingChange";
import { BriefPrioritiesEditor } from "@/components/leadBrief/BriefPrioritiesEditor";
import { briefPlanFor, canEditLeadBrief } from "@/lib/leadBrief/gate";
import {
  BriefVersionsUnavailableError,
  loadBriefVersions,
  type BriefVersionRow,
  type BriefVersions,
} from "@/lib/leadBrief/briefVersions";
import { planAndTravelOf, readStoredPriorities } from "@/lib/leadBrief/editBrief";
import {
  EDIT_COPY,
  currentAreaLine,
  levelLabel,
  pendingAreaLine,
  type AreaLineArgs,
} from "@/lib/leadBrief/editCopy";
import type { EssentialKey } from "@/lib/leadBrief/types";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";

export const dynamic = "force-dynamic";

function areaArgs(row: BriefVersionRow): AreaLineArgs {
  return {
    radiusMiles: row.service_radius_miles,
    basePostcode: row.base_postcode,
    otherAreas: (row.priority_outcodes ?? []).length,
    minBedrooms: row.min_bedrooms,
    minGross: row.min_gross,
  };
}

export default async function LeadBriefEditorPage() {
  const { user, customer, viewAs } = await getCurrentCustomer();
  if (!user) redirect("/login?redirectedFrom=/dashboard/leads/brief");
  if (!customer || !canEditLeadBrief(customer)) redirect("/dashboard/leads");

  let versions: BriefVersions | null = null;
  try {
    versions = await loadBriefVersions(createAdminClient(), customer.id);
  } catch (err) {
    if (!(err instanceof BriefVersionsUnavailableError)) throw err;
    console.error("[dashboard/leads/brief] versions unavailable", err.message);
  }

  const header = (
    <div className="space-y-1">
      <h1 className="text-2xl font-bold">{EDIT_COPY.pageTitle}</h1>
      <p className="text-sm text-muted-foreground">{EDIT_COPY.pageIntro}</p>
    </div>
  );

  const active = versions?.active ?? null;
  if (!versions || !active) {
    return (
      <div className="space-y-6">
        {header}
        <p className="text-sm text-alert">{EDIT_COPY.errors.unavailable}</p>
      </div>
    );
  }

  const readOnly = Boolean(viewAs);
  const scheduled = versions.scheduled;
  const startsOnIso = nextGrantDate({
    billing_cycle_anchor: customer.billing_cycle_anchor,
    gr_billing_cycle_anchor: customer.gr_billing_cycle_anchor,
    created_at: customer.created_at,
  });
  // The renewal cron skips a change sized for a plan the customer no longer
  // has; the screen asks them to review it instead (B1).
  const planChanged = scheduled !== null && briefPlanFor(customer) !== scheduled.allocation;

  const priorities = readStoredPriorities(active.priorities);
  const essentials = (active.essentials ?? []) as EssentialKey[];
  const { plan, travel } = planAndTravelOf(active);

  // The area editor starts from the change already in flight, if there is one,
  // so editing it again updates that change rather than starting over.
  const source = scheduled ?? active;
  const essentialLabels = essentials.flatMap((k) => {
    const value = k === "bedrooms" ? active.min_bedrooms : active.min_gross;
    return value === null ? [] : [levelLabel(k, value)];
  });

  return (
    <div className="space-y-6">
      {header}
      {readOnly && (
        <p className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">{EDIT_COPY.readOnly}</p>
      )}

      <Card>
        <CardContent className="space-y-2 pt-6 text-sm">
          <h2 className="text-base font-semibold text-ink">{EDIT_COPY.currentTitle}</h2>
          <p className="text-ink">{currentAreaLine(areaArgs(active))}</p>
          <p className="text-ink-2">
            {essentialLabels.length > 0
              ? `${EDIT_COPY.essentialsTitle}: ${essentialLabels.join(", ")}`
              : EDIT_COPY.essentialsNone}
          </p>
        </CardContent>
      </Card>

      {scheduled && (
        <BriefPendingChange
          areaLine={pendingAreaLine(areaArgs(scheduled))}
          startsOnIso={startsOnIso}
          planChanged={planChanged}
          readOnly={readOnly}
        />
      )}

      <BriefPrioritiesEditor
        activeId={active.id}
        priorities={priorities}
        essentials={essentials}
        plan={plan}
        travel={travel}
        readOnly={readOnly}
      />

      <BriefAreaEditor
        activeId={active.id}
        initial={{
          basePostcode: source.base_postcode,
          priorityOutcodes: [...(source.priority_outcodes ?? [])],
          travel: planAndTravelOf(source).travel,
          minBedrooms: source.min_bedrooms,
          minGross: source.min_gross,
          similarAreas: [...(source.similar_areas ?? [])],
        }}
        startsOnIso={startsOnIso}
        readOnly={readOnly}
      />
    </div>
  );
}
