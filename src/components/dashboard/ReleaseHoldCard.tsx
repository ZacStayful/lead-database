"use client";

/**
 * "Hold my leads until…" (§54).
 *
 * A hold is the thing that stops a week's leads dying in an inbox nobody is
 * reading. It is deliberately NOT a pause: billing continues, credits are
 * kept, nothing is voided at Stripe — delivery simply waits until the date
 * named and catches up at the daily cap afterwards. The copy says so in
 * words, because a customer who reads "hold" as "pause" and then sees an
 * invoice has a complaint we would deserve.
 *
 * Per product (invariant 6). The ceiling is enforced by the route; the
 * `max` on the input is a courtesy.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RELEASE_HOLD } from "@/lib/releaseCopy";
import type { Customer, LeadType } from "@/lib/types";

function ProductHold({
  leadType,
  label,
  current,
}: {
  leadType: LeadType;
  label: string | null;
  current: string | null;
}) {
  const router = useRouter();
  const [date, setDate] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(holdUntil: string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/customer/settings/release-hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_type: leadType, hold_until: holdUntil }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error ?? "Could not save that.");
        return;
      }
      setMessage(holdUntil ? `Held until ${holdUntil}.` : "Hold cleared — leads resume from the next release.");
      if (!holdUntil) setDate("");
      router.refresh();
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const id = `hold-${leadType}`;
  return (
    <div className="space-y-2">
      {label && <p className="text-sm font-medium">{label}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor={id}>Leads start again on</Label>
          <Input
            id={id}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-44"
          />
        </div>
        <Button onClick={() => submit(date || null)} disabled={busy || !date}>
          {busy ? "Saving…" : current ? "Change hold" : "Hold my leads"}
        </Button>
        {current && (
          <Button variant="outline" onClick={() => submit(null)} disabled={busy}>
            Clear hold
          </Button>
        )}
      </div>
      {current && !message && (
        <p className="text-xs text-muted-foreground">
          Currently held until {current}. Nothing is delivered before then.
        </p>
      )}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}

export function ReleaseHoldCard({ customer }: { customer: Customer }) {
  const mgmt = customer.subscription_status === "active";
  const gr = customer.gr_subscription_status === "active";
  const both = mgmt && gr;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Away for a few days?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{RELEASE_HOLD}</p>
        {mgmt && (
          <ProductHold
            leadType="management"
            label={both ? "Management leads" : null}
            current={customer.release_hold_until}
          />
        )}
        {gr && (
          <ProductHold
            leadType="guaranteed_rent"
            label={both ? "Guaranteed Rent leads" : null}
            current={customer.gr_release_hold_until}
          />
        )}
        <p className="text-xs text-muted-foreground">
          This is not a pause — your subscription, billing and credits carry on
          exactly as they are. For longer than a couple of weeks, pause instead.
        </p>
      </CardContent>
    </Card>
  );
}
