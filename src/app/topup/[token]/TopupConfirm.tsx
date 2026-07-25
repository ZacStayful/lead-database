"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

type Status = "idle" | "loading" | "success" | "error";

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
}: {
  token: string;
  credits: number;
  priceLabel: string;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function confirm() {
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch(`/api/topup/${encodeURIComponent(token)}`, {
        method: "POST",
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
        <p className="mb-4 text-sm font-medium text-[#1a1a19]">
          Payment confirmed — {credits} leads have been added to your balance.
        </p>
        <Button asChild className="w-full">
          <Link href="/dashboard">Go to your dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div>
      {status === "error" && (
        <p className="mb-3 text-center text-sm text-destructive">{message}</p>
      )}
      <Button
        onClick={confirm}
        disabled={status === "loading"}
        className="w-full"
      >
        {status === "loading"
          ? "Processing…"
          : `Confirm ${priceLabel} for ${credits} more leads`}
      </Button>
    </div>
  );
}
