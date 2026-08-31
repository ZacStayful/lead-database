"use client";

/**
 * One admin kill switch, with confirm-on-OFF.
 *
 * ⚠️ EXTRACTED, NOT WRITTEN. This is the exact markup and state machine that
 * lived as an unexported inner function of MessagingSettingsPanel, moved here
 * verbatim when a third switch was needed. ApiKillSwitch already carried a
 * second copy; a third would have made the shape unmaintainable.
 *
 * The asymmetry is the design: switching OFF asks for confirmation and names
 * what stops, switching ON does not — restoring service is not something anyone
 * needs protecting from.
 *
 * `offWarning` is a ReactNode rather than a string so it can carry emphasis,
 * which is what ApiKillSwitch's own copy does.
 */
import { useState } from "react";
import type { ReactNode } from "react";

export function SettingSwitch({
  on,
  label,
  description,
  offWarning,
  busy,
  onChange,
}: {
  on: boolean;
  label: string;
  description: ReactNode;
  offWarning: ReactNode;
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
