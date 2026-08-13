"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One product's subscriber capacity: usage, the bar, and the editable cap.
 *
 * Rendered once per product on the admin overview. The two instances are
 * independent — separate settings keys, separate populations — so nothing is
 * shared between them beyond this component.
 */
export function CapacityPanel({
  product = "management",
  title = "Subscriber capacity",
  weightedUsed,
  rawActiveCount,
  activeLabel = "active customer",
  initialLimit,
  derivedCeiling,
  slotsPerMonth,
  demandPerMonth,
  waitlistedCount,
}: {
  /** Which cap this panel edits. Selects the system_settings key server-side. */
  product?: "management" | "guaranteed_rent";
  /** Heading above the figure. */
  title?: string;
  /** Weighted slots consumed by active customers (20-lead = 1, 10-lead = 0.5). */
  weightedUsed: number;
  /** Unweighted count of active customers, shown for context. */
  rawActiveCount: number;
  /** Singular noun for the count line; pluralised with a trailing "s". */
  activeLabel?: string;
  initialLimit: number;
  /**
   * Customers this product's actual lead supply can carry, derived from leads
   * ingested over the last 28 days and the caps those leads carry
   * (get_service_capacity). Undefined when it could not be read.
   */
  derivedCeiling?: number;
  /** Sustainable slots a month, and what is promised — for the shortfall line. */
  slotsPerMonth?: number;
  demandPerMonth?: number;
  /**
   * Waitlisted accounts, shown only when provided. The waitlist is a management
   * concept (`account_status`), so the GR panel omits it rather than showing a
   * zero that would read as "nobody is waiting for Guaranteed Rent".
   */
  waitlistedCount?: number;
}) {
  const [limit, setLimit] = useState(initialLimit);
  const [input, setInput] = useState(String(initialLimit));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The denominator is what the lead supply can actually serve, not a number
  // somebody typed. A typed cap cannot know that volume moved last week or that
  // escalation has opened extra slots, and it goes stale silently while still
  // being trusted. The manual setting stays as a hard ceiling below.
  const ceiling = derivedCeiling ?? limit;
  const pct = ceiling > 0 ? Math.min(100, Math.round((weightedUsed / ceiling) * 100)) : 0;
  const full = weightedUsed >= ceiling;

  // Which problem does this product have? They need opposite responses: too few
  // customers for the leads means sell more, too few leads for the customers
  // means buy more leads. Reporting only "slots used" leaves both invisible.
  const shortfall =
    slotsPerMonth != null && demandPerMonth != null
      ? Math.round(demandPerMonth - slotsPerMonth)
      : null;
  // Unique per panel — two capacity panels render on the same page, and a
  // duplicated id would point both labels at the management input.
  const inputId = `capacity-limit-${product}`;

  async function save() {
    const capacity = parseInt(input, 10);
    if (!Number.isFinite(capacity) || capacity < 1) {
      setMessage("Enter a whole number of at least 1.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings/capacity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacity, product }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not update capacity");
      setLimit(data.capacity ?? capacity);
      setMessage("Hard cap updated");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not update capacity");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-1 text-2xl font-semibold">
            {weightedUsed} / {ceiling}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              slots used
            </span>
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {rawActiveCount} {activeLabel}
            {rawActiveCount === 1 ? "" : "s"}
            {derivedCeiling != null && (
              <> · ceiling derived from the last 28 days of lead volume</>
            )}
          </p>
        </div>

        {shortfall != null && (
          <p className="text-sm">
            {shortfall > 0 ? (
              <span className="text-red-700">
                <strong>Under-delivering by about {shortfall} leads a month.</strong>{" "}
                More is promised than arrives, so this is a lead-supply problem,
                not a sales one — the gap is being covered from unsold stock
                until that runs out.
              </span>
            ) : (
              <span className="text-muted-foreground">
                <strong className="text-foreground">
                  About {Math.abs(shortfall)} leads a month spare.
                </strong>{" "}
                Room to sell to more customers before supply becomes the limit.
              </span>
            )}
          </p>
        )}

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: full ? "#b91c1c" : "#5D8156" }}
          />
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label
              htmlFor={inputId}
              className="block text-xs text-muted-foreground"
            >
              Capacity limit
            </label>
            <Input
              id={inputId}
              type="number"
              min={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="w-24"
            />
          </div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {message && (
            <span className="pb-2 text-sm text-muted-foreground">{message}</span>
          )}
        </div>

        {waitlistedCount !== undefined && (
          <p className="text-sm text-muted-foreground">
            Waitlisted accounts:{" "}
            <span className="font-medium text-foreground">{waitlistedCount}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
