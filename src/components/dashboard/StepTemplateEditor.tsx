"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check } from "lucide-react";
import { fieldsForProduct, MAX_TEMPLATE_CHARS } from "@/lib/messaging/mergeFields";

/**
 * Writing a follow-up in your own words (§40.14).
 *
 * ⚠️ THE REACH LINE IS THE POINT OF THIS COMPONENT, not the textarea. Measured
 * over the 449 live leads, the income, nightly-rate and occupancy figures fill
 * on 173 of them — 39%. So an operator who drops {{income}} into a chase and
 * saves it silently loses three sends in five and finds out weeks later, if at
 * all. Telling them "this reaches 84 of your 137 leads; 53 have no income
 * figure" while the wording can still be changed is the whole reason skipping
 * those leads is a defensible answer.
 *
 * Same discipline as §28's filter forecast and §40.13's "state how long the
 * backlog will take": show the number that changes the decision, before the
 * decision closes.
 */

interface Coverage {
  ok: boolean;
  error?: string;
  total?: number;
  reach?: number;
  missingByField?: { key: string; label: string; count: number }[];
  sample?: string | null;
}

export function StepTemplateEditor({
  value,
  leadType,
  hasBookingLink,
  onChange,
}: {
  value: string;
  leadType: string;
  hasBookingLink: boolean;
  onChange: (next: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [checking, setChecking] = useState(false);

  // Debounced, and the request is abandoned when the text moves on — a reach
  // figure that lands after the operator has kept typing describes a message
  // they no longer have.
  useEffect(() => {
    const text = value.trim();
    if (!text) {
      setCoverage(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setChecking(true);
      fetch("/api/customer/messaging/sequences/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body_template: text, lead_type: leadType }),
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((d) => setCoverage(d as Coverage))
        .catch(() => undefined)
        .finally(() => setChecking(false));
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [value, leadType]);

  function insert(key: string) {
    const token = `{{${key}}}`;
    const el = ref.current;
    if (!el) {
      onChange(`${value}${token}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    // Put the caret after what was just inserted, so the operator can carry on
    // typing rather than hunting for where they were.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  // ⚠️ Filtered by PRODUCT, not just by whether a link is saved. Zero of 252
  // guaranteed rent leads carry an income figure — §25's analysis is
  // management-only — so offering {{income}} on a GR sequence would offer a
  // field that reaches nobody.
  const usable = fieldsForProduct(leadType).filter(
    (f) => f.key !== "booking_link" || hasBookingLink
  );
  const missed = coverage?.missingByField ?? [];
  const shortfall = (coverage?.total ?? 0) - (coverage?.reach ?? 0);

  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={MAX_TEMPLATE_CHARS}
        placeholder="Hi {{first_name}}, still thinking about {{address}}? Happy to leave it if the timing is wrong."
        className="w-full rounded-md border-[0.5px] border-border bg-background p-3 text-sm"
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Insert:</span>
        {usable.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => insert(f.key)}
            title={`${f.label} — e.g. ${f.example}${f.note ? `. ${f.note}` : ""}`}
            className={
              "rounded px-2 py-0.5 text-xs font-medium transition-colors " +
              (f.tier === "sometimes"
                ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                : "bg-background text-muted-foreground hover:bg-accent")
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {!hasBookingLink && (
        <p className="text-xs text-muted-foreground">
          Links cannot be typed into a follow-up — it is the strongest spam
          signal in a cold WhatsApp and the number at risk is yours. Save one
          booking link on{" "}
          <Link href="/dashboard/settings/messaging" className="underline">
            Messaging settings
          </Link>{" "}
          and it becomes a field you can insert.
        </p>
      )}

      {/* ---- The reach line ------------------------------------------- */}
      {coverage && !coverage.ok && coverage.error && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {coverage.error}
        </p>
      )}

      {coverage?.ok && (coverage.total ?? 0) > 0 && (
        <div className="space-y-1 text-xs">
          <p
            className={
              shortfall > 0
                ? "flex items-start gap-1.5 text-amber-700"
                : "flex items-start gap-1.5 text-muted-foreground"
            }
          >
            {shortfall > 0 ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              Reaches <strong>{coverage.reach}</strong> of your {coverage.total}{" "}
              {leadType === "guaranteed_rent" ? "guaranteed rent" : "management"}{" "}
              leads.
              {missed.length > 0 && (
                <>
                  {" "}
                  {missed
                    .map((m) => `${m.count} have no ${m.label.toLowerCase()}`)
                    .join(", ")}
                  , so this message is skipped for them.
                </>
              )}
            </span>
          </p>

          {coverage.sample && (
            <p className="rounded bg-background p-2 text-muted-foreground">
              <span className="font-medium">One of yours: </span>
              {coverage.sample}
            </p>
          )}
        </div>
      )}

      {checking && !coverage && (
        <p className="text-xs text-muted-foreground">Checking your leads…</p>
      )}
    </div>
  );
}
