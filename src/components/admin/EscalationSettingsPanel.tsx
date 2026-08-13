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
 * Three things, in descending order of how often they will be touched: the
 * kill switch, the lead-age gate, and the two score thresholds.
 *
 * The thresholds are shown but framed as provisional, because they are: they
 * were set from sixteen days of telemetry against three recorded outcomes, and
 * the point of the 60-day review is to replace them with numbers fitted to what
 * actually converts.
 */
export function EscalationSettingsPanel({
  enabled: initialEnabled,
  maxLeadAgeDays: initialAge,
  thresholdDay10: initialT10,
  thresholdDay20: initialT20,
}: {
  enabled: boolean;
  /** Empty string means deliberately not configured — not zero. */
  maxLeadAgeDays: string;
  thresholdDay10: number;
  thresholdDay20: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [age, setAge] = useState(initialAge);
  const [t10, setT10] = useState(String(initialT10));
  const [t20, setT20] = useState(String(initialT20));
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
            A lead nobody has touched for 10 days goes to one more operator, and
            again at 20. Full price, standard routing, and the first operator
            keeps everything.
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

        {/* Thresholds */}
        <div className="rounded-lg border-[0.5px] border-border p-4">
          <p className="text-sm font-medium">Inactivity thresholds</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A lead escalates when its engagement score over the previous 10 days
            falls below these. Opening a lead scores 0.30, so at 0.30 an open
            keeps it past day 10 but not past day 20.{" "}
            <span className="text-amber-800">
              Provisional — set from 16 days of data and due for review against
              real outcomes.
            </span>
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground">Day 10</span>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={t10}
                disabled={busy}
                onChange={(e) => setT10(e.target.value)}
                className="mt-1 w-28"
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground">Day 20</span>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={t20}
                disabled={busy}
                onChange={(e) => setT20(e.target.value)}
                className="mt-1 w-28"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void save({
                  escalation_score_threshold_day_10: Number(t10),
                  escalation_score_threshold_day_20: Number(t20),
                })
              }
            >
              Save thresholds
            </Button>
          </div>
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
