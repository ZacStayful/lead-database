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
import { ukMobileE164, UK_MOBILE_ERRORS } from "@/lib/leadQuality";

/**
 * What the picker offers, in the order it offers it.
 *
 * The VALUES are the wire vocabulary the enquiry route narrows with
 * toLeadInterest() — deliberately the same hyphenated spelling every marketing
 * link into this page already uses in ?product=, so the URL and the form speak
 * one language.
 */
const LEAD_INTEREST_OPTIONS = [
  { value: "management", label: "Management", hint: "Landlords wanting a managing agent" },
  {
    value: "guaranteed-rent",
    label: "Guaranteed rent",
    hint: "Landlords open to a rent-to-rent deal",
  },
  { value: "both", label: "Both", hint: "You run both models" },
] as const;

type LeadInterestValue = (typeof LEAD_INTEREST_OPTIONS)[number]["value"];

const CALENDLY_URL = "https://calendly.com/zac-stayful/stayful-lead-database";

function EnquiryForm() {
  const params = useSearchParams();
  const productParam = params.get("product");
  const initialPlan = toPlanKey(params.get("plan"));

  // ?product= is EVIDENCE, not an answer: it is set only by the links on the
  // guaranteed-rent landing page, so it can seed the picker but must never be
  // the last word. Anyone arriving here from an ad, a shared link or the
  // management page carries nothing at all, and used to be filed as Management
  // silently with no way to say otherwise.
  //
  // Never seeded to "both" — that is a claim only the prospect can make.
  const initialInterest: LeadInterestValue =
    productParam === "guaranteed-rent" || productParam === "guaranteed_rent"
      ? "guaranteed-rent"
      : "management";

  const [leadInterest, setLeadInterest] =
    useState<LeadInterestValue>(initialInterest);
  const [plan, setPlan] = useState<PlanKey>(initialPlan);

  // Everything below keys on the CHOICE, never on the URL. Reading the URL here
  // is what would ask somebody who arrived from the management page and picked
  // Guaranteed rent how they currently get management leads.
  const wantsGuaranteedRent = leadInterest === "guaranteed-rent";
  const wantsBoth = leadInterest === "both";
  const [form, setForm] = useState({
    name: "",
    mobile: "",
    email: "",
    website_url: "",
    properties_managed: "",
    current_lead_source: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [mobileError, setMobileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function update(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      // Clear the mobile complaint the moment they start fixing it. Leaving it
      // up while they retype reads as the new number being wrong too.
      if (key === "mobile") setMobileError(null);
      setForm((f) => ({ ...f, [key]: e.target.value }));
    };
  }

  /**
   * Show what will actually be stored, before they submit.
   *
   * ⚠️ ON BLUR, NEVER ON EVERY KEYSTROKE. Rewriting a half-typed number as
   * somebody types it moves the caret and fights them; `07` would become `+447`
   * before they had finished the first field.
   *
   * The server re-derives this with the same function, so this is confirmation
   * rather than validation — a browser with the script broken still submits and
   * still gets the identical verdict from /api/enquiry.
   */
  function onMobileBlur(e: React.FocusEvent<HTMLInputElement>) {
    const typed = e.target.value.trim();
    if (!typed) return; // `required` already covers an empty field; don't nag.
    const result = ukMobileE164(typed);
    if (result.ok) {
      setMobileError(null);
      setForm((f) => ({ ...f, mobile: result.value }));
      return;
    }
    // Leave what they typed alone — it is theirs to correct, and blanking or
    // rewriting a number we could not read loses the digits they got right.
    setMobileError(UK_MOBILE_ERRORS[result.reason]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          plan,
          lead_interest: leadInterest,
          // Kept for anything still reading the old field. It cannot express
          // "both", which is why lead_interest exists.
          product: wantsGuaranteedRent ? "guaranteed-rent" : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
      // Enquiry saved — send them straight to book a call on Calendly.
      window.location.href = CALENDLY_URL;
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  // ---- Form ----------------------------------------------------------------
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <Link href="/" aria-label="Stayful home" className="flex justify-center">
          <Logo height={36} priority />
        </Link>
        <CardTitle className="pt-2">
          {wantsGuaranteedRent
            ? "Enquire about Guaranteed Rent"
            : "Enquire about access"}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Tell us about your business and we&apos;ll get you set up.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {/*
            First in the form, because everything below reacts to it. There is
            no "not sure" option and no blank state: one of the three is always
            selected, so the answer cannot be skipped by inattention.
          */}
          <div className="space-y-2">
            <Label>What kind of leads are you after?</Label>
            <div className="grid gap-2">
              {LEAD_INTEREST_OPTIONS.map((option) => {
                const selected = leadInterest === option.value;
                return (
                  <button
                    type="button"
                    key={option.value}
                    aria-pressed={selected}
                    onClick={() => setLeadInterest(option.value)}
                    className={
                      "rounded-md border p-3 text-left transition " +
                      (selected
                        ? "border-brand bg-brand/5 ring-1 ring-brand"
                        : "border-input hover:border-brand/50")
                    }
                  >
                    <div className="text-sm font-semibold">{option.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {option.hint}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          {/*
            Shown for every choice now. The two products are price-identical —
            PLANS and GR_PLANS are both £150/10 and £300/20, the same reason
            LEAD_PRICE_GBP needs no per-product branch — so these prices are
            right whichever service they picked.
          */}
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
              placeholder="07700 900123"
              value={form.mobile}
              onChange={update("mobile")}
              onBlur={onMobileBlur}
              required
              autoComplete="tel"
              aria-invalid={mobileError ? true : undefined}
              aria-describedby={mobileError ? "mobile-error" : undefined}
            />
            {mobileError ? (
              <p id="mobile-error" className="text-sm text-destructive">
                {mobileError}
              </p>
            ) : null}
          </div>
          {/* Optional, and asked of everybody — the column exists on the one
              board every enquiry now lands on, and GR operators have websites
              too. */}
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
          <div className="space-y-2">
            <Label htmlFor="current_lead_source">
              {wantsBoth
                ? "How do you currently get leads?"
                : wantsGuaranteedRent
                  ? "How do you currently get guaranteed rent leads?"
                  : "How do you currently get management leads?"}
            </Label>
            <Input
              id="current_lead_source"
              value={form.current_lead_source}
              onChange={update("current_lead_source")}
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
