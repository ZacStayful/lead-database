"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/**
 * Admin controls for the escalation ladder.
 *
 * Two things: the kill switch and the lead-age gate.
 *
 * The score thresholds are gone (0089). Escalation no longer scores anything —
 * it asks whether the lead was opened — so there is no longer a tunable number
 * standing between a lead and its one extra operator. That is the point: the
 * old thresholds were provisional guesses against a score whose heaviest
 * signals barely occurred, and a control that invites tuning implies a
 * precision the underlying measurement never had.
 */
export function EscalationSettingsPanel({
  enabled: initialEnabled,
  maxLeadAgeDays: initialAge,
}: {
  enabled: boolean;
  /** Empty string means deliberately not configured — not zero. */
  maxLeadAgeDays: string;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [age, setAge] = useState(initialAge);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(payload: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings/escalation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      setMessage("Saved.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div>
          <h2 className="text-base font-medium">Lead escalation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A lead <strong>nobody has opened</strong> within 10 days goes to one
            more operator — once, to a maximum of 4. Full price, standard
            routing, and the operators already holding it keep everything.
          </p>
        </div>

        {/* Kill switch */}
        <div className="flex items-center justify-between gap-4 rounded-lg border-[0.5px] border-border p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {enabled ? "Running daily" : "Paused"}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {enabled
                ? "The daily job escalates eligible leads."
                : "The job runs and stops immediately, logging that it was skipped."}
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(next: boolean) => {
              setEnabled(next);
              void save({ escalation_enabled: next });
            }}
          />
        </div>

        {/* Freshness gate */}
        <div className="rounded-lg border-[0.5px] border-border p-4">
          <p className="text-sm font-medium">Maximum lead age</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Leads older than this are never escalated.{" "}
            {age === "" ? (
              <span className="text-amber-800">
                Not yet configured — no age limit is being applied, so a lead of
                any age can escalate.
              </span>
            ) : (
              "Leave empty to apply no limit."
            )}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={age}
              placeholder="Not set"
              disabled={busy}
              onChange={(e) => setAge(e.target.value)}
              className="w-32"
            />
            <span className="text-sm text-muted-foreground">days</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void save({ escalation_max_lead_age_days: age })}
            >
              Save
            </Button>
          </div>
        </div>

        {/* The rule, stated rather than configured. */}
        <div className="rounded-lg border-[0.5px] border-border p-4">
          <p className="text-sm font-medium">What counts as engaged</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Opening the lead — anyone holding it opening the detail page within
            10 days keeps it. Expanding the card in the feed does not count: it
            no longer shows the landlord&rsquo;s phone or email, so it proves
            nothing. There is nothing to tune here by design; the rule is a
            single yes-or-no fact rather than a score.
          </p>
        </div>

        {message && (
          <p className="text-sm text-muted-foreground" role="status">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
