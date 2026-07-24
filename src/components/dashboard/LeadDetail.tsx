"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { statusBadge } from "@/components/dashboard/leadStatus";
import {
  pipelineStatusText,
  pipelineBadgeClass,
  pipelineLabel,
  stagesForLeadType,
} from "@/components/dashboard/pipelineStage";
import { LeadNotes } from "@/components/dashboard/LeadNotes";
import { LeadFiles } from "@/components/dashboard/LeadFiles";
import { SignedCelebration } from "@/components/dashboard/SignedCelebration";
import type { AssignmentWithLead, LeadNote, LeadFile } from "@/lib/types";
import type { LeadSource } from "@/lib/leadOrder";
import {
  ArrowLeft,
  BarChart3,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Mail,
  MapPin,
  MessageSquareText,
  PartyPopper,
  Phone,
  Presentation,
  Trash2,
} from "lucide-react";

export function LeadDetail({
  assignment,
  notes,
  files,
  userId,
  from,
  prevLeadId,
  nextLeadId,
  signedCountBefore,
}: {
  assignment: AssignmentWithLead;
  notes: LeadNote[];
  files: LeadFile[];
  userId: string;
  from: LeadSource;
  prevLeadId: string | null;
  nextLeadId: string | null;
  signedCountBefore: number;
}) {
  const router = useRouter();
  const lead = assignment.lead;
  const isGuaranteedRent = lead.lead_type === "guaranteed_rent";
  const stageOptions = stagesForLeadType(lead.lead_type);
  const [status, setStatus] = useState(assignment.status);
  const [pipelineStage, setPipelineStage] = useState(assignment.pipeline_stage);
  const [dueDate, setDueDate] = useState(assignment.due_to_call_date ?? "");
  const [income, setIncome] = useState(
    assignment.income_estimate != null ? String(assignment.income_estimate) : ""
  );
  const [editingPipeline, setEditingPipeline] = useState(false);
  const [hasNotes, setHasNotes] = useState(notes.length > 0);
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [celebrateOpen, setCelebrateOpen] = useState(false);

  const prevHref = prevLeadId ? `/dashboard/leads/${prevLeadId}?from=${from}` : null;
  const nextHref = nextLeadId ? `/dashboard/leads/${nextLeadId}?from=${from}` : null;

  // Keyboard prev/next — ignored while a text field or date picker is focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      if (e.key === "ArrowLeft" && prevHref) router.push(prevHref);
      if (e.key === "ArrowRight" && nextHref) router.push(nextHref);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevHref, nextHref, router]);

  async function patch(payload: Record<string, unknown>) {
    return fetch(`/api/customer/assignments/${assignment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function handleAccept() {
    setBusy(true);
    setStatus("contacted");
    try {
      await patch({ contacted: true });
      router.refresh();
    } catch {
      setStatus(assignment.status);
    } finally {
      setBusy(false);
    }
  }

  async function handleSigned() {
    const previous = status;
    setBusy(true);
    setStatus("won");
    try {
      const res = await patch({ signed: true });
      if (!res.ok) throw new Error();
      // Celebrate + invite a testimonial; the server refresh runs on close so
      // the modal isn't torn down mid-interaction.
      setCelebrateOpen(true);
    } catch {
      setStatus(previous);
      setToast("Could not mark this lead as signed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${assignment.lead_id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignment.id }),
      });
      if (!res.ok) throw new Error();
      setStatus("rejected");
      setShowRejectConfirm(false);
      setToast("Lead marked as rejected.");
      router.refresh();
    } catch {
      setToast("Could not reject this lead. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${assignment.lead_id}/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignment.id }),
      });
      if (!res.ok) throw new Error();
      router.push("/dashboard/leads");
    } catch {
      setToast("Could not discard this lead. Please try again.");
      setBusy(false);
    }
  }

  async function changePipeline(stage: string) {
    const previous = pipelineStage;
    setPipelineStage(stage);
    setEditingPipeline(false);
    try {
      const res = await patch({ pipeline_stage: stage });
      if (!res.ok) throw new Error();
    } catch {
      setPipelineStage(previous);
      setToast("Could not update pipeline stage.");
    }
  }

  async function changeDueDate(value: string) {
    const previous = dueDate;
    setDueDate(value);
    try {
      const res = await patch({ due_to_call_date: value });
      if (!res.ok) throw new Error();
    } catch {
      setDueDate(previous);
      setToast("Could not update the call-back date.");
    }
  }

  async function saveIncome() {
    const raw = income.trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) {
      setToast("Income must be a number.");
      return;
    }
    // Normalise the displayed value.
    setIncome(value === null ? "" : String(value));
    try {
      const res = await patch({ income_estimate: value });
      if (!res.ok) throw new Error();
    } catch {
      setToast("Could not update the income estimate.");
    }
  }

  const badge = statusBadge(status);
  const canDiscard = status === "new" && !hasNotes;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Back + prev/next */}
      <div className="flex items-center justify-between">
        <Link
          href="/dashboard/leads"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          All leads
        </Link>
        <div className="flex items-center gap-1">
          <ArrowControl href={prevHref} label="Previous lead">
            <ChevronLeft className="h-4 w-4" />
          </ArrowControl>
          <ArrowControl href={nextHref} label="Next lead">
            <ChevronRight className="h-4 w-4" />
          </ArrowControl>
        </div>
      </div>

      {toast && (
        <div className="rounded-lg border-[0.5px] border-border bg-muted/50 px-4 py-3 text-sm">
          {toast}
        </div>
      )}

      <div className="rounded-xl border-[0.5px] border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{lead.lead_name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Assigned {formatDate(assignment.assigned_at)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge variant="outline" className={badge.className}>
              {badge.label}
            </Badge>
            {/* Pipeline stage — independent of status, click to edit */}
            {editingPipeline ? (
              <select
                autoFocus
                value={pipelineStage}
                onChange={(e) => changePipeline(e.target.value)}
                onBlur={() => setEditingPipeline(false)}
                className="rounded-md border-[0.5px] border-input bg-background px-2 py-1 text-xs"
              >
                {(stageOptions.some((s) => s.value === pipelineStage)
                  ? stageOptions
                  : [
                      { value: pipelineStage, label: pipelineLabel(pipelineStage) },
                      ...stageOptions,
                    ]
                ).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            ) : (
              <button
                onClick={() => setEditingPipeline(true)}
                title="Click to change pipeline stage"
              >
                <Badge
                  variant="outline"
                  className={pipelineBadgeClass(pipelineStage)}
                >
                  {pipelineStatusText(pipelineStage)}
                </Badge>
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Detail icon={Mail} label="Email" value={lead.email} isEmail />
          <Detail icon={Phone} label="Phone" value={lead.phone} isPhone />
          <Detail icon={MapPin} label="Address" value={lead.address} />
          <Detail
            icon={Calendar}
            label="Enquiry date"
            value={formatDate(lead.enquiry_date)}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <FieldRow label="Bedrooms" value={lead.bedrooms} />
          <div>
            <label
              htmlFor="due-date"
              className="text-xs text-muted-foreground"
            >
              Due to call
            </label>
            <input
              id="due-date"
              type="date"
              value={dueDate}
              onChange={(e) => changeDueDate(e.target.value)}
              className="mt-0.5 block rounded-md border-[0.5px] border-input bg-background px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label
              htmlFor="income"
              className="text-xs text-muted-foreground"
            >
              Estimated monthly income (£)
            </label>
            <div className="mt-0.5 flex items-center rounded-md border-[0.5px] border-input bg-background px-2">
              <span className="text-sm text-muted-foreground">£</span>
              <input
                id="income"
                type="number"
                min={0}
                inputMode="numeric"
                value={income}
                onChange={(e) => setIncome(e.target.value)}
                onBlur={saveIncome}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder="0"
                className="w-full bg-transparent py-1 pl-1 text-sm focus:outline-none"
              />
            </div>
          </div>
        </div>

        {lead.lead_profile && (
          <div className="mt-4 rounded-md bg-muted/50 p-3 text-sm">
            <p className="mb-1 font-medium text-muted-foreground">
              Lead profile notes
            </p>
            <p>{lead.lead_profile}</p>
          </div>
        )}

        {isGuaranteedRent && (
          <a
            href="https://intelligence.stayful.co.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-[#5D8156] hover:underline mt-3"
          >
            Run figures on this property →
          </a>
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
              href="/dashboard/objection-assistant"
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageSquareText className="h-4 w-4" />
              Objection Assistant
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
        </div>

        {status === "new" && (
          <div className="mt-6 flex flex-col gap-3">
            <button
              onClick={() => handleAccept()}
              disabled={busy}
              className="w-full rounded-lg bg-[#3B6D11] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
            >
              Mark as contacted
            </button>
            {!showRejectConfirm ? (
              <button
                onClick={() => setShowRejectConfirm(true)}
                disabled={busy}
                className="w-full rounded-lg border border-black/10 px-6 py-3 text-sm font-medium text-[#898781] transition-colors hover:bg-gray-50"
              >
                Reject this lead
              </button>
            ) : (
              <div className="rounded-xl border border-black/10 bg-white p-4">
                <p className="mb-3 text-sm text-[#52514e]">
                  Mark this lead as rejected? It still counts toward your leads
                  this month and won&apos;t be replaced — this just records that
                  you&apos;re passing on it.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleReject()}
                    disabled={busy}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                  >
                    Confirm rejection
                  </button>
                  <button
                    onClick={() => setShowRejectConfirm(false)}
                    disabled={busy}
                    className="flex-1 rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-[#52514e] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Discard — only while brand new and un-noted. */}
            {canDiscard &&
              (!showDiscardConfirm ? (
                <button
                  onClick={() => setShowDiscardConfirm(true)}
                  disabled={busy}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-black/10 px-6 py-3 text-sm font-medium text-[#898781] transition-colors hover:bg-gray-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Discard lead
                </button>
              ) : (
                <div className="rounded-xl border border-black/10 bg-white p-4">
                  <p className="mb-3 text-sm text-[#52514e]">
                    Discard this lead? It will be released for another operator.
                    You can only do this before adding a note or changing the
                    status, and it still counts toward your monthly allocation.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleDiscard()}
                      disabled={busy}
                      className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                    >
                      Confirm discard
                    </button>
                    <button
                      onClick={() => setShowDiscardConfirm(false)}
                      disabled={busy}
                      className="flex-1 rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-[#52514e] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
        {/* Terminal positive outcome. Available once the lead has been worked
            (contacted / in discussion) — signing is the conversion signal the
            ROI funnel counts. */}
        {(status === "contacted" || status === "in_discussion") && (
          <div className="mt-6">
            <button
              onClick={() => handleSigned()}
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#5D8156] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#4c6b47] disabled:opacity-60"
            >
              <PartyPopper className="h-4 w-4" />
              Mark as signed
            </button>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Signed the landlord? Marking it here tracks your conversion rate.
            </p>
          </div>
        )}

        {status === "won" && (
          <div className="mt-6 flex items-center gap-2 rounded-lg border border-[#5D8156]/30 bg-[#EAF3DE] px-4 py-3 text-sm font-medium text-[#3B6D11]">
            <PartyPopper className="h-4 w-4 shrink-0" />
            Signed — landlord onboarded. Nice one.
          </div>
        )}
      </div>

      <SignedCelebration
        open={celebrateOpen}
        onClose={() => {
          setCelebrateOpen(false);
          router.refresh();
        }}
        signedNumber={signedCountBefore + 1}
        assignmentId={assignment.id}
      />

      <LeadFiles
        assignmentId={assignment.id}
        userId={userId}
        initialFiles={files}
      />

      <LeadNotes
        assignmentId={assignment.id}
        initialNotes={notes}
        onNoteAdded={() => setHasNotes(true)}
      />
    </div>
  );
}

function ArrowControl({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!href) {
    return (
      <span
        aria-hidden
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground/30"
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </Link>
  );
}

function FieldRow({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm">{value || "—"}</p>
    </div>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
  isEmail,
  isPhone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
  isEmail?: boolean;
  isPhone?: boolean;
}) {
  const display = value || "—";
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        {isEmail && value ? (
          <a href={`mailto:${value}`} className="text-sm text-brand hover:underline">
            {value}
          </a>
        ) : isPhone && value ? (
          <a href={`tel:${value}`} className="text-sm text-brand hover:underline">
            {value}
          </a>
        ) : (
          <p className="text-sm break-words">{display}</p>
        )}
      </div>
    </div>
  );
}
