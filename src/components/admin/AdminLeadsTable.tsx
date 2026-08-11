"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

export interface LeadRow {
  id: string;
  lead_name: string;
  lead_type: string;
  address: string | null;
  assignment_count: number;
  max_assignments: number;
  created_at: string;
  recipients: string[];
}

export interface CustomerRow {
  id: string;
  business_name: string;
  lead_balance: number;
  gr_lead_balance: number;
  subscription_status: string;
  gr_subscription_status: string;
}

/**
 * Turn a raw Postgres error from the assign RPCs into something an admin can act
 * on. 0053 makes the functions raise readable messages themselves, so most of
 * these pass straight through — but the duplicate case is kept here too, because
 * a database that hasn't had 0053 applied yet still returns the bare constraint
 * name, and "duplicate key value violates unique constraint
 * lead_assignments_lead_id_customer_id_key" tells the reader nothing about what
 * to do next.
 */
function friendlyFailure(raw: string): string {
  const msg = raw.toLowerCase();
  if (
    msg.includes("lead_assignments_lead_id_customer_id_key") ||
    msg.includes("already has this lead")
  ) {
    return "customer already has that lead";
  }
  if (msg.includes("at max assignments")) {
    return "lead already at its recipient limit";
  }
  if (msg.includes("no remaining gr lead balance")) {
    return "customer is out of Guaranteed Rent credits";
  }
  if (msg.includes("no remaining lead balance")) {
    return "customer is out of lead credits";
  }
  if (msg.includes("is paused")) {
    return "customer is paused";
  }
  return raw;
}

/**
 * Where the collapsed/expanded choice for the bulk-assign bar is remembered.
 *
 * The bar is sticky and tall enough to cover several table rows while you scroll
 * — including the Type column, which is the one thing you need to read while
 * choosing which leads to batch. Collapsing it leaves a slim summary strip, and
 * the choice persists so an admin who prefers it out of the way doesn't have to
 * re-collapse it on every visit.
 */
const BAR_COLLAPSED_KEY = "admin:bulk-assign-bar-collapsed";

