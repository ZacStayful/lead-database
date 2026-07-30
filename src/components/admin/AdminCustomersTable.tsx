"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Filter, Mail, Pause } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { computePacing, type PacingStatus } from "@/lib/pacing";
import type { Customer } from "@/lib/types";

type Tab = "all" | "active" | "waitlisted" | "invited" | "cancelled";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "waitlisted", label: "Waitlisted" },
  { key: "invited", label: "Invited" },
  { key: "cancelled", label: "Cancelled" },
];

type ProductTab = "all" | "management" | "guaranteed_rent" | "both";

const PRODUCT_TABS: { key: ProductTab; label: string }[] = [
  { key: "all", label: "All products" },
  { key: "management", label: "Management" },
  { key: "guaranteed_rent", label: "Guaranteed Rent" },
  { key: "both", label: "Both" },
];

// Mirror the routing gate: management leads only reach customers who are both
// account-active and subscription-active (see get_next_customers_for_lead).
const hasManagement = (c: Customer) =>
  c.subscription_status === "active" && c.account_status === "active";
const hasGuaranteedRent = (c: Customer) => c.gr_subscription_status === "active";

// A management subscriber whose subscription is currently paused (account_status
// stays 'active', so they still appear under the Active tab).
const isPaused = (c: Customer) => Boolean(c.paused_at);

// A customer with an active or pending-lift filter on either product.
const isFiltered = (s: string | null | undefined) =>
  s === "active" || s === "pending_lift";
const hasFilter = (c: Customer) =>
  isFiltered(c.filter_status) || isFiltered(c.gr_filter_status);

const ACCOUNT_BADGE: Record<string, string> = {
  active: "border-transparent bg-green-100 text-green-700",
  invited: "border-transparent bg-amber-100 text-amber-700",
  waitlisted: "border-transparent bg-gray-100 text-gray-600",
  cancelled: "border-transparent bg-red-100 text-red-700",
};

// Who a follow-up reminder can be sent to: an account with a portal login that
// is still live on a product it could have leads waiting on. Deliberately
// mirrors isLiveOnAnyProduct() in @/lib/followUp — the server re-checks every
// recipient and reports anyone it skips, so this only keeps the button off rows
// where it could never do anything.
const canRemind = (c: Customer, status: string) =>
  status === "active" &&
  c.is_active &&
  c.user_id != null &&
  ((hasManagement(c) && !isPaused(c)) || hasGuaranteedRent(c));

// How long without signing in counts as dormant — the population the reminder
// exists for. Used only to highlight rows and to power "Select dormant"; it
// never gates a send, so an admin can still chase anyone.
const DORMANT_DAYS = 14;

// Recipients per request to /api/admin/customers/reminders. Must not exceed the
// endpoint's own cap; a larger selection is sent as several requests.
const REMINDER_BATCH_SIZE = 25;

/** A remindable customer who hasn't signed in for DORMANT_DAYS (or ever). */
function isDormant(lastSignInAt: string | null | undefined): boolean {
  if (!lastSignInAt) return true;
  const days = (Date.now() - +new Date(lastSignInAt)) / 86_400_000;
  return days >= DORMANT_DAYS;
}

/** One recipient's outcome from POST /api/admin/customers/reminders. */
type ReminderResult = {
  customerId: string;
  email: string;
  businessName?: string;
  sent: boolean;
  leadCount: number;
  skipped?: string;
  skippedMessage?: string;
  error?: string;
};

/** A toast headline with optional per-recipient detail lines. */
type Toast = { text: string; details?: string[] };

