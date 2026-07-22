"use client";

import { useState } from "react";
import { PartyPopper, X } from "lucide-react";

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Fires when a customer marks a lead as signed. Celebrates the win (their Nth
 * signed landlord) and — at that peak moment — invites a one-line testimonial.
 * Publishing consent turns retention behaviour into acquisition proof.
 */
export function SignedCelebration({
  open,
  onClose,
  signedNumber,
  assignmentId,
}: {
  open: boolean;
  onClose: () => void;
  signedNumber: number;
  assignmentId: string;
}) {
  const [body, setBody] = useState("");
  const [consent, setConsent] = useState(true);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  if (!open) return null;

  async function submit() {
    if (!body.trim()) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/customer/testimonials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          lead_assignment_id: assignmentId,
          consent_to_publish: consent,
        }),
      });
      if (!res.ok) throw new Error();
      setDone(true);
      setTimeout(onClose, 900);
    } catch {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-black/10 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <PartyPopper className="h-6 w-6 text-[#5D8156]" />
            <h2 className="text-lg font-bold">
              That’s your {ordinal(signedNumber)} signed landlord!
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <p className="mt-4 text-sm text-[#3B6D11]">
            Thank you — that means a lot. 🙏
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Nice work. Mind sharing a quick line about how Stayful leads are
              working out? It helps us — and it’s optional.
            </p>

            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Signed two landlords in my first month — the leads pay for themselves."
              className="mt-4 w-full rounded-lg border-[0.5px] border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />

            <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
              />
              Stayful may publish this as a testimonial (first name / business
              only).
            </label>

            <div className="mt-5 flex gap-2">
              <button
                onClick={submit}
                disabled={saving}
                className="flex-1 rounded-lg bg-[#5D8156] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#4c6b47] disabled:opacity-60"
              >
                {saving ? "Sending…" : body.trim() ? "Share" : "Done"}
              </button>
              <button
                onClick={onClose}
                disabled={saving}
                className="rounded-lg border border-black/10 px-4 py-2.5 text-sm font-medium text-[#52514e] transition-colors hover:bg-gray-50"
              >
                Skip
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
