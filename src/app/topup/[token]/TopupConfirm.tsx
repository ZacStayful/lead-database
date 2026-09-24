"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Status = "idle" | "loading" | "success" | "error" | "pending";

/**
 * Confirm button for the top-up page. POSTs to the token-gated confirm route,
 * then either shows success, redirects to a hosted Stripe page (the no-saved-card
 * fallback), or shows a plain failure message. Never charges on its own — the
 * server route owns the charge.
 */
export function TopupConfirm({
  token,
  credits,
  priceLabel,
  deliveryNote,
  filterWarning,
}: {
  token: string;
  credits: number;
  priceLabel: string;
  /** Delivery expectation — shown before purchase and repeated after. */
  deliveryNote: string;
  /**
   * The figure-specific filter warning, or null (§69).
   *
   * ⚠️ When it is present the purchase needs an explicit tick, mirroring
   * §39.8's forecast acknowledgement — and the tick is re-checked SERVER-SIDE,
   * so this control is a courtesy rather than the gate. It refuses an
   * UN-ACKNOWLEDGED purchase, never the purchase: §16's rule is never to turn
   * away a sale, and the credit here is genuinely spendable the moment the
   * filter widens.
   */
  filterWarning: string | null;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  async function confirm() {
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch(`/api/topup/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledge_filter: acknowledged }),
      });
      const data = await res.json();

      if (data.status === "redirect" && data.url) {
        window.location.href = data.url as string;
        return;
      }
      if (data.status === "success") {
        setStatus("success");
        return;
      }
      if (data.status === "pending") {
        // Outcome not yet determined — the token was released, so retrying is
        // safe and cannot double-charge.
        setStatus("pending");
        setMessage(data.message ?? "Your payment is still going through.");
        return;
      }
      setStatus("error");
      setMessage(data.message ?? "Something went wrong. Please try again.");
    } catch {
      setStatus("error");
      setMessage("Network error. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <div className="text-center">
        <p className="mb-3 text-sm font-medium text-[#1a1a19]">
          Payment confirmed — {credits} leads have been added to your balance.
        </p>
        {/* A top-up increases what we owe, not the delivery rate — say so at the
            moment of purchase rather than leaving it to be discovered. */}
        <p className="mb-4 text-xs leading-relaxed text-[#8a8f88]">
          {deliveryNote}
        </p>
        <Button asChild className="w-full">
          <Link href="/dashboard">Go to your dashboard</Link>
        </Button>
      </div>
    );
  }

  if (status === "pending") {
    return (
      <p className="text-center text-sm leading-relaxed text-[#52514e]">
        {message}
      </p>
    );
  }

  return (
    <div>
      {status === "error" && (
        <p className="mb-3 text-center text-sm text-destructive">{message}</p>
      )}
      {filterWarning && (
        <div className="mb-3 rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-3 py-2">
          <p className="text-xs leading-relaxed text-amber-800">
            {filterWarning}
          </p>
          <label className="mt-2 flex items-start gap-2 text-xs text-amber-800">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I have read this and want to buy the extra leads anyway.
            </span>
          </label>
        </div>
      )}
      <p className="mb-3 text-xs leading-relaxed text-[#8a8f88]">
        {deliveryNote}
      </p>
      <Button
        onClick={confirm}
        disabled={status === "loading" || (filterWarning != null && !acknowledged)}
        className="w-full"
      >
        {status === "loading"
          ? "Processing…"
          : `Confirm ${priceLabel} for ${credits} more leads`}
      </Button>
    </div>
  );
}
