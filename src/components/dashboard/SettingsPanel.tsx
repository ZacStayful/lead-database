"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { Customer, LeadType, NotificationPreferences } from "@/lib/types";
import { planForAllocation } from "@/lib/plans";
import { PRODUCT_COPY, holdsProduct } from "@/lib/products";
import { PlanChangeCard } from "@/components/dashboard/PlanChangeCard";
import {
  CancelSubscriptionCard,
  type CancelProductState,
} from "@/components/dashboard/CancelSubscriptionCard";
import {
  PAUSE_MONTHS_OPTIONS,
  PAUSE_NOTE_MAX_LENGTH,
  PAUSE_REASONS,
  pauseMonthsLabel,
  type PauseMonths,
  type PauseReason,
} from "@/lib/pauseOptions";

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
  {
    key: "monthly_insights",
    label: "Monthly lead summary",
    description:
      "Once a month: how your leads are going, alongside what the operators signing clients do. Your figures stay private.",
  },
  {
    key: "announcements",
    label: "Announcements",
    description:
      "Occasional news and service notices from Stayful. Turning this off stops the email only — announcements still appear on your dashboard.",
  },
];

/** Format an ISO timestamp as e.g. "23 October 2026". */
function formatLongDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function SettingsPanel({ customer }: { customer: Customer }) {
  const [portalLoading, setPortalLoading] = useState(false);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [pausedAt, setPausedAt] = useState<string | null>(customer.paused_at);
  const [pauseResumesAt, setPauseResumesAt] = useState<string | null>(
    customer.pause_resumes_at
  );
  const [showPauseForm, setShowPauseForm] = useState(false);
  // Defaults to 3, which is what every pause was before the choice existed.
  const [selectedMonths, setSelectedMonths] = useState<PauseMonths>(3);
  const [selectedReasons, setSelectedReasons] = useState<Set<PauseReason>>(
    new Set()
  );
  const [pauseNote, setPauseNote] = useState("");
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [smsEnabled, setSmsEnabled] = useState(customer.sms_alerts_enabled);
  const [smsSaving, setSmsSaving] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPreferences>({
    new_lead: prefOn(customer.notification_preferences, "new_lead"),
    credit_warnings: prefOn(customer.notification_preferences, "credit_warnings"),
    inactivity_nudge: prefOn(customer.notification_preferences, "inactivity_nudge"),
    progress_report: prefOn(customer.notification_preferences, "progress_report"),
    monthly_insights: prefOn(customer.notification_preferences, "monthly_insights"),
    announcements: prefOn(customer.notification_preferences, "announcements"),
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

  function toggleReason(value: PauseReason) {
    setPauseError(null);
    setSelectedReasons((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function pauseSubscription() {
    if (selectedReasons.size === 0) {
      setPauseError("Please tell us why you are pausing.");
      return;
    }
    if (selectedReasons.has("other") && pauseNote.trim().length === 0) {
      setPauseError("Please tell us a little more.");
      return;
    }
    setPauseError(null);
    setPauseLoading(true);
    try {
      const res = await fetch("/api/customer/subscription/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          months: selectedMonths,
          reasons: Array.from(selectedReasons),
          note: pauseNote.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not pause.");
      setPausedAt(data.paused_at);
      setPauseResumesAt(data.pause_resumes_at);
      setShowPauseForm(false);
    } catch (err) {
      setPauseError(
        err instanceof Error
          ? err.message
          : "Could not pause your subscription. Please try again."
      );
    } finally {
      setPauseLoading(false);
    }
  }

  const isActive = customer.subscription_status === "active";
  // Pausing is a management-only action, offered only to an active management
  // subscriber (account + subscription both active).
  const managementActive =
    customer.account_status === "active" &&
    customer.subscription_status === "active";
  const isPaused = Boolean(pausedAt);

  // One cancel section per held product. Deliberately NOT gated on
  // managementActive or the pause state — a paused customer deciding not to
  // return is the most important person this flow serves, and a GR-only
  // customer (who cannot even open the billing portal without a
  // stripe_customer_id) has no other route out.
  const cancelProducts: CancelProductState[] = (
    ["management", "guaranteed_rent"] as LeadType[]
  )
    .filter((leadType) => holdsProduct(customer, leadType))
    .map((leadType) => ({
      leadType,
      name: PRODUCT_COPY[leadType].name,
      pending:
        leadType === "guaranteed_rent"
          ? customer.gr_cancel_at_period_end
          : customer.cancel_at_period_end,
      effectiveAt:
        leadType === "guaranteed_rent"
          ? customer.gr_cancel_effective_at
          : customer.cancel_effective_at,
      hasSubscription: Boolean(
        leadType === "guaranteed_rent"
          ? customer.gr_stripe_subscription_id
          : customer.stripe_subscription_id
      ),
      // The pause-instead interstitial: management only (GR has no pause
      // product), and only when a pause is actually available right now.
      offerPauseFirst:
        leadType === "management" && managementActive && !isPaused,
    }));

  function pauseInstead() {
    setShowPauseForm(true);
    // The pause card sits above the cancel card; bring it into view once the
    // form has rendered.
    setTimeout(() => {
      document
        .getElementById("pause-subscription-card")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  // Mirrors the route's date maths exactly (new Date(now).setMonth(+months)),
  // including its roll-over on short months, so the date shown here is the date
  // the server will actually store rather than an optimistic approximation.
  const resumeDatePreview = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + selectedMonths);
    return d;
  })();

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

          {/* One tier switcher per product actually held. The rows above are
              management-only, so a GR-only subscriber saw nothing about their
              own plan on this page at all before this. */}
          {(["management", "guaranteed_rent"] as LeadType[])
            .filter((leadType) => holdsProduct(customer, leadType))
            .map((leadType) => (
              <div key={leadType}>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {PRODUCT_COPY[leadType].name}
                </p>
                <PlanChangeCard
                  leadType={leadType}
                  currentAllocation={
                    leadType === "guaranteed_rent"
                      ? customer.gr_monthly_allocation
                      : customer.monthly_allocation
                  }
                  pendingAllocation={
                    leadType === "guaranteed_rent"
                      ? customer.gr_pending_monthly_allocation
                      : customer.pending_monthly_allocation
                  }
                  pendingEffectiveAt={
                    leadType === "guaranteed_rent"
                      ? customer.gr_pending_plan_change_at
                      : customer.pending_plan_change_at
                  }
                  hasSubscription={Boolean(
                    leadType === "guaranteed_rent"
                      ? customer.gr_stripe_subscription_id
                      : customer.stripe_subscription_id
                  )}
                  blockedReason={
                    leadType === "management" && pausedAt
                      ? "Your subscription is paused. Resume it below to change plan."
                      : null
                  }
                />
              </div>
            ))}
        </CardContent>
      </Card>

      {managementActive && (
        <Card id="pause-subscription-card">
          <CardHeader>
            <CardTitle>Pause subscription</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isPaused ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Your subscription is paused. You are not being billed and are
                  not receiving new leads. Your current lead balance is preserved.
                </p>
                {pauseResumesAt && (
                  <p className="text-sm">
                    Resumes automatically on{" "}
                    <span className="font-medium">
                      {formatLongDate(pauseResumesAt)}
                    </span>
                    , when billing restarts.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Decided not to return? You can cancel below at any time — then
                  billing never restarts.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Need a break? You can pause your subscription instead of
                  cancelling. During the pause you are not billed and you do not
                  receive new leads, but any lead credits you have left are kept
                  and will be waiting when you return. Your subscription resumes
                  automatically at the end of the pause — or sooner if you decide
                  to start paying again.
                </p>

                {!showPauseForm ? (
                  <div className="pt-2">
                    <Button
                      variant="outline"
                      onClick={() => setShowPauseForm(true)}
                    >
                      Pause subscription
                    </Button>
                    <p className="mt-2 text-xs text-muted-foreground">
                      To cancel entirely, see Cancel subscription below.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-5 rounded-lg border p-4">
                    <div>
                      <p className="text-sm font-medium">How long for?</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {PAUSE_MONTHS_OPTIONS.map((m) => (
                          <button
                            key={m}
                            type="button"
                            aria-pressed={selectedMonths === m}
                            onClick={() => setSelectedMonths(m)}
                            className={`rounded-md border px-3 py-1.5 text-sm transition ${
                              selectedMonths === m
                                ? "border-transparent bg-brand text-brand-foreground"
                                : "hover:bg-muted"
                            }`}
                          >
                            {pauseMonthsLabel(m)}
                          </button>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Billing and leads restart on{" "}
                        <span className="font-medium">
                          {formatLongDate(resumeDatePreview.toISOString())}
                        </span>
                        .
                      </p>
                    </div>

                    <div>
                      <p className="text-sm font-medium">
                        Why are you pausing?{" "}
                        <span className="font-normal text-muted-foreground">
                          (required — pick as many as apply)
                        </span>
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(
                          Object.entries(PAUSE_REASONS) as [PauseReason, string][]
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={selectedReasons.has(value)}
                            onClick={() => toggleReason(value)}
                            className={`rounded-md border px-3 py-1.5 text-sm transition ${
                              selectedReasons.has(value)
                                ? "border-transparent bg-brand text-brand-foreground"
                                : "hover:bg-muted"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="pause-note"
                        className="text-sm font-medium"
                      >
                        {selectedReasons.has("other")
                          ? "Please tell us more (required)"
                          : "Anything else you'd like us to know? (optional)"}
                      </label>
                      <textarea
                        id="pause-note"
                        value={pauseNote}
                        onChange={(e) => {
                          setPauseNote(e.target.value);
                          setPauseError(null);
                        }}
                        maxLength={PAUSE_NOTE_MAX_LENGTH}
                        rows={3}
                        className="mt-2 w-full rounded-md border bg-background p-2 text-sm"
                        placeholder="This goes straight to us and helps us improve the service."
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {pauseNote.length} / {PAUSE_NOTE_MAX_LENGTH}
                      </p>
                    </div>

                    {pauseError && (
                      <p className="text-sm text-red-600">{pauseError}</p>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <Button onClick={pauseSubscription} disabled={pauseLoading}>
                        {pauseLoading
                          ? "Pausing…"
                          : `Pause for ${pauseMonthsLabel(selectedMonths)}`}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setShowPauseForm(false);
                          setPauseError(null);
                        }}
                        disabled={pauseLoading}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <CancelSubscriptionCard
        products={cancelProducts}
        onPauseInstead={pauseInstead}
      />

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
