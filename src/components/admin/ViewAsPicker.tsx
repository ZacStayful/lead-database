"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { VIEW_AS_ROUTE } from "@/lib/viewAs";

export interface PickerCustomer {
  id: string;
  name: string;
  contact: string;
  email: string;
  /** One word for the badge: active · paused · cancelling · cancelled · waitlisted · invited · declined. */
  status: string;
  products: string;
  archived: boolean;
}

/**
 * The picker behind Admin → Customer portal (§62). First row is always the
 * admin's own account and opens the plain live dashboard; every other row
 * opens a read-only view. Sorting and the search are in the browser because
 * the list is the whole book (~60 rows) and already on the page.
 */
export function ViewAsPicker({
  self,
  customers,
  current,
}: {
  /** The admin's own customers row, or null when they have none. */
  self: { id: string; name: string } | null;
  customers: PickerCustomer[];
  /** The customer currently being viewed, if any. */
  current: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return customers;
    return customers.filter((c) =>
      [c.name, c.contact, c.email, c.status].some((v) => v.toLowerCase().includes(needle))
    );
  }, [customers, q]);

  async function choose(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(VIEW_AS_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; redirect?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not open that account.");
        setBusyId(null);
        return;
      }
      // A full navigation, not router.push: every server component must
      // re-resolve identity from the cookie that was just set.
      window.location.assign(data.redirect ?? "/dashboard");
    } catch {
      setError("Could not open that account.");
      setBusyId(null);
    }
  }

  async function exit() {
    setBusyId("exit");
    await fetch(VIEW_AS_ROUTE, { method: "DELETE" }).catch(() => {});
    router.refresh();
    setBusyId(null);
  }

  return (
    <div className="space-y-6">
      {current && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>
            You are currently viewing <strong>{current.name}</strong> read-only.
          </span>
          <div className="flex gap-2">
            <Link href="/dashboard" className="rounded-md border border-amber-400 bg-white px-3 py-1 font-medium hover:bg-amber-100">
              Back to their dashboard
            </Link>
            <button
              type="button"
              onClick={exit}
              disabled={busyId === "exit"}
              className="rounded-md border border-amber-400 bg-white px-3 py-1 font-medium hover:bg-amber-100 disabled:opacity-60"
            >
              Exit view
            </button>
          </div>
        </div>
      )}

      <section className="rounded-lg border-[0.5px] border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="font-medium">Your own account{self ? ` — ${self.name}` : ""}</p>
            <p className="text-sm text-muted-foreground">
              Opens your normal dashboard, fully live. This is the one to demo from.
            </p>
          </div>
          {self ? (
            <button
              type="button"
              onClick={() => choose(self.id)}
              disabled={busyId !== null}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 disabled:opacity-60"
            >
              {busyId === self.id ? "Opening…" : "Open my dashboard"}
            </button>
          ) : (
            <Link href="/dashboard" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90">
              Open my dashboard
            </Link>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">View a customer&apos;s dashboard</h2>
            <p className="text-sm text-muted-foreground">
              Exactly what they see when they log in. Read-only: nothing you do there changes
              their account, their leads or their billing.
            </p>
          </div>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by business, name, email or status"
            className="w-full sm:w-80"
            aria-label="Search customers"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <ul className="divide-y divide-border rounded-lg border-[0.5px] border-border bg-card">
          {rows.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No customers match.</li>
          )}
          {rows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Badge variant={c.archived ? "muted" : c.status === "active" ? "brand" : "outline"}>
                    {c.status}
                  </Badge>
                  {c.archived && <Badge variant="warning">Archived</Badge>}
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {c.contact}
                  {c.contact && c.email ? " · " : ""}
                  {c.email}
                  {c.products ? ` · ${c.products}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => choose(c.id)}
                disabled={busyId !== null}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                {busyId === c.id ? "Opening…" : "View as"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
