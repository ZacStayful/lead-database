"use client";

/**
 * The state and handlers a lead's workspace shares between its columns
 * (§56.7). Lifted VERBATIM from the old single-column LeadDetail component —
 * every optimistic write, rollback and toast is the one that ran before, so
 * the split into three columns changed no behaviour.
 *
 * The gates themselves stay in src/lib/leadOutcomes.ts, where they are
 * proved across a matrix; this only feeds them.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { recordLeadEvent } from "@/lib/contact/leadEvents";
import { leadOutcomes, type LeadOutcomes } from "@/lib/leadOutcomes";
import { normaliseTags } from "@/lib/leadTags";
import type { AssignmentWithLead, ClientLeadEventType } from "@/lib/types";
import type { LeadWorkspaceData } from "@/lib/leadWorkspace";

export type DeadLeadPlacement = "banner" | "panel" | "none";

export interface LeadWorkflow {
  assignment: AssignmentWithLead;
  status: string;
  pipelineStage: string;
  dueDate: string;
  income: string;
  tags: string[];
  hasNotes: boolean;
  busy: boolean;
  toast: string | null;
  celebrateOpen: boolean;
  showDeleteConfirm: boolean;
  isOwnLead: boolean;
  isResoldLead: boolean;
  isGuaranteedRent: boolean;
  deadLeadPlacement: DeadLeadPlacement;
  outcomes: LeadOutcomes;
  prevHref: string | null;
  nextHref: string | null;
  recordEvent: (eventType: ClientLeadEventType) => void;
  setIncome: (v: string) => void;
  setToast: (v: string | null) => void;
  setCelebrateOpen: (v: boolean) => void;
  setShowDeleteConfirm: (v: boolean) => void;
  setHasNotes: (v: boolean) => void;
  dismissPrompt: () => void;
  handleDelete: () => Promise<void>;
  handleAccept: () => Promise<void>;
  handleSigned: () => Promise<void>;
  handleUnsign: () => Promise<void>;
  handleReject: (reason: string, detail: string) => Promise<void>;
  handleClose: (reason: string, detail: string) => Promise<void>;
  handleDiscard: (reason: string, detail: string) => Promise<void>;
  changePipeline: (stage: string) => Promise<void>;
  changeDueDate: (value: string) => Promise<void>;
  saveIncome: () => Promise<void>;
  saveTags: (tags: string[]) => Promise<boolean>;
}

export function useLeadWorkflow(data: LeadWorkspaceData): LeadWorkflow {
  const router = useRouter();
  const { assignment, notes, deadLeadClaim } = data;
  const lead = assignment.lead;
  const isGuaranteedRent = lead.lead_type === "guaranteed_rent";
  const [status, setStatus] = useState(assignment.status);
  const [pipelineStage, setPipelineStage] = useState(assignment.pipeline_stage);
  const [dueDate, setDueDate] = useState(assignment.due_to_call_date ?? "");
  const [income, setIncome] = useState(
    assignment.income_estimate != null ? String(assignment.income_estimate) : ""
  );
  const [tags, setTags] = useState<string[]>(assignment.tags ?? []);
  const [hasNotes, setHasNotes] = useState(notes.length > 0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Session-only. Dismissing moves the report into the outcome panel rather
  // than removing it — the operator can still reach it, it just stops leading.
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [celebrateOpen, setCelebrateOpen] = useState(false);

  // Re-seed when the server re-renders with a different lead (prev/next).
  useEffect(() => {
    setStatus(assignment.status);
    setPipelineStage(assignment.pipeline_stage);
    setDueDate(assignment.due_to_call_date ?? "");
    setIncome(assignment.income_estimate != null ? String(assignment.income_estimate) : "");
    setTags(assignment.tags ?? []);
    setHasNotes(notes.length > 0);
    setShowDeleteConfirm(false);
    setToast(null);
  }, [assignment.id, assignment.status, assignment.pipeline_stage, assignment.due_to_call_date, assignment.income_estimate, assignment.tags, notes.length]);

  const { from, prevLeadId, nextLeadId } = data.position;
  const prevHref = prevLeadId ? `/dashboard/leads/${prevLeadId}?from=${from}` : null;
  const nextHref = nextLeadId ? `/dashboard/leads/${nextLeadId}?from=${from}` : null;

  const assignmentId = assignment.id;
  // Passive engagement telemetry, through the shared recorder (§42) so the
  // pipeline card records identically. Deliberately fire-and-forget.
  const recordEvent = useCallback(
    (eventType: ClientLeadEventType) => recordLeadEvent(assignmentId, eventType),
    [assignmentId]
  );

  async function patch(payload: Record<string, unknown>) {
    return fetch(`/api/customer/assignments/${assignment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Remove a lead the customer added themselves. Deletes the lead outright —
   * with it go the assignment, notes and files, by the cascade. Nothing was
   * charged for it and it was never offered to anyone else, so there is no
   * record worth preserving once they say it is gone.
   */
  async function handleDelete() {
    setBusy(true);
    try {
      const res = await fetch(`/api/customer/my-leads/${lead.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      router.push("/dashboard/leads");
      router.refresh();
    } catch {
      setBusy(false);
      setShowDeleteConfirm(false);
      alert("Could not delete that lead. Please try again.");
    }
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

  async function handleUnsign() {
    setBusy(true);
    const res = await patch({ signed: false });
    if (res.ok) {
      setStatus("contacted");
      setToast("Win removed.");
      router.refresh();
    } else {
      setToast("Could not undo that. Please try again.");
    }
    setBusy(false);
  }

  async function handleReject(reason: string, detail: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${assignment.lead_id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignment.id, reason, detail }),
      });
      if (!res.ok) throw new Error();
      setStatus("rejected");
      setToast("Lead marked as rejected.");
      router.refresh();
    } catch {
      setToast("Could not reject this lead. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Record what happened on a lead that has actually been worked. Stays on
   * the page rather than routing away like discard does: the lead is still
   * theirs and still in their list, it is simply finished.
   */
  async function handleClose(reason: string, detail: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${assignment.lead_id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignment.id, reason, detail }),
      });
      if (!res.ok) throw new Error();
      setStatus("not_relevant");
      setToast("Thanks — that helps us send better leads.");
      router.refresh();
    } catch {
      setToast("Could not close this lead. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard(reason: string, detail: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${assignment.lead_id}/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignment.id, reason, detail }),
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
    try {
      const res = await patch({ pipeline_stage: stage });
      if (!res.ok) throw new Error();
      // The stage_changed event (0150) now feeds the activity column.
      router.refresh();
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
    setIncome(value === null ? "" : String(value));
    try {
      const res = await patch({ income_estimate: value });
      if (!res.ok) throw new Error();
    } catch {
      setToast("Could not update the income estimate.");
    }
  }

  /** Tags are per assignment (0150); the DB CHECK is the authority, this is the courtesy. */
  async function saveTags(next: string[]): Promise<boolean> {
    const v = normaliseTags(next);
    if (!v.ok) {
      setToast(v.error);
      return false;
    }
    const previous = tags;
    setTags(v.tags);
    try {
      const res = await patch({ tags: v.tags });
      if (!res.ok) throw new Error();
      return true;
    } catch {
      setTags(previous);
      setToast("Could not save the tags.");
      return false;
    }
  }

  // A lead the customer added themselves. The three marketplace exits make no
  // sense for one: reject is a chargeable outcome on a lead we sold, close
  // tells us not to re-offer the landlord to anybody else, and discard would
  // strand the leads row with no assignment at all. Delete is the verb for a
  // lead you own, and the API refuses the other three regardless of this.
  const isOwnLead = Boolean(lead.owner_customer_id);
  // owner_resale_qualified_at survives viewerScopedLead deliberately — it says
  // a lead was analysed and is shared, and identifies nobody.
  const isResoldLead = Boolean(lead.owner_resale_qualified_at);

  // ⚠️ Where the report sits, decided ONCE so it can never render in two
  // places (§51.6). A settled claim keeps the prominent slot; an INELIGIBLE
  // lead lands in the panel, greyed with the reason (0139).
  const deadLeadPlacement: DeadLeadPlacement = !deadLeadClaim
    ? "none"
    : deadLeadClaim.claimStatus
      ? "banner"
      : deadLeadClaim.prompt && !promptDismissed
        ? "banner"
        : "panel";

  const outcomes = leadOutcomes({
    status,
    pipelineStage,
    hasNotes,
    isOwnLead,
    isResoldLead,
    reportAvailable: deadLeadPlacement === "panel" && Boolean(deadLeadClaim?.claimable),
    reportUnavailableBecause: deadLeadClaim?.unavailableBecause ?? null,
  });

  return {
    assignment,
    status,
    pipelineStage,
    dueDate,
    income,
    tags,
    hasNotes,
    busy,
    toast,
    celebrateOpen,
    showDeleteConfirm,
    isOwnLead,
    isResoldLead,
    isGuaranteedRent,
    deadLeadPlacement,
    outcomes,
    prevHref,
    nextHref,
    recordEvent,
    setIncome,
    setToast,
    setCelebrateOpen,
    setShowDeleteConfirm,
    setHasNotes,
    dismissPrompt: () => setPromptDismissed(true),
    handleDelete,
    handleAccept,
    handleSigned,
    handleUnsign,
    handleReject,
    handleClose,
    handleDiscard,
    changePipeline,
    changeDueDate,
    saveIncome,
    saveTags,
  };
}
