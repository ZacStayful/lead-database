"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
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

    // Goes through our own route, which mints the recovery link server-side and
    // delivers it via Resend. The browser must NOT call
    // supabase.auth.resetPasswordForEmail() here: that uses Supabase's built-in
    // mailer, whose shared test sender is capped at a couple of emails per hour
    // across the entire project, so a few retries by one customer locked
    // everybody out with "email rate limit exceeded".
    let message: string | null = null;
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        message =
          body?.error ??
          "Something went wrong sending your reset email. Please contact support.";
      }
    } catch {
      message =
        "We couldn't reach the server. Check your connection and try again.";
    }

    // Don't reveal whether an account exists — an unknown address still shows
    // the same confirmation. Surface only genuine transport failures.
    if (message) {
      setError(message);
      setLoading(false);
      return;
    }
    setSent(true);
    setLoading(false);
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
          {sent ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                If an account exists for <strong>{email.trim()}</strong>,
                we&apos;ve sent a link to reset your password. Check your inbox
                (and spam folder).
              </p>
              <Link
                href="/login"
                className="block text-sm text-brand hover:underline"
              >
                Back to log in
              </Link>
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
