"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Customer } from "@/lib/types";

export function SettingsPanel({ customer }: { customer: Customer }) {
  const [overflow, setOverflow] = useState(customer.overflow_enabled);
  const [saving, setSaving] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  async function toggleOverflow(next: boolean) {
    setOverflow(next);
    setSaving(true);
    try {
      const res = await fetch("/api/customer/overflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overflow_enabled: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setOverflow(!next); // revert on failure
      alert("Could not update overflow setting. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function openPortal() {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error();
      }
    } catch {
      alert("Could not open the billing portal.");
      setPortalLoading(false);
    }
  }

  const isActive = customer.subscription_status === "active";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row label="Status">
            <span className="flex items-center gap-2">
              {isActive && <span className="h-2 w-2 rounded-full bg-brand" />}
              <span className="capitalize">{customer.subscription_status}</span>
            </span>
          </Row>
          <Row label="Plan">£300 / month · 20 leads included</Row>
          <Row label="Leads this month">
            {customer.leads_received_this_month} of {customer.monthly_allocation}
          </Row>
          <div className="pt-2">
            <Button
              variant="outline"
              onClick={openPortal}
              disabled={portalLoading}
            >
              {portalLoading ? "Opening…" : "Manage billing"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Overflow leads</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Enable overflow</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep receiving leads after your 20 included leads are used, at
                £20 per additional lead.
              </p>
            </div>
            <Switch
              checked={overflow}
              onCheckedChange={toggleOverflow}
              disabled={saving}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}
