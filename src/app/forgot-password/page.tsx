"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // Land on the server callback, which exchanges the code for a session
      // and sets the auth cookies before forwarding to the reset form. This is
      // far more reliable than exchanging the code purely client-side.
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });

    // Don't reveal whether an account exists — always show the same confirmation
    // on success. Surface only genuine configuration/transport errors.
    if (error) {
      const status = (error as { status?: number }).status;
      const msg = error.message?.toLowerCase() ?? "";
      const rateLimited =
        status === 429 ||
        msg.includes("rate limit") ||
        msg.includes("you can only request");
      setError(
        rateLimited
          ? "We can only send a limited number of reset emails per hour, and that limit has just been reached. Please wait about an hour and try again."
          : error.message
      );
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
