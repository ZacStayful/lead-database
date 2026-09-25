"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { LeadType } from "@/lib/types";

type Status = "idle" | "confirming" | "loading" | "success" | "error" | "pending";

/**
 * One product's top-up card. Buying is two-step on purpose — a single click
 * must never move £75, so the button arms a confirm state first.
 *
 * The server owns the price and credit count; nothing here is trusted as input
 * beyond which product was chosen.
 */
export function TopupPurchasePanel({
  leadType,
  productLabel,
  balance,
  credits,
  priceLabel,
  blockedReason,
  deliveryNote,
  filterInForce,
  filterWarning,
}: {
  leadType: LeadType;
  productLabel: string;
  balance: number;
  credits: number;
  priceLabel: string;
  blockedReason: string | null;
  /** Delivery expectation shown before and after purchase (see topupDeliveryNote). */
  deliveryNote: string;
  filterInForce: boolean;
  /** Shown BEFORE the charge when the filter, not the balance, is the
   *  constraint — see topupFilterWarning. Null when we have nothing
   *  specific and true to say. */
  filterWarning: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  // ⚠️ Re-checked SERVER-SIDE (§69). This control is a courtesy; the route owns
  // the gate, and it refuses an UN-ACKNOWLEDGED purchase, never the purchase.
  const [acknowledged, setAcknowledged] = useState(false);

  async function buy() {
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/customer/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_type: leadType,
          acknowledge_filter: acknowledged,
        }),
      });
      const data = await res.json();

      if (data.status === "redirect" && data.url) {
        window.location.href = data.url as string;
        return;
      }
      if (data.status === "success") {
        setStatus("success");
        // Reflect the new balance from the server.
        router.refresh();
        return;
      }
      if (data.status === "pending") {
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

  return (
    <div className="rounded-xl border border-black/10 bg-white p-6">
      <div className="mb-1 text-sm font-medium text-foreground">{productLabel}</div>
      <div className="mb-4 text-sm text-muted-foreground">
        Current balance:{" "}
        <span
          className={
            balance === 0 ? "font-semibold text-amber-600" : "font-semibold text-foreground"
          }
        >
          {balance} lead{balance === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mb-4 rounded-lg border border-black/10 bg-muted/30 p-4 text-center">
        <div className="text-xl font-semibold text-foreground">
          +{credits} leads
        </div>
        <div className="mt-0.5 text-sm text-muted-foreground">
          {priceLabel} one-off
        </div>
      </div>

      {/* ⚠️ BEFORE the charge, not after. When the FILTER rather than the
          balance is what is holding delivery back, buying more credit does not
          help — and nothing in this path used to say so (topupFilterWarning).
          It warns and still allows: §16's rule is never to refuse a sale, and
          the credits do carry forward. */}
      {filterWarning && !blockedReason && status !== "success" && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          <p>
            {filterWarning}{" "}
            <Link
              href="/dashboard/filtering"
              className="font-medium underline underline-offset-2"
            >
              Review your filter
            </Link>
          </p>
          <label className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            <span>I have read this and want to buy the extra leads anyway.</span>
          </label>
        </div>
      )}

      {blockedReason ? (
        <p className="text-sm text-muted-foreground">{blockedReason}</p>
      ) : status === "success" ? (
        <div>
          <p className="text-sm font-medium text-foreground">
            Done — {credits} leads added to your balance.
          </p>
          {/* What they bought is a claim on future leads, not faster delivery.
              Stated plainly right after payment so expectations are set at the
              moment it matters. */}
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {deliveryNote}
          </p>
          {filterInForce && (
            <Link
              href="/dashboard/filtering"
              className="mt-2 inline-block text-xs font-medium underline underline-offset-2"
            >
              Review your lead filter
            </Link>
          )}
        </div>
      ) : status === "pending" ? (
        <p className="text-sm text-muted-foreground">{message}</p>
      ) : status === "confirming" ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Charge {priceLabel} to your card on file?
          </p>
          {/* Say it BEFORE the money moves too — telling someone only after
              they've paid that no timeframe is guaranteed is too late to be
              fair, and it matters most for filtered customers. */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {deliveryNote}
          </p>
          <div className="flex gap-2">
            <Button onClick={buy} className="flex-1">
              Confirm {priceLabel}
            </Button>
            <Button variant="outline" onClick={() => setStatus("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          {status === "error" && (
            <p className="mb-2 text-sm text-destructive">{message}</p>
          )}
          <Button
            onClick={() => setStatus("confirming")}
            disabled={
              status === "loading" || (filterWarning != null && !acknowledged)
            }
            className="w-full"
          >
            {status === "loading" ? "Processing…" : `Buy ${credits} leads`}
          </Button>
        </div>
      )}
    </div>
  );
}
