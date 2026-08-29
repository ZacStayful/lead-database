"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * One booking link, and why it is the only one (§40.14).
 *
 * ⚠️ THE CARD HAS TO EXPLAIN THE REFUSAL IT EXISTS BECAUSE OF. An operator who
 * types a link into a follow-up gets it rejected, and a rejection that does not
 * name the alternative reads as the product being broken rather than as a rule.
 * So the reasoning sits here, where they come to fix it: a link in a cold
 * WhatsApp is the strongest single spam signal there is, and the number at risk
 * is theirs — one stored link inserted by name is safe where forty pasted ones
 * are not.
 */
export function BookingLinkCard({ initial }: { initial: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/customer/messaging/booking-link", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_link: value.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save that link.");
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
        <CardTitle>Your booking link</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Your Calendly, Cal.com or whatever you use. Once it is here you can
          drop it into a follow-up you write yourself, as{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {"{{booking_link}}"}
          </code>
          .
        </p>
        <p className="text-sm text-muted-foreground">
          It is the only way a link can go into a written follow-up. A link in a
          first message from an unknown number is the strongest signal WhatsApp
          has for spam, and the number at risk is yours — so one link you have
          checked is fine where forty pasted ones are not.
        </p>

        <div className="flex flex-wrap gap-2">
          <Input
            type="url"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            placeholder="https://cal.com/you/30min"
            className="sm:max-w-md"
          />
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && (
          <p className="text-sm text-muted-foreground">
            {value.trim()
              ? "Saved."
              : "Removed. Any follow-up still using it will now be skipped, so take the field out of those messages."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
