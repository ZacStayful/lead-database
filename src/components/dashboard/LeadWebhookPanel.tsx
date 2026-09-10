"use client";

/**
 * Send us your own leads (§48) — support ticket STF-0009.
 *
 * The counterpart to ApiAccessPanel, in the other direction: that one hands out
 * a credential for READING, this one hands out a URL for CREATING. It follows
 * the same three conventions, and for the same reasons stated there — the URL
 * is shown once with the warning BEFORE the button rather than only after, the
 * snippet is the product (a URL on its own is a support ticket), and revoke
 * confirms inline because this app vendors no Dialog primitive.
 *
 * ⚠️ THE COPY MUST KEEP SAYING THAT NOTHING IS CHARGED. The whole reason a
 * bearer token in a URL path is proportionate here is that this door spends no
 * money (see src/lib/api/leadWebhooks.ts). A customer who believed it could buy
 * the £3 analysis unattended would treat the URL as far more dangerous than it
 * is — and, worse, somebody later reading the panel might make it true.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MAX_LEAD_WEBHOOKS_PER_CUSTOMER } from "@/lib/api/limits";
import type { LeadType } from "@/lib/types";

export interface LeadWebhookRow {
  id: string;
  name: string;
  lead_type: LeadType;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface Props {
  initialWebhooks: LeadWebhookRow[];
  /** Products this customer has run. Empty means the panel is not rendered. */
  availableProducts: LeadType[];
}

const PRODUCT_LABEL: Record<LeadType, string> = {
  management: "Management",
  guaranteed_rent: "Guaranteed Rent",
};

function when(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
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
          /* clipboard unavailable — the value is on screen to be read */
        }
      }}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

const PLACEHOLDER_URL =
  "https://leads.stayful.co.uk/api/webhook/customer-leads/sflw_xxxxxxxxxxxx";

