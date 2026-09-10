"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { allowanceBudget } from "@/lib/quality/claimPolicy";
import type { Customer } from "@/lib/types";

/**
 * Lead-quality settings for one customer.
 *
 * Everything here is admin-only and invisible to the customer. The budget line
 * is the important one: it is what bounds how much a customer can recover by
 * reporting leads dead, and it grows on its own as they take leads without
 * claiming.
 */
export function CustomerQualityPanel({
  customer,
  claimsFiled,
  claimsUpheld,
  leadsReceived,
  cohortClaimRate,
}: {
  customer: Customer;
  claimsFiled: number;
  claimsUpheld: number;
  leadsReceived: number;
  cohortClaimRate: number;
}) {
  const router = useRouter();
  const [pct, setPct] = useState(
    String(Math.round((customer.quality_allowance_pct ?? 0.1) * 100))
  );
  const [reviewRequired, setReviewRequired] = useState(
    customer.quality_review_required
  );
  const [cities, setCities] = useState(
    (customer.replacement_filter?.cities ?? []).join(", ")
  );
  const [minBedrooms, setMinBedrooms] = useState(
    customer.replacement_filter?.min_bedrooms
      ? String(customer.replacement_filter.min_bedrooms)
      : ""
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const budget = allowanceBudget(customer);
  const claimRate = leadsReceived > 0 ? claimsFiled / leadsReceived : 0;
  const outlier = claimRate > cohortClaimRate * 2 && claimsFiled >= 3;

  async function save(next: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/customers/${customer.id}/quality`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setMessage(data?.error ?? "Could not save.");
        setBusy(false);
        return;
      }
      setMessage("Saved.");
      setBusy(false);
      router.refresh();
    } catch {
      setMessage("Could not save.");
      setBusy(false);
    }
  }

  function saveAll() {
    const pctValue = Number(pct);
    if (!Number.isFinite(pctValue) || pctValue < 0 || pctValue > 100) {
      setMessage("Allowance must be a percentage between 0 and 100.");
      return;
    }
    save({
      quality_allowance_pct: pctValue / 100,
      replacement_filter: {
        cities: cities
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
        min_bedrooms: minBedrooms ? Number(minBedrooms) : undefined,
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead quality</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Stat
            label="Claims this cycle"
            value={`${customer.quality_claims_this_cycle} of ${budget}`}
            hint="The customer never sees this number."
          />
          <Stat
            label="Clean streak"
            value={String(customer.clean_leads_streak)}
            hint="Leads taken since their last upheld claim."
          />
          <Stat
            label="Claim rate"
            value={
              leadsReceived > 0
                ? `${Math.round(claimRate * 100)}% of ${leadsReceived}`
                : "—"
            }
            hint={`Everyone else: ${Math.round(cohortClaimRate * 100)}%`}
          />
          <Stat
            label="Upheld"
            value={`${claimsUpheld} of ${claimsFiled}`}
            hint="Claims filed all time."
          />
        </dl>

        {outlier && (
          <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
            This customer reports leads dead at more than twice the rate of
            everyone else. Worth a look before it becomes a pattern — it may
            equally mean they are working a thin patch.
          </p>
        )}

        <div className="flex items-center justify-between gap-4 rounded-md border-[0.5px] border-border px-3 py-2">
          <div>
            <p className="text-sm font-medium">Send every claim to review</p>
            <p className="text-xs text-muted-foreground">
              Nothing is settled automatically for this customer.
            </p>
          </div>
          <Switch
            checked={reviewRequired}
            disabled={busy}
            onCheckedChange={(checked) => {
              setReviewRequired(checked);
              save({ quality_review_required: checked });
            }}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Allowance (% of plan)">
            <input
              type="number"
              min={0}
              max={100}
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              disabled={busy}
              className="w-full rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Replacement cities">
            <input
              type="text"
              value={cities}
              onChange={(e) => setCities(e.target.value)}
              disabled={busy}
              placeholder="Leeds, York"
              className="w-full rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Min bedrooms">
            <input
              type="number"
              min={0}
              value={minBedrooms}
              onChange={(e) => setMinBedrooms(e.target.value)}
              disabled={busy}
              className="w-full rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          The filter only narrows replacement leads. It has no effect on normal
          distribution.
        </p>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveAll}
            disabled={busy}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {message && (
            <span className="text-xs text-muted-foreground">{message}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