export function AdminCustomersTable({
  customers,
  lastActive = {},
}: {
  customers: Customer[];
  /** customer.id → last sign-in timestamp (null = has login, never signed in). */
  lastActive?: Record<string, string | null>;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [product, setProduct] = useState<ProductTab>("all");
  // Local overrides so a row's badge updates after invite without a reload.
  const [statusOverride, setStatusOverride] = useState<Record<string, string>>({});
  // Same idea for the reminder action: customer.id → send timestamp.
  const [remindedOverride, setRemindedOverride] = useState<Record<string, string>>(
    {}
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const accountStatus = (c: Customer) => statusOverride[c.id] ?? c.account_status;
  const remindedAt = (c: Customer) =>
    remindedOverride[c.id] ?? c.last_nudge_sent_at;

  const rows = useMemo(() => {
    let list = customers.filter((c) => tab === "all" || accountStatus(c) === tab);
    list = list.filter((c) => {
      if (product === "management") return hasManagement(c);
      if (product === "guaranteed_rent") return hasGuaranteedRent(c);
      if (product === "both") return hasManagement(c) && hasGuaranteedRent(c);
      return true;
    });
    if (tab === "waitlisted") {
      // Earliest signup first.
      list = [...list].sort(
        (a, b) => +new Date(a.created_at) - +new Date(b.created_at)
      );
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, tab, product, statusOverride]);

  async function handleInvite(id: string, email: string) {
    setBusyId(id);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/customers/${id}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ text: data.error ?? "Could not send invitation." });
        return;
      }
      setStatusOverride((s) => ({ ...s, [id]: "invited" }));
      // Capacity is non-blocking: the invite always succeeds, but flag it when
      // this customer would push weighted usage over the limit.
      setToast({
        text:
          data.capacityWarning && data.warningMessage
            ? `Invitation sent to ${email}. ${data.warningMessage}`
            : `Invitation sent to ${email}`,
      });
    } catch {
      setToast({ text: "Could not send invitation." });
    } finally {
      setBusyId(null);
    }
  }

  async function handleResendInvite(id: string, email: string) {
    setBusyId(id);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/customers/${id}/resend-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ text: data.error ?? "Could not resend invitation." });
        return;
      }
      setToast({ text: `Invitation resent to ${email}` });
    } catch {
      setToast({ text: "Could not resend invitation." });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Send the "log in and follow up your leads" reminder to one or more
   * customers. One endpoint covers both, so a single row and a bulk selection
   * report their outcomes the same way.
   */
  async function sendReminders(ids: string[]) {
    if (ids.length === 0) return;
    const single = ids.length === 1;
    if (single) setBusyId(ids[0]);
    else setBulkBusy(true);
    setToast(null);
    try {
      // Chunked to stay inside the endpoint's per-request cap (and its serverless
      // time budget) rather than failing a large selection outright.
      const results: ReminderResult[] = [];
      for (let i = 0; i < ids.length; i += REMINDER_BATCH_SIZE) {
        const batch = ids.slice(i, i + REMINDER_BATCH_SIZE);
        const res = await fetch("/api/admin/customers/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: batch }),
        });
        const data = await res.json();
        if (!res.ok) {
          // Report what did go out before the failure, then stop — the rest stay
          // selected and can be retried.
          const failure = data.error ?? "Could not send the reminder.";
          if (results.length === 0) {
            setToast({ text: failure });
          } else {
            const partial = reminderToast(results, single);
            setToast({
              ...partial,
              details: [...(partial.details ?? []), `Stopped early — ${failure}`],
            });
          }
          applySent(results);
          return;
        }
        results.push(...((data.results ?? []) as ReminderResult[]));
      }

      applySent(results);
      setToast(reminderToast(results, single));
    } catch {
      setToast({ text: "Could not send the reminder." });
    } finally {
      setBusyId(null);
      setBulkBusy(false);
    }
  }

  /** Stamp the rows that were emailed and untick them. */
  function applySent(results: ReminderResult[]) {
    const now = new Date().toISOString();
    const stamped: Record<string, string> = {};
    results.forEach((r) => {
      if (r.sent) stamped[r.customerId] = now;
    });
    setRemindedOverride((s) => ({ ...s, ...stamped }));
    // Drop everyone who was actually emailed from the selection; anyone skipped
    // or failed stays ticked so they can be dealt with or retried.
    setSelected((s) => {
      const next = new Set(s);
      Object.keys(stamped).forEach((id) => next.delete(id));
      return next;
    });
  }

  const remindable = rows.filter((c) => canRemind(c, accountStatus(c)));
  const dormant = remindable.filter((c) => isDormant(lastActive[c.id]));
  // Selection is scoped to what is on screen: switching tabs must not leave
  // invisible rows ticked and silently included in the next bulk send.
  const selectedVisible = remindable.filter((c) => selected.has(c.id));
  const allVisibleSelected =
    remindable.length > 0 && selectedVisible.length === remindable.length;

  function toggleRow(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((s) => {
      const next = new Set(s);
      if (allVisibleSelected) remindable.forEach((c) => next.delete(c.id));
      else remindable.forEach((c) => next.add(c.id));
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (tab === t.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="hidden h-5 w-px bg-border sm:block" />
        <div className="flex gap-1">
          {PRODUCT_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setProduct(t.key)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (product === t.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        {dormant.length > 0 && (
          <button
            onClick={() =>
              setSelected((s) => {
                const next = new Set(s);
                dormant.forEach((c) => next.add(c.id));
                return next;
              })
            }
            title={`Tick every customer in this view who hasn't signed in for ${DORMANT_DAYS} days or more`}
            className="ml-auto text-sm font-medium text-brand hover:underline"
          >
            Select dormant ({dormant.length})
          </button>
        )}
      </div>

      {selectedVisible.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border-[0.5px] border-brand/40 bg-brand/5 px-4 py-2.5 text-sm">
          <span>
            <strong>{selectedVisible.length}</strong> customer
            {selectedVisible.length === 1 ? "" : "s"} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-muted-foreground hover:underline"
            >
              Clear
            </button>
            <button
              onClick={() => sendReminders(selectedVisible.map((c) => c.id))}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Mail className="h-3.5 w-3.5" />
              {bulkBusy ? "Sending…" : "Send follow-up reminder"}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="rounded-md border-[0.5px] border-border bg-muted/50 px-4 py-2 text-sm">
          {toast.text}
          {toast.details && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {toast.details.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-lg border-[0.5px] border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all customers who can be reminded"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  disabled={remindable.length === 0}
                  className="h-4 w-4 accent-brand align-middle disabled:opacity-30"
                />
              </TableHead>
              <TableHead>Business</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead>Credits / received</TableHead>
              <TableHead>Pacing</TableHead>
              <TableHead>Last lead</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => {
              const status = accountStatus(c);
              const pacing = computePacing(c);
              const canSend = canRemind(c, status);
              const checked = selected.has(c.id);
              return (
                <TableRow
                  key={c.id}
                  className={checked ? "bg-brand/5" : undefined}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.business_name}`}
                      checked={checked}
                      onChange={() => toggleRow(c.id)}
                      disabled={!canSend}
                      title={
                        canSend
                          ? undefined
                          : "Only active customers with a portal login can be reminded"
                      }
                      className="h-4 w-4 accent-brand align-middle disabled:opacity-30"
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {c.business_name}
                      {hasFilter(c) && (
                        <span
                          title="Lead filter active"
                          className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand"
                        >
                          <Filter className="h-3 w-3" />
                          Filtered
                        </span>
                      )}
                      {isPaused(c) && (
                        <span
                          title={
                            c.pause_resumes_at
                              ? `Subscription paused · resumes ${formatDate(c.pause_resumes_at)}`
                              : "Subscription paused"
                          }
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                        >
                          <Pause className="h-3 w-3" />
                          Paused
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {hasManagement(c) && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-[#EAF3DE] text-[#3B6D11]"
                        >
                          Management
                        </Badge>
                      )}
                      {hasGuaranteedRent(c) && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-blue-50 text-blue-700"
                        >
                          Guaranteed Rent
                        </Badge>
                      )}
                      {!hasManagement(c) && !hasGuaranteedRent(c) && (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        ACCOUNT_BADGE[status] ??
                        "border-transparent bg-gray-100 text-gray-600"
                      }
                    >
                      {status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        c.subscription_status === "active" ? "brand" : "muted"
                      }
                    >
                      {c.subscription_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="whitespace-nowrap">
                      <span
                        className={
                          c.lead_balance <= 0
                            ? "font-medium text-amber-700"
                            : "font-medium text-foreground"
                        }
                      >
                        {c.lead_balance} credit{c.lead_balance === 1 ? "" : "s"}
                      </span>
                      <span className="ml-1 text-xs text-muted-foreground">
                        · {c.leads_received_this_month}/{c.monthly_allocation}{" "}
                        this cycle
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <PacingBadge status={pacing.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.last_assignment_at ? formatDate(c.last_assignment_at) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <LastActive
                      hasLogin={c.user_id != null}
                      lastSignInAt={lastActive[c.id] ?? null}
                    />
                    {remindedAt(c) && (
                      <div
                        title={`Last follow-up reminder: ${remindedAt(c)}`}
                        className="text-xs text-muted-foreground"
                      >
                        Reminded {formatDate(remindedAt(c)!)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-3">
                      {canSend && (
                        <button
                          onClick={() => sendReminders([c.id])}
                          disabled={busyId === c.id || bulkBusy}
                          title="Email this customer a reminder to log in and follow up their leads"
                          className="text-sm font-medium text-[#5D8156] hover:underline disabled:opacity-50"
                        >
                          {busyId === c.id ? "Sending…" : "Send reminder"}
                        </button>
                      )}
                      {status === "waitlisted" && (
                        <button
                          onClick={() => handleInvite(c.id, c.email)}
                          disabled={busyId === c.id}
                          className="text-sm font-medium text-[#5D8156] hover:underline disabled:opacity-50"
                        >
                          Invite to subscribe
                        </button>
                      )}
                      {status === "invited" && (
                        <button
                          onClick={() => handleResendInvite(c.id, c.email)}
                          disabled={busyId === c.id}
                          className="text-sm font-medium text-[#5D8156] hover:underline disabled:opacity-50"
                        >
                          Resend invitation
                        </button>
                      )}
                      <Link
                        href={`/admin/customers/${c.id}`}
                        className="text-sm text-brand hover:underline"
                      >
                        Edit
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={11}
                  className="py-10 text-center text-muted-foreground"
                >
                  No customers in this view.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Turn the per-recipient results into something an admin can act on: what went
 * out, and for anyone who did not get an email, why. A skipped recipient is not
 * a failure — it is a rule (opted out, no login, left the product) — so the two
 * are reported separately.
 */
function reminderToast(results: ReminderResult[], single: boolean): Toast {
  const who = (r: ReminderResult) => r.businessName ?? r.email;

  if (single) {
    const r = results[0];
    if (!r) return { text: "Nothing was sent." };
    if (r.sent) {
      return {
        text: `Reminder sent to ${r.email}`,
        details: [
          r.leadCount > 0
            ? `${r.leadCount} lead${r.leadCount === 1 ? "" : "s"} listed for follow-up.`
            : "No leads were waiting, so they were asked to sign in and review their pipeline.",
        ],
      };
    }
    if (r.skipped) {
      return { text: `No reminder sent — ${who(r)} ${r.skippedMessage ?? ""}`.trim() };
    }
    return {
      text: `Could not email ${r.email}${r.error ? ` — ${r.error}` : ""}`,
    };
  }

  const sent = results.filter((r) => r.sent);
  const skipped = results.filter((r) => !r.sent && r.skipped);
  const failed = results.filter((r) => !r.sent && !r.skipped);
  const leads = sent.reduce((total, r) => total + r.leadCount, 0);

  const text =
    sent.length > 0
      ? `${sent.length} reminder${sent.length === 1 ? "" : "s"} sent${
          leads > 0 ? `, covering ${leads} lead${leads === 1 ? "" : "s"}` : ""
        }`
      : "No reminders were sent";

  const details = [
    ...skipped.map((r) => `Skipped ${who(r)} — ${r.skippedMessage ?? "not eligible"}`),
    ...failed.map(
      (r) => `Failed for ${who(r)}${r.error ? ` — ${r.error}` : ""}`
    ),
  ];

  return { text, details: details.length > 0 ? details : undefined };
}

/** Last time the customer signed in to the portal (their "last active"). */
function LastActive({
  hasLogin,
  lastSignInAt,
}: {
  hasLogin: boolean;
  lastSignInAt: string | null;
}) {
  if (!hasLogin) {
    return (
      <span title="No portal login has been created yet">No account</span>
    );
  }
  if (!lastSignInAt) {
    return (
      <span
        title="Login exists but the customer has never signed in"
        className="text-amber-700"
      >
        Never
      </span>
    );
  }
  // Amber once they cross the dormant threshold, so the rows worth reminding
  // stand out without having to read every date.
  return (
    <span
      title={lastSignInAt}
      className={isDormant(lastSignInAt) ? "text-amber-700" : undefined}
    >
      {formatDate(lastSignInAt)}
    </span>
  );
}

function PacingBadge({ status }: { status: PacingStatus }) {
  if (status === "behind") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
        Behind
      </span>
    );
  }
  if (status === "ahead") {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        Ahead
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-medium text-brand">
      On track
    </span>
  );
}
