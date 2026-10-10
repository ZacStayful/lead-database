"use client";

/**
 * The confirm-on-login screen (batch 04 Phase 3, locked decision 4). Shown by
 * /onboarding/area, which the dashboard gate sends a brief customer to while
 * they have a recalculated area waiting.
 *
 * Three actions, the batch's three buttons:
 *   - Confirm. For a return whose date has come, "Confirm and start my
 *     leads": the area becomes active and the leads restart. Before the date,
 *     or for a widening, "Confirm my area": the area becomes active and the
 *     leads restart on the date they chose (or never stopped).
 *   - Switch to 10 leads (C5). The plan cannot change while paused, so it
 *     confirms first, which restarts a return's leads, then switches the plan
 *     (the existing route), then schedules the 10-lead area for the renewal
 *     the plan changes at. Before the return date it says so before they press.
 *   - Extend my pause, for a return: a later date, up to 3 months from the
 *     pause.
 *
 * It is given radii, a postcode, a point and dates, never an outcode list (A4).
 */
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AreaChangeMap } from "@/components/leadBrief/AreaChangeMap";
import {
  AREA_CONFIRM_COPY as C,
  areaChangeLine,
  extendedLine,
  restartsOnLine,
  switchedLine,
  tighterLine,
  welcomeBack,
} from "@/lib/leadBrief/areaConfirmCopy";

export interface AreaConfirmScreenProps {
  pendingId: string;
  isReturn: boolean;
  beforeReturn: boolean;
  firstName: string;
  basePostcode: string;
  otherAreas: number;
  newMiles: number;
  oldMiles: number;
  tighterMiles: number | null;
  canSwitch: boolean;
  centre: { lat: number; lng: number } | null;
  /** "7 November 2026", for a return. */
  returnLabel: string | null;
  extend: { earliest: string; latest: string } | null;
}

type Busy = null | "confirm" | "switch" | "extend";

