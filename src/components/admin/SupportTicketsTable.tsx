"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import {
  TICKET_STATUSES,
  adminStatusLabel,
  channelLabel,
  kindLabel,
  ticketReference,
  type TicketChannel,
  type TicketKind,
  type TicketStatus,
} from "@/lib/supportTickets";

export type SupportTicketRow = {
  id: string;
  reference: number;
  source: string;
  kind: TicketKind;
  status: TicketStatus;
  channel: TicketChannel;
  subject: string;
  body: string;
  page: string | null;
  product: string | null;
  plan_snapshot: string | null;
  visible_to_customer: boolean;
  submitted_at: string;
  resolved_at: string | null;
  shipped_migration: string | null;
  shipped_claude_section: string | null;
  submitter_name: string;
  submitter_email: string;
  submitter_business: string | null;
  backfill_key: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_state: "archived" | "cancelled" | null;
  live_plan: string | null;
};

export type SupportTicketNoteRow = {
  id: string;
  ticket_id: string;
  body: string;
  author_email: string | null;
  created_at: string;
};

const KIND_BADGE: Record<TicketKind, string> = {
  support: "border-transparent bg-blue-100 text-blue-700",
  feature: "border-transparent bg-[#EAF3DE] text-[#3B6D11]",
  bug: "border-transparent bg-red-100 text-red-700",
};

function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The working queue (CLAUDE.md §46).
 *
 * Tick-box plus a status select in the same cell: the tick-box is the control
 * the page is built around and it sets `done`, but it cannot express
 * `in_progress` or `wont_do`, and a tri-state checkbox is not a thing anyone
 * can read. ⚠️ UNTICKING RETURNS TO `open`, never to a remembered previous
 * status — remembering one needs a column, and "I ticked that by mistake" is
 * the only reason anybody unticks. `wont_do` is reachable ONLY from the select,
 * so a tick can never quietly mean "we refused it".
 */
