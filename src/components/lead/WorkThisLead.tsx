"use client";

/**
 * "Work this lead" — every control the single-column lead page had, under
 * the contact fields (§56.7). Nothing is dropped, and every gate is the one
 * it had: `leadOutcomes()` from src/lib/leadOutcomes.ts, the report's
 * placement decided once in the workflow hook, own/resold/GR flags from the
 * lead. ⚠️ The outcome and report controls stay reachable here on purpose —
 * §51.10 measured what hiding them cost (126 eligible, zero reports).
 */
import { BarChart3, Info, MessageSquareText, PartyPopper, Presentation, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContactTimeline } from "@/components/dashboard/ContactTimeline";
import { LandlordHandoff } from "@/components/dashboard/LandlordHandoff";
import { IncomeProjection } from "@/components/dashboard/IncomeProjection";
import { AnalysisOfferPanel } from "@/components/dashboard/AnalysisOfferPanel";
import { LEAD_ANALYSIS_PRICE_PENCE, analysability } from "@/lib/leadAnalysis";
import { IncomeReportLink } from "@/components/dashboard/IncomeReportLink";
import { DeadLeadClaimCard } from "@/components/dashboard/DeadLeadClaimCard";
import { LeadOutcomePanel } from "@/components/dashboard/LeadOutcomePanel";
import { formatLeadAge } from "@/lib/utils";
import type { LeadWorkspaceData } from "@/lib/leadWorkspace";
import type { LeadWorkflow } from "./useLeadWorkflow";

