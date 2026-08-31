"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MAX_INTRO_CHARS } from "@/lib/operatorIntro";

/**
 * How a landlord meets you (§41).
 *
 * ⚠️ THIS IS THE ONE PIECE OF OPERATOR IDENTITY THAT REACHES A LANDLORD IN
 * WORDS. Everything else we can say about an operator is a company name and a
 * phone number. Without this the referral email introduces "a local short-let
 * management company", which is true and says nothing.
 *
 * ⚠️ THE CARD EXPLAINS THE TWO REFUSALS BEFORE THEY HAPPEN. An operator who
 * types their fee in here gets a 400, and a rejection that does not name the
 * reason reads as the product being broken — the same argument BookingLinkCard
 * makes about links. Both rules are stated in the helper text, not just in the
 * error.
 */
export function OperatorIntroCard({
  initial,
  businessName,
}: {
  initial: string | null;
  businessName: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const remaining = MAX_INTRO_CHARS - value.trim().length;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/customer/settings/operator-intro", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_intro: value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save that.");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>How landlords meet you</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          When a lead is assigned to you, we email the landlord to introduce you
          before you call. Two or three sentences about who you are goes into
          that email, and into the follow-up messages we draft for you.
        </p>

        <textarea
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          rows={4}
          maxLength={MAX_INTRO_CHARS + 100}
          placeholder={
            businessName
              ? `We're ${businessName}. We look after short lets across the North East, and we've been doing it for six years.`
              : "We look after short lets across the North East, and we've been doing it for six years."
          }
          className="w-full rounded-md border border-input bg-background p-3 text-sm"
        />

        <p className="text-xs text-muted-foreground">
          {/*
            Both refusals, said before they are hit. The pricing one is not
            editorial: this text is also fed to the message drafter, which
            rejects any message quoting a fee — so an intro containing one would
            silently break every draft.
          */}
          Leave out pricing and links. This wording is used in messages as well
          as the email, and a fee or a URL in a first contact stops the message
          being sent. Your fee belongs in your presentation settings, and a
          booking link in Messaging.{" "}
          <span className={remaining < 0 ? "text-destructive" : undefined}>
            {remaining} characters left.
          </span>
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && <p className="text-sm text-emerald-700">Saved.</p>}

        <Button onClick={save} disabled={busy || remaining < 0}>
          {busy ? "Saving…" : "Save introduction"}
        </Button>
      </CardContent>
    </Card>
  );
}
