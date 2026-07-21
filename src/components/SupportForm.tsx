"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SupportForm({
  defaults,
}: {
  defaults?: { name?: string; email?: string; business?: string };
}) {
  const [form, setForm] = useState({
    name: defaults?.name ?? "",
    email: defaults?.email ?? "",
    business: defaults?.business ?? "",
    subject: "",
    message: "",
  });
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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
        <p className="text-sm font-medium text-brand">
          Thanks — your request has been sent.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The Stayful team has your message and will get back to you by email.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border-[0.5px] border-border bg-card p-6"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="su-name">Your name</Label>
          <Input id="su-name" value={form.name} onChange={update("name")} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="su-email">Your email</Label>
          <Input
            id="su-email"
            type="email"
            value={form.email}
            onChange={update("email")}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="su-business">Business name</Label>
        <Input id="su-business" value={form.business} onChange={update("business")} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="su-subject">Subject</Label>
        <Input
          id="su-subject"
          value={form.subject}
          onChange={update("subject")}
          required
          placeholder="What do you need help with?"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="su-message">Message</Label>
        <textarea
          id="su-message"
          value={form.message}
          onChange={update("message")}
          required
          rows={6}
          placeholder="Describe your issue or question in as much detail as you can."
          className="w-full resize-y rounded-md border-[0.5px] border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Sending…" : "Send support request"}
      </Button>
    </form>
  );
}