export function AdminLeadsTable({
  leads,
  customers,
}: {
  leads: LeadRow[];
  customers: CustomerRow[];
}) {
  const router = useRouter();
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(
    new Set()
  );
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Starts expanded so the bar behaves exactly as it always has on a fresh
  // browser; the stored preference is applied after mount to avoid a hydration
  // mismatch between server-rendered HTML and localStorage.
  const [collapsed, setCollapsed] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(BAR_COLLAPSED_KEY) === "1");
    } catch {
      // Private mode / storage disabled — the bar just always starts expanded.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(BAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Not being able to remember the choice is not worth failing the click.
      }
      return next;
    });
  }

  // Only leads still below capacity can take another recipient.
  const selectableIds = useMemo(
    () =>
      leads
        .filter((l) => l.assignment_count < l.max_assignments)
        .map((l) => l.id),
    [leads]
  );
  const allSelected =
    selectableIds.length > 0 && selectedLeads.size === selectableIds.length;

  // How the current selection splits by product — used to flag GR/mgmt mixing,
  // and shown in the bar so the split stays readable even when the bar is
  // collapsed over the Type column.
  const selectedCounts = useMemo(() => {
    let management = 0;
    let guaranteedRent = 0;
    for (const l of leads) {
      if (!selectedLeads.has(l.id)) continue;
      if (l.lead_type === "guaranteed_rent") guaranteedRent += 1;
      else management += 1;
    }
    return { management, guaranteedRent };
  }, [leads, selectedLeads]);
  const hasGr = selectedCounts.guaranteedRent > 0;
  const hasMgmt = selectedCounts.management > 0;
  const selectionBreakdown = [
    hasMgmt ? `${selectedCounts.management} Management` : null,
    hasGr ? `${selectedCounts.guaranteedRent} Guaranteed Rent` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // The picker is a fixed-height scroller, so a name that doesn't match the
  // search is genuinely unreachable — keep anything already ticked visible
  // regardless, or a stale query would silently hide part of the batch.
  const visibleCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        selectedCustomers.has(c.id) ||
        c.business_name.toLowerCase().includes(q)
    );
  }, [customers, customerQuery, selectedCustomers]);

  // How many of the listed customers can actually be charged for what's
  // selected. When this is 0 the answer is almost always "nobody has credits",
  // not "the customer is missing" — say so rather than leaving an admin
  // hunting the list for a name that is present but unaffordable.
  const payableCount = useMemo(
    () =>
      customers.filter(
        (c) =>
          (hasMgmt && c.subscription_status === "active" && c.lead_balance > 0) ||
          (hasGr && c.gr_subscription_status === "active" && c.gr_lead_balance > 0)
      ).length,
    [customers, hasMgmt, hasGr]
  );

  function toggleLead(id: string) {
    setMessage(null);
    setSelectedLeads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setMessage(null);
    setSelectedLeads(allSelected ? new Set() : new Set(selectableIds));
  }

  function toggleCustomer(id: string) {
    setMessage(null);
    setSelectedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedLeads(new Set());
    setSelectedCustomers(new Set());
    setMessage(null);
  }

  async function assign() {
    if (selectedLeads.size === 0 || selectedCustomers.size === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/assign/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_ids: Array.from(selectedLeads),
          customer_ids: Array.from(selectedCustomers),
          override,
        }),
      });
      // The endpoint can return a non-JSON gateway error (e.g. a timeout page),
      // which would otherwise blow up as "Unexpected token ... is not valid
      // JSON". Read the body defensively and surface a clear message instead.
      const raw = await res.text();
      let data: {
        error?: string;
        assignments?: number;
        leads_affected?: number;
        failures?: { error: string }[];
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          res.ok
            ? "The server returned an unexpected response. Some leads may have been assigned — refresh to check."
            : "The request timed out or errored before finishing. Try assigning fewer leads at once, then refresh to see what went through."
        );
      }
      if (!res.ok) throw new Error(data.error ?? "Assignment failed");

      const failed = (data.failures ?? []) as { error: string }[];
      let msg = `Made ${data.assignments} assignment${
        data.assignments === 1 ? "" : "s"
      } across ${data.leads_affected} lead${
        data.leads_affected === 1 ? "" : "s"
      }.`;
      if (failed.length > 0) {
        // Summarise every distinct reason with a count. Showing only the first
        // failure hid the fact that a batch usually fails for one repeated,
        // mundane reason — most often that the customer already holds the lead —
        // and made a wholly-skipped batch look like a broken feature.
        const byReason = new Map<string, number>();
        failed.forEach((f) => {
          const reason = friendlyFailure(f.error);
          byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        });
        const reasons = Array.from(byReason.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `${n} × ${reason}`)
          .join("; ");
        msg += ` ${failed.length} pair${
          failed.length === 1 ? "" : "s"
        } skipped — ${reasons}.`;
      }
      setMessage(msg);
      setSelectedCustomers(new Set());
      setSelectedLeads(new Set());
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all pending leads"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={selectableIds.length === 0}
                  className="h-4 w-4 accent-brand align-middle"
                />
              </TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Received</TableHead>
              <TableHead className="text-right">View</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((l) => {
              const full = l.assignment_count >= l.max_assignments;
              const none = l.assignment_count === 0;
              const checked = selectedLeads.has(l.id);
              return (
                <TableRow
                  key={l.id}
                  className={checked ? "bg-brand/5" : undefined}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.lead_name}`}
                      checked={checked}
                      onChange={() => toggleLead(l.id)}
                      disabled={full}
                      className="h-4 w-4 accent-brand align-middle disabled:opacity-30"
                    />
                  </TableCell>
                  <TableCell className="font-medium">{l.lead_name}</TableCell>
                  <TableCell>
                    {l.lead_type === "guaranteed_rent"
                      ? "Guaranteed Rent"
                      : "Management"}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate text-muted-foreground">
                    {l.address ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={full ? "muted" : "brand"}
                      className={
                        none
                          ? "border-amber-300 bg-amber-50 text-amber-700"
                          : undefined
                      }
                    >
                      {l.assignment_count} / {l.max_assignments}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground">
                    {l.recipients.length ? l.recipients.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(l.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/leads/${l.id}`}
                      className="text-brand hover:underline"
                    >
                      View
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
            {leads.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-10 text-center text-muted-foreground"
                >
                  No leads yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Sticky bulk-assign bar — appears once leads are selected. Collapses to
          a slim summary strip so it stops covering the table underneath. */}
      {selectedLeads.size > 0 && (
        <div className="sticky bottom-4 z-10 mx-auto flex max-h-[85vh] max-w-3xl flex-col overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <span className="text-sm font-medium">
                {selectedLeads.size} lead{selectedLeads.size === 1 ? "" : "s"}{" "}
                selected
              </span>
              {selectionBreakdown && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {selectionBreakdown}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {/* Collapsed, the customer picker is hidden — but a picker choice
                  survives the collapse, so an admin batching lead after lead to
                  the same customers can assign without expanding again. */}
              {collapsed && selectedCustomers.size > 0 && (
                <Button size="sm" onClick={assign} disabled={busy}>
                  {busy ? "Assigning…" : `Assign to ${selectedCustomers.size}`}
                </Button>
              )}
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {collapsed ? (
                  <>
                    <ChevronUp className="h-3 w-3" /> Show options
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" /> Hide options
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            </div>
          </div>

          {collapsed && message && (
            <p className="mt-2 text-xs text-muted-foreground">{message}</p>
          )}

          {!collapsed && (
            <>
              <div className="mt-3 mb-1.5 flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Assign to which customers?
                </p>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {selectedCustomers.size} of {customers.length} selected
                </span>
              </div>

              {customers.length > 6 && (
                <input
                  type="search"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  disabled={busy}
                  placeholder="Search customers by name…"
                  className="mb-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-brand"
                />
              )}

              {/* Bounded scroller. Without a height cap this grid grew with the
                  customer list until the bar was taller than the viewport, and a
                  sticky element cannot be scrolled past its own overflow — names
                  beyond the fold became unreachable rather than merely
                  off-screen. */}
              <div className="grid max-h-[38vh] gap-1.5 overflow-y-auto sm:grid-cols-2">
                {visibleCustomers.map((c) => {
                  const isSel = selectedCustomers.has(c.id);
                  const bits: string[] = [];
                  if (hasMgmt) bits.push(`Mgmt ${c.lead_balance}`);
                  if (hasGr) bits.push(`GR ${c.gr_lead_balance}`);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCustomer(c.id)}
                      disabled={busy}
                      className={
                        "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors " +
                        (isSel
                          ? "border-brand bg-brand/10"
                          : "border-border hover:bg-muted")
                      }
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {c.business_name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {bits.join(" · ") || "credits"}
                        </span>
                      </span>
                      <span
                        className={
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border " +
                          (isSel
                            ? "border-brand bg-brand text-white"
                            : "border-border")
                        }
                      >
                        {isSel && <Check className="h-3 w-3" />}
                      </span>
                    </button>
                  );
                })}
                {visibleCustomers.length === 0 && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    No customer matches “{customerQuery}”.
                  </p>
                )}
              </div>

              {!override && payableCount === 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  No customer currently has credits for the selected lead
                  {selectedLeads.size === 1 ? "" : "s"} — every name here will be
                  refused unless you tick “Override credit limit”.
                </p>
              )}

              <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={() => setOverride((v) => !v)}
                  disabled={busy}
                  className="mt-0.5 h-4 w-4 accent-brand"
                />
                <span>
                  <span className="font-medium text-foreground">
                    Override credit limit
                  </span>{" "}
                  <span className="text-muted-foreground">
                    — place these even with customers who are out of credits or
                    not subscribed. No credit is spent. (Paused customers are
                    still blocked.)
                  </span>
                </span>
              </label>

              <div className="mt-3 flex items-center gap-3">
                <Button
                  onClick={assign}
                  disabled={busy || selectedCustomers.size === 0}
                >
                  {busy
                    ? "Assigning…"
                    : `Assign ${selectedLeads.size} lead${
                        selectedLeads.size === 1 ? "" : "s"
                      } to ${selectedCustomers.size || ""} ${
                        selectedCustomers.size === 1 ? "customer" : "customers"
                      }`.trim()}
                </Button>
                {message && (
                  <span className="text-xs text-muted-foreground">
                    {message}
                  </span>
                )}
              </div>
              {!override && hasGr && (
                <p className="mt-2 text-xs text-amber-700">
                  GR leads are selected — without override, only customers with
                  an active GR subscription and GR credits will take them.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {message && selectedLeads.size === 0 && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
    </>
  );
}
