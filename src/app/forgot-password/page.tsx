"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

/**
 * The three outcomes the route can now distinguish (§43). It used to answer
 * every failure with "check your inbox" over an email that was never sent,
 * which cost a paying customer a day: she had signed up with a personal address
 * and was resetting with her business one.
 */
type Outcome = "sent" | "unknown_email" | "no_login";

const SUPPORT_EMAIL = "zac@stayful.co.uk";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recognised, setRecognised] = useState(false);

  // When a paid customer is redirected here from signup, prefill their email
  // and reassure them they're in the right place (no payment needed).
  useEffect(() => {
    try {
      const prefill = new URLSearchParams(window.location.search).get("email");
      if (prefill) {
        setEmail(prefill);
        setRecognised(true);
      }
    } catch {
      /* window unavailable — ignore */
    }
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const attempted = email.trim();

    // Goes through our own route, which mints the recovery link server-side and
    // delivers it via Resend. The browser must NOT call
    // supabase.auth.resetPasswordForEmail() here: that uses Supabase's built-in
    // mailer, whose shared test sender is capped at a couple of emails per hour
    // across the entire project, so a few retries by one customer locked
    // everybody out with "email rate limit exceeded".
    let message: string | null = null;
    let result: Outcome | null = null;
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: attempted }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; status?: Outcome }
        | null;

      if (!res.ok) {
        // Covers the 429 from the rate limiter and the 500s from a transport or
        // configuration failure. Both name the actual condition.
        message =
          body?.error ??
          "Something went wrong sending your reset email. Please contact support.";
      } else {
        result = body?.status ?? "sent";
      }
    } catch {
      message =
        "We couldn't reach the server. Check your connection and try again.";
    }

    if (message) {
      setError(message);
      setLoading(false);
      return;
    }
    setSubmitted(attempted);
    setOutcome(result);
    setLoading(false);
  }

  function reset() {
    setOutcome(null);
    setError(null);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Link href="/" aria-label="Stayful home" className="flex justify-center">
            <Logo height={36} priority />
          </Link>
          <CardTitle className="pt-2">Reset your password</CardTitle>
        </CardHeader>
        <CardContent>
          {outcome === "sent" ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                We&apos;ve sent a link to <strong>{submitted}</strong> to reset
                your password. Check your inbox (and spam folder).
              </p>
              <Link
                href="/login"
                className="block text-sm text-brand hover:underline"
              >
                Back to log in
              </Link>
            </div>
          ) : outcome === "unknown_email" ? (
            <div className="space-y-4">
              <div className="rounded-md border-[0.5px] border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <p className="font-semibold">
                  We don&apos;t recognise {submitted}.
                </p>
                <p className="mt-1">
                  You may have signed up with a different address — a personal
                  one rather than your business one is the usual reason. Try any
                  other address you might have used, or email us at{" "}
                  <a
                    href={`mailto:${SUPPORT_EMAIL}`}
                    className="underline underline-offset-2"
                  >
                    {SUPPORT_EMAIL}
                  </a>{" "}
                  and we&apos;ll find your account.
                </p>
              </div>
              <Button variant="outline" className="w-full" onClick={reset}>
                Try another email
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <Link href="/login" className="text-brand hover:underline">
                  Back to log in
                </Link>
              </p>
            </div>
          ) : outcome === "no_login" ? (
            <div className="space-y-4">
              <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                <p className="font-semibold text-foreground">
                  {submitted} is on our records, but it doesn&apos;t have a
                  login yet.
                </p>
                <p className="mt-1">
                  If you&apos;ve already paid, email us at{" "}
                  <a
                    href={`mailto:${SUPPORT_EMAIL}`}
                    className="underline underline-offset-2"
                  >
                    {SUPPORT_EMAIL}
                  </a>{" "}
                  and we&apos;ll set one up for you.
                </p>
              </div>
              <Button variant="outline" className="w-full" onClick={reset}>
                Try another email
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Haven&apos;t signed up yet?{" "}
                <Link href="/signup" className="text-brand hover:underline">
                  Apply for access
                </Link>
              </p>
            </div>
          ) : (
            <>
              {recognised && (
                <p className="mb-4 rounded-md bg-brand/10 px-3 py-2 text-sm text-brand">
                  You already have an account — no payment needed. Confirm your
                  email below and we&apos;ll send a link to set your password.
                </p>
              )}
              <p className="mb-4 text-sm text-muted-foreground">
                Enter your email and we&apos;ll send you a link to set a new
                password.
              </p>
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Sending…" : "Send reset link"}
                </Button>
              </form>
              <p className="mt-4 text-center text-sm text-muted-foreground">
                Remembered it?{" "}
                <Link href="/login" className="text-brand hover:underline">
                  Log in
                </Link>
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
