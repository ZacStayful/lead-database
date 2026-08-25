"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProductChooser } from "./AddLeadsPanel";
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

  const update =
    (key: keyof FormState) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [key]: event.target.value }));
      setError(null);
    };

  const hasSomething = Boolean(
    form.name.trim() || form.email.trim() || form.phone.trim() || form.address.trim()
  );

  async function submit(event: React.FormEvent, thenAnother: boolean) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/customer/my-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, lead_type: leadType }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not add that lead.");
        return;
      }

      if (thenAnother) {
        setForm(EMPTY);
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
