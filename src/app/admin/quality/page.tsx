/**
 * /admin/quality — dead-lead claims, and where the dead leads come from
 * (CLAUDE.md §51).
 *
 * Two halves, and the second is the reason the feature exists. Crediting a
 * customer back for a lead that was already gone keeps them; finding out WHICH
 * leads keep turning out to be gone is what stops it happening again. A queue
 * with no analysis beside it turns §51 into a refund desk.
 *
 * ⚠️ The breakdowns are by POSTCODE AREA, not by town. §40.14 measured
 * `extractCity()` at 173 of 446 addresses and wrong on the commonest shape —
 * "212 Gill Avenue, Bristol BS16 2PH" returns the street. `postcode_area` is
 * parsed, indexed and used by the router itself, so it is the one geography
 * this database can be trusted on.
 */
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { QualityClaimActions } from "@/components/admin/QualityClaimActions";
import { formatDate } from "@/lib/utils";
import {
  DEAD_LEAD_REASON_LABELS,
  claimBudget,
  type ClaimCustomer,
  type DeadLeadReason,
} from "@/lib/quality/deadLeadPolicy";
import { FIT_REASONS, type FitReason } from "@/lib/outcomeReasons";
import { CLOSE_REASONS, type CloseReason } from "@/lib/closeReasons";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 300;

/**
 * What the queue needs to know about the operator who made a claim.
 *
 * ⚠️ It extends `ClaimCustomer` rather than restating the allowance columns, so
 * the budget shown here is computed by `claimBudget()` — the same function the
 * claim route decides with. Restating the arithmetic would let the page explain
 * a decision it had worked out differently.
 */
type QueueCustomer = ClaimCustomer & {
  id: string;
  business_name: string;
  contact_name: string;
  email: string;
};

/**
 * Where this operator stands against their hidden budget.
 *
 * ⚠️ Admin-only, and it must stay that way (§51.3). The whole mechanism rests
 * on the number being discovered rather than announced: an operator told they
 * have two a month has been handed the number of leads it is safe to write off
 * without evidence.
 */