export function WorkThisLead({
  data,
  wf,
  openReport,
}: {
  data: LeadWorkspaceData;
  wf: LeadWorkflow;
  openReport: boolean;
}) {
  const { assignment, contactTimeline, deadLeadClaim, messageCount, presentationConfigured } = data;
  const lead = assignment.lead;
  const { status, busy, isOwnLead, isResoldLead, isGuaranteedRent, deadLeadPlacement, outcomes } = wf;
  const { showActions } = outcomes;

  return (
    <div className="space-y-4">
      {/*
        ⚠️ Above everything, and only once the operator has opened this lead
        three or more times AND actually tried to contact the landlord. It
        names no credit and never names the trigger (§51.10).
      */}
      {deadLeadPlacement === "banner" && deadLeadClaim && (
        <DeadLeadClaimCard
          variant="prominent"
          assignmentId={assignment.id}
          claimable={deadLeadClaim.claimable}
          claimStatus={deadLeadClaim.claimStatus}
          reasons={deadLeadClaim.reasons}
          defaultOpen={openReport && deadLeadClaim.claimable}
          onDismiss={wf.dismissPrompt}
        />
      )}

      {/* Reclaimed lead — say plainly what this is before they pick up the phone. */}
      {assignment.is_reclaimed && (
        <div className="rounded-lg border border-line bg-page px-4 py-3">
          <p className="text-sm font-medium">{formatLeadAge(assignment.assigned_at)}</p>
          <p className="mt-1 text-sm text-ink-2">
            This lead was offered to another operator first and wasn&apos;t taken up, so it&apos;s come to
            you at a reduced rate. The landlord may not have been contacted yet.
          </p>
        </div>
      )}

      {showActions && status === "new" && (
        <button
          onClick={() => void wf.handleAccept()}
          disabled={busy}
          className="w-full rounded-lg bg-brand-dark px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d5409] disabled:opacity-60"
        >
          Mark as contacted
        </button>
      )}

      {/* The one way to end a lead (§51.10). */}
      <LeadOutcomePanel
        outcomes={outcomes}
        busy={busy}
        deadLead={
          deadLeadPlacement === "panel" && deadLeadClaim
            ? { assignmentId: assignment.id, claimStatus: deadLeadClaim.claimStatus, reasons: deadLeadClaim.reasons }
            : null
        }
        onReject={wf.handleReject}
        onDiscard={wf.handleDiscard}
        onClose={wf.handleClose}
      />

      {(status === "contacted" || status === "in_discussion") && (
        <div>
          <button
            onClick={() => void wf.handleSigned()}
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#4c6b47] disabled:opacity-60"
          >
            <PartyPopper className="h-4 w-4" />
            Mark as signed
          </button>
          <p className="mt-2 text-center text-xs text-ink-2">
            Signed the landlord? Marking it here tracks your conversion rate.
          </p>
        </div>
      )}

      {status === "not_relevant" && (
        <div className="rounded-lg border border-line bg-page px-4 py-3 text-sm text-ink-3">
          Closed — thanks for telling us. This landlord won&apos;t be offered to anyone else.
        </div>
      )}

      {status === "won" && (
        <div className="flex items-center gap-2 rounded-lg border border-brand/30 bg-brand-light px-4 py-3 text-sm font-medium text-brand-dark">
          <PartyPopper className="h-4 w-4 shrink-0" />
          Signed — landlord onboarded. Nice one.
          <button
            onClick={() => void wf.handleUnsign()}
            disabled={busy}
            className="ml-auto shrink-0 text-xs font-normal underline underline-offset-2 opacity-70 hover:opacity-100 disabled:opacity-40"
          >
            Undo
          </button>
        </div>
      )}

      {contactTimeline && (
        <ContactTimeline
          view={contactTimeline}
          leadId={lead.id}
          assignmentId={assignment.id}
          phone={lead.phone ?? null}
          email={lead.email ?? null}
          className="border-t border-line pt-4"
        />
      )}

      {/* Stayful projection — OURS (§25). The operator's own estimate is the input above. */}
      <div>
        <IncomeProjection lead={lead} />
        <IncomeReportLink
          leadId={lead.id}
          available={Boolean(lead.income_report_path)}
          sizeBytes={lead.income_report_size_bytes}
          className="mt-3"
        />
        {isOwnLead && !lead.gross_annual_income && analysability(lead).ok && (
          <AnalysisOfferPanel
            offer={{ eligible_lead_ids: [lead.id], amount_pence: LEAD_ANALYSIS_PRICE_PENCE, ineligible: [] }}
            leadType={lead.lead_type}
            source="detail"
            heading="Run the figures on this property"
          />
        )}
      </div>

      {/* What the landlord was told about THIS operator, and what they said back (§41). */}
      <LandlordHandoff sentAt={assignment.landlord_referral_sent_at ?? null} lead={lead} />

      {isGuaranteedRent && (
        <a
          href="https://intelligence.stayful.co.uk"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-brand hover:underline"
        >
          Run figures on this property →
        </a>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <a href="https://intelligence.stayful.co.uk" target="_blank" rel="noopener noreferrer">
            <BarChart3 className="h-4 w-4" />
            Open STR Analyser
          </a>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href="/dashboard/objection-assistant" target="_blank" rel="noopener noreferrer">
            <MessageSquareText className="h-4 w-4" />
            Objection Assistant
          </a>
        </Button>
        {/* ?lead= only for management: the report's figures are a management pitch (invariant 6). */}
        <Button size="sm" variant="outline" asChild>
          <a
            href={isGuaranteedRent ? "/income-presentation/index.html" : `/income-presentation/index.html?lead=${lead.id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Presentation className="h-4 w-4" />
            {isGuaranteedRent ? "Income presentation" : "Presentation for this lead"}
          </a>
        </Button>
      </div>

      {!isGuaranteedRent && !presentationConfigured && (
        <p className="text-xs text-ink-2">
          The presentation fills itself in from this property&rsquo;s analysis.{" "}
          <a href="/dashboard/settings#presentation" className="text-brand hover:underline">
            Set up your own fee and terms
          </a>{" "}
          so it uses yours.
        </p>
      )}

      <div className="flex items-start gap-3 rounded-lg border border-line bg-page px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-2" />
        <div className="text-sm">
          <p className="font-medium">Keep this lead up to date</p>
          <p className="mt-1 text-ink-2">
            Updating the status and adding a note after each contact keeps your pipeline organised, and
            it&apos;s how we measure how well the lead database is working for you.
          </p>
        </div>
      </div>

      {/* Delete — only for a lead the customer added themselves, and the only exit they get. */}
      {isOwnLead && (
        <div>
          {!wf.showDeleteConfirm ? (
            <button
              onClick={() => wf.setShowDeleteConfirm(true)}
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-control px-6 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:bg-page disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
              Delete this lead
            </button>
          ) : (
            <div className="rounded-xl border border-line bg-white p-4">
              <p className="mb-3 text-sm text-ink-3">
                {isResoldLead
                  ? "Remove this lead from your database? Your notes and files on it go with it, and it cannot be undone."
                  : "Delete this lead for good? You added it yourself, so it is only in your database — its notes and files go with it, and it cannot be undone."}
              </p>
              {/*
                ⚠️ MESSAGES ARE NOT DELETED, AND THIS MUST NOT SAY THEY ARE.
                lead_messages.assignment_id is ON DELETE SET NULL (0116), so the
                rows survive; the timeline is keyed on assignment_id, so the
                conversation vanishes from the dashboard.
              */}
              {messageCount > 0 && (
                <p className="mb-3 text-sm text-amber-700">
                  This lead has {messageCount} {messageCount === 1 ? "message" : "messages"}. They stay in our
                  records, but they will no longer appear anywhere in your dashboard.
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => void wf.handleDelete()}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                >
                  Delete lead
                </button>
                <button
                  onClick={() => wf.setShowDeleteConfirm(false)}
                  disabled={busy}
                  className="flex-1 rounded-lg border border-control px-4 py-2 text-sm font-medium text-ink-3"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
