"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EDIT_COPY, pendingLine } from "@/lib/leadBrief/editCopy";

/**
 * A saved area change waiting for the next renewal (Lead Brief Phase 5): what
 * it is, the date it starts, and Cancel. Cancelling deletes the scheduled
 * version; the current brief is untouched.
 *
 * `planChanged`: the customer's plan has moved since they saved it, so the
 * renewal cron will not apply it (the area was sized for the old plan). The
 * screen asks them to review and save it again.
 */
export function BriefPendingChange(props: {
  areaLine: string;
  startsOnIso: string | null;
  planChanged: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/lead-brief/edit", { method: "DELETE" });
      if (!res.ok) {
        setError(EDIT_COPY.errors.failed);
        return;
      }
      setCancelled(true);
      router.refresh();
    } catch {
      setError(EDIT_COPY.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  if (cancelled) {
    return <p className="rounded-md bg-brand-light p-3 text-sm text-brand-dark">{EDIT_COPY.pendingCancelled}</p>;
  }

  return (
    <Card className="border-attention/40">
      <CardContent className="space-y-3 pt-6 text-sm">
        <h2 className="text-base font-semibold text-ink">{EDIT_COPY.pendingTitle}</h2>
        <p className="text-ink">{props.areaLine}</p>
        {/* A change sized for a plan the customer no longer has will not
            start on that date (the cron skips it), so the date is not shown. */}
        {props.planChanged ? (
          <p className="text-alert">{EDIT_COPY.planChanged}</p>
        ) : (
          <p className="font-medium text-ink">{pendingLine(props.startsOnIso)}</p>
        )}
        {error && <p className="text-alert">{error}</p>}
        {!props.readOnly && (
          <Button variant="outline" onClick={() => void cancel()} disabled={busy}>
            {busy ? EDIT_COPY.pendingCancelling : EDIT_COPY.pendingCancel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
