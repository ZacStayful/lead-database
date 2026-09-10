"use client";

/**
 * The Allow / Cancel form.
 *
 * A plain form POST rather than fetch(), because the flow ENDS IN A 302 TO A
 * THIRD-PARTY ORIGIN. A fetch would follow that redirect itself and land the
 * authorization code in our own JavaScript instead of the client's callback.
 *
 * The nonce is the CSRF half of a double-submit pair: the same value is set as
 * a cookie, and the route requires them to match. Without it, a page on another
 * origin could POST this form with the customer's session cookie attached and
 * silently authorise an application they never saw.
 *
 * ⚠️ THE NONCE IS FETCHED, NOT PASSED IN, and that is not a style choice. The
 * page used to mint it and set the cookie itself, but cookies() is read-only in
 * a Server Component on Next 14 and .set() throws there — so every VALID
 * authorization request 500'd while both error paths rendered fine, because
 * they return before the write. A Route Handler may set cookies; a page may
 * not. Middleware would have been smaller and is not available: this project
 * keeps its app in src/ while middleware.ts sits at the repository root, so
 * Next never loads it.
 *
 * The cost, accepted knowingly: Allow now needs JavaScript. This was already a
 * client component and the whole flow is driven by an OAuth client, so nothing
 * reaches this screen without it.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export interface ConsentFormProps {
  params: Record<string, string>;
  cancelUrl: string;
}

type NonceState =
  | { status: "loading" }
  | { status: "ready"; nonce: string }
  | { status: "failed" };

export function ConsentForm({ params, cancelUrl }: ConsentFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const [nonce, setNonce] = useState<NonceState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/oauth/consent-nonce", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { nonce?: unknown };
        if (typeof body.nonce !== "string" || body.nonce.length === 0) {
          throw new Error("malformed");
        }
        if (!cancelled) setNonce({ status: "ready", nonce: body.nonce });
      } catch {
        // Deliberately no detail. Whatever went wrong, the only useful action
        // is to try again, and this screen is reached from another origin.
        if (!cancelled) setNonce({ status: "failed" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (nonce.status === "failed") {
    // ⚠️ Never render an armed button without a nonce. It would POST, be
    // refused with a 403 "this consent form has expired", and read to the
    // customer as us breaking rather than as something to retry.
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          We could not prepare this form. Please try again.
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            setNonce({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
        <a
          href={cancelUrl}
          className="block w-full rounded-md border-[0.5px] border-border py-2 text-center text-sm text-muted-foreground hover:bg-muted/40"
        >
          Cancel
        </a>
      </div>
    );
  }

  const ready = nonce.status === "ready";

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
      <input
        type="hidden"
        name="consent_nonce"
        value={ready ? nonce.nonce : ""}
      />

      <Button type="submit" className="w-full" disabled={!ready || submitting}>
        {submitting ? "Connecting…" : ready ? "Allow access" : "Preparing…"}
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
