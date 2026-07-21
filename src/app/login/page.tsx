"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const REMEMBER_KEY = "stayful:rememberedEmail";

  // Pre-fill the email from the last "remember me" login. We never store the
  // password — the browser's password manager handles that securely.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REMEMBER_KEY);
      if (saved) {
        setEmail(saved);
        setRemember(true);
      }
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Read the live field values from the form, not just React state — browser
    // password-manager autofill doesn't always fire onChange, which would
    // otherwise submit an empty password.
    const fd = new FormData(e.currentTarget);
    const emailVal = (String(fd.get("email") ?? email)).trim();
    const passwordVal = String(fd.get("password") ?? password);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: emailVal,
      password: passwordVal,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Remember (or forget) the email for next time — never the password.
    try {
      if (remember) {
        window.localStorage.setItem(REMEMBER_KEY, emailVal);
      } else {
        window.localStorage.removeItem(REMEMBER_KEY);
      }
    } catch {
      /* ignore */
    }

    const role = data.user?.app_metadata?.role as string | undefined;
    const redirectedFrom = params.get("redirectedFrom");
    // Only follow same-site paths — never an absolute URL from the query string.
    const safeRedirect =
      redirectedFrom && redirectedFrom.startsWith("/") && !redirectedFrom.startsWith("//")
        ? redirectedFrom
        : null;
    const target =
      safeRedirect ?? (role === "admin" ? "/admin" : "/dashboard");
    router.push(target);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Link href="/" aria-label="Stayful home" className="flex justify-center">
            <Logo height={36} priority />
          </Link>
          <CardTitle className="pt-2">Log in to your portal</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-brand"
              />
              Remember my email on this device
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Log in"}
            </Button>
          </form>
          <p className="mt-3 text-center text-sm">
            <Link
              href="/forgot-password"
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              Forgot your password?
            </Link>
          </p>
          <p className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-center text-sm text-muted-foreground">
            First time signing in, or already paid but never set a password?{" "}
            <Link href="/forgot-password" className="text-brand hover:underline">
              Set your password
            </Link>{" "}
            — no payment needed.
          </p>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/signup" className="text-brand hover:underline">
              Apply for access
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
