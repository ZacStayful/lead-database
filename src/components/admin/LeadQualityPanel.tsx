"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  describeLeadQuality,
  passesQualityGate,
  type LeadQualityCode,
} from "@/lib/leadQuality";

/**
 * The contact-quality verdict on a lead, and the controls to act on it (0111).
 *
 * The override is the point of this component. The rules are syntactic and will
 * be wrong sometimes; without a way to say "this one is fine" a false positive
 * is a lead nobody can ever sell. It is arm-then-confirm rather than a modal —
 * the repo vendors no dialog primitive, and this is the pattern
 * AnnouncementSendPanel and the reject confirmation already use.
 */
export function LeadQualityPanel({
  leadId,
  status,
  codes,
  checkedAt,
  overrideAt,
  overrideBy,
  overrideNote,
  isOwnedLead,
}: {
  leadId: string;
  status: string;
  codes: string[];
  checkedAt: string | null;
  overrideAt: string | null;
  overrideBy: string | null;
  overrideNote: string | null;
  isOwnedLead: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // A customer's own lead is never judged by us, so showing a verdict on one
  // would report a check that did not happen.
  if (isOwnedLead) return null;

  const blocked = !passesQualityGate({
    lead_quality_status: status,
    lead_quality_override_at: overrideAt,
  });
  const failed = status === "failed";

  async function act(action: "override" | "clear" | "recheck") {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/leads/${leadId}/quality`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: note.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? "Something went wrong.");
        return;
      }
      setArming(false);
      setNote("");
      router.refresh();
    } catch {
      setMessage("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const tone = blocked
    ? { border: "border-red-200", bg: "bg-red-50", text: "text-red-900" }
    : failed
      ? { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-900" }
      : status === "passed"
        ? { border: "border-emerald-200", bg: "bg-emerald-50", text: "text-emerald-900" }
        : { border: "border-slate-200", bg: "bg-slate-50", text: "text-slate-700" };

  const Icon = blocked
    ? AlertTriangle
    : status === "passed"
      ? CheckCircle2
      : failed
        ? AlertTriangle
        : HelpCircle;

  return (
    <div className={`rounded-lg border p-4 ${tone.border} ${tone.bg}`}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.text}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${tone.text}`}>
            {blocked
              ? "Blocked — not being allocated"
              : failed
                ? "Failed the check, override in place"
                : status === "passed"
                  ? "Contact details look usable"
                  : "Not checked yet"}
          </p>

          <p className="mt-1 text-sm text-slate-700">
            {status === "pending"
              ? "This lead predates the contact-quality check, so nothing has judged it. It routes exactly as it always has."
              : describeLeadQuality(codes as LeadQualityCode[])}
          </p>

          {overrideAt ? (
            <p className="mt-2 text-xs text-slate-600">
              Overridden by {overrideBy ?? "an admin"} on{" "}
              {new Date(overrideAt).toLocaleDateString("en-GB")}
              {overrideNote ? ` — ${overrideNote}` : ""}
            </p>
          ) : null}

          {checkedAt ? (
            <p className="mt-1 text-xs text-slate-500">
              Checked {new Date(checkedAt).toLocaleDateString("en-GB")}
            </p>
          ) : null}

          {message ? (
            <p className="mt-2 text-sm text-red-700">{message}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => act("recheck")}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Check again
            </Button>

            {blocked && !arming ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setArming(true)}
              >
                Sell anyway
              </Button>
            ) : null}

            {overrideAt ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act("clear")}
              >
                Withdraw override
              </Button>
            ) : null}
          </div>

          {arming ? (
            <div className="mt-3 rounded-md border border-red-300 bg-white p-3">
              <p className="text-sm text-slate-800">
                This lead will be allocated to paying operators with the contact
                details it has. They are charged for it either way, and reject
                does not refund.
              </p>
              <input
                type="text"
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why is this one fine? (optional)"
                className="mt-2 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => act("override")}
                >
                  Yes, allocate it
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setArming(false);
                    setNote("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
