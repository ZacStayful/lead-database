"use client";

/**
 * The Allow / Cancel form.
 *
 * A plain form POST rather than fetch(), because the flow ENDS IN A 302 TO A
 * THIRD-PARTY ORIGIN. A fetch would follow that redirect itself and land the
 * authorization code in our own JavaScript instead of the client's callback.
 *
 * The nonce is the CSRF half of a double-submit pair: the page set the same
 * value as a cookie, and the route requires them to match. Without it, a page on
 * another origin could POST this form with the customer's session cookie
 * attached and silently authorise an application they never saw.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface ConsentFormProps {
  params: Record<string, string>;
  nonce: string;
  cancelUrl: string;
}

export function ConsentForm({ params, nonce, cancelUrl }: ConsentFormProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      method="POST"
      action="/api/oauth/authorize"
      onSubmit={() => setSubmitting(true)}
      className="space-y-3"
    >
      {Object.entries(params).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="consent_nonce" value={nonce} />

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Connecting…" : "Allow access"}
      </Button>

      {/* Cancel is a link to the client's callback carrying access_denied, not a
          dead end — a client left waiting on a window the customer closed has no
          way to tell refusal from a crash. */}
      <a
        href={cancelUrl}
        className="block w-full rounded-md border-[0.5px] border-border py-2 text-center text-sm text-muted-foreground hover:bg-muted/40"
      >
        Cancel
      </a>
    </form>
  );
}
