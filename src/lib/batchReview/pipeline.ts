/**
 * How a review answer relates to the lead's own pipeline (§73).
 *
 * Two directions:
 *   - PREFILL: what the pipeline already says, so the customer only has to
 *     confirm. Only stages that map unambiguously are prefilled; `cold` is left
 *     blank, so a customer has to say whether they rang the lead.
 *   - WRITE-BACK: what an answer changes on the assignment. There is one source
 *     of truth, so the survey and the dashboard can never disagree.
 *
 * ⚠️ IMPORT-FREE: the form prefills from this in the browser. Same rule as
 * answers.ts.
 *
 * ⚠️ A SETTLED LEAD IS READ-ONLY. Won, rejected and closed leads are shown and
 * cannot be changed. A rejected lead is chargeable and settled (0019, §6A).
 * `PATCH /api/customer/assignments/[id]` refuses to move it, and the survey must
 * not be a second door round that guard.
 */
import type { BatchAnswer, LeadTypeKey } from "./answers";

export interface AssignmentState {
  status: string | null;
  pipeline_stage: string | null;
  closed_at: string | null;
}

export type ReadOnlyReason = "won" | "rejected" | "closed" | "gone";

export function readOnlyReason(state: AssignmentState | null): ReadOnlyReason | null {
  if (!state) return "gone";
  if (state.status === "rejected") return "rejected";
  if (state.status === "won") return "won";
  if (state.closed_at) return "closed";
  return null;
}

export const READ_ONLY_LABEL: Record<ReadOnlyReason, string> = {
  won: "Signed. Nothing to change.",
  rejected: "You passed on this lead.",
  closed: "You closed this lead.",
  gone: "No longer in your leads.",
};

export function prefillAnswer(
  leadType: LeadTypeKey,
  state: AssignmentState | null
): BatchAnswer | null {
  if (!state) return null;
  if (state.status === "won") return "signed";
  const stage = state.pipeline_stage;
  if (leadType === "guaranteed_rent") {
    if (stage === "viewing_booked") return "viewing_booked";
    if (stage === "contract_sent") return "contract_sent";
    if (stage === "contract_signed") return "signed";
    return null;
  }
  switch (stage) {
    // A no-show still counts as booked (§20).
    case "web_meeting_booked":
    case "web_meeting_no_show":
      return "meeting_booked";
    case "web_meeting_attended":
      return "meeting_held";
    case "interested_in_the_future":
      return "likely_later";
    case "abandoned":
      return "not_interested";
    case "won":
      return "signed";
    default:
      return null;
  }
}

export interface PipelineChange {
  /** Set only when the lead is still `new`. A worked lead keeps its status. */
  markContacted: boolean;
  pipeline_stage?: string;
}

/**
 * What an answer writes. Null means nothing, which covers a settled lead and an
 * answer with no pipeline counterpart.
 *
 * GR has no `abandoned` stage and no "later" stage, so `not_interested` and
 * `likely_later` record the answer and change only the contacted flag.
 */
export function pipelineChangeFor(
  leadType: LeadTypeKey,
  answer: BatchAnswer,
  state: AssignmentState | null
): PipelineChange | null {
  if (readOnlyReason(state) !== null) return null;
  if (answer === "not_called") return null;

  const stage = (() => {
    if (leadType === "guaranteed_rent") {
      switch (answer) {
        case "viewing_booked":
          return "viewing_booked";
        case "contract_sent":
          return "contract_sent";
        case "signed":
          return "contract_signed";
        default:
          return undefined;
      }
    }
    switch (answer) {
      case "not_interested":
        return "abandoned";
      case "meeting_booked":
        return "web_meeting_booked";
      case "meeting_held":
        return "web_meeting_attended";
      case "likely_later":
        return "interested_in_the_future";
      case "signed":
        return "won";
      default:
        return undefined;
    }
  })();

  const markContacted = state?.status === "new";
  const stageChanges = stage !== undefined && stage !== state?.pipeline_stage;
  if (!markContacted && !stageChanges) return null;
  return stageChanges ? { markContacted, pipeline_stage: stage } : { markContacted };
}
