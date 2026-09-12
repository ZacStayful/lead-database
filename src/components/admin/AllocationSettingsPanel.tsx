"use client";

/**
 * The one-lead-a-working-day switch and its three limits (§54), on
 * /admin/allocation. Same shape as MessagingSettingsPanel and the same route:
 * every key goes through the closed allow-list in adminSettings.ts, so this
 * form cannot name a setting the reader does not know.
 *
 * Switching OFF confirms and names what stops; switching ON does not.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SettingSwitch } from "@/components/admin/SettingSwitch";

const NUMBER_FIELDS: { key: string; label: string; hint: string; min: number; max: number }[] = [
  {
    key: "release_max_per_day",
    label: "Leads per customer per day",
    hint: "The hard ceiling per product per London day. It bounds catch-up: a customer owed five after a quiet week gets them at this rate, not all at once. Never 0 — that refuses every lead for everyone.",
    min: 1,
    max: 10,
  },
  {
    key: "release_cycle_days",
    label: "Cycle length (days)",
    hint: "The window the working days are counted in. 30 matches the pacing model everywhere else; a 30-day window from a Monday holds 22 working days, so a 20-lead plan is very nearly one a day.",
    min: 28,
    max: 31,
  },
  {
    key: "release_hold_max_days",
    label: "Longest hold a customer may set (days)",
    hint: "\"I'm away until Monday — hold my leads.\" Not a pause: billing and credits are untouched and delivery catches up at the daily cap when it ends.",
    min: 1,
    max: 60,
  },
];

export function AllocationSettingsPanel({
  initial,
  slotOpenToday,
  onHold,
}: {
  initial: Record<string, string>;
  slotOpenToday: number;
  onHold: number;
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

  const on = initial.release_enabled === "true";

  return (
    <div className="space-y-4">
      <SettingSwitch
        label="One lead a working day"
        on={on}
        busy={busy}
        onChange={(next) => save({ release_enabled: next })}
        description={
          <>
            Ordinary routing hands each customer their month&apos;s leads one per
            UK working day (a 10-lead plan: one every other working day) instead
            of the whole batch on renewal. Admin force-assigns, replacements and
            pool claims are never rationed. {slotOpenToday} customer
            {slotOpenToday === 1 ? " has" : "s have"} a slot open right now
            {onHold > 0 ? `, ${onHold} on hold` : ""}.
          </>
        }
        offWarning="Switch the daily release off? From the next sync every customer with credit is offered leads until their credit runs out — the renewal-day batch comes back for everyone. Holds and the per-customer exemption stay recorded but do nothing."
      />

      <div className="rounded-md border-[0.5px] border-border p-4">
        <h3 className="text-sm font-medium">Limits</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
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
                onChange={(e) => setNumbers((prev) => ({ ...prev, [f.key]: e.target.value }))}
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
            save(Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, Number(numbers[f.key])])))
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