function budgetLine(customer: QueueCustomer | undefined): string | null {
  if (!customer) return null;
  const budget = claimBudget(customer);
  const used = Math.max(0, Math.trunc(customer.quality_claims_this_cycle ?? 0));
  return `${used} of ${budget} used this cycle`;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border-[0.5px] border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

type ClaimRow = {
  id: string;
  lead_id: string;
  customer_id: string;
  lead_assignment_id: string;
  reason: string;
  detail: string;
  contacted_on: string | null;
  status: string;
  resolution: string;
  corroboration: string;
  allowance_consumed: boolean;
  review_note: string | null;
  created_at: string;
};

/**
 * One label lookup across all four vocabularies. They cannot collide — 0138's
 * CHECK keeps the fit list and the landlord lists disjoint, and
 * `outcomeReasons.test.ts` asserts it — so a flat lookup is safe where a
 * per-outcome one would be noise.
 */
function reasonLabel(reason: string): string {
  return (
    DEAD_LEAD_REASON_LABELS[reason as DeadLeadReason] ??
    FIT_REASONS[reason as FitReason] ??
    CLOSE_REASONS[reason as CloseReason] ??
    reason.replace(/_/g, " ")
  );
}

function outcomeLabel(outcome: string): string {
  return (
    {
      reject: "Rejected",
      discard: "Discarded",
      close: "Didn't work out",
      report: "Reported as gone",
    }[outcome] ?? outcome
  );
}

function Tally({
  title,
  rows,
  label,
}: {
  title: string;
  rows: [string, number][];
  label?: (key: string) => string;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map(([key, n]) => (
            <li key={key} className="flex justify-between gap-2">
              <span>{label ? label(key) : key}</span>
              <span className="text-muted-foreground">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${Math.round((n / d) * 1000) / 10}%`;
}

export default async function AdminQualityPage() {
  const admin = createAdminClient();

  const { data: claimData } = await admin
    .from("lead_quality_claims")
    .select(
      "id, lead_id, customer_id, lead_assignment_id, reason, detail, contacted_on, " +
        "status, resolution, corroboration, allowance_consumed, review_note, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);

  const claims = (claimData ?? []) as unknown as ClaimRow[];
  const pending = claims.filter((c) => c.status === "under_review");

  const customerIds = Array.from(new Set(claims.map((c) => c.customer_id)));
  const leadIds = Array.from(new Set(claims.map((c) => c.lead_id)));

  const { data: customerData } = customerIds.length
    ? await admin
        .from("customers")
        .select(
          "id, business_name, contact_name, email, quality_claims_this_cycle, " +
            "clean_leads_streak, quality_review_required, account_status, " +
            "subscription_status, gr_subscription_status, monthly_allocation, " +
            "gr_monthly_allocation, quality_allowance_pct",
        )
        .in("id", customerIds)
    : { data: [] };

  const customers = new Map(
    (
      (customerData ?? []) as unknown as (QueueCustomer[])
    ).map((c) => [c.id, c]),
  );

  const { data: leadData } = leadIds.length
    ? await admin
        .from("leads")
        .select(
          "id, lead_name, address, postcode_area, bedrooms, lead_type, created_at, quality_flag",
        )
        .in("id", leadIds)
    : { data: [] };

  const leads = new Map(
    (
      (leadData ?? []) as unknown as {
        id: string;
        lead_name: string;
        address: string | null;
        postcode_area: string | null;
        bedrooms: string | null;
        lead_type: string;
        created_at: string;
        quality_flag: string | null;
      }[]
    ).map((l) => [l.id, l]),
  );

  // Peers, for the pending queue only. The single most useful thing on the
  // screen: one co-assigned operator with the lead live is the strongest
  // evidence against a claim, and one whose own claim was upheld is the
  // strongest evidence for it.
  const pendingLeadIds = Array.from(new Set(pending.map((c) => c.lead_id)));
  const { data: peerData } = pendingLeadIds.length
    ? await admin
        .from("lead_assignments")
        .select("id, lead_id, customer_id, status, pipeline_stage, assigned_at")
        .in("lead_id", pendingLeadIds)
    : { data: [] };

  const peersByLead = new Map<
    string,
    {
      id: string;
      customer_id: string;
      status: string;
      pipeline_stage: string;
    }[]
  >();
  for (const p of (peerData ?? []) as unknown as {
    id: string;
    lead_id: string;
    customer_id: string;
    status: string;
    pipeline_stage: string;
  }[]) {
    const list = peersByLead.get(p.lead_id) ?? [];
    list.push(p);
    peersByLead.set(p.lead_id, list);
  }

  const assignedAt = new Map(
    ((peerData ?? []) as unknown as { id: string; assigned_at: string }[]).map(
      (p) => [p.id, p.assigned_at],
    ),
  );

  // ── The analysis half ────────────────────────────────────────────────────
  const upheld = claims.filter(
    (c) => c.status === "auto_upheld" || c.status === "upheld",
  );

  const byArea = new Map<string, number>();
  const byBedrooms = new Map<string, number>();
  for (const c of upheld) {
    const lead = leads.get(c.lead_id);
    const area = lead?.postcode_area ?? "unknown";
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
    const beds = lead?.bedrooms?.trim() || "unstated";
    byBedrooms.set(beds, (byBedrooms.get(beds) ?? 0) + 1);
  }
  const topAreas = Array.from(byArea.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const topBedrooms = Array.from(byBedrooms.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const byReason = new Map<string, number>();
  for (const c of upheld) {
    byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
  }

  const { count: totalAssignments } = await admin
    .from("lead_assignments")
    .select("id", { count: "exact", head: true });

  // ── Why leads end at all (0138) ──────────────────────────────────────────
  //
  // The reports above are the half that costs money. This is the half that
  // says which sources produce leads nobody can do anything with: before 0138
  // reject recorded no reason at all, discard recorded none, and close recorded
  // one of two coarse options.
  //
  // ⚠️ Read straight from lead_outcome_reasons rather than joined back to
  // leads. A discarded assignment is gone and a customer-added lead can be
  // deleted outright (§30.7), so the area and bedroom count are denormalised on
  // the row — joining would silently drop exactly the rows worth counting.
  const { data: outcomeData } = await admin
    .from("lead_outcome_reasons")
    .select("outcome, reason, postcode_area, bedrooms, created_at")
    .order("created_at", { ascending: false })
    .limit(2000);

  const outcomeRows = (outcomeData ?? []) as {
    outcome: string;
    reason: string;
    postcode_area: string | null;
    bedrooms: string | null;
  }[];

  const tally = (get: (r: (typeof outcomeRows)[number]) => string) => {
    const m = new Map<string, number>();
    for (const r of outcomeRows) m.set(get(r), (m.get(get(r)) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };

  const outcomeCounts = tally((r) => r.outcome);
  const outcomeReasons = tally((r) => r.reason).slice(0, 8);
  const outcomeAreas = tally((r) => r.postcode_area ?? "unknown").slice(0, 8);
  const outcomeBedrooms = tally((r) => r.bedrooms?.trim() || "unstated").slice(
    0,
    6,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Lead quality</h1>
        <p className="text-sm text-muted-foreground">
          Leads an operator says were already gone when they got there, and
          where they came from.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Awaiting a decision" value={String(pending.length)} />
        <Stat
          label="Upheld"
          value={String(upheld.length)}
          hint={`of ${claims.length} reported`}
        />
        <Stat
          label="Share of all leads sold"
          value={pct(upheld.length, totalAssignments ?? 0)}
          hint={`${totalAssignments ?? 0} assignments`}
        />
        <Stat
          label="Reported by"
          value={String(customerIds.length)}
          hint="operators"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Awaiting a decision</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pending.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing waiting. Claims inside what we uphold automatically never
              reach this queue.
            </p>
          )}
          {pending.map((c) => {
            const lead = leads.get(c.lead_id);
            const customer = customers.get(c.customer_id);
            const peers = (peersByLead.get(c.lead_id) ?? []).filter(
              (p) => p.customer_id !== c.customer_id,
            );
            const live = peers.filter(
              (p) =>
                p.status === "in_discussion" ||
                p.status === "won" ||
                (p.pipeline_stage && p.pipeline_stage !== "cold"),
            );
            const assigned = assignedAt.get(c.lead_assignment_id) ?? null;
            const ageDays =
              lead && assigned
                ? Math.round(
                    (new Date(assigned).getTime() -
                      new Date(lead.created_at).getTime()) /
                      86_400_000,
                  )
                : null;

            return (
              <div
                key={c.id}
                className="rounded-md border-[0.5px] border-border p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {lead?.lead_name ?? "Lead"}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      {lead?.postcode_area ?? "—"} ·{" "}
                      {lead?.bedrooms ?? "beds unstated"}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(c.created_at)}
                  </p>
                </div>

                <p className="mt-1 text-sm text-muted-foreground">
                  <Link
                    href={`/admin/customers/${c.customer_id}`}
                    className="underline"
                  >
                    {customer?.business_name ?? "Operator"}
                  </Link>{" "}
                  · {reasonLabel(c.reason)}
                  {c.contacted_on
                    ? ` · spoke to them ${formatDate(c.contacted_on)}`
                    : ""}
                  {customer?.quality_review_required
                    ? " · flagged for review"
                    : ""}
                  {budgetLine(customer) ? ` · ${budgetLine(customer)}` : ""}
                </p>

                <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-sm">
                  {c.detail}
                </blockquote>

                <p className="mt-2 text-sm text-muted-foreground">
                  {peers.length === 0
                    ? "No other operator holds this lead."
                    : `${peers.length} other operator${peers.length === 1 ? "" : "s"} hold it, ${live.length} still working it.`}
                  {c.corroboration === "peer_contradicts" &&
                    " Contradicted — that is why it is here."}
                  {c.corroboration === "peer_agrees" &&
                    " Another operator agrees."}
                  {ageDays != null &&
                    ` Lead was ${ageDays} day${ageDays === 1 ? "" : "s"} old when it was sold.`}
                </p>

                <QualityClaimActions claimId={c.id} />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By postcode area</CardTitle>
          </CardHeader>
          <CardContent>
            {topAreas.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing upheld yet.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {topAreas.map(([area, n]) => (
                  <li key={area} className="flex justify-between">
                    <span>{area}</span>
                    <span className="text-muted-foreground">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By bedrooms</CardTitle>
          </CardHeader>
          <CardContent>
            {topBedrooms.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing upheld yet.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {topBedrooms.map(([beds, n]) => (
                  <li key={beds} className="flex justify-between">
                    <span>{beds}</span>
                    <span className="text-muted-foreground">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">What the landlord said</CardTitle>
          </CardHeader>
          <CardContent>
            {byReason.size === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing upheld yet.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {Array.from(byReason.entries())
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, n]) => (
                    <li key={reason} className="flex justify-between gap-2">
                      <span>{reasonLabel(reason)}</span>
                      <span className="text-muted-foreground">{n}</span>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Why leads end</CardTitle>
          <p className="text-sm text-muted-foreground">
            Every recorded outcome, not only the ones that cost a credit. A lead
            rejected for being in the wrong county says as much about where the
            leads come from as one the landlord had already left.
          </p>
        </CardHeader>
        <CardContent>
          {outcomeRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded yet. Reasons start arriving as operators use the
              outcome panel on a lead.
            </p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-4">
              <Tally title="Ending" rows={outcomeCounts} label={outcomeLabel} />
              <Tally title="Reason" rows={outcomeReasons} label={reasonLabel} />
              <Tally title="Postcode area" rows={outcomeAreas} />
              <Tally title="Bedrooms" rows={outcomeBedrooms} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Everything reported</CardTitle>
        </CardHeader>
        <CardContent>
          {claims.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been reported yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Reported</th>
                    <th className="py-2 pr-3">Operator</th>
                    <th className="py-2 pr-3">Lead</th>
                    <th className="py-2 pr-3">Reason</th>
                    <th className="py-2 pr-3">Outcome</th>
                    <th className="py-2 pr-3">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => (
                    <tr key={c.id} className="border-t-[0.5px] border-border">
                      <td className="py-2 pr-3">{formatDate(c.created_at)}</td>
                      <td className="py-2 pr-3">
                        {customers.get(c.customer_id)?.business_name ?? "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {leads.get(c.lead_id)?.lead_name ?? "—"}
                      </td>
                      <td className="py-2 pr-3">{reasonLabel(c.reason)}</td>
                      <td className="py-2 pr-3">
                        {c.status.replace(/_/g, " ")}
                      </td>
                      <td className="py-2 pr-3">
                        {c.resolution === "credit" ? "refunded" : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
