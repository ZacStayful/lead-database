"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { Customer, NotificationPreferences } from "@/lib/types";
import { planForAllocation } from "@/lib/plans";

/** Missing / unset keys default to true — an opt-out is only an explicit false. */
function prefOn(
  prefs: Partial<NotificationPreferences> | null | undefined,
  key: keyof NotificationPreferences
): boolean {
  return prefs?.[key] !== false;
}

const PREFERENCE_ROWS: {
  key: keyof NotificationPreferences;
  label: string;
  description: string;
}[] = [
  {
    key: "new_lead",
    label: "New lead alerts",
    description:
      "An email and portal notification each time a new lead is assigned to you.",
  },
  {
    key: "credit_warnings",
    label: "Low/exhausted credit warnings",
    description:
      "An email when your monthly lead allocation is running low or is used up.",
  },
  {
    key: "inactivity_nudge",
    label: "Inactivity nudges",
    description: "A reminder if you have leads waiting for follow-up.",
  },
  {
    key: "progress_report",
    label: "Weekly progress report",
    description:
      "A Friday summary of the leads you've worked through this week.",
  },
];

export function SettingsPanel({ customer }: { customer: Customer }) {
  const [portalLoading, setPortalLoading] = useState(false);
  const [smsEnabled, setSmsEnabled] = useState(customer.sms_alerts_enabled);
  const [smsSaving, setSmsSaving] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPreferences>({
    new_lead: prefOn(customer.notification_preferences, "new_lead"),
    credit_warnings: prefOn(customer.notification_preferences, "credit_warnings"),
    inactivity_nudge: prefOn(customer.notification_preferences, "inactivity_nudge"),
    progress_report: prefOn(customer.notification_preferences, "progress_report"),
  });
  const [prefSaving, setPrefSaving] = useState<keyof NotificationPreferences | null>(
    null
  );
  const plan = planForAllocation(customer.monthly_allocation);

  async function togglePref(key: keyof NotificationPreferences, next: boolean) {
    const previous = prefs[key];
    setPrefs((p) => ({ ...p, [key]: next }));
    setPrefSaving(key);
    try {
      const res = await fetch("/api/customer/settings/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setPrefs((p) => ({ ...p, [key]: previous }));
      alert("Could not update your notification preference. Please try again.");
    } finally {
      setPrefSaving(null);
    }
  }

  async function toggleSms(next: boolean) {
    const previous = smsEnabled;
    setSmsEnabled(next);
    setSmsSaving(true);
    try {
      const res = await fetch("/api/customer/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sms_alerts_enabled: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setSmsEnabled(previous);
      alert("Could not update your SMS preference. Please try again.");
    } finally {
      setSmsSaving(false);
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
          <Row label="Plan">
            £{plan.priceGbp} / month · {plan.leads} leads included
          </Row>
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
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Instant SMS lead alerts</p>
              <p className="text-sm text-muted-foreground">
                Get a text the moment a new lead is assigned to you, so you can
                be first to call.
              </p>
            </div>
            <Switch
              checked={smsEnabled}
              onCheckedChange={toggleSms}
              disabled={smsSaving}
              aria-label="Instant SMS lead alerts"
            />
          </div>
          {!customer.phone && (
            <p className="mt-3 text-xs text-amber-600">
              Add a mobile number to your account to receive SMS alerts.
            </p>
          )}

          <div className="mt-6 space-y-6 border-t pt-6">
            {PREFERENCE_ROWS.map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-4"
              >
                <div>
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {row.description}
                  </p>
                </div>
                <Switch
                  checked={prefs[row.key]}
                  onCheckedChange={(next) => togglePref(row.key, next)}
                  disabled={prefSaving === row.key}
                  aria-label={row.label}
                />
              </div>
            ))}
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
