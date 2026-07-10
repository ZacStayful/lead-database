"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Customer } from "@/lib/types";
import { planForAllocation } from "@/lib/plans";

export function SettingsPanel({ customer }: { customer: Customer }) {
  const [portalLoading, setPortalLoading] = useState(false);
  const plan = planForAllocation(customer.monthly_allocation);

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
  const hasGr = customer.gr_subscription_status === "active";
  // A customer subscribed to Guaranteed Rent only: the management columns are
  // empty/zero for them, so read from the GR columns instead of showing "0 of 0".
  const grOnly = hasGr && !isActive;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row label="Status">
            <span className="flex items-center gap-2">
              {(isActive || hasGr) && (
                <span className="h-2 w-2 rounded-full bg-brand" />
              )}
              <span className="capitalize">
                {isActive || hasGr ? "active" : customer.subscription_status}
              </span>
            </span>
          </Row>
          <Row label="Plan">
            {grOnly
              ? `Guaranteed Rent · ${customer.gr_monthly_allocation} leads included`
              : `£${plan.priceGbp} / month · ${plan.leads} leads included`}
          </Row>
          {!grOnly && (
            <Row label="Leads this month">
              {customer.leads_received_this_month} of {customer.monthly_allocation}
            </Row>
          )}
          {hasGr && (
            <Row label={isActive ? "GR leads this month" : "Leads this month"}>
              {customer.gr_leads_received_this_month} of{" "}
              {customer.gr_monthly_allocation}
            </Row>
          )}
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
