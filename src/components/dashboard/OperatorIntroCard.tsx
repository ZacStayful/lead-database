"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MAX_INTRO_CHARS } from "@/lib/operatorIntro";

/**
 * How a landlord meets you (§41).
 *
 * ⚠️ THIS IS THE ONE PIECE OF OPERATOR IDENTITY THAT REACHES A LANDLORD IN
 * WORDS. Everything else we can say about an operator is a company name and a
 * phone number. Without this the referral email introduces "a local short-let
 * management company", which is true and says nothing.
 *
 * ⚠️ THE CARD EXPLAINS THE TWO REFUSALS BEFORE THEY HAPPEN. An operator who
 * types their fee in here gets a 400, and a rejection that does not name the
 * reason reads as the product being broken — the same argument BookingLinkCard
 * makes about links. Both rules are stated in the helper text, not just in the
 * error.
 *
 * 0131 added the four contact fields above the blurb. They are the rest of that
 * same email, so they belong on the same card: splitting them would put half
 * the answer on a card the customer has already scrolled past.
 *
 * ⚠️ AN EMPTY BOX IS NOT A BLANK VALUE, IT MEANS "USE MY ACCOUNT DETAILS", and
 * that is the whole reason each field is placeheld with the account value and
 * the preview below shows the resolved rows. A form of empty boxes with no
 * indication of what they fall back to is how a customer concludes their
 * details have been wiped.
 */

interface Preview {
  ok: boolean;
  error?: string;
  field?: string;
  subject?: string;
  rows?: { label: string; value: string }[];
}

export interface ReferralDetailsValue {
  referral_contact_name: string;
  referral_business_name: string;
  referral_phone: string;
  referral_email: string;
}

export function OperatorIntroCard({
  initial,
  businessName,
  details,
  account,
}: {
  initial: string | null;
  businessName: string | null;
  /** The stored overrides. Empty string = not overridden. */
  details: ReferralDetailsValue;
  /** What each field falls back to, shown as the placeholder. */
  account: {
    contact_name: string | null;
    business_name: string | null;
    phone: string | null;
    email: string | null;
  };
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [fields, setFields] = useState<ReferralDetailsValue>(details);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  const remaining = MAX_INTRO_CHARS - value.trim().length;

  // Debounced, and abandoned when the text moves on — a preview that lands
  // after the operator has kept typing describes details they no longer have.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/customer/settings/referral-details/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((d) => setPreview(d as Preview))
        .catch(() => undefined);
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [fields]);

  function set(key: keyof ReferralDetailsValue, next: string) {
    setFields((f) => ({ ...f, [key]: next }));
    setSaved(false);
    setBadField(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setBadField(null);
    setSaved(false);
    try {
      const res = await fetch("/api/customer/settings/operator-intro", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_intro: value.trim(), ...fields }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save that.");
        setBadField(typeof data.field === "string" ? data.field : null);
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const detailFields: {
    key: keyof ReferralDetailsValue;
    label: string;
    placeholder: string | null;
    type?: string;
  }[] = [
    { key: "referral_contact_name", label: "Your name", placeholder: account.contact_name },
    { key: "referral_business_name", label: "Company", placeholder: account.business_name },
    { key: "referral_phone", label: "Phone", placeholder: account.phone, type: "tel" },
    { key: "referral_email", label: "Email", placeholder: account.email, type: "email" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>How landlords meet you</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When a lead is assigned to you, we email the landlord to introduce you
          before you call. These are the details they see, and two or three
          sentences about who you are goes into that email and into the follow-up
          messages we draft for you.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {detailFields.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-sm font-medium">{f.label}</label>
              <Input
                type={f.type}
                value={fields[f.key]}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.placeholder ?? "Not set"}
                aria-invalid={badField === f.key || undefined}
              />
            </div>
          ))}
        </div>

        {/*
          The two things a customer cannot work out from the form itself: that
          blank falls back rather than blanks, and — the one that matters — that
          none of this repoints their login or their billing. §43 keeps that an
          admin action for good reasons, and a customer who assumed otherwise
          would have changed it here and wondered why they still log in with the
          old address.
        */}
        <p className="text-xs text-muted-foreground">
          Leave a box empty to use your account details. Changing these does not
          change the email address you log in with, or where your invoices and
          lead alerts go — ask us if you need those moved.
        </p>

        <div className="space-y-2">
          <label className="text-sm font-medium">In your words</label>
          <textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            rows={4}
            maxLength={MAX_INTRO_CHARS + 100}
            placeholder={
              businessName
                ? `We're ${businessName}. We look after short lets across the North East, and we've been doing it for six years.`
                : "We look after short lets across the North East, and we've been doing it for six years."
            }
            className="w-full rounded-md border border-input bg-background p-3 text-sm"
          />

          <p className="text-xs text-muted-foreground">
            {/*
              Both refusals, said before they are hit. The pricing one is not
              editorial: this text is also fed to the message drafter, which
              rejects any message quoting a fee — so an intro containing one would
              silently break every draft.
            */}
            Leave out pricing and links. This wording is used in messages as well
            as the email, and a fee or a URL in a first contact stops the message
            being sent. Your fee belongs in your presentation settings, and a
            booking link in Messaging.{" "}
            <span className={remaining < 0 ? "text-destructive" : undefined}>
              {remaining} characters left.
            </span>
          </p>
        </div>

        {/* ---- What the landlord actually gets --------------------------- */}
        {preview?.ok && (preview.rows?.length ?? 0) > 0 && (
          <div className="rounded-md bg-muted/50 p-3 text-xs">
            <p className="font-medium text-foreground">The landlord will see:</p>
            <p className="mt-1 text-muted-foreground">{preview.subject}</p>
            <table className="mt-2">
              <tbody>
                {preview.rows?.map((r) => (
                  <tr key={r.label}>
                    <td className="pr-3 align-top text-muted-foreground">{r.label}</td>
                    <td className="align-top text-foreground">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {preview && !preview.ok && preview.error && (
          <p className="text-sm text-destructive">{preview.error}</p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && <p className="text-sm text-emerald-700">Saved.</p>}

        <Button onClick={save} disabled={busy || remaining < 0}>
          {busy ? "Saving…" : "Save introduction"}
        </Button>
      </CardContent>
    </Card>
  );
}
