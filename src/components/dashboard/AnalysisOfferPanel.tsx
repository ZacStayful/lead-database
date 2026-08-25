"use client";

import { useState } from "react";
import { AlertTriangle, HelpCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ANALYSIS_SHEET_HELP, formatPence } from "@/lib/leadAnalysis";
import type { LeadType } from "@/lib/types";

export interface AnalysisOffer {
  eligible_lead_ids: string[];
  amount_pence: number;
  ineligible: Array<{ lead_name: string; reason: string }>;
}

export type OfferState =
  | { kind: "idle" }
  | { kind: "buying" }
  | { kind: "started"; leadCount: number; jobId: string }
  | { kind: "error"; message: string };

/**
 * The offer: run these leads through the analyser for £3 each.
 *
 * ONE COMPONENT, EVERY SURFACE that sells this — the import result screen and
 * the bulk action on the leads list — so the price, the wording and the
 * arithmetic exist once. Two implementations would eventually quote a customer
 * two different numbers for the same batch.
 *
 * ⚠️ ARM THEN CONFIRM. A single click must never move £552. The repo vendors no
 * dialog primitive, so this follows the two-step the reject control and
 * TopupPurchasePanel already use: the button reveals a confirmation naming the
 * count and the amount, and only the second click spends anything. The count
 * and the amount are exactly the two things somebody can have wrong without
 * noticing, so both are restated in words at the moment of confirming.
 *
 * The price shown here is only ever a display of what the SERVER quoted. The
 * purchase route re-derives it from the leads themselves and ignores anything
 * the browser sends about counts or amounts — the client-proposes,
 * server-re-derives discipline the import commit already follows.
 */
export function AnalysisOfferPanel({
  offer,
  leadType,
  source,
  onStarted,
  heading = "Add due diligence?",
}: {
  offer: AnalysisOffer;
  leadType: LeadType;
  source: "import" | "manual" | "detail";
  onStarted?: (jobId: string) => void;
  heading?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [state, setState] = useState<OfferState>({ kind: "idle" });

  const count = offer.eligible_lead_ids.length;
  const price = formatPence(offer.amount_pence);

  async function buy() {
    setState({ kind: "buying" });
    try {
      const res = await fetch("/api/customer/lead-analysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lead_ids: offer.eligible_lead_ids,
          lead_type: leadType,
          source,
        }),
      });
      const body = await res.json();

      if (body.status === "redirect" && body.url) {
        // No reusable card, or an amount large enough that the cardholder
        // should be present. Stripe's own page takes it from here.
        window.location.href = body.url;
        return;
      }
      if (body.status === "success") {
        setState({ kind: "started", leadCount: count, jobId: body.job_id });
        onStarted?.(body.job_id);
        return;
      }
      setState({
        kind: "error",
        message: body.message ?? "We couldn't start that. Please try again.",
      });
    } catch {
      setState({ kind: "error", message: "We couldn't reach the server. Please try again." });
    }
  }

  if (state.kind === "started") {
    return (
      <div className="rounded-lg border-[0.5px] border-border bg-muted/40 p-4">
        <p className="flex items-start gap-2 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            <span className="font-medium">
              Running the figures on {state.leadCount} lead
              {state.leadCount === 1 ? "" : "s"}.
            </span>{" "}
            Each property takes about half a minute, so a large batch runs in the
            background — you don&rsquo;t need to stay on this page. We&rsquo;ll email you when
            they&rsquo;re done, and the figures appear on each lead as they land.
          </span>
        </p>
      </div>
    );
  }

  if (!count) return null;

  return (
    <div className="rounded-lg border-[0.5px] border-border p-4">
      <h3 className="text-sm font-semibold">{heading}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Run {count === 1 ? "this lead" : `${count} of them`} through the Stayful
        analyser — projected occupancy, nightly rate, gross income and your
        management fee, with the full property analysis attached to the lead.
        Exactly what a lead from us arrives with.
      </p>

      <p className="mt-3 text-sm">
        <span className="font-semibold">
          {count} lead{count === 1 ? "" : "s"} &times; £3 = {price}
        </span>
        <span className="text-muted-foreground">
          {" "}
          — charged once. You&rsquo;re only charged for figures we actually produce; if
          we can&rsquo;t get trustworthy numbers for a property, that £3 comes back.
        </span>
      </p>

      {offer.ineligible.length > 0 && (
        <div className="mt-3 rounded-md bg-amber-500/10 p-3 text-sm">
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            {offer.ineligible.length} lead
            {offer.ineligible.length === 1 ? "" : "s"} can&rsquo;t be run yet — you are
            not charged for {offer.ineligible.length === 1 ? "it" : "them"}.
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {offer.ineligible.slice(0, 8).map((row, i) => (
              <li key={i}>
                <span className="font-medium text-foreground">{row.lead_name}</span> —{" "}
                {row.reason}
              </li>
            ))}
            {offer.ineligible.length > 8 && (
              <li>and {offer.ineligible.length - 8} more.</li>
            )}
          </ul>
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-sm underline underline-offset-2"
          >
            <HelpCircle className="h-3.5 w-3.5" />
            {showHelp ? "Hide" : "How to fix your spreadsheet"}
          </button>
          {showHelp && <SheetHelp />}
        </div>
      )}

      {state.kind === "error" && (
        <p className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {state.message}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {armed ? (
          <>
            <Button onClick={buy} disabled={state.kind === "buying"}>
              {state.kind === "buying"
                ? "Starting…"
                : `Yes — charge ${price} for ${count} lead${count === 1 ? "" : "s"}`}
            </Button>
            <Button
              variant="outline"
              onClick={() => setArmed(false)}
              disabled={state.kind === "buying"}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button onClick={() => setArmed(true)}>Run the figures — {price}</Button>
        )}
      </div>
    </div>
  );
}

/**
 * How to format a spreadsheet so its leads can be analysed.
 *
 * The copy itself lives in `ANALYSIS_SHEET_HELP` rather than here, so the
 * mapping screen and this panel cannot drift — the rule `topupDeliveryNote()`
 * already follows for the top-up wording.
 */
export function SheetHelp({ className }: { className?: string }) {
  return (
    <div className={`mt-3 space-y-2 text-sm ${className ?? ""}`}>
      <p className="font-medium">{ANALYSIS_SHEET_HELP.heading}</p>
      <p className="text-muted-foreground">{ANALYSIS_SHEET_HELP.intro}</p>
      <ul className="space-y-1.5">
        {ANALYSIS_SHEET_HELP.points.map((point) => (
          <li key={point.label}>
            <span className="font-medium">{point.label}</span>
            <span className="text-muted-foreground"> — {point.body}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">{ANALYSIS_SHEET_HELP.footer}</p>
    </div>
  );
}
