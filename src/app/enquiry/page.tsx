"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { PLANS, toPlanKey, type PlanKey } from "@/lib/plans";

const CALENDLY_URL = "https://calendly.com/zac-stayful/stayful-lead-database";

type Result = { hasCapacity: boolean } | null;

function EnquiryForm() {
  const params = useSearchParams();
  const initialPlan = toPlanKey(params.get("plan"));

  const [plan, setPlan] = useState<PlanKey>(initialPlan);
  const [form, setForm] = useState({
    name: "",
    mobile: "",
    email: "",
    website_url: "",
    properties_managed: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result>(null);

  function update(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, plan }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
      setResult({ hasCapacity: Boolean(data.hasCapacity) });
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  // ---- Result states -------------------------------------------------------
  if (result) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Link href="/" aria-label="Stayful home" className="flex justify-center">
            <Logo height={36} priority />
          </Link>
          <CardTitle className="pt-2">
            {result.hasCapacity ? "Let's book your call" : "You're on the list"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          {result.hasCapacity ? (
            <>
              <p className="text-sm text-muted-foreground">
                Thanks {form.name.split(" ")[0]} — we&apos;ve got a space open.
                Book a quick call with Zac to get set up and start receiving
                leads.
              </p>
              <a
                href={CALENDLY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block w-full rounded-md bg-brand px-6 py-3 text-center text-sm font-semibold text-white hover:opacity-90"
              >
                Book your call
              </a>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Thanks {form.name.split(" ")[0]} — we&apos;re currently at full
              capacity. We&apos;ve saved your details and Zac will be in touch as
              soon as a space opens up.
            </p>
          )}
          <Link
            href="/"
            className="block text-sm text-brand hover:underline"
          >
            Back to home
          </Link>
        </CardContent>
      </Card>
    );
  }

  // ---- Form ----------------------------------------------------------------
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <Link href="/" aria-label="Stayful home" className="flex justify-center">
          <Logo height={36} priority />
        </Link>
        <CardTitle className="pt-2">Enquire about access</CardTitle>
        <p className="text-sm text-muted-foreground">
          Tell us about your business and we&apos;ll get you set up.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Plan</Label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PLANS) as PlanKey[]).map((key) => {
                const p = PLANS[key];
                const selected = plan === key;
                return (
                  <button
                    type="button"
                    key={key}
                    onClick={() => setPlan(key)}
                    className={
                      "rounded-md border p-3 text-left transition " +
                      (selected
                        ? "border-brand bg-brand/5 ring-1 ring-brand"
                        : "border-input hover:border-brand/50")
                    }
                  >
                    <div className="text-base font-semibold">
                      £{p.priceGbp}
                      <span className="text-xs font-normal text-muted-foreground">
                        {" "}
                        /mo
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {p.leads} leads / month
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <Input id="name" value={form.name} onChange={update("name")} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={form.email}
              onChange={update("email")}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mobile">Mobile</Label>
            <Input
              id="mobile"
              type="tel"
              value={form.mobile}
              onChange={update("mobile")}
              required
              autoComplete="tel"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="website_url">Website URL</Label>
            <Input
              id="website_url"
              type="text"
              inputMode="url"
              placeholder="e.g. stayful.co.uk"
              value={form.website_url}
              onChange={update("website_url")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="properties_managed">
              How many properties do you currently manage?
            </Label>
            <Input
              id="properties_managed"
              value={form.properties_managed}
              onChange={update("properties_managed")}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Submitting…" : "Submit enquiry"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-brand hover:underline">
            Log in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function EnquiryPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Suspense fallback={null}>
        <EnquiryForm />
      </Suspense>
    </main>
  );
}
