"use client";

/**
 * The messaging switches, on /admin/messaging.
 *
 * ⚠️ TURNING SOMETHING OFF CONFIRMS; TURNING IT ON DOES NOT. `ApiKillSwitch`'s
 * own rule, and for its reason: switching off stops something people are
 * relying on, where restoring service is not a thing anybody needs protecting
 * from. The confirmation names what actually stops, in words, rather than
 * asking "are you sure" with no new information (§22.4).
 *
 * The numbers save as one form rather than per field: the quiet-hours pair can
 * only be judged together, and a per-field save would let a start land past a
 * stored end and close the window for ever.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

export interface MessagingSettingsValues {
  [key: string]: string;
}

const NUMBER_FIELDS: {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
}[] = [
  {
    key: "messaging_quiet_start_hour",
    label: "Sending starts (London)",
    hint: "Inclusive. 9 means the first message may go at 09:00.",
    min: 0,
    max: 23,
  },
  {
    key: "messaging_quiet_end_hour",
    label: "Sending stops (London)",
    hint: "Exclusive. 20 means nothing goes at 20:00 or after.",
    min: 1,
    max: 24,
  },
  {
    key: "messaging_lead_cooldown_hours",
    label: "Cross-operator cooldown (hours)",
    hint: "How long after one operator messages a landlord before a different one may. 0 disables it.",
    min: 0,
    max: 720,
  },
  {
    key: "messaging_whatsapp_ceiling_per_second",
    label: "Requests a second to TimelinesAI",
    hint: "Their documented limit is 30 PER IP, and every customer shares our egress — so this is one bucket for the whole platform, not one each.",
    min: 1,
    max: 30,
  },
  {
    key: "messaging_sequence_review_hours",
    label: "Draft follow-ups this far ahead (hours)",
    hint: "⚠️ Tied to the drafting cron. It runs at 17:00 UTC and the earliest a step can send is 09:00 the next morning — sixteen hours later. Below that, every ordinary morning step is drafted a day late.",
    min: 1,
    max: 72,
  },
  {
    key: "messaging_sequence_daily_draft_cap",
    label: "Sequence drafts per customer a day",
    hint: "Separate from the 50/day cap on a person pressing Generate. Sized against the send cap — drafting far more than can be sent only builds a queue of stale text.",
    min: 1,
    max: 5000,
  },
];

function Switch({
  on,
  label,
  description,
  offWarning,
  busy,
  onChange,
}: {
  on: boolean;
  label: string;
  description: string;
  offWarning: string;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rounded-md border-[0.5px] border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ${
            on ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${on ? "bg-emerald-600" : "bg-red-600"}`} />
          {label} {on ? "is on" : "is off"}
        </span>

        {on && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            Switch off
          </button>
        )}

        {!on && (
          <button
            type="button"
            onClick={() => onChange(true)}
            disabled={busy}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Switching on…" : "Switch on"}
          </button>
        )}
      </div>

      <p className="mt-2 text-sm text-muted-foreground">{description}</p>

      {confirming && (
        <div className="mt-3 rounded-md border-[0.5px] border-border bg-muted/30 p-4">
          <p className="mb-3 text-sm">{offWarning}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onChange(false);
                setConfirming(false);
              }}
              disabled={busy}
              className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
            >
              {busy ? "Switching off…" : "Confirm — switch off"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MessagingSettingsPanel({
  initial,
  activeRuns,
  pendingDrafts,
}: {
  initial: MessagingSettingsValues;
  activeRuns: number;
  pendingDrafts: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<Record<string, string>>(() =>
    Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, initial[f.key] ?? ""]))
  );

  async function save(settings: Record<string, boolean | number>) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/admin/settings/messaging", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save that setting.");
        return;
      }
      setSaved("Saved.");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const on = (key: string) => initial[key] === "true";

  return (
    <div className="space-y-4">
      <Switch
        label="Messaging"
        on={on("messaging_enabled")}
        busy={busy}
        onChange={(next) => save({ messaging_enabled: next })}
        description="The whole feature. While it is off, only admins see the messaging buttons and only an admin's own account can send — which is what makes a rehearsal on production possible."
        offWarning="Switch messaging off for every customer? The composer and the follow-up pages disappear, and sending returns a 503. Conversations already stored are untouched, and inbound replies are still received and recorded."
      />

      <Switch
        label="Follow-up sequences"
        on={on("messaging_sequences_enabled")}
        busy={busy}
        onChange={(next) => save({ messaging_sequences_enabled: next })}
        description="Scheduled follow-ups. Operators can build sequences and add leads either way; this decides whether anything is drafted and sent. It ships off because what it starts sends unattended messages from a real person's own number to members of the public."
        offWarning={
          activeRuns > 0
            ? `Switch off scheduled follow-ups? ${activeRuns} lead${activeRuns === 1 ? "" : "s"} currently working through a sequence stop receiving messages, and ${pendingDrafts} message${pendingDrafts === 1 ? "" : "s"} already in review will not go. The runs are not cancelled — turning this back on resumes them.`
            : "Switch off scheduled follow-ups? Nothing is running right now, so this stops anything new being drafted or sent."
        }
      />

      <Switch
        label="Email channel"
        on={on("messaging_email_enabled")}
        busy={busy}
        onChange={(next) => save({ messaging_email_enabled: next })}
        description="Dormant. Seven DNS records, three of them 60-character DKIM CNAMEs, is not something a property operator completes — measured against the first real user, not guessed. The code is kept rather than deleted because it carries the defence against putting an MX record on a customer's live domain."
        offWarning="Switch the email channel off? Customers stop seeing email as an option and the send route refuses it. Domains already verified are not deleted."
      />

      <div className="rounded-md border-[0.5px] border-border p-4">
        <h3 className="text-sm font-medium">Limits</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {NUMBER_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="text-xs font-medium" htmlFor={f.key}>
                {f.label}
              </label>
              <input
                id={f.key}
                type="number"
                min={f.min}
                max={f.max}
                value={numbers[f.key] ?? ""}
                onChange={(e) =>
                  setNumbers((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
                className="mt-1 h-9 w-28 rounded-md border-[0.5px] border-border bg-background px-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">{f.hint}</p>
            </div>
          ))}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() =>
            save(
              Object.fromEntries(
                NUMBER_FIELDS.map((f) => [f.key, Number(numbers[f.key])])
              )
            )
          }
          className="mt-4 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save limits"}
        </button>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {saved && <p className="text-sm text-muted-foreground">{saved}</p>}
    </div>
  );
}
