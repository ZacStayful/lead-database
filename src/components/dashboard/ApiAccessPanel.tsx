"use client";

/**
 * API access — mint a key, see what your integrations are doing, revoke.
 *
 * Three things here are load-bearing rather than decorative:
 *
 *  1. THE KEY IS SHOWN ONCE, and the warning says so BEFORE the button is
 *     pressed rather than only in the result block. Following AdminAccessPanel,
 *     which does the same for a generated password.
 *  2. THE SNIPPETS ARE THE PRODUCT. A key on its own is a support ticket; a key
 *     with a working curl, an n8n config and an MCP block is an integration.
 *     They are rendered with the real key while it is on screen, and with a
 *     placeholder afterwards.
 *  3. REVOKE CONFIRMS INLINE, not in a modal. There is no Dialog primitive in
 *     this app and not one modal anywhere in it; a two-button swap would ask
 *     "are you sure" while adding no information, so the expanded block states
 *     the consequence — that anything using this key stops working immediately.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SCOPE_LABELS, type ApiScope } from "@/lib/api/scopes";
import { MAX_KEYS_PER_CUSTOMER } from "@/lib/api/limits";

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface KeyUsage {
  /** Requests in the last 24 hours, summed from the rate-limit windows. */
  last24h: number;
  /** Requests over the last 30 days, from the daily rollup. */
  last30d: number;
}

interface Props {
  apiBaseUrl: string;
  mcpUrl: string;
  initialKeys: ApiKeyRow[];
  usage: Record<string, KeyUsage>;
  recent: RecentRequest[];
}

export interface RecentRequest {
  request_id: string;
  surface: string;
  operation: string;
  status_code: number;
  error_code: string | null;
  created_at: string;
}

