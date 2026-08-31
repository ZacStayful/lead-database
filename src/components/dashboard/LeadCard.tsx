"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, initials, formatDate, formatGBP, formatLeadAge } from "@/lib/utils";
import { statusBadge } from "@/components/dashboard/leadStatus";
import { pipelineStatusText, pipelineBadgeClass } from "@/components/dashboard/pipelineStage";
import { IncomeProjection } from "@/components/dashboard/IncomeProjection";
import type { AssignmentWithLead } from "@/lib/types";
import {
  BarChart3,
  Check,
  Phone,
  Mail,
  MessageCircle,
  MapPin,
  Calendar,
  Presentation,
} from "lucide-react";
import { recordLeadEvent } from "@/lib/contact/leadEvents";
import { whatsappHandoffLink } from "@/lib/messaging/handoff";

export function LeadCard({
  assignment: initial,
  from = "leads",
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  assignment: AssignmentWithLead;
  from?: string;
  /** Multi-select for bulk enrolment into a follow-up sequence (SS40.13). */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const [assignment, setAssignment] = useState(initial);
  // Re-seed from fresh server data (router.refresh / realtime) — the stable
  // React key otherwise keeps the first snapshot forever.
  useEffect(() => setAssignment(initial), [initial]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const lead = assignment.lead;
  const rejected = assignment.status === "rejected";
  const isUnread = !assignment.viewed_at && !rejected;
  const contacted = assignment.status === "contacted";
  const badge = statusBadge(assignment.status);
  // No message text: the operator writes their own words (§42). The link's job
  // is to open the right chat on the right number.
  const waLink = lead.phone ? whatsappHandoffLink(lead.phone, "") : null;

  async function markViewed() {
    if (assignment.viewed_at) return;
    // Optimistically clear the "new" state.
    setAssignment((a) => ({ ...a, viewed_at: new Date().toISOString() }));
    try {
      await fetch(`/api/customer/assignments/${assignment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewed: true }),
      });
    } catch {
      /* non-blocking */
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void markViewed();
  }

  async function markContacted() {
    setBusy(true);
    setAssignment((a) => ({ ...a, status: "contacted" }));
    try {
      await fetch(`/api/customer/assignments/${assignment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contacted: true }),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg bg-card transition-colors",
        rejected
          ? "opacity-50"
          : isUnread
            ? "lead-card-unread"
            : "lead-card-viewed"
      )}
    >
      <div className="flex items-stretch">
        {/*
          ⚠️ OUTSIDE the expanding button, not inside it. A checkbox nested in a
          <button> is invalid markup and, worse, ticking it would also expand
          the card and mark the lead viewed — so selecting forty leads would
          silently clear forty "new" badges the operator was using to find them.
        */}
        {selectable && (
          <label
            className="flex cursor-pointer items-center pl-4"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect?.(assignment.id)}
              className="h-4 w-4"
              aria-label={`Select ${lead.lead_name}`}
            />
          </label>
        )}
      <button
        onClick={toggle}
        className="flex w-full items-center gap-4 p-4 text-left"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/10 text-sm font-semibold text-brand">
          {initials(lead.lead_name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{lead.lead_name}</span>
            {isUnread && (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-brand"
                title="Unread"
              />
            )}
            <Badge variant="outline" className={badge.className}>
              {badge.label}
            </Badge>
            <Badge
              variant="outline"
              className={pipelineBadgeClass(assignment.pipeline_stage)}
            >
              {pipelineStatusText(assignment.pipeline_stage)}
            </Badge>
            {lead.owner_customer_id && (
              <Badge
                variant="outline"
                className="border-transparent bg-sky-100 text-sky-700"
                title={
                  // Exclusivity is no longer true of an analysed lead
                  // that has been shared onward (§32). Silence about that
                  // is the decision; asserting the opposite is not.
                  lead.owner_resale_qualified_at
                    ? "You added this lead yourself."
                    : "You added this lead yourself. It is only visible to you."
                }
              >
                Your lead
              </Badge>
            )}
            {assignment.due_to_call_date && (
              <Badge
                variant="outline"
                className="border-transparent bg-amber-100 text-amber-700"
              >
                Call {formatDate(assignment.due_to_call_date)}
              </Badge>
            )}
            {assignment.is_reclaimed && (
              <Badge
                variant="outline"
                className="border-transparent bg-slate-100 text-slate-600"
              >
                {formatLeadAge(assignment.assigned_at)}
              </Badge>
            )}
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {lead.address ?? "Address on file"}
          </p>
        </div>
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          {lead.lead_type === "guaranteed_rent" ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
              Guaranteed Rent
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#EAF3DE] text-[#3B6D11]">
              Management
            </span>
          )}
          {lead.bedrooms && (
            <span className="text-sm text-muted-foreground">
              {lead.bedrooms} bed
            </span>
          )}
          {assignment.income_estimate != null && (
            <span className="rounded-full bg-brand/10 px-3 py-1 text-sm font-medium text-brand">
              {formatGBP(assignment.income_estimate)}/mo
            </span>
          )}
        </div>
      </button>
      </div>

      {open && (
        <div className="border-t-[0.5px] border-border px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {/* ⚠️ THE CONTACT DETAILS ARE BACK ON THIS CARD, AND 0079 IS
                REVERSED DELIBERATELY (§42). Do not read this as somebody
                undoing that change by accident.

                0079 removed the landlord's phone and email from here because
                "114 of 308 assignments were expanded in the feed and never
                opened on the detail page — roughly half of all engagement
                leaving no usable trace of whether anyone went after the lead".
                The objection was that a click HERE left no trace. Buttons that
                record tel_click / whatsapp_click / mailto_click ARE that trace,
                so the reason for the gate is gone — and keeping it now costs us
                exactly the signal it was introduced to protect. Operators work
                from this list; tel_click reading 13 against 666 detail_opened
                is partly an artefact of there being nothing here to click.

                Nothing was ever withheld either: this page selects
                `lead:leads(*)`, so the phone and email were already in the
                payload reaching the browser. 0079 was a rendering choice over
                data the client already had.

                ⚠️ It changes what `detail_opened` MEANS for the third time
                (0079, then 0123, now this), so the date is recorded in
                CLAUDE.md beside the other two. Contact actions will step up
                sharply and part of that is measurement, not behaviour. */}
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              {lead.phone && (
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  onClick={() => recordLeadEvent(assignment.id, "tel_click")}
                >
                  <a href={`tel:${lead.phone}`}>
                    <Phone className="h-4 w-4" />
                    {lead.phone}
                  </a>
                </Button>
              )}
              {waLink && (
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  onClick={() => recordLeadEvent(assignment.id, "whatsapp_click")}
                >
                  <a href={waLink} target="_blank" rel="noopener noreferrer">
                    <MessageCircle className="h-4 w-4" />
                    WhatsApp
                  </a>
                </Button>
              )}
              {lead.email && (
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  onClick={() => recordLeadEvent(assignment.id, "mailto_click")}
                >
                  <a href={`mailto:${lead.email}`}>
                    <Mail className="h-4 w-4" />
                    Email
                  </a>
                </Button>
              )}
            </div>
            <Detail icon={MapPin} label="Full address" value={lead.address} />
            <Detail
              icon={Calendar}
              label="Received"
              value={formatDate(assignment.assigned_at)}
            />
          </div>
          <IncomeProjection lead={lead} className="mt-3" />
          {lead.lead_profile && (
            <div className="mt-3 rounded-md bg-muted/50 p-3 text-sm">
              <p className="mb-1 font-medium text-muted-foreground">
                Lead profile notes
              </p>
              <p>{lead.lead_profile}</p>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <a
                href="https://intelligence.stayful.co.uk"
                target="_blank"
                rel="noopener noreferrer"
              >
                <BarChart3 className="h-4 w-4" />
                Open STR Analyser
              </a>
            </Button>
            <Button size="sm" asChild>
              <a
                href="/income-presentation/index.html"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Presentation className="h-4 w-4" />
                Income presentation
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href={`/dashboard/leads/${lead.id}?from=${from}`}>
                Open lead
              </Link>
            </Button>
            {!rejected && (
              <Button
                size="sm"
                variant="outline"
                onClick={markContacted}
                disabled={busy || contacted}
              >
                <Check className="h-4 w-4" />
                {contacted ? "Contacted" : "Mark as contacted"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
}) {
  // No link branches: the only fields on this card that warranted one were the
  // landlord's phone and email, and those now live on the lead detail page.
  const display = value || "\u2014";
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm">{display}</p>
      </div>
    </div>
  );
}
