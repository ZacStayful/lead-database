"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CustomerOption {
  id: string;
  business_name: string;
  credits: number;
  /** Does this lead pass their lead filter? True for an unfiltered customer. */
  matches_filter: boolean;
  /** Their filter in words ("3+ beds · Bristol"), null when they have none. */
  filter_summary: string | null;
}

export function AdminLeadControls({
  leadId,
  maxAssignments,
  assignmentCount,
  customers,
  overrideCustomers,
  leadType,
}: {
  leadId: string;
  maxAssignments: number;
  assignmentCount: number;
  customers: CustomerOption[];
  overrideCustomers: CustomerOption[];
  leadType?: string;
}) {
  const productLabel =
    leadType === "guaranteed_rent" ? "Guaranteed Rent" : "Management";
  const router = useRouter();
  const [max, setMax] = useState(String(maxAssignments));
  const [override, setOverride] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Ticked only after the admin has been shown, by name, which customers
  // asked not to receive a lead like this one. Reset on every selection
  // change below, so it can never carry over from one choice to another.
  const [acknowledged, setAcknowledged] = useState(false);

  const remainingSlots = Math.max(0, Number(max) - assignmentCount);
  const atCapacity = remainingSlots === 0;

  // Normal mode only lists customers who can actually be charged a credit;
  // override mode lists every approved customer regardless of credit/subscription.
  const pool = override ? overrideCustomers : customers;
  // The pool renders in a short fixed-height scroller, so past the first few
  // names an admin has to know to scroll inside it. Search makes the whole
  // pool reachable without that; ticked customers always stay listed.
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter(
      (c) => selected.has(c.id) || c.business_name.toLowerCase().includes(q)
    );
  }, [pool, query, selected]);
  // Matching first, then the rest — one list with a heading before each group,
  // so the search box and the remainingSlots cap keep working unchanged.
  const matching = useMemo(() => list.filter((c) => c.matches_filter), [list]);
  const outside = useMemo(() => list.filter((c) => !c.matches_filter), [list]);
  const ordered = useMemo(() => [...matching, ...outside], [matching, outside]);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  // The selected customers this lead misses. Empty for an unfiltered book, so
  // every branch below stays out of the way until it is real.
  const offFilterSelected = useMemo(
    () => pool.filter((c) => selected.has(c.id) && !c.matches_filter),
    [pool, selected]
  );
  const needsAcknowledgement = offFilterSelected.length > 0;
  const anyFiltered = useMemo(
    () => pool.some((c) => !c.matches_filter),
    [pool]
  );

  function toggle(id: string) {
    setMessage(null);
    setAcknowledged(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < remainingSlots) {
        next.add(id);
      }
      return next;
    });
  }

  function toggleOverride() {
    setSelected(new Set());
    setMessage(null);
    setAcknowledged(false);
    setOverride((v) => !v);
  }

  async function changeMax(value: string) {
    setMax(value);
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_assignments: Number(value) }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function forceAssign() {
    if (selectedIds.length === 0) return;
    if (needsAcknowledgement && !acknowledged) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: leadId,
          customer_ids: selectedIds,
          override,
          // Only ever sent for customers the admin has been shown are outside
          // their filter and has ticked for. Without it the RPC refuses.
          allow_filter_mismatch: needsAcknowledgement && acknowledged,
        }),
      });
      const raw = await res.text();
      let data: { error?: string; assigned_count?: number; failures?: { error: string }[] };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          "The request timed out or errored before finishing. Refresh to see what went through."
        );
      }
      if (!res.ok) throw new Error(data.error ?? "Assignment failed");

      const failed = (data.failures ?? []) as { error: string }[];
      if (failed.length > 0) {
        setMessage(
          `Assigned ${data.assigned_count}. ${failed.length} could not be assigned: ${failed[0].error}`
        );
      } else {
        setMessage(
          `Assigned ${data.assigned_count} customer${
            data.assigned_count === 1 ? "" : "s"
          }.`
        );
      }
      setSelected(new Set());
      setAcknowledged(false);
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Assignment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>Max assignments</Label>
        <Select value={max} onValueChange={changeMax} disabled={busy}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1</SelectItem>
            <SelectItem value="2">2</SelectItem>
            <SelectItem value="3">3</SelectItem>
            <SelectItem value="4">4</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Currently {assignmentCount} of {max} assigned. Default is 2 — raise up
          to 4 to place a lead with more operators.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Assign to customers</Label>
          <span className="text-xs text-muted-foreground">
            {selected.size}/{remainingSlots} selected
          </span>
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border-[0.5px] border-border p-2.5">
          <input
            type="checkbox"
            checked={override}
            onChange={toggleOverride}
            disabled={busy}
            className="mt-0.5 h-4 w-4 accent-brand"
          />
          <span className="text-xs">
            <span className="font-medium text-foreground">
              Override credit limit
            </span>
            <span className="block text-muted-foreground">
              Place this lead with any approved customer, even one out of paid
              credits{leadType === "guaranteed_rent" ? " or without a GR subscription" : ""}. No credit is spent. (Paused customers are still blocked.)
            </span>
          </span>
        </label>

        {pool.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {override
              ? "No approved customers available to assign."
              : `No active ${productLabel} subscribers with credits available. Tick “Override credit limit” to place it anyway.`}
          </p>
        ) : atCapacity ? (
          <p className="text-xs text-muted-foreground">
            At capacity — raise max assignments to add more recipients.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Pick up to {remainingSlots} customer
              {remainingSlots === 1 ? "" : "s"}, then assign in one go.
            </p>
            {pool.length > 6 && (
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={busy}
                placeholder="Search customers by name…"
                className="w-full rounded-md border-[0.5px] border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-brand"
              />
            )}
            <div className="max-h-60 space-y-1 overflow-y-auto rounded-md border-[0.5px] border-border p-1">
              {/* Grouped only when something in the pool actually misses a
                  filter. An unfiltered book renders the flat list it always
                  did, with no headings and no extra chrome. */}
              {anyFiltered && matching.length > 0 && (
                <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Matches their filter ({matching.length})
                </p>
              )}
              {ordered.map((c, i) => {
                // The second heading rides on the first non-matching row rather
                // than a second map, so there is exactly one row renderer.
                const startsOutsideGroup =
                  anyFiltered && !c.matches_filter && i === matching.length;
                const isSelected = selected.has(c.id);
                const disabled =
                  busy || (!isSelected && selected.size >= remainingSlots);
                const noCredits = c.credits <= 0;
                return (
                  <Fragment key={c.id}>
                  {startsOutsideGroup && (
                    <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-amber-700">
                      Outside their filter ({outside.length})
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    disabled={disabled}
                    className={
                      "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors " +
                      (isSelected
                        ? "bg-brand/10 text-foreground"
                        : "hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent")
                    }
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {c.business_name}
                      </span>
                      <span
                        className={
                          "text-xs " +
                          (noCredits ? "text-amber-600" : "text-muted-foreground")
                        }
                      >
                        {c.credits} credit{c.credits === 1 ? "" : "s"} left
                        {noCredits && override ? " — override" : ""}
                      </span>
                      {!c.matches_filter && c.filter_summary && (
                        <span className="truncate text-xs text-amber-700">
                          Wants {c.filter_summary}
                        </span>
                      )}
                    </span>
                    <span
                      className={
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border " +
                        (isSelected
                          ? "border-brand bg-brand text-white"
                          : "border-border")
                      }
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                  </Fragment>
                );
              })}
              {list.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  No customer matches “{query}”.
                </p>
              )}
            </div>
          </>
        )}

        {needsAcknowledgement && (
          <div className="space-y-2 rounded-md border-[0.5px] border-amber-300 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">
              <span className="font-medium">
                {offFilterSelected.length === 1
                  ? `${offFilterSelected[0].business_name} asked not to receive leads like this one`
                  : `${offFilterSelected.length} of the customers you picked asked not to receive leads like this one`}
              </span>{" "}
              — {offFilterSelected
                .map((c) =>
                  c.filter_summary
                    ? `${c.business_name} wants ${c.filter_summary}`
                    : c.business_name
                )
                .join("; ")}
              . They chose that filter and their volume forecast and cost per
              lead were quoted on it. They will get the ordinary new-lead email
              and text for this one, with nothing to say it is not what they
              asked for.
            </p>
            <label className="flex items-start gap-2 text-sm text-amber-900">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={busy}
                className="mt-0.5"
              />
              <span>
                Send {offFilterSelected.length === 1 ? "it" : "them"} anyway — I
                have a reason and I will tell them.
              </span>
            </label>
          </div>
        )}

        <Button
          onClick={forceAssign}
          disabled={
            busy ||
            selected.size === 0 ||
            (needsAcknowledgement && !acknowledged)
          }
          className="w-full"
        >
          {override && selected.size > 0
            ? `Override-assign ${selected.size}`
            : selected.size > 1
              ? `Assign ${selected.size} customers`
              : "Assign lead"}
        </Button>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
