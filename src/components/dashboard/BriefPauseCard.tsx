"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BRIEF_PAUSE_COPY,
  briefPauseWindow,
  daysBetweenYmd,
  holdsArea,
  londonToday,
  longDate,
  restartLine,
} from "@/lib/briefPause";
import {
  PAUSE_NOTE_MAX_LENGTH,
  PAUSE_REASONS,
  type PauseReason,
} from "@/lib/pauseOptions";
import { KEEP_CRM_SUMMARY } from "@/lib/retentionCopy";
import { AREA_CONFIRM_PATH } from "@/lib/leadBrief/areaConfirmCopy";

/**
 * The pause card for a Lead Brief customer (batch 04 Phase 2). Replaces the
 * 1/2/3-month card for them only: SettingsPanel renders one or the other, so
 * every other customer sees exactly the card they always did.
 *
 * Three choices, in the batch's words (BRIEF_PAUSE_COPY): pause for 4 weeks,
 * choose a longer pause (a return date, up to 3 months), or switch to 10 leads
 * a month. Every one is armed, then confirmed: a single click never pauses
 * anybody or changes their plan. The server decides the dates and whether the
 * area is kept; this only shows what it will decide (briefPause.ts, shared).
 *
 * A reason is still required, as on every pause (0084): it is how we learn
 * why people pause.
 */

type Armed = null | "four" | "longer" | "switch";

