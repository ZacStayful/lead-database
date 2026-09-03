"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Message = { tone: "ok" | "error"; text: string };

type ChangeResponse = {
  ok?: boolean;
  email?: string;
  previousEmail?: string;
  stripe?: "updated" | "failed" | "none";
  identity?: "updated" | "stale" | "unknown";
  ownerWarning?: boolean;
  error?: string;
};

/**
 * Change the address a customer logs in with (§43).
 *
 * Two-step confirm, as the password panel beside it: this repoints a login and
 * updates the billing record, and one stray click should not do that.
 *
 * The response's `stripe` and `identity` fields are surfaced verbatim rather
 * than folded into "done". A Stripe failure deliberately does not unwind the
 * change, so the admin is the one who has to know it happened — and the
 * identity row is a GoTrue-version-dependent unknown the route reads back
 * rather than assumes.
 */
export function AdminEmailPanel({
  customerId,
  email,
  hasLogin,
}: {
  customerId: string;
  email: string;
  /** False when the customer has no auth user yet — invite creates one. */
  hasLogin: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  async function run() {
    setBusy(true);
    setMessage(null);
    setNotes([]);

    try {
      const res = await fetch(`/api/admin/customers/${customerId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = (await res.json().catch(() => null)) as ChangeResponse | null;

      if (!res.ok) {
        setMessage({
          tone: "error",
          text: data?.error ?? "Something went wrong. Please try again.",
        });
        return;
      }

      const extra: string[] = [];
      if (data?.stripe === "failed") {
        extra.push(
          "Stripe was NOT updated — their invoices still go to the old address. " +
            "Fix it in Stripe, or the next unmatched invoice can create a duplicate account."
        );
      }
      if (data?.stripe === "none") {
        extra.push("No Stripe customer on this account, so nothing to update there.");
      }
      if (data?.identity === "stale") {
        extra.push(
          "Their Supabase identity record still holds the old address. The login works, but flag this."
        );
      }
      if (data?.ownerWarning) {
        extra.push(
          "This address was on OWNER_EMAILS. Update that env var if they should keep owner access at signup."
        );
      }

      setNotes(extra);
      setMessage({
        tone: "ok",
        text: `Login changed to ${data?.email ?? value}. They sign in with that from now on — tell them.`,
      });
      setValue("");
      setConfirming(false);
      router.refresh();
    } catch {
      setMessage({
        tone: "error",
        text: "Couldn't reach the server. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  const trimmed = value.trim();
  const ready = trimmed.length > 0 && trimmed.toLowerCase() !== email.toLowerCase();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email address</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasLogin ? (
          <p className="text-sm text-muted-foreground">
            This customer has no login yet, so there is no email to move. Use the
            invite action, which creates one.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              They currently sign in with{" "}
              <span className="font-medium text-foreground">{email}</span>.
              Changing it updates their login, their record and Stripe together.
            </p>

            <div className="space-y-2">
              <label
                htmlFor="new-email"
                className="text-sm font-medium leading-none"
              >
                New email
              </label>
              <input
                id="new-email"
                type="email"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  // A changed address invalidates the thing being confirmed.
                  setConfirming(false);
                }}
                autoComplete="off"
                placeholder="them@theirbusiness.co.uk"
                className="flex h-9 w-full rounded-md border-[0.5px] border-border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                disabled={busy}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {!confirming ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(true);
                    setMessage(null);
                  }}
                  disabled={busy || !ready}
                  className="rounded-md border-[0.5px] border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  Change email
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void run()}
                    disabled={busy}
                    className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                  >
                    {busy ? "Changing" : "Confirm — this changes their login"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                    className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>

            {confirming && (
              <p className="text-sm text-muted-foreground">
                They will no longer be able to sign in with {email}. Nothing is
                emailed to them — tell them yourself.
              </p>
            )}

            {message && (
              <p
                className={
                  "text-sm " +
                  (message.tone === "error"
                    ? "text-red-700"
                    : "text-muted-foreground")
                }
              >
                {message.text}
              </p>
            )}

            {notes.length > 0 && (
              <ul className="space-y-1 rounded-md border-[0.5px] border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
