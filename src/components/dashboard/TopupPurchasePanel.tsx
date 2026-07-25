"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
}: {
  leadType: LeadType;
  productLabel: string;
  balance: number;
  credits: number;
  priceLabel: string;
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function buy() {
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/customer/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_type: leadType }),
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

      {blockedReason ? (
        <p className="text-sm text-muted-foreground">{blockedReason}</p>
      ) : status === "success" ? (
        <p className="text-sm font-medium text-foreground">
          Done — {credits} leads added to your balance.
        </p>
      ) : status === "pending" ? (
        <p className="text-sm text-muted-foreground">{message}</p>
      ) : status === "confirming" ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Charge {priceLabel} to your card on file?
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
            disabled={status === "loading"}
            className="w-full"
          >
            {status === "loading" ? "Processing…" : `Buy ${credits} leads`}
          </Button>
        </div>
      )}
    </div>
  );
}
