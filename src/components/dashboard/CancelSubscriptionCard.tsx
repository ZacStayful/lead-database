"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeadType } from "@/lib/types";
import {
  CANCEL_NOTE_MAX_LENGTH,
  CANCEL_REASONS,
  type CancelReason,
} from "@/lib/cancelOptions";

export interface CancelProductState {
  leadType: LeadType;
  /** Product as the customer knows it, e.g. "Management leads". */
  name: string;
  /** A cancellation is already scheduled. */
  pending: boolean;
  /** When it lands (customers.(gr_)cancel_effective_at). */
  effectiveAt: string | null;
  /** False for comped / hand-provisioned accounts with no Stripe subscription. */
  hasSubscription: boolean;
  /**
   * Show the "pause instead?" interstitial before the reason step. True only
   * for an active, unpaused management subscription — GR has no pause product
   * and an already-paused customer has already seen the offer.
   */
  offerPauseFirst: boolean;
}

/** Format an ISO timestamp as e.g. "23 October 2026". */
function formatLongDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Self-serve cancellation, one section per held product.
 *
 * The flow is deliberately three steps for an unpaused management subscriber —
 * cancel button → pause-instead interstitial → reasons and confirm — and the
 * interstitial is a REQUIRED step, not a dismissible hint: pausing keeps the
 * customer and cancelling loses them, so the comparison gets a full screen
 * before the decision is final. But every step forward is one click and nothing
 * blocks: a customer who wants out gets out, with the exact consequences stated
 * before the button and confirmed by email after it.
 */
export function CancelSubscriptionCard({
  products,
  onPauseInstead,
}: {
  products: CancelProductState[];
  onPauseInstead: () => void;
}) {
  if (products.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cancel subscription</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {products.map((product) => (
          <ProductSection
            key={product.leadType}
            product={product}
            showName={products.length > 1}
            onPauseInstead={onPauseInstead}
          />
        ))}
      </CardContent>
    </Card>
  );
}

type Step = "closed" | "pause_offer" | "reasons";

function ProductSection({
  product,
  showName,
  onPauseInstead,
}: {
  product: CancelProductState;
  showName: boolean;
  onPauseInstead: () => void;
}) {
  const [pending, setPending] = useState(product.pending);
  const [effectiveAt, setEffectiveAt] = useState(product.effectiveAt);
  const [step, setStep] = useState<Step>("closed");
  const [selectedReasons, setSelectedReasons] = useState<Set<CancelReason>>(
    new Set()
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function toggleReason(value: CancelReason) {
    setError(null);
    setSelectedReasons((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function submit(action: "cancel" | "keep") {
    if (action === "cancel") {
      if (selectedReasons.size === 0) {
        setError("Please tell us why you are cancelling.");
        return;
      }
      if (selectedReasons.has("other") && note.trim().length === 0) {
        setError("Please tell us a little more.");
        return;
      }
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/customer/subscription/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "cancel"
            ? {
                product: product.leadType,
                action,
                reasons: Array.from(selectedReasons),
                note: note.trim() || undefined,
              }
            : { product: product.leadType, action }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Something went wrong.");
      setPending(data.cancel_at_period_end);
      setEffectiveAt(data.effective_at ?? null);
      setStep("closed");
      if (action === "cancel") {
        setSelectedReasons(new Set());
        setNote("");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  const heading = showName ? (
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {product.name}
    </p>
  ) : null;

  if (pending) {
    return (
      <div className="space-y-3">
        {heading}
        <p className="text-sm">
          Your {product.name} subscription is cancelled and ends{" "}
          {effectiveAt ? (
            <>
              on <span className="font-medium">{formatLongDate(effectiveAt)}</span>
            </>
          ) : (
            "at the end of your current billing period"
          )}
          .
        </p>
        <p className="text-sm text-muted-foreground">
          You will not be billed again. You keep your access and any remaining
          leads until then. We have emailed you a confirmation.
        </p>
        <div className="pt-1">
          <Button
            variant="outline"
            onClick={() => submit("keep")}
            disabled={loading}
          >
            {loading ? "One moment…" : "Keep my subscription"}
          </Button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  if (!product.hasSubscription) {
    return (
      <div className="space-y-2">
        {heading}
        <p className="text-sm text-muted-foreground">
          Your {product.name} subscription is managed for you. To cancel, contact
          support and we will sort it straight away.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {heading}

      {step === "closed" && (
        <>
          <p className="text-sm text-muted-foreground">
            You can cancel your {product.name} subscription here at any time.
            Cancelling stops all future billing — you keep your access and any
            remaining leads until the end of the period you have already paid
            for.
          </p>
          <div className="pt-1">
            <Button
              variant="outline"
              onClick={() =>
                setStep(product.offerPauseFirst ? "pause_offer" : "reasons")
              }
            >
              Cancel subscription
            </Button>
          </div>
        </>
      )}

      {step === "pause_offer" && (
        <div className="space-y-4 rounded-lg border p-4">
          <p className="text-sm font-medium">
            Before you cancel — you can pause for 1, 2 or 3 months instead.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="text-sm font-medium">Pause</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                <li>Billing stops immediately — nothing is charged during the pause.</li>
                <li>Your unused lead credits are kept and waiting when you return.</li>
                <li>Your place is reserved, so you don&apos;t rejoin any queue.</li>
                <li>
                  Restarts automatically on a date you choose — and we email you 7
                  days before billing resumes.
                </li>
                <li>You can still cancel at any time during the pause.</li>
              </ul>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-sm font-medium">Cancel</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                <li>Billing stops at the end of your current period.</li>
                <li>Your subscription ends for good and lead delivery stops on that date.</li>
                <li>Coming back later needs a new signup.</li>
              </ul>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => {
                setStep("closed");
                onPauseInstead();
              }}
            >
              Pause instead
            </Button>
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setStep("reasons")}
            >
              No thanks, continue to cancel
            </button>
          </div>
        </div>
      )}

      {step === "reasons" && (
        <div className="space-y-5 rounded-lg border p-4">
          <div>
            <p className="text-sm font-medium">
              Why are you cancelling?{" "}
              <span className="font-normal text-muted-foreground">
                (required — pick as many as apply)
              </span>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.entries(CANCEL_REASONS) as [CancelReason, string][]).map(
                ([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={selectedReasons.has(value)}
                    onClick={() => toggleReason(value)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition ${
                      selectedReasons.has(value)
                        ? "border-transparent bg-brand text-brand-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    {label}
                  </button>
                )
              )}
            </div>
          </div>

          <div>
            <label htmlFor={`cancel-note-${product.leadType}`} className="text-sm font-medium">
              {selectedReasons.has("other")
                ? "Please tell us more (required)"
                : "Anything else you'd like us to know? (optional)"}
            </label>
            <textarea
              id={`cancel-note-${product.leadType}`}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setError(null);
              }}
              maxLength={CANCEL_NOTE_MAX_LENGTH}
              rows={3}
              className="mt-2 w-full rounded-md border bg-background p-2 text-sm"
              placeholder="This goes straight to us and helps us improve the service."
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {note.length} / {CANCEL_NOTE_MAX_LENGTH}
            </p>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            Your subscription will end at the end of your current billing period.
            You keep your access and any remaining leads until then, you will not
            be billed again, and there are no refunds for time already paid. We
            will email you a confirmation with the exact end date.
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              onClick={() => submit("cancel")}
              disabled={loading}
            >
              {loading ? "Cancelling…" : "Cancel my subscription"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep("closed");
                setError(null);
              }}
              disabled={loading}
            >
              Never mind
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
