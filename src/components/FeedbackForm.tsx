"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FeedbackType = "feature" | "bug";

export function FeedbackForm({
  initialType = "feature",
  defaults,
}: {
  initialType?: FeedbackType;
  defaults?: { name?: string; email?: string; business?: string };
}) {
  const [type, setType] = useState<FeedbackType>(initialType);
  const [form, setForm] = useState({
    name: defaults?.name ?? "",
    email: defaults?.email ?? "",
    business: defaults?.business ?? "",
    subject: "",
    details: "",
    page: "",
  });
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof typeof form) {
    return (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not send");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-xl border-[0.5px] border-border bg-card p-6 text-center">
        <p className="text-sm font-medium text-brand">Thanks — that's been sent.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The Stayful team has your {type === "bug" ? "bug report" : "feature request"} and
          will be in touch if anything's needed.
        </p>
      </div>
    );
  }

  const isBug = type === "bug";

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border-[0.5px] border-border bg-card p-6"
    >
      {/* Type toggle */}
      <div className="flex gap-2">
        {(["feature", "bug"] as FeedbackType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={
              "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors " +
              (type === t
                ? "border-brand bg-brand/10 text-brand"
                : "border-border text-muted-foreground hover:bg-accent")
            }
          >
            {t === "feature" ? "Request a feature" : "Report a bug"}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="fb-name">Your name</Label>
          <Input id="fb-name" value={form.name} onChange={update("name")} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fb-email">Your email</Label>
          <Input
            id="fb-email"
            type="email"
            value={form.email}
            onChange={update("email")}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="fb-business">Business name</Label>
        <Input id="fb-business" value={form.business} onChange={update("business")} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="fb-subject">
          {isBug ? "What went wrong? (short summary)" : "What would you like? (short summary)"}
        </Label>
        <Input id="fb-subject" value={form.subject} onChange={update("subject")} required />
      </div>

      {isBug && (
        <div className="space-y-2">
          <Label htmlFor="fb-page">Which page or screen? (optional)</Label>
          <Input
            id="fb-page"
            value={form.page}
            onChange={update("page")}
            placeholder="e.g. Priority list, a lead's detail page"
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="fb-details">Details</Label>
        <textarea
          id="fb-details"
          value={form.details}
          onChange={update("details")}
          required
          rows={6}
          placeholder={
            isBug
              ? "What happened, what you were doing, and what you expected to happen."
              : "Describe the feature and how it would help you."
          }
          className="w-full resize-y rounded-md border-[0.5px] border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Sending…" : isBug ? "Send bug report" : "Send feature request"}
      </Button>
    </form>
  );
}
