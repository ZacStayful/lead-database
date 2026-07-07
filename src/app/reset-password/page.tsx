"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { Eye, EyeOff } from "lucide-react";

type Status = "verifying" | "ready" | "invalid";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("verifying");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // On arrival from the email link, the Supabase client auto-exchanges the
  // recovery code in the URL for a session (detectSessionInUrl). Wait for that
  // session before allowing a new password to be set.
  useEffect(() => {
    const supabase = createClient();
    let done = false;
    const ready = () => {
      if (!done) {
        done = true;
        setStatus("ready");
      }
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) ready();
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) ready();
    });

    // If no recovery session materialises, the link was invalid or expired.
    const q = new URLSearchParams(window.location.search);
    const linkError = q.get("error_description") || q.get("error");
    const timer = setTimeout(() => {
      if (!done) {
        setError(
          linkError ||
            "This reset link is invalid or has expired. Please request a new one."
        );
        setStatus("invalid");
      }
    }, 4000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // The recovery session is now an authenticated session — send them to the
    // right place based on their role.
    const { data } = await supabase.auth.getUser();
    const role = data.user?.app_metadata?.role as string | undefined;
    router.push(role === "admin" ? "/admin" : "/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Link href="/" aria-label="Stayful home" className="flex justify-center">
            <Logo height={36} priority />
          </Link>
          <CardTitle className="pt-2">Set a new password</CardTitle>
        </CardHeader>
        <CardContent>
          {status === "verifying" && (
            <p className="text-center text-sm text-muted-foreground">
              Verifying your reset link…
            </p>
          )}

          {status === "invalid" && (
            <div className="space-y-4 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Link
                href="/forgot-password"
                className="block text-sm text-brand hover:underline"
              >
                Request a new reset link
              </Link>
            </div>
          )}

          {status === "ready" && (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={show ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={show ? "Hide password" : "Show password"}
                    tabIndex={-1}
                  >
                    {show ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">Confirm new password</Label>
                <Input
                  id="confirm"
                  type={show ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Saving…" : "Set new password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