export function SupportTicketsTable({
  tickets,
  notes,
}: {
  tickets: SupportTicketRow[];
  notes: SupportTicketNoteRow[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, TicketStatus>>({});
  const [noteDraft, setNoteDraft] = useState("");
  const [armedWontDo, setArmedWontDo] = useState<string | null>(null);

  const notesByTicket = useMemo(() => {
    const map = new Map<string, SupportTicketNoteRow[]>();
    for (const n of notes) {
      const list = map.get(n.ticket_id) ?? [];
      list.push(n);
      map.set(n.ticket_id, list);
    }
    return map;
  }, [notes]);

  const statusOf = (t: SupportTicketRow): TicketStatus => statuses[t.id] ?? t.status;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) =>
      [
        t.subject,
        t.body,
        t.submitter_name,
        t.submitter_email,
        t.submitter_business ?? "",
        t.customer_name ?? "",
        ticketReference(t.reference),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [tickets, search]);

  async function setStatus(t: SupportTicketRow, next: TicketStatus) {
    setBusy(t.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/support-tickets/${t.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not save that status.");
        return;
      }
      setStatuses((s) => ({ ...s, [t.id]: next }));
      setArmedWontDo(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function patch(t: SupportTicketRow, body: Record<string, unknown>) {
    setBusy(t.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/support-tickets/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not save that change.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function addNote(t: SupportTicketRow) {
    const body = noteDraft.trim();
    if (!body) return;
    setBusy(t.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/support-tickets/${t.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not save that note.");
        return;
      }
      setNoteDraft("");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search subject, customer or wording"
          className="h-9 w-full max-w-sm rounded-md border-[0.5px] border-border bg-background px-3 text-sm"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">Done</TableHead>
            <TableHead className="w-20">Ref</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Service</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-24">Raised</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                No tickets yet.
              </TableCell>
            </TableRow>
          )}
          {shown.map((t) => {
            const status = statusOf(t);
            const isOpen = expanded === t.id;
            const ticketNotes = notesByTicket.get(t.id) ?? [];
            return (
              <Fragment key={t.id}>
                <TableRow
                  className={isOpen ? "bg-accent/40" : undefined}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand align-middle disabled:opacity-30"
                      aria-label={`Mark ${ticketReference(t.reference)} done`}
                      checked={status === "done"}
                      disabled={busy === t.id}
                      onChange={(e) =>
                        setStatus(t, e.target.checked ? "done" : "open")
                      }
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {ticketReference(t.reference)}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => {
                        setExpanded(isOpen ? null : t.id);
                        setNoteDraft("");
                        setArmedWontDo(null);
                      }}
                      className="text-left"
                    >
                      <span className="font-medium">{t.subject}</span>
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <Badge variant="outline" className={KIND_BADGE[t.kind]}>
                        {kindLabel(t.kind)}
                      </Badge>
                      {t.channel !== "in_app" && (
                        <span className="text-[10px] text-muted-foreground">
                          via {channelLabel(t.channel)}
                        </span>
                      )}
                      {ticketNotes.length > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          {ticketNotes.length} note
                          {ticketNotes.length === 1 ? "" : "s"}
                        </span>
                      )}
                      {t.backfill_key && (
                        <span className="text-[10px] text-muted-foreground">
                          from the inbox
                        </span>
                      )}
                      {!t.visible_to_customer && (
                        <span className="text-[10px] text-amber-700">
                          not shown to them
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {t.customer_id ? (
                      <Link
                        href={`/admin/customers/${t.customer_id}`}
                        className="hover:underline"
                      >
                        {t.customer_name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Signed out</span>
                    )}
                    {t.customer_state && (
                      <span className="ml-1 text-[10px] text-amber-700">
                        {t.customer_state}
                      </span>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      {t.submitter_email}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div>
                      {t.product === "guaranteed_rent"
                        ? "Guaranteed Rent"
                        : t.product === "management"
                          ? "Management"
                          : "Platform-wide"}
                    </div>
                    {/* Two numbers, never one: what they paid then, and now. */}
                    <div className="text-[11px] text-muted-foreground">
                      {t.plan_snapshot ?? "no plan recorded"}
                    </div>
                    {t.live_plan !== t.plan_snapshot && (
                      <div className="text-[11px] text-amber-700">
                        now: {t.live_plan ?? "not subscribed"}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <select
                      value={status}
                      disabled={busy === t.id}
                      onChange={(e) => {
                        const next = e.target.value as TicketStatus;
                        if (next === "wont_do") {
                          setArmedWontDo(t.id);
                          return;
                        }
                        setStatus(t, next);
                      }}
                      className="h-8 rounded-md border-[0.5px] border-border bg-background px-2 text-xs"
                      aria-label={`Status for ${ticketReference(t.reference)}`}
                    >
                      {TICKET_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {adminStatusLabel(s)}
                        </option>
                      ))}
                    </select>
                    {armedWontDo === t.id && (
                      <div className="mt-2 rounded-md border-[0.5px] border-border bg-muted/50 p-2 text-xs">
                        <p>
                          Close {ticketReference(t.reference)} as something we
                          are not going to build? They will see &ldquo;Not
                          planned&rdquo;.
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className="rounded-md bg-brand px-2 py-1 text-brand-foreground"
                            onClick={() => setStatus(t, "wont_do")}
                          >
                            Yes, close it
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground"
                            onClick={() => setArmedWontDo(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {when(t.submitted_at)}
                  </TableCell>
                </TableRow>

                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={7} className="bg-accent/20">
                      <div className="space-y-4 py-2">
                        <p className="whitespace-pre-wrap text-sm">{t.body}</p>

                        <div className="text-xs text-muted-foreground">
                          {t.submitter_name}
                          {t.submitter_business ? ` · ${t.submitter_business}` : ""}
                          {t.page ? ` · from ${t.page}` : ""}
                          {" · "}
                          {status === "done" || status === "wont_do"
                            ? t.resolved_at
                              ? `closed ${when(t.resolved_at)}`
                              : "closed, date unknown"
                            : "open"}
                        </div>

                        <div>
                          <p className="text-xs font-medium">Log book</p>
                          {ticketNotes.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              Nothing recorded yet.
                            </p>
                          )}
                          <ul className="space-y-2 pt-1">
                            {ticketNotes.map((n) => (
                              <li key={n.id} className="text-xs">
                                <span className="text-muted-foreground">
                                  {when(n.created_at)}
                                  {n.author_email ? ` · ${n.author_email}` : ""}
                                </span>
                                <p className="whitespace-pre-wrap">{n.body}</p>
                              </li>
                            ))}
                          </ul>
                          <div className="flex gap-2 pt-2">
                            <textarea
                              value={noteDraft}
                              onChange={(e) => setNoteDraft(e.target.value)}
                              rows={2}
                              placeholder="What did you do, or decide?"
                              className="w-full max-w-xl rounded-md border-[0.5px] border-border bg-background p-2 text-xs"
                            />
                            <button
                              type="button"
                              disabled={busy === t.id || !noteDraft.trim()}
                              onClick={() => addNote(t)}
                              className="h-8 self-end rounded-md bg-brand px-3 text-xs text-brand-foreground disabled:opacity-40"
                            >
                              Add note
                            </button>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-end gap-4">
                          <label className="text-xs">
                            <span className="block text-muted-foreground">
                              Service this concerns
                            </span>
                            <select
                              defaultValue={t.product ?? ""}
                              disabled={busy === t.id}
                              onChange={(e) =>
                                patch(t, { product: e.target.value })
                              }
                              className="mt-1 h-8 rounded-md border-[0.5px] border-border bg-background px-2 text-xs"
                            >
                              <option value="">Platform-wide</option>
                              <option value="management">Management</option>
                              <option value="guaranteed_rent">Guaranteed Rent</option>
                            </select>
                          </label>

                          <label className="text-xs">
                            <span className="block text-muted-foreground">
                              Shipped in migration
                            </span>
                            <input
                              defaultValue={t.shipped_migration ?? ""}
                              placeholder="0133"
                              disabled={busy === t.id}
                              onBlur={(e) =>
                                e.target.value !== (t.shipped_migration ?? "") &&
                                patch(t, { shipped_migration: e.target.value })
                              }
                              className="mt-1 h-8 w-24 rounded-md border-[0.5px] border-border bg-background px-2 text-xs"
                            />
                          </label>

                          <label className="text-xs">
                            <span className="block text-muted-foreground">
                              CLAUDE.md section
                            </span>
                            <input
                              defaultValue={t.shipped_claude_section ?? ""}
                              placeholder="§46"
                              disabled={busy === t.id}
                              onBlur={(e) =>
                                e.target.value !== (t.shipped_claude_section ?? "") &&
                                patch(t, { shipped_claude_section: e.target.value })
                              }
                              className="mt-1 h-8 w-24 rounded-md border-[0.5px] border-border bg-background px-2 text-xs"
                            />
                          </label>

                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-brand"
                              checked={t.visible_to_customer}
                              disabled={busy === t.id}
                              onChange={(e) =>
                                patch(t, { visible_to_customer: e.target.checked })
                              }
                            />
                            <span>
                              Show this to the customer
                              {t.source === "admin" && (
                                <span className="block text-[10px] text-muted-foreground">
                                  you wrote this, not them
                                </span>
                              )}
                            </span>
                          </label>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