const EXPIRY_CHOICES = [
  { label: "No expiry", days: null },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

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

function when(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function Snippet({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <CopyButton value={body} />
      </div>
      <pre className="overflow-x-auto rounded-md border-[0.5px] border-border bg-muted/40 p-3 text-xs leading-relaxed">
        {body}
      </pre>
    </div>
  );
}

export function ApiAccessPanel({
  apiBaseUrl,
  mcpUrl,
  initialKeys,
  usage,
  recent,
}: Props) {
  const router = useRouter();
  const [keys, setKeys] = useState(initialKeys);
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const live = keys.filter((k) => !k.revoked_at);
  const atCeiling = live.length >= MAX_KEYS_PER_CUSTOMER;
  const shown = secret ?? "sfl_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

  async function create() {
    setCreating(true);
    setError(null);
    setToast(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/customer/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, expires_in_days: expiryDays }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not create the key.");
        return;
      }
      setSecret(data.secret);
      setKeys((prev) => [data.key, ...prev]);
      setName("");
      router.refresh();
    } catch {
      setError("Could not create the key.");
    } finally {
      setCreating(false);
    }
  }

  /**
   * Calls the real endpoint with the real key, same origin.
   *
   * This is the only place a key ever touches a browser, and it is the key the
   * browser has just been handed — so nothing is exposed that was not already
   * on screen. It catches a mis-copied key now rather than an hour into
   * debugging a workflow.
   */
  async function testKey() {
    if (!secret) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/v1/me", {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const data = await res.json();
      setTestResult(
        res.ok
          ? `Working — ${data?.customer?.business_name ?? "account"}, ${
              data?.products?.length ?? 0
            } product(s).`
          : `Failed: ${data?.error?.message ?? res.status}`
      );
    } catch {
      setTestResult("Failed: could not reach the API.");
    } finally {
      setTesting(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/customer/api-keys/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not revoke the key.");
        return;
      }
      setKeys((prev) =>
        prev.map((k) => (k.id === id ? { ...k, revoked_at: data.key.revoked_at } : k))
      );
      setConfirmingRevoke(null);
      setToast("Key revoked. Anything using it has stopped working.");
      router.refresh();
    } catch {
      setError("Could not revoke the key.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API and MCP access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Read your own leads from your own tools — n8n, a script, or an AI
          assistant. Access is <strong>read-only</strong>: a key can see your
          leads and your account, and cannot change anything, spend credits or
          touch your subscription.
        </p>

        {/* Somebody arriving here to mint a key should find out they may not
            need one: Claude and ChatGPT connect by signing in. */}
        <p className="rounded-md border-[0.5px] border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          <strong className="text-foreground">Connecting Claude or ChatGPT?</strong>{" "}
          You do not need a key — paste the MCP address into the assistant and
          sign in.{" "}
          <Link href="/dashboard/api" className="text-brand hover:underline">
            How to connect an assistant
          </Link>
          . A key is for things that run unattended, with no browser to sign in
          with.
        </p>

        {/* Connections — the two front doors, side by side. */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Connections</h3>
          {[
            { label: "REST API", url: apiBaseUrl, note: "For n8n, Make, or your own code." },
            { label: "MCP server", url: mcpUrl, note: "For Claude, Cursor and other AI clients." },
          ].map((c) => (
            <div
              key={c.label}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border-[0.5px] border-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{c.url}</p>
                <p className="text-xs text-muted-foreground">{c.note}</p>
              </div>
              <CopyButton value={c.url} label="Copy URL" />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            <Link href="/dashboard/api" className="text-brand hover:underline">
              Read the API reference
            </Link>{" "}
            for the full field list, filters and setup notes per client.
          </p>
        </div>

        {/* Create */}
        <div className="space-y-3 rounded-md border-[0.5px] border-border p-4">
          <h3 className="text-sm font-medium">Create a key</h3>
          <p className="text-xs text-muted-foreground">
            The key is shown <strong>once</strong>, when it is created. We store
            only a fingerprint of it, so it cannot be shown again and leaving
            this page loses it.
          </p>

          <div className="flex flex-wrap gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="What is it for? e.g. n8n CRM sync"
              className="min-w-[220px] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <select
              value={expiryDays === null ? "none" : String(expiryDays)}
              onChange={(e) =>
                setExpiryDays(e.target.value === "none" ? null : Number(e.target.value))
              }
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.label} value={c.days === null ? "none" : String(c.days)}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating || name.trim().length === 0 || atCeiling}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create key"}
            </button>
          </div>

          {atCeiling && (
            <p className="text-xs text-muted-foreground">
              You are holding the maximum of {MAX_KEYS_PER_CUSTOMER} active keys.
              Revoke one you are not using to create another.
            </p>
          )}
        </div>

        {/* The one and only sight of the secret */}
        {secret && (
          <div className="space-y-3 rounded-md border-[0.5px] border-border bg-muted/50 p-4">
            <p className="text-sm font-medium">Your new API key</p>
            <p className="select-all break-all font-mono text-sm">{secret}</p>
            <div className="flex flex-wrap items-center gap-3">
              <CopyButton value={secret} label="Copy key" />
              <button
                type="button"
                onClick={() => void testKey()}
                disabled={testing}
                className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                {testing ? "Testing…" : "Test this key"}
              </button>
              <span className="text-xs text-muted-foreground">
                Shown once — it is not stored anywhere and leaving this page loses it.
              </span>
            </div>
            {testResult && <p className="text-sm">{testResult}</p>}
          </div>
        )}

        {/* Snippets — real key while it is on screen, placeholder afterwards. */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">
            Getting started{!secret && " (replace the placeholder with your key)"}
          </h3>
          <Snippet
            title="curl"
            body={`curl -H "Authorization: Bearer ${shown}" \\\n  ${apiBaseUrl}/leads?limit=5`}
          />
          <Snippet
            title="n8n — HTTP Request node"
            body={`Method:  GET\nURL:     ${apiBaseUrl}/leads\nHeaders: Authorization: Bearer ${shown}\n\nUse ?updated_since=<ISO date>&sort=last_status_change_at\nto pull only what has changed since your last run.`}
          />
          <Snippet
            title="MCP client (Claude Desktop, Cursor)"
            body={JSON.stringify(
              {
                mcpServers: {
                  stayful: {
                    command: "npx",
                    args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${shown}`],
                  },
                },
              },
              null,
              2
            )}
          />
        </div>

        {/* Existing keys */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Your keys</h3>
          {keys.length === 0 && (
            <p className="text-sm text-muted-foreground">No keys yet.</p>
          )}
          {keys.map((k) => {
            const u = usage[k.id];
            const expired = k.expires_at != null && new Date(k.expires_at) <= new Date();
            return (
              <div
                key={k.id}
                className="space-y-2 rounded-md border-[0.5px] border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {k.name}{" "}
                      {k.revoked_at ? (
                        <Badge variant="muted">Revoked</Badge>
                      ) : expired ? (
                        <Badge variant="muted">Expired</Badge>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {k.key_prefix}…
                    </p>
                  </div>
                  {!k.revoked_at && confirmingRevoke !== k.id && (
                    <button
                      type="button"
                      onClick={() => setConfirmingRevoke(k.id)}
                      className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                    >
                      Revoke
                    </button>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  Created {when(k.created_at)} · Last used {when(k.last_used_at)}
                  {k.expires_at && ` · Expires ${when(k.expires_at)}`}
                  {u && ` · ${u.last24h} requests in 24h, ${u.last30d} in 30 days`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {(k.scopes ?? [])
                    .map((s) => SCOPE_LABELS[s as ApiScope] ?? s)
                    .join(" · ")}
                </p>

                {confirmingRevoke === k.id && (
                  <div className="rounded-md border-[0.5px] border-border bg-muted/30 p-3">
                    <p className="mb-3 text-sm">
                      Revoke <strong>{k.name}</strong>? Anything using this key —
                      a workflow, a script, an AI assistant — stops working
                      immediately, and the key cannot be restored. Create a
                      replacement first if something depends on it.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void revoke(k.id)}
                        className="rounded-md border-[0.5px] border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
                      >
                        Confirm revoke
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingRevoke(null)}
                        className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Recent activity — answers "did my workflow run?" without a support email. */}
        {recent.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Recent activity</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.request_id + r.created_at} className="border-b-[0.5px] border-border">
                      <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                        {new Date(r.created_at).toLocaleString("en-GB", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="py-1.5 pr-3 uppercase text-muted-foreground">{r.surface}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.operation}</td>
                      <td className="py-1.5 text-right">
                        {r.status_code < 400 ? (
                          <span className="text-emerald-700">{r.status_code}</span>
                        ) : (
                          <span className="text-red-700">
                            {r.status_code} {r.error_code}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-700">{error}</p>}
        {toast && (
          <div className="rounded-md border-[0.5px] border-border bg-muted/50 px-4 py-2 text-sm">
            {toast}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
