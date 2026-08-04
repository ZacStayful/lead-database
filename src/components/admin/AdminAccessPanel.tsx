"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Mode = "link" | "password";
type Message = { tone: "ok" | "error"; text: string };

/**
 * Account access recovery for a single customer.
 *
 * Two actions, in the order they should be tried. The reset link is the normal
 * one and leaves the customer choosing their own password. Generating a
 * password is the failsafe for when the email does not land — and because it
 * overwrites whatever password the customer currently has, it asks first.
 *
 * The generated password is shown once, here, and is never stored: the response
 * that carries it is the only copy that will ever exist. Leaving this page
 * loses it, which is why the panel says so rather than letting an admin
 * discover it.
 */
export function AdminAccessPanel({
  customerId,
  email,
  hasLogin,
}: {
  customerId: string;
  email: string;
  /** False when the customer has no auth user yet — invite creates one. */
  hasLogin: boolean;
}) {
  const [busy, setBusy] = useState<Mode | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run(mode: Mode) {
    setBusy(mode);
    setMessage(null);
    setConfirming(false);
    if (mode === "password") setPassword(null);

    try {
      const res = await fetch(
        `/api/admin/customers/${customerId}/reset-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        }
      );
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setMessage({
          tone: "error",
          text: data?.error ?? "Something went wrong. Please try again.",
        });
        return;
      }

      if (mode === "password" && typeof data?.password === "string") {
        setPassword(data.password);
        setCopied(false);
        setMessage(null);
        return;
      }

      setMessage({ tone: "ok", text: `Reset link sent to ${email}` });
    } catch {
      setMessage({
        tone: "error",
        text: "Something went wrong. Please try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function copyPassword() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the password is on screen to be read.
      setCopied(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasLogin ? (
          <p className="text-sm text-muted-foreground">
            This customer has no login yet. Use the invite action, which creates
            one.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Send a reset link first. If it does not arrive, generate a
              password and pass it on directly.
            </p>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void run("link")}
                disabled={busy !== null}
                className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy === "link" ? "Sending" : "Send reset link"}
              </button>

              {!confirming ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(true);
                    setMessage(null);
                  }}
                  disabled={busy !== null}
                  className="rounded-md border-[0.5px] border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  Create a password
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void run("password")}
                    disabled={busy !== null}
                    className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                  >
                    {busy === "password"
                      ? "Setting"
                      : "Confirm — replace their password"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={busy !== null}
                    className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>

            {confirming && (
              <p className="text-sm text-muted-foreground">
                This replaces the password they have now. If they are mid-way
                through a reset of their own, it will undo it.
              </p>
            )}

            {password && (
              <div className="space-y-3 rounded-md border-[0.5px] border-border bg-muted/50 p-4">
                <p className="text-sm font-medium">
                  Password set for {email}
                </p>
                <p className="select-all font-mono text-lg tracking-wide">
                  {password}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void copyPassword()}
                    className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <span className="text-sm text-muted-foreground">
                    Shown once — it is not stored anywhere and leaving this page
                    loses it.
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Send it over something other than the inbox they cannot reach,
                  and ask them to change it once they are in.
                </p>
              </div>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
