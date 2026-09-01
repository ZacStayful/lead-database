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
import { SettingSwitch } from "@/components/admin/SettingSwitch";
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

/**
 * The contact-plan limits (§42), kept in their own form.
 *
 * Two of them ration approaches to a LANDLORD across every operator holding
 * them; two decide who is told they are falling behind. Grouped separately
 * from the messaging limits above because they govern a different thing —
 * these bind calls and hand-off clicks, which never touch TimelinesAI at all.
 */
const CONTACT_NUMBER_FIELDS: {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
}[] = [
  {
    key: "contact_landlord_max_per_day",
    label: "Approaches to one landlord a day",
    hint: "Across EVERY operator holding them, whoever acts first. 69% of open landlords are held by two or more, so without this a three-holder landlord hears from somebody fifteen times in nine days.",
    min: 1,
    max: 10,
  },
  {
    key: "contact_landlord_max_per_week",
    label: "…and a week",
    hint: "The weekly ceiling on the same count. An attempt over either limit has its due date pushed a day; nothing is cancelled, and the operator is never told why (they must not learn another operator is working the same landlord).",
    min: 1,
    max: 50,
  },
  {
    key: "followup_adherence_notice_pct",
    label: "Falling-behind threshold (%)",
    hint: "Adherence below this, AND at least the minimum overdue below, sends the weekly notice. Both conditions — a customer with two overdue attempts is not neglecting anything.",
    min: 0,
    max: 100,
  },
  {
    key: "followup_adherence_notice_min_overdue",
    label: "…with at least this many overdue",
    hint: "The floor that stops a brand-new customer being chased about a single missed call.",
    min: 1,
    max: 500,
  },
];

const NUDGE_NUMBER_FIELDS: {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
}[] = [
  {
    key: "landlord_prefs_nudge_first_hours",
    label: "First reminder after (hours)",
    hint: "Measured from the introduction Resend actually DELIVERED, not from when it was claimed — so a landlord is never chased about an email that never reached them.",
    min: 1,
    max: 336,
  },
  {
    key: "landlord_prefs_nudge_second_hours",
    label: "Second reminder after (hours)",
    hint: "Also measured from delivery, and it is the last one. A minimum 12-hour gap since the first is enforced regardless, so a reminder held back by quiet hours cannot land an hour before this one.",
    min: 1,
    max: 336,
  },
  {
    key: "landlord_prefs_reask_days",
    label: "Re-ask floor (days)",
    hint: "How long before ANOTHER operator's introduction may carry the questions again. Never 0: allocation can place one lead with three operators in a single pass, and the floor is the only thing stopping all three emails asking the same landlord the same questions at once.",
    min: 1,
    max: 90,
  },
];

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
    Object.fromEntries(
      [...NUMBER_FIELDS, ...CONTACT_NUMBER_FIELDS, ...NUDGE_NUMBER_FIELDS].map((f) => [
        f.key,
        initial[f.key] ?? "",
      ])
    )
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
      <SettingSwitch
        label="Messaging"
        on={on("messaging_enabled")}
        busy={busy}
        onChange={(next) => save({ messaging_enabled: next })}
        description="The whole feature. While it is off, only admins see the messaging buttons and only an admin's own account can send — which is what makes a rehearsal on production possible."
        offWarning="Switch messaging off for every customer? The composer and the follow-up pages disappear, and sending returns a 503. Conversations already stored are untouched, and inbound replies are still received and recorded."
      />

      <SettingSwitch
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

      <SettingSwitch
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

      <SettingSwitch
        label="Contact plans"
        on={on("contact_plans_enabled")}
        busy={busy}
        onChange={(next) => save({ contact_plans_enabled: next })}
        description="The five-attempt contact plan (§42): the timeline on each lead, and the daily prompt telling an operator who is due a call, message or email. Every open lead already carries a plan; this decides whether anybody is asked to work one."
        offWarning="Switch contact plans off? The daily follow-up email and text stop, and the falling-behind notice with them. Timelines already on leads are not deleted and completed attempts are kept — nobody is prompted about them."
      />

      <div className="rounded-md border-[0.5px] border-border p-4">
        <h3 className="text-sm font-medium">Contact plan limits</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {CONTACT_NUMBER_FIELDS.map((f) => (
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
                CONTACT_NUMBER_FIELDS.map((f) => [f.key, Number(numbers[f.key])])
              )
            )
          }
          className="mt-4 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save contact limits"}
        </button>
      </div>

      <SettingSwitch
        label="Landlord reminders"
        on={on("landlord_referral_nudge_enabled")}
        busy={busy}
        onChange={(next) => save({ landlord_referral_nudge_enabled: next })}
        description="Chases a landlord who was introduced to an operator and never finished answering how they want to be contacted (§41.1). Two emails, then it stops — and never once the operator has actually rung them. Separate from the referral switch on purpose, so introductions can run while this stays off."
        offWarning="Switch landlord reminders off? Landlords who never answered are simply left, and their operator opens with a cold call rather than the channel they might have chosen. Introductions themselves are unaffected."
      />

      <div className="rounded-md border-[0.5px] border-border p-4">
        <h3 className="text-sm font-medium">Landlord reminder timing</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {NUDGE_NUMBER_FIELDS.map((f) => (
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
                NUDGE_NUMBER_FIELDS.map((f) => [f.key, Number(numbers[f.key])])
              )
            )
          }
          className="mt-4 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save reminder timing"}
        </button>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {saved && <p className="text-sm text-muted-foreground">{saved}</p>}
    </div>
  );
}
