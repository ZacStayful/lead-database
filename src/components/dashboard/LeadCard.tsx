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
  MapPin,
  Calendar,
  Presentation,
} from "lucide-react";

export function LeadCard({
  assignment: initial,
  from = "leads",
}: {
  assignment: AssignmentWithLead;
  from?: string;
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
                title="You added this lead yourself. It is only visible to you."
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

      {open && (
        <div className="border-t-[0.5px] border-border px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Contact details live on the lead detail page only.

                This card used to render the landlord's phone and email as
                tel:/mailto: links, so an operator could take the number
                straight from the feed. 114 of 308 assignments were expanded
                here and never opened on the detail page — roughly half of all
                engagement leaving no usable trace of whether anyone went after
                the lead.

                Putting the details one click away makes that click mean
                something: nobody opens a lead they have no intention of
                ringing. The open is recorded as detail_opened, so "went for
                the contact details, and how many times" becomes measurable
                where before it was invisible.

                Everything else about the lead stays here. The gate is on the
                two fields that represent intent to make contact, not on the
                information an operator needs to decide whether the lead is
                worth their time. */}
            <div className="sm:col-span-2 flex items-start gap-2">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  Phone and email
                </p>
                <Link
                  href={`/dashboard/leads/${lead.id}?from=${from}`}
                  className="text-sm text-brand hover:underline"
                >
                  Open the lead to see contact details
                </Link>
              </div>
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
