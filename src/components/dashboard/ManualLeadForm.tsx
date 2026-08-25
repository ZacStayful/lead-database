"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProductChooser } from "./AddLeadsPanel";
import { analysability, describeIneligibility } from "@/lib/leadAnalysis";
import type { LeadType } from "@/lib/types";

interface FormState {
  name: string;
  email: string;
  phone: string;
  address: string;
  bedrooms: string;
  profile: string;
}

const EMPTY: FormState = {
  name: "",
  email: "",
  phone: "",
  address: "",
  bedrooms: "",
  profile: "",
};

/**
 * One lead, typed in.
 *
 * NOTHING IS REQUIRED, which is the whole brief for this form and is why there
 * is not a single `required` attribute below. An operator writing down a call
 * has whatever the landlord has said so far — often just a mobile number — and
 * forcing them to invent a name to get past validation is how rubbish gets into
 * a database. The one thing refused is a wholly blank submission, because there
 * would be nobody to ring and nothing to show in a list.
 *
 * Structurally this mirrors the public enquiry form at src/app/enquiry/page.tsx
 * (single form-state object, one generic change handler) with the validation
 * taken out.
 */
export function ManualLeadForm({ available }: { available: LeadType[] }) {
  const router = useRouter();
  const [leadType, setLeadType] = useState<LeadType>(available[0] ?? "management");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [runAnalysis, setRunAnalysis] = useState(false);

  const update =
    (key: keyof FormState) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [key]: event.target.value }));
      setError(null);
    };

  const hasSomething = Boolean(
    form.name.trim() || form.email.trim() || form.phone.trim() || form.address.trim()
  );

  /**
   * Can the analyser price this property, as the form stands right now?
   *
   * `analysability` is a pure function of the same fields the server will
   * check, so the checkbox enables and disables live as they type — and when it
   * is disabled it says exactly which field is missing rather than leaving them
   * to guess. Both helpers it uses are pure and safe on the client.
   */
  const analysable = useMemo(
    () => analysability({ address: form.address, bedrooms: form.bedrooms }),
    [form.address, form.bedrooms]
  );

  async function submit(event: React.FormEvent, thenAnother: boolean) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/customer/my-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          lead_type: leadType,
          // Only ever sent when the form itself says the property is runnable —
          // the server re-checks, but asking for something we already know will
          // be refused is a worse experience than not offering it.
          run_analysis: runAnalysis && analysable.ok,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not add that lead.");
        return;
      }

      // The lead is added at this point, whatever the analysis did.
      const outcome = data.analysis as
        | { status: string; message?: string; url?: string }
        | null
        | undefined;

      if (outcome?.status === "redirect" && outcome.url) {
        // No reusable card. Stripe's own page takes it from here; the lead is
        // already added and stays added whether or not they complete it.
        window.location.href = outcome.url;
        return;
      }

      if (outcome && outcome.status !== "success") {
        // Say what happened rather than swallowing it: the lead IS added, and
        // pretending the figures are running when they are not would be worse
        // than a plain sentence.
        setError(
          outcome.message
            ? `Lead added, but the figures didn't start: ${outcome.message} You can run them from the lead itself.`
            : "Lead added, but the figures didn't start. You can run them from the lead itself."
        );
        setForm(EMPTY);
        setRunAnalysis(false);
        setSavedCount((n) => n + 1);
        return;
      }

      if (thenAnother) {
        setForm(EMPTY);
        setRunAnalysis(false);
        setSavedCount((n) => n + 1);
      } else if (data.lead_id) {
        router.push(`/dashboard/leads/${data.lead_id}`);
      } else {
        router.push("/dashboard/leads");
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => submit(e, false)} className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Add one lead</h2>
        <p className="text-sm text-muted-foreground">
          Fill in whatever you have — nothing here is required. You can always
          add the rest later from the lead&rsquo;s own page.
        </p>
      </div>

      <ProductChooser
        available={available}
        value={leadType}
        onChange={setLeadType}
        disabled={saving}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="lead-name">Landlord name</Label>
          <Input id="lead-name" value={form.name} onChange={update("name")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-phone">Phone</Label>
          <Input
            id="lead-phone"
            value={form.phone}
            onChange={update("phone")}
            inputMode="tel"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-email">Email</Label>
          <Input
            id="lead-email"
            type="email"
            value={form.email}
            onChange={update("email")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-bedrooms">Bedrooms</Label>
          <Input
            id="lead-bedrooms"
            value={form.bedrooms}
            onChange={update("bedrooms")}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lead-address">Property address</Label>
          <Input
            id="lead-address"
            value={form.address}
            onChange={update("address")}
          />
          <p className="text-xs text-muted-foreground">
            Include the postcode if you have it — we use it to work out the area.
          </p>
        </div>

        {/*
          The upsell, directly under the two fields it depends on, so the
          reason it is disabled is next to the thing that would enable it.
          The lead is created FREE either way and before any charge is
          attempted, so a declined card never costs them the lead.
        */}
        <div className="sm:col-span-2">
          <label
            className={`flex items-start gap-2.5 rounded-lg border-[0.5px] p-3 ${
              analysable.ok
                ? "cursor-pointer border-border hover:bg-muted/40"
                : "border-border/60 opacity-70"
            }`}
          >
            <input
              type="checkbox"
              checked={runAnalysis && analysable.ok}
              disabled={!analysable.ok}
              onChange={(e) => setRunAnalysis(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
            />
            <span className="text-sm">
              <span className="font-medium">
                Run the estimated figures for this lead — £3
              </span>
              <span className="block text-muted-foreground">
                Projected occupancy, nightly rate, gross income and your
                management fee, with the full property analysis attached — the
                same figures a lead from us arrives with.
              </span>
              {!analysable.ok && (
                <span className="mt-1 block text-xs text-amber-700">
                  {describeIneligibility(analysable.code)}
                </span>
              )}
            </span>
          </label>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lead-profile">Notes</Label>
          <textarea
            id="lead-profile"
            value={form.profile}
            onChange={update("profile")}
            rows={4}
            className="flex w-full rounded-md border-[0.5px] border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            placeholder="Anything worth remembering — where they came from, what they are after, when to call back."
          />
        </div>
      </div>

      {error && (
        <p className="rounded-lg border-[0.5px] border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {savedCount > 0 && !error && (
        <p className="text-sm text-muted-foreground">
          {savedCount} lead{savedCount === 1 ? "" : "s"} added. They are in your
          leads list now.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving || !hasSomething}>
          {saving ? "Adding…" : "Add lead and open it"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={saving || !hasSomething}
          onClick={(e) => submit(e, true)}
        >
          Add and start another
        </Button>
      </div>

      {!hasSomething && (
        <p className="text-xs text-muted-foreground">
          Add at least a name, phone number, email or address so you have
          something to work with.
        </p>
      )}
    </form>
  );
}
