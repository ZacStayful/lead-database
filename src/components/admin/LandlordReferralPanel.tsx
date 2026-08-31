"use client";

/**
 * The landlord referral switch, and the button that rehearses it (§41).
 *
 * ⚠️ THE TEST SEND WORKS WHILE THE SWITCH IS OFF, and the copy says so. That is
 * the whole point: you press it to decide whether to turn the thing on. It
 * emails you, never a landlord, and writes nothing — so it cannot burn a real
 * lead's one-and-only introduction slot.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SettingSwitch } from "@/components/admin/SettingSwitch";

export function LandlordReferralPanel({
  enabled,
  adminEmail,
}: {
  enabled: boolean;
  adminEmail: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [testTo, setTestTo] = useState(adminEmail ?? "");
  const [testing, setTesting] = useState(false);

  async function set(next: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/admin/settings/landlord-referral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save that setting.");
        return;
      }
      setNote("Saved.");
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/admin/landlord-referral/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not send the test email.");
        return;
      }
      setNote(`Test sent to ${data?.to ?? testTo}. Nothing was recorded against the lead.`);
    } catch {
      setError("We could not reach the server.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingSwitch
        on={enabled}
        label="Landlord referrals"
        description="When a lead is assigned, Stayful emails the landlord to introduce the operator before they call. The first operator's email also asks the landlord how and when to reach them."
        offWarning={
          <>
            No landlord will be emailed when a lead is assigned. Operators still
            get their own alerts and leads still allocate normally — the landlord
            simply hears nothing, and the questions are never asked. Anything
            already queued for retry stops too.
          </>
        }
        busy={busy}
        onChange={(next) => void set(next)}
      />

      <div className="rounded-md border-[0.5px] border-border p-4">
        <p className="mb-1 text-sm font-medium">Send yourself one first</p>
        <p className="mb-3 text-sm text-muted-foreground">
          Builds a real referral from your newest management lead and emails it
          to you, with a working link to the landlord page.{" "}
          {/* Stated because it is the reason this is safe to press. */}
          It works while the switch is off, and it records nothing against the
          lead.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@stayful.co.uk"
            className="min-w-[240px] flex-1 rounded-md border-[0.5px] border-border bg-background px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testing}
            className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {testing ? "Sending…" : "Send test"}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {note && <p className="text-sm text-emerald-700">{note}</p>}
    </div>
  );
}
