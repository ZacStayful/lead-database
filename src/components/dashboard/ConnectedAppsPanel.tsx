"use client";

/**
 * Connected applications — see what has access, and take it away.
 *
 * The counterpart to ApiAccessPanel, and it follows its two conventions: the
 * consequence is stated BEFORE the button rather than in the result, and
 * disconnect confirms INLINE rather than in a modal (this app vendors no Dialog
 * primitive and has not one modal in it).
 *
 * It renders nothing when there is nothing connected. A permanently empty card
 * headed "Connected applications" is furniture that teaches a customer to scroll
 * past the place where a rogue connection would eventually appear.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SCOPE_LABELS, type ApiScope } from "@/lib/api/scopes";

export interface ConnectedApp {
  id: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  oauth_clients: { client_name: string; client_uri: string | null } | null;
}

function when(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function ConnectedAppsPanel({ grants }: { grants: ConnectedApp[] }) {
  const router = useRouter();
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (grants.length === 0) return null;

  async function disconnect(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/customer/oauth-grants/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not disconnect that application.");
        return;
      }
      setArming(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected applications</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Applications you have allowed to read your leads. All access is
          read-only — none of these can change a lead, spend a credit or touch
          your billing.
        </p>

        {error ? (
          <p className="rounded-md border-[0.5px] border-destructive/40 bg-destructive/5 p-3 text-destructive">
            {error}
          </p>
        ) : null}

        <ul className="space-y-3">
          {grants.map((g) => (
            <li key={g.id} className="rounded-md border-[0.5px] border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  {/* React escapes this. The name comes from an open registration
                      endpoint and is not ours. */}
                  <p className="font-medium">
                    {g.oauth_clients?.client_name ?? "Unknown application"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Connected {when(g.created_at)} · last used {when(g.last_used_at)}
                  </p>
                </div>
                {arming === g.id ? null : (
                  <button
                    type="button"
                    onClick={() => setArming(g.id)}
                    className="text-xs text-destructive hover:underline"
                  >
                    Disconnect
                  </button>
                )}
              </div>

              <ul className="mt-2 text-xs text-muted-foreground">
                {g.scopes.map((s) => (
                  <li key={s}>· {SCOPE_LABELS[s as ApiScope] ?? s}</li>
                ))}
              </ul>

              {arming === g.id ? (
                <div className="mt-3 rounded-md border-[0.5px] border-border bg-muted/30 p-3">
                  <p>
                    Disconnect{" "}
                    <strong>{g.oauth_clients?.client_name ?? "this application"}</strong>?
                    It will stop being able to read your leads immediately, and
                    you will need to connect it again from the application itself.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={busy === g.id}
                      onClick={() => disconnect(g.id)}
                      className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-60"
                    >
                      {busy === g.id ? "Disconnecting…" : "Yes, disconnect it"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setArming(null)}
                      className="rounded-md border-[0.5px] border-border px-3 py-1.5 text-xs"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
