"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { offerState, formatRemaining, type PostCallOffer } from "@/lib/postCallOffers";
import { Copy, Check, Ticket } from "lucide-react";

interface GenerateResult {
  promo_code_string: string;
  checkout_url_10: string;
  checkout_url_20: string;
  status: string;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** Distinct, clearly-labelled status badge per offer state. */
function OfferStatusBadge({ offer }: { offer: PostCallOffer }) {
  const state = offerState(offer);
  if (state.kind === "redeemed") {
    // The state Zac wants reliably visible — visually distinct (solid emerald).
    return (
      <Badge className="border-transparent bg-emerald-600 text-white">
        Discount applied — {state.plan ?? "?"}-lead plan
      </Badge>
    );
  }
  if (state.kind === "active") {
    return (
      <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800">
        Active — expires in {formatRemaining(state.expiresAt)}
      </Badge>
    );
  }
  if (state.kind === "expired_unused") {
    return (
      <Badge variant="outline" className="border-transparent bg-gray-100 text-gray-600">
        Expired — unused
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-transparent bg-gray-100 text-gray-500">
      No offer generated
    </Badge>
  );
}

export function PostCallOfferPanel({ offers }: { offers: PostCallOffer[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/post-call-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospect_name: name.trim() || null,
          prospect_email: email.trim(),
          prospect_phone: phone.trim() || null,
          source: "manual",
        }),
      });
      const data = (await res.json()) as GenerateResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not generate offer.");
        return;
      }
      setResult(data);
      router.refresh();
    } catch {
      setError("Could not generate offer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ticket className="h-4 w-4 text-brand" />
            Generate post-call discount link
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Creates a single-use <strong>15% off first month</strong> code, valid 24
            hours, that works on either plan. No customer record needed — send the
            prospect whichever plan link you agreed on the call.
          </p>
          <form onSubmit={generate} className="grid gap-3 sm:grid-cols-3">
            <input
              type="text"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm"
            />
            <input
              type="email"
              placeholder="Email (required)"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm"
            />
            <input
              type="tel"
              placeholder="Phone (optional)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm"
            />
            <div className="sm:col-span-3">
              <Button type="submit" disabled={busy} size="sm">
                {busy ? "Generating…" : "Generate discount link"}
              </Button>
            </div>
          </form>

          {error && (
            <div className="mt-4 rounded-md border-[0.5px] border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {result && (
            <div className="mt-4 space-y-3 rounded-lg border-[0.5px] border-border bg-muted/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Promo code</p>
                  <p className="font-mono text-lg font-bold tracking-wide">
                    {result.promo_code_string}
                  </p>
                </div>
                {result.status === "existing" && (
                  <Badge variant="muted">Existing active offer</Badge>
                )}
              </div>
              <div className="space-y-2">
                <LinkRow
                  label="10-lead plan link"
                  url={result.checkout_url_10}
                />
                <LinkRow
                  label="20-lead plan link"
                  url={result.checkout_url_20}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-lg border-[0.5px] border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Prospect</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {offers.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">
                  {o.prospect_name ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {o.prospect_email}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {o.promo_code_string}
                </TableCell>
                <TableCell>
                  <Badge variant="muted">
                    {o.source === "auto_monday" ? "Auto (Monday)" : "Manual"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <OfferStatusBadge offer={o} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(o.created_at)}
                </TableCell>
              </TableRow>
            ))}
            {offers.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  No post-call offers generated yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border-[0.5px] border-border bg-background px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{url}</p>
      </div>
      <CopyButton value={url} label="Copy" />
    </div>
  );
}