export function LeadWebhookPanel({ initialWebhooks, availableProducts }: Props) {
  const router = useRouter();
  const [hooks, setHooks] = useState(initialWebhooks);
  const [name, setName] = useState("");
  const [leadType, setLeadType] = useState<LeadType>(availableProducts[0] ?? "management");
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);

  const live = hooks.filter((h) => !h.revoked_at);
  const atCeiling = live.length >= MAX_LEAD_WEBHOOKS_PER_CUSTOMER;
  const shown = url ?? PLACEHOLDER_URL;

  const curl = [
    `curl -X POST '${shown}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Idempotency-Key: YOUR-RECORD-ID' \\`,
    `  -d '{"name":"Jane Smith","phone":"07700 900123",`,
    `       "address":"12 Gill Avenue, Bristol","postcode":"BS16 2PH",`,
    `       "bedrooms":"3"}'`,
  ].join("\n");

  async function create() {
    setCreating(true);
    setError(null);
    setToast(null);
    try {
      const res = await fetch("/api/customer/lead-webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, lead_type: leadType }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not create the webhook.");
        return;
      }
      setUrl(data.url);
      setHooks((prev) => [data.webhook, ...prev]);
      setName("");
      router.refresh();
    } catch {
      setError("Could not create the webhook.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/customer/lead-webhooks/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not revoke the webhook.");
        return;
      }
      setHooks((prev) =>
        prev.map((h) => (h.id === id ? { ...h, revoked_at: data.webhook.revoked_at } : h))
      );
      setConfirmingRevoke(null);
      setToast("Webhook revoked. Anything posting to that URL has stopped working.");
      router.refresh();
    } catch {
      setError("Could not revoke the webhook.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send us your own leads</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Give Make, n8n or Zapier the address below and your own leads arrive
          here automatically — the same as typing one into{" "}
          <Link href="/dashboard/leads/add" className="text-brand hover:underline">
            Add a lead
          </Link>
          . They are free, unlimited, and visible only to you.
        </p>

        <p className="rounded-md border-[0.5px] border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          <strong className="text-foreground">Nothing is ever charged here.</strong>{" "}
          A lead arriving this way is created and nothing else. The reply tells
          you whether we could analyse the property, and running the analysis is
          still one click from the lead itself.
        </p>

        {/* Existing ---------------------------------------------------- */}
        {hooks.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Your webhooks</h3>
            {hooks.map((h) => (
              <div
                key={h.id}
                className="rounded-md border-[0.5px] border-border px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {h.name}{" "}
                      <Badge variant="outline" className="ml-1 align-middle">
                        {PRODUCT_LABEL[h.lead_type]}
                      </Badge>
                      {h.revoked_at && (
                        <Badge variant="outline" className="ml-1 align-middle">
                          Revoked
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Created {when(h.created_at)} · Last used {when(h.last_used_at)}
                    </p>
                  </div>
                  {!h.revoked_at && (
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmingRevoke(confirmingRevoke === h.id ? null : h.id)
                      }
                      className="text-xs font-medium text-destructive hover:underline"
                    >
                      Revoke
                    </button>
                  )}
                </div>

                {confirmingRevoke === h.id && (
                  <div className="mt-2 rounded-md border-[0.5px] border-border bg-muted/30 p-3 text-sm">
                    <p className="text-muted-foreground">
                      Anything posting to this URL stops working immediately, and
                      the URL cannot be recovered. Leads it has already created
                      are unaffected.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => revoke(h.id)}
                        className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground"
                      >
                        Revoke {h.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingRevoke(null)}
                        className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-xs font-medium"
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Create ------------------------------------------------------ */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Create a webhook</h3>
          <p className="text-xs text-muted-foreground">
            The URL is shown <strong>once</strong>. Copy it into your automation
            before you leave this page — we store only a hash of it and cannot
            show it again.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What is sending these? e.g. Make — approved enquiries"
              maxLength={80}
              className="min-w-[16rem] flex-1 rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
            />
            {availableProducts.length > 1 && (
              <select
                value={leadType}
                onChange={(e) => setLeadType(e.target.value as LeadType)}
                className="rounded-md border-[0.5px] border-border px-3 py-2 text-sm"
              >
                {availableProducts.map((p) => (
                  <option key={p} value={p}>
                    {PRODUCT_LABEL[p]}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={creating || atCeiling || name.trim().length === 0}
              onClick={create}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create webhook"}
            </button>
          </div>
          {atCeiling && (
            <p className="text-xs text-muted-foreground">
              You have {MAX_LEAD_WEBHOOKS_PER_CUSTOMER} active webhooks, which is
              the limit. Revoke one you are not using first.
            </p>
          )}
        </div>

        {url && (
          <div className="space-y-1 rounded-md border-[0.5px] border-brand/40 bg-brand/5 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                Your webhook URL — copy it now
              </span>
              <CopyButton value={url} label="Copy URL" />
            </div>
            <pre className="overflow-x-auto rounded-md border-[0.5px] border-border bg-background p-3 text-xs">
              {url}
            </pre>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {toast && <p className="text-sm text-muted-foreground">{toast}</p>}

        {/* How to use it ----------------------------------------------- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">How to send a lead</h3>
            <CopyButton value={curl} />
          </div>
          <pre className="overflow-x-auto rounded-md border-[0.5px] border-border bg-muted/40 p-3 text-xs leading-relaxed">
            {curl}
          </pre>
          <p className="text-xs text-muted-foreground">
            Every field is optional except that you must send at least one of{" "}
            <code>name</code>, <code>email</code>, <code>phone</code> or{" "}
            <code>address</code>. Send an <code>address</code>,{" "}
            <code>postcode</code> and <code>bedrooms</code> as well if you want
            the property analysed afterwards.
          </p>
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">The Idempotency-Key matters.</strong>{" "}
            Use the record id from your own system. If your automation times out
            and retries, we recognise the key and return the lead we already
            created instead of creating a second one.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