/** "7 November 2026" from a YYYY-MM-DD date, or null. */
function longLabel(ymd: string | null | undefined): string | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ymd.slice(0, 10)}T12:00:00Z`));
}

export function AreaConfirmScreen(props: AreaConfirmScreenProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);
  const [extending, setExtending] = useState(false);
  const [returnDate, setReturnDate] = useState(props.extend?.earliest ?? "");

  async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  }

  function fail(status: number, data: Record<string, unknown>) {
    if (status === 409 && data.code === "conflict") {
      setConflict(true);
      setError(C.errorConflict);
      return;
    }
    setError(typeof data.error === "string" ? data.error : C.errorGeneric);
  }

  /** The line shown once the area is confirmed, from what the route reported. */
  function confirmedLines(data: Record<string, unknown>): string[] {
    if (!props.isReturn) return [C.confirmedWidening];
    const resume = data.resume;
    if (resume === "resumed" || resume === "already_resumed") return [C.confirmedStarted];
    if (resume === "refused") return [C.restartBlocked];
    if (resume === "stripe_failed" || resume === "db_failed") return [C.restartPending];
    const label = longLabel(typeof data.restartYmd === "string" ? data.restartYmd : null) ?? props.returnLabel;
    return label ? [restartsOnLine(label)] : [C.confirmedWidening];
  }

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      const r = await post("/api/customer/lead-brief/area/confirm", { pendingId: props.pendingId });
      if (!r.ok) return fail(r.status, r.data);
      setDone(confirmedLines(r.data));
    } catch {
      setError(C.errorGeneric);
    } finally {
      setBusy(null);
    }
  }

  async function switchTo10() {
    setBusy("switch");
    setError(null);
    try {
      const confirmed = await post("/api/customer/lead-brief/area/confirm", {
        pendingId: props.pendingId,
        forSwitch: true,
      });
      if (!confirmed.ok) return fail(confirmed.status, confirmed.data);

      const plan = await post("/api/customer/subscription/plan", { product: "management", plan: "lead_10" });
      if (!plan.ok) {
        setDone([...confirmedLines(confirmed.data), C.switchFailed]);
        return;
      }
      const tightened = await post("/api/customer/lead-brief/area/tighten", {});
      const effective =
        typeof plan.data.effectiveAt === "string" ? plan.data.effectiveAt : null;
      const miles =
        tightened.ok && typeof tightened.data.radiusMiles === "number" ? tightened.data.radiusMiles : null;
      setDone([...confirmedLines(confirmed.data), switchedLine(longLabel(effective), miles)]);
    } catch {
      setError(C.errorGeneric);
    } finally {
      setBusy(null);
    }
  }

  async function extend() {
    setBusy("extend");
    setError(null);
    try {
      const r = await post("/api/customer/lead-brief/area/extend", { returnDate });
      if (!r.ok) return fail(r.status, r.data);
      const label = longLabel(typeof r.data.returnDate === "string" ? r.data.returnDate : returnDate);
      setDone(label ? [extendedLine(label), C.extendRecalculated] : [C.extendRecalculated]);
    } catch {
      setError(C.errorGeneric);
    } finally {
      setBusy(null);
    }
  }

  const title = props.isReturn ? welcomeBack(props.firstName) : C.wideningTitle;

  if (done) {
    return (
      <Card>
        <CardContent className="space-y-4 pt-6">
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          {done.map((line) => (
            <p key={line} className="text-sm text-ink-2">
              {line}
            </p>
          ))}
          <Button asChild>
            <Link href="/dashboard/leads">{C.continue}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const confirmLabel = props.isReturn && !props.beforeReturn ? C.confirmStart : C.confirmArea;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          <p className="text-sm text-ink-2">{C.intro}</p>
        </div>

        <p className="text-sm text-ink">
          <strong>{C.areaLabel}</strong>{" "}
          {areaChangeLine({
            radiusMiles: props.newMiles,
            basePostcode: props.basePostcode,
            otherAreas: props.otherAreas,
            previousRadiusMiles: props.oldMiles,
          })}
        </p>

        {props.centre && (
          <AreaChangeMap centre={props.centre} newMiles={props.newMiles} oldMiles={props.oldMiles} />
        )}

        <p className="text-sm text-ink-2">
          <strong className="text-ink">{C.sameLabel}</strong> {C.same}
        </p>
        <p className="text-sm text-ink-2">
          <strong className="text-ink">{C.labelsLabel}</strong> {C.labels}
        </p>
        {props.canSwitch && props.tighterMiles !== null && (
          <p className="text-sm text-ink-2">
            <strong className="text-ink">{C.tighterLabel}</strong> {tighterLine(props.tighterMiles)}
          </p>
        )}
        {props.beforeReturn && props.returnLabel && (
          <p className="text-sm text-ink-2">{restartsOnLine(props.returnLabel)}</p>
        )}

        {error && (
          <div className="space-y-2 rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p>{error}</p>
            {conflict && (
              <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                {C.reload}
              </Button>
            )}
          </div>
        )}

        {extending && props.extend ? (
          <div className="space-y-3 rounded-md border-[0.5px] border-border p-4">
            <p className="text-sm font-medium text-ink">{C.extendTitle}</p>
            <label className="block space-y-1 text-sm text-ink-2">
              <span>{C.extendLabel}</span>
              <input
                type="date"
                className="block rounded-md border-[0.5px] border-border bg-card px-3 py-2 text-ink"
                min={props.extend.earliest}
                max={props.extend.latest}
                value={returnDate}
                onChange={(e) => setReturnDate(e.target.value)}
              />
            </label>
            <p className="text-xs text-ink-2">{C.extendRecalculated}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void extend()} disabled={busy !== null || !returnDate}>
                {busy === "extend" ? C.working : C.extendSave}
              </Button>
              <Button variant="ghost" onClick={() => setExtending(false)} disabled={busy !== null}>
                {C.extendBack}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void confirm()} disabled={busy !== null}>
                {busy === "confirm" ? C.working : confirmLabel}
              </Button>
              {props.canSwitch && (
                <Button variant="outline" onClick={() => void switchTo10()} disabled={busy !== null}>
                  {busy === "switch" ? C.switching : C.switchTo10}
                </Button>
              )}
              {props.isReturn && props.extend && (
                <Button variant="ghost" onClick={() => setExtending(true)} disabled={busy !== null}>
                  {C.extend}
                </Button>
              )}
            </div>
            {props.canSwitch && props.beforeReturn && (
              <p className="text-xs text-ink-2">{C.switchRestartsToday}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
