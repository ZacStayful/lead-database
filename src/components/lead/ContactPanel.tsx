"use client";

/**
 * The contact panel (§56.7), shared by the lead page and the inbox.
 *
 * Fields, in the design's order, with the two corrections the cross-check
 * settled: Received (assigned_at) and NO enquiry date (§11); two labelled
 * incomes — "Your estimate" here (the operator's own `income_estimate`) and
 * "Stayful projection" under Work this lead (`gross_annual_income`). Never
 * merged (§25).
 *
 * Notes are the append-only list (§40.6) and the thread column shows the
 * messages, so LeadNotes renders WITHOUT its messages prop here.
 */
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Mail, MessageCircle, Phone, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LeadNotes } from "@/components/dashboard/LeadNotes";
import { LeadFiles } from "@/components/dashboard/LeadFiles";
import { statusBadge } from "@/components/dashboard/leadStatus";
import { pipelineBadgeClass, pipelineLabel, stagesForLeadType } from "@/components/dashboard/pipelineStage";
import { whatsappHandoffLink } from "@/lib/messaging/handoff";
import { formatDate } from "@/lib/utils";
import type { LeadWorkspaceData } from "@/lib/leadWorkspace";
import { Avatar } from "@/components/conversations/Avatar";
import { TagsEditor } from "./TagsEditor";
import { WorkThisLead } from "./WorkThisLead";
import type { LeadWorkflow } from "./useLeadWorkflow";