export interface BriefPauseCardProps {
  pausedAt: string | null;
  pauseResumesAt: string | null;
  holdsAreaNow: boolean | null;
  /** On the 20-lead plan with no change to 10 pending: the switch is offered. */
  canSwitchTo10: boolean;
  /** A change to 10 leads a month is pending (§24). */
  switchPending: boolean;
  cancelPending: boolean;
  /** The cancel flow's "Pause instead" opens the card. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaused: (state: { pausedAt: string; resumesAt: string; holdArea: boolean }) => void;
  onResumed: () => void;
}

export function BriefPauseCard(props: BriefPauseCardProps) {
  const pauseWindow = useMemo(() => briefPauseWindow(new Date()), []);
  const [armed, setArmed] = useState<Armed>(props.open ? "four" : null);
  const [returnDate, setReturnDate] = useState<string>(pauseWindow.fourWeeks);
  const [reasons, setReasons] = useState<Set<PauseReason>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switched, setSwitched] = useState(props.switchPending);
  const [resumeArmed, setResumeArmed] = useState(false);

  // "Pause instead" in the cancel flow arms the 4-week pause.
  useEffect(() => {
    if (props.open) setArmed((current) => current ?? "four");
  }, [props.open]);

  const chosenDate = armed === "four" ? pauseWindow.fourWeeks : returnDate;
  const chosenDays = useMemo(() => {
    try {
      return daysBetweenYmd(pauseWindow.today, chosenDate);
    } catch {
      return null;
    }
  }, [pauseWindow.today, chosenDate]);

  function close() {
    setArmed(null);
    setError(null);
    props.onOpenChange(false);
  }

  function toggleReason(value: PauseReason) {
    setError(null);
    setReasons((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function pause() {
    if (reasons.size === 0) {
      setError("Please tell us why you are pausing.");
      return;
    }
    if (reasons.has("other") && note.trim().length === 0) {
      setError("Please tell us a little more.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/subscription/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnDate: chosenDate,
          reasons: Array.from(reasons),
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not pause.");
      props.onPaused({
        pausedAt: data.paused_at,
        resumesAt: data.pause_resumes_at,
        holdArea: data.pause_holds_area === true,
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pause. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function switchTo10() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/subscription/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: "management", plan: "lead_10" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not change your plan.");
      setSwitched(true);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change your plan. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/subscription/resume", { method: "POST" });
      const data = await res.json();
      // Batch 04 Phase 3: their recalculated area is waiting. Take them to it
      // to confirm, which is what restarts the leads.
      if (res.status === 409 && data?.code === "area_review_required") {
        window.location.assign(AREA_CONFIRM_PATH);
        return;
      }
      if (!res.ok) throw new Error(data?.error || "Could not restart your leads.");
      setResumeArmed(false);
      props.onResumed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restart your leads. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const reasonPicker = (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">
          Why are you pausing?{" "}
          <span className="font-normal text-muted-foreground">
            (required — pick as many as apply)
          </span>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.entries(PAUSE_REASONS) as [PauseReason, string][]).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={reasons.has(value)}
              onClick={() => toggleReason(value)}
              className={`rounded-md border px-3 py-1.5 text-sm transition ${
                reasons.has(value)
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
        <label htmlFor="brief-pause-note" className="text-sm font-medium">
          {reasons.has("other")
            ? "Please tell us more (required)"
            : "Anything else you'd like us to know? (optional)"}
        </label>
        <textarea
          id="brief-pause-note"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setError(null);
          }}
          maxLength={PAUSE_NOTE_MAX_LENGTH}
          rows={3}
          className="mt-2 w-full rounded-md border bg-background p-2 text-sm"
        />
      </div>
    </div>
  );

  if (props.pausedAt) {
    const restart = props.pauseResumesAt ? londonToday(new Date(props.pauseResumesAt)) : null;
    return (
      <Card id="pause-subscription-card">
        <CardHeader>
          <CardTitle>{BRIEF_PAUSE_COPY.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {props.holdsAreaNow === false ? BRIEF_PAUSE_COPY.pausedLong : BRIEF_PAUSE_COPY.pausedShort}
          </p>
          {restart && <p className="text-sm font-medium">{restartLine(restart)}</p>}
          {props.cancelPending ? (
            <p className="text-sm text-muted-foreground">
              Your subscription is scheduled to cancel, so it will not restart. Choose{" "}
              <span className="font-medium">Keep my subscription</span> below first if you want
              your leads to start again.
            </p>
          ) : resumeArmed ? (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="text-sm font-medium">Start receiving leads again now?</p>
              <p className="text-sm text-muted-foreground">
                Your pause ends straight away and leads start arriving again. Billing restarts at
                your next normal billing date — nothing is charged today.
              </p>
              {props.holdsAreaNow === false && (
                <p className="text-sm text-muted-foreground">{BRIEF_PAUSE_COPY.earlyLong}</p>
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button onClick={resume} disabled={busy}>
                  {busy ? "Restarting…" : "Yes, start my leads"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setResumeArmed(false);
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Not yet
                </Button>
              </div>
            </div>
          ) : (
            <div className="pt-1">
              <Button onClick={() => setResumeArmed(true)}>Start my leads again</Button>
              <p className="mt-2 text-xs text-muted-foreground">
                You do not have to wait for the pause to end.
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Decided not to return? You can cancel below at any time — then billing never restarts.{" "}
            {KEEP_CRM_SUMMARY}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="pause-subscription-card">
      <CardHeader>
        <CardTitle>{BRIEF_PAUSE_COPY.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{BRIEF_PAUSE_COPY.intro}</p>
        <p className="text-sm text-muted-foreground">{BRIEF_PAUSE_COPY.short}</p>
        <p className="text-sm text-muted-foreground">{BRIEF_PAUSE_COPY.long}</p>
        {(props.canSwitchTo10 || switched) && (
          <p className="text-sm text-muted-foreground">{BRIEF_PAUSE_COPY.slower}</p>
        )}

        {armed === null && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" onClick={() => setArmed("four")}>
              {BRIEF_PAUSE_COPY.pauseFourWeeks}
            </Button>
            <Button variant="outline" onClick={() => setArmed("longer")}>
              {BRIEF_PAUSE_COPY.chooseLonger}
            </Button>
            {props.canSwitchTo10 && !switched && (
              <Button variant="outline" onClick={() => setArmed("switch")}>
                {BRIEF_PAUSE_COPY.switchTo10}
              </Button>
            )}
          </div>
        )}
        {switched && <p className="text-sm font-medium">{BRIEF_PAUSE_COPY.switchPending}</p>}

        {(armed === "four" || armed === "longer") && (
          <div className="space-y-5 rounded-lg border p-4">
            {armed === "longer" ? (
              <div>
                <label htmlFor="brief-pause-date" className="text-sm font-medium">
                  {BRIEF_PAUSE_COPY.returnDateLabel}
                </label>
                <input
                  id="brief-pause-date"
                  type="date"
                  value={returnDate}
                  min={pauseWindow.earliest}
                  max={pauseWindow.latest}
                  onChange={(e) => {
                    setReturnDate(e.target.value);
                    setError(null);
                  }}
                  className="mt-2 block rounded-md border bg-background p-2 text-sm"
                />
                {chosenDays !== null && chosenDays > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {holdsArea(chosenDays) ? BRIEF_PAUSE_COPY.keepsArea : BRIEF_PAUSE_COPY.recalculated}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm">{BRIEF_PAUSE_COPY.keepsArea}</p>
            )}
            <p className="text-sm font-medium">{restartLine(chosenDate)}</p>
            {reasonPicker}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={pause} disabled={busy}>
                {busy ? "Pausing…" : `Pause until ${longDate(chosenDate)}`}
              </Button>
              <Button variant="outline" onClick={close} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {armed === "switch" && (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm">{BRIEF_PAUSE_COPY.switchConfirm}</p>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={switchTo10} disabled={busy}>
                {busy ? "Switching…" : "Switch to 10 leads a month"}
              </Button>
              <Button variant="outline" onClick={close} disabled={busy}>
                Not now
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
