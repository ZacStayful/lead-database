"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { LeadSourceMap } from "@/components/dashboard/LeadSourceMap";
import type { FilterStatus, LeadType } from "@/lib/types";

export interface AreaOption {
  area: string;
  label: string;
}

export interface FilterPanelProps {
  product: LeadType;
  productLabel: string;
  status: FilterStatus;
  areas: string[];
  minBedrooms: number | null;
  maxBedrooms: number | null;
  liftEffectiveDate: string | null;
  availableAreas: AreaOption[];
  // Lead volume per postcode area (national), for the map + list hints.
  areaCounts?: Record<string, number>;
  maxAreaCount?: number;
}

const CONSENT =
  "Applying a filter means we can't guarantee lead volume — you may receive fewer leads some months. Your monthly subscription amount stays the same regardless.";

const MINI_GUIDE =
  "Applying or editing your filter takes effect immediately — you'll only be matched to leads in your chosen locations and bedroom range. Lifting your filter does not take effect immediately. You'll keep receiving only leads matching your current filter until your next billing cycle starts. From that date, you'll return to the standard guaranteed lead allocation.";

export function LeadFilteringPanel(props: FilterPanelProps) {
  const router = useRouter();
  const { product, productLabel, availableAreas } = props;
  const areaCounts = props.areaCounts ?? {};
  const maxAreaCount = props.maxAreaCount ?? 0;
  const selectableAreas = useMemo(
    () => availableAreas.map((a) => a.area),
    [availableAreas]
  );

  const [editing, setEditing] = useState(props.status === "off");
  const [selectedAreas, setSelectedAreas] = useState<string[]>(props.areas);
  const [minBeds, setMinBeds] = useState<string>(
    props.minBedrooms != null ? String(props.minBedrooms) : ""
  );
  const [maxBeds, setMaxBeds] = useState<string>(
    props.maxBedrooms != null ? String(props.maxBedrooms) : ""
  );
  const [areaQuery, setAreaQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleAreas = useMemo(() => {
    const q = areaQuery.trim().toLowerCase();
    if (!q) return availableAreas;
    return availableAreas.filter(
      (a) =>
        a.area.toLowerCase().includes(q) || a.label.toLowerCase().includes(q)
    );
  }, [availableAreas, areaQuery]);

  function toggleArea(area: string) {
    setSelectedAreas((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]
    );
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, ...body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    const ok = await post({
      action: "apply",
      areas: selectedAreas,
      min_bedrooms: minBeds === "" ? null : parseInt(minBeds, 10),
      max_bedrooms: maxBeds === "" ? null : parseInt(maxBeds, 10),
    });
    if (ok) setEditing(false);
  }

  async function lift() {
    if (
      !window.confirm(
        "This returns you to the standard guaranteed lead allocation. Continue?"
      )
    ) {
      return;
    }
    await post({ action: "lift" });
  }

  async function cancelLift() {
    await post({ action: "cancel_lift" });
  }

  const bedroomSummary = summariseBedrooms(props.minBedrooms, props.maxBedrooms);
  const areaSummary =
    props.areas.length > 0
      ? props.areas
          .map((a) => labelFor(a, availableAreas))
          .join(", ")
      : "Any location";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{productLabel} lead filtering</CardTitle>
          <StatusBadge status={props.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {props.status === "off" && !editing && null}

        {/* Read-only summary for active / pending-lift states. */}
        {props.status !== "off" && !editing && (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Areas</dt>
                <dd className="mt-0.5 text-sm font-medium">{areaSummary}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Bedrooms</dt>
                <dd className="mt-0.5 text-sm font-medium">{bedroomSummary}</dd>
              </div>
            </dl>

            {props.status === "pending_lift" && props.liftEffectiveDate && (
              <div className="rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Your filter will lift on{" "}
                <span className="font-semibold">
                  {formatDate(props.liftEffectiveDate)}
                </span>
                . Until then you'll keep receiving only leads matching this
                filter.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {props.status === "active" && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setEditing(true)}
                    disabled={busy}
                  >
                    Edit filter
                  </Button>
                  <Button variant="outline" onClick={lift} disabled={busy}>
                    Lift filter completely
                  </Button>
                </>
              )}
              {props.status === "pending_lift" && (
                <Button
                  variant="outline"
                  onClick={cancelLift}
                  disabled={busy}
                >
                  Cancel pending lift
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Editable form: off state, or editing an active filter. */}
        {editing && (
          <div className="space-y-5">
            {props.status === "off" && (
              <p className="text-sm text-muted-foreground">
                Lead filtering lets you receive only leads in the locations and
                bedroom sizes you choose. It's useful if you focus on particular
                cities or property sizes — you trade the volume guarantee for
                relevance. Leave a control open to accept anything for that
                dimension.
              </p>
            )}

            <div>
              <label className="text-sm font-medium">Areas</label>
              <p className="text-xs text-muted-foreground">
                Choose the postcode areas you want leads from. Leave all
                unchecked to accept any location.
              </p>
              {availableAreas.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No postcode areas are available yet.
                </p>
              ) : (
                <>
                  {maxAreaCount > 0 && (
                    <div className="mt-2">
                      <LeadSourceMap
                        counts={areaCounts}
                        maxCount={maxAreaCount}
                        selectable={selectableAreas}
                        selected={selectedAreas}
                        onToggle={toggleArea}
                      />
                    </div>
                  )}
                  <Input
                    className="mt-2"
                    placeholder="Search areas…"
                    value={areaQuery}
                    onChange={(e) => setAreaQuery(e.target.value)}
                  />
                  <div className="mt-2 grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-md border-[0.5px] border-border p-2 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleAreas.map((a) => {
                      const checked = selectedAreas.includes(a.area);
                      return (
                        <label
                          key={a.area}
                          className={
                            "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm " +
                            (checked ? "bg-brand/10" : "hover:bg-accent")
                          }
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleArea(a.area)}
                            className="h-4 w-4 shrink-0"
                          />
                          <span className="truncate">{a.label}</span>
                          {areaCounts[a.area] != null && (
                            <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
                              {areaCounts[a.area]}
                            </span>
                          )}
                        </label>
                      );
                    })}
                    {visibleAreas.length === 0 && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">
                        No areas match “{areaQuery}”.
                      </p>
                    )}
                  </div>
                  {selectedAreas.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {selectedAreas.map((a) => (
                        <span
                          key={a}
                          className="inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand"
                        >
                          {labelFor(a, availableAreas)}
                          <button
                            type="button"
                            onClick={() => toggleArea(a)}
                            aria-label={`Remove ${a}`}
                            className="text-brand/70 hover:text-brand"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div>
              <label className="text-sm font-medium">Bedroom range</label>
              <p className="text-xs text-muted-foreground">
                Leave both blank to accept any bedroom size. Setting the minimum
                and maximum to the same number requests an exact bedroom count.
              </p>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex-1">
                  <label
                    htmlFor={`${product}-min`}
                    className="block text-xs text-muted-foreground"
                  >
                    Minimum bedrooms
                  </label>
                  <Input
                    id={`${product}-min`}
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={minBeds}
                    onChange={(e) => setMinBeds(e.target.value)}
                    placeholder="Any"
                  />
                </div>
                <div className="flex-1">
                  <label
                    htmlFor={`${product}-max`}
                    className="block text-xs text-muted-foreground"
                  >
                    Maximum bedrooms
                  </label>
                  <Input
                    id={`${product}-max`}
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={maxBeds}
                    onChange={(e) => setMaxBeds(e.target.value)}
                    placeholder="Any"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Requesting bedroom sizes beyond 5 will reduce the accuracy of
                    comparable data, as properties of this size are rarer to come
                    across.
                  </p>
                </div>
              </div>
            </div>

            <p className="rounded-md border-[0.5px] border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              {CONSENT}
            </p>

            {error && <p className="text-sm text-amber-600">{error}</p>}

            <div className="flex flex-wrap gap-2">
              <Button onClick={apply} disabled={busy}>
                {busy
                  ? "Saving…"
                  : props.status === "off"
                    ? "Apply filter"
                    : "Save changes"}
              </Button>
              {props.status !== "off" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setSelectedAreas(props.areas);
                    setMinBeds(
                      props.minBedrooms != null ? String(props.minBedrooms) : ""
                    );
                    setMaxBeds(
                      props.maxBedrooms != null ? String(props.maxBedrooms) : ""
                    );
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}

        {error && !editing && <p className="text-sm text-amber-600">{error}</p>}

        <div className="rounded-md bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {MINI_GUIDE}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: FilterStatus }) {
  if (status === "active") return <Badge variant="brand">Filter active</Badge>;
  if (status === "pending_lift")
    return <Badge variant="muted">Lift scheduled</Badge>;
  return <Badge variant="muted">No filter</Badge>;
}

function summariseBedrooms(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Any bedroom size";
  if (min != null && max != null) {
    return min === max
      ? `Exactly ${min} bedroom${min === 1 ? "" : "s"}`
      : `${min}–${max} bedrooms`;
  }
  if (min != null) return `${min}+ bedrooms`;
  return `Up to ${max} bedrooms`;
}

function labelFor(area: string, options: AreaOption[]): string {
  return options.find((o) => o.area === area)?.label ?? area;
}