export function ContactPanel({
  data,
  wf,
  userId,
  header,
  onClose,
  openReport,
}: {
  data: LeadWorkspaceData;
  wf: LeadWorkflow;
  userId: string;
  /** "lead" carries back/prev/next + "n / N"; "contact" carries the close. */
  header: "lead" | "contact";
  onClose?: () => void;
  openReport: boolean;
}) {
  const { assignment, position } = data;
  const lead = assignment.lead;
  const badge = statusBadge(wf.status);
  const stageOptions = stagesForLeadType(lead.lead_type);
  const waLink = whatsappHandoffLink(lead.phone, "");

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-white">
      <header className="flex flex-shrink-0 items-center gap-2.5 border-b border-line px-4 py-3.5">
        {header === "lead" ? (
          <>
            <Link
              href={position.from === "priority" ? "/dashboard/leads/priority" : "/dashboard/leads"}
              aria-label="Back to leads"
              className="p-1 text-ink hover:text-brand-dark"
            >
              <ArrowLeft className="h-[18px] w-[18px]" />
            </Link>
            <h2 className="text-lg font-semibold">Lead details</h2>
            <div className="ml-auto flex items-center gap-1">
              {position.index >= 0 && (
                <span className="text-xs text-ink-2">
                  {position.index + 1} / {position.total}
                </span>
              )}
              <Arrow href={wf.prevHref} label="Previous lead">
                <ChevronLeft className="h-4 w-4" />
              </Arrow>
              <Arrow href={wf.nextHref} label="Next lead">
                <ChevronRight className="h-4 w-4" />
              </Arrow>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold">Contact details</h2>
            {onClose && (
              <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-ink-2 hover:text-ink">
                <X className="h-[18px] w-[18px]" />
              </button>
            )}
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {wf.toast && (
          <div className="mb-3 rounded-lg border border-line bg-page px-3 py-2 text-sm">{wf.toast}</div>
        )}

        {/* Identity */}
        <div className="flex gap-3 border-b border-rail pb-3.5">
          <Avatar name={lead.lead_name} size={48} />
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{lead.lead_name}</h3>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge variant="outline" className={badge.className}>
                {badge.label}
              </Badge>
              <Badge variant="outline" className={pipelineBadgeClass(wf.pipelineStage)}>
                {pipelineLabel(wf.pipelineStage)}
              </Badge>
              <Badge variant="outline" className="border-transparent bg-brand-light text-brand-dark">
                {lead.lead_type === "guaranteed_rent" ? "Guaranteed Rent" : "Management"}
              </Badge>
              {wf.isOwnLead && (
                <Badge
                  variant="outline"
                  className="border-transparent bg-sky-100 text-sky-700"
                  title={wf.isResoldLead ? "You added this lead yourself." : "You added this lead yourself. It is only visible to you."}
                >
                  Your lead
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Call / WhatsApp / Email — the events are the record (§42.6). */}
        <div className="flex gap-2 border-b border-rail py-3">
          <ActionButton href={lead.phone ? `tel:${lead.phone}` : null} onClick={() => wf.recordEvent("tel_click")} icon={Phone} label="Call" />
          <ActionButton href={waLink} onClick={() => wf.recordEvent("whatsapp_click")} icon={MessageCircle} label="WhatsApp" external />
          <ActionButton href={lead.email ? `mailto:${lead.email}` : null} onClick={() => wf.recordEvent("mailto_click")} icon={Mail} label="Email" />
        </div>

        <Field label="Address" value={lead.address} />
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="Bedrooms" value={lead.bedrooms ? `${lead.bedrooms}` : null} />
          <div className="border-b border-rail py-2.5">
            <label htmlFor="income" className="text-xs text-ink-2">
              Your estimate (£/mo)
            </label>
            <div className="mt-0.5 flex items-center">
              <span className="text-sm text-ink-2">£</span>
              <input
                id="income"
                type="number"
                min={0}
                inputMode="numeric"
                value={wf.income}
                onChange={(e) => wf.setIncome(e.target.value)}
                onBlur={() => void wf.saveIncome()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder="0"
                className="w-full bg-transparent pl-1 text-sm font-medium outline-none"
              />
            </div>
          </div>
        </div>
        {lead.lead_profile && <Field label="Lead profile" value={lead.lead_profile} />}
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="Received" value={formatDate(assignment.assigned_at)} />
          <div className="border-b border-rail py-2.5">
            <label htmlFor="due-date" className="text-xs text-ink-2">
              Due to call
            </label>
            <input
              id="due-date"
              type="date"
              value={wf.dueDate}
              onChange={(e) => void wf.changeDueDate(e.target.value)}
              className="mt-0.5 block w-full bg-transparent text-sm font-medium outline-none"
            />
          </div>
        </div>
        <Field
          label="Phone"
          value={lead.phone}
          href={lead.phone ? `tel:${lead.phone}` : undefined}
          onClick={() => wf.recordEvent("tel_click")}
        />
        <Field
          label="Email"
          value={lead.email}
          href={lead.email ? `mailto:${lead.email}` : undefined}
          onClick={() => wf.recordEvent("mailto_click")}
        />

        <div className="border-b border-rail py-2.5">
          <div className="text-xs text-ink-2">Pipeline stage</div>
          {wf.outcomes.stageLocked ? (
            <p className="mt-1 text-sm font-medium" title="Rejected leads can't be moved to another stage">
              {pipelineLabel(wf.pipelineStage)}
            </p>
          ) : (
            <label className="relative mt-1 flex h-[34px] items-center rounded-lg border border-control px-2.5 text-[13px] font-medium">
              <select
                aria-label="Pipeline stage"
                value={wf.pipelineStage}
                onChange={(e) => void wf.changePipeline(e.target.value)}
                className="w-full appearance-none bg-transparent pr-5 outline-none"
              >
                {(stageOptions.some((s) => s.value === wf.pipelineStage)
                  ? stageOptions
                  : [{ value: wf.pipelineStage, label: pipelineLabel(wf.pipelineStage) }, ...stageOptions]
                ).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-ink-2" />
            </label>
          )}
        </div>

        <div className="border-b border-rail py-2.5">
          <div className="mb-1.5 text-xs text-ink-2">Tags</div>
          <TagsEditor tags={wf.tags} onSave={wf.saveTags} />
        </div>

        <div className="py-2.5">
          <LeadNotes assignmentId={assignment.id} initialNotes={data.notes} onNoteAdded={() => wf.setHasNotes(true)} />
        </div>

        <div className="py-2.5">
          <LeadFiles assignmentId={assignment.id} userId={userId} initialFiles={data.files} />
        </div>

        <div className="mt-2 border-t border-line pt-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-2">Work this lead</h3>
          <WorkThisLead data={data} wf={wf} openReport={openReport} />
        </div>
      </div>
    </aside>
  );
}

function Arrow({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  if (!href) {
    return (
      <span aria-hidden className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-2/30">
        {children}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-page hover:text-ink">
      {children}
    </Link>
  );
}

function ActionButton({
  href,
  onClick,
  icon: Icon,
  label,
  external,
}: {
  href: string | null;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  external?: boolean;
}) {
  const cls =
    "flex h-[34px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-control bg-white text-[13px] font-semibold text-ink";
  if (!href) {
    return (
      <span className={cls + " opacity-40"} title={`No ${label.toLowerCase()} details on this lead`}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      onClick={onClick}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cls + " hover:bg-page"}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </a>
  );
}

function Field({
  label,
  value,
  href,
  onClick,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
  onClick?: () => void;
}) {
  return (
    <div className="border-b border-rail py-2.5">
      <div className="text-xs text-ink-2">{label}</div>
      {value && href ? (
        <a href={href} onClick={onClick} className="mt-0.5 block break-words text-sm font-medium text-brand hover:underline">
          {value}
        </a>
      ) : (
        <p className="mt-0.5 break-words text-sm font-medium">{value || "—"}</p>
      )}
    </div>
  );
}
