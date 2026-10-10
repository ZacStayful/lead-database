import { holdsProduct, type ProductCustomerFields } from "@/lib/products";
import type { BriefPlan } from "@/lib/leadBrief/plans";
import type { Customer } from "@/lib/types";

/**
 * Who must complete a Lead Brief before seeing the dashboard (Phase 3).
 *
 * Three conditions, all of them required:
 *   - `lead_brief_required`: false on every customer who existed before the
 *     brief shipped (0162), so no existing customer is ever redirected;
 *   - no `lead_brief_completed_at` yet: confirming the brief stamps it, and
 *     that is what releases the gate (A3: there is never a dead end);
 *   - they hold Management. The brief is Management only, and a GR-only
 *     customer must never be gated by it (invariant 6).
 *
 * ⚠️ NOT TIED TO `lead_brief_enabled`. That switch is Phase 4's routing
 * switch. A flagged customer who skipped the brief would land on a dashboard
 * with nothing coming, so the gate holds whatever the switch says.
 */
export type BriefGateFields = ProductCustomerFields &
  Pick<Customer, "lead_brief_required" | "lead_brief_completed_at">;

export function needsLeadBrief(customer: BriefGateFields | null | undefined): boolean {
  if (!customer) return false;
  return (
    customer.lead_brief_required === true &&
    !customer.lead_brief_completed_at &&
    holdsProduct(customer, "management")
  );
}

/**
 * Who may open the "Your brief" editor (Phase 5): a customer who has
 * confirmed a brief and still holds Management. Everyone else is sent back to
 * their leads, and the editor routes refuse them.
 */
export function canEditLeadBrief(customer: BriefGateFields | null | undefined): boolean {
  if (!customer) return false;
  return (
    customer.lead_brief_required === true &&
    !!customer.lead_brief_completed_at &&
    holdsProduct(customer, "management")
  );
}

/**
 * The plan a customer's brief is computed for: 10 or 20 leads a month.
 *
 * ⚠️ READ FROM THE ROW, NEVER FROM A REQUEST BODY. A pending tier change
 * (§24) wins over the current allocation: a customer who chose "Switch to 10
 * leads a month" on the brief preview has `pending_monthly_allocation = 10`
 * until their next invoice, and their brief is computed for the 10-lead area
 * they were shown. Anything at or under 10 is the 10-lead plan; anything else
 * (including a bespoke allocation above 20, §33) is the 20-lead plan.
 */
export function briefPlanFor(
  customer: Pick<Customer, "monthly_allocation" | "pending_monthly_allocation">
): BriefPlan {
  const allocation = customer.pending_monthly_allocation ?? customer.monthly_allocation;
  return typeof allocation === "number" && allocation <= 10 ? 10 : 20;
}

/** The confirm-on-login screen (batch 04 Phase 3); defined in the import-free copy module. */
export { AREA_CONFIRM_PATH } from "@/lib/leadBrief/areaConfirmCopy";

/**
 * Who must review a recalculated area before the dashboard (batch 04 Phase 3,
 * locked decision 4): a customer who has confirmed a brief, still holds
 * Management, and has a `pending_confirmation` version.
 *
 * `hasPending` is the server's read of that row. NULL means the read failed,
 * and that FAILS OPEN: an unreadable table must never lock a customer out of
 * their own leads. The cost is one sign-in without the screen; a return stays
 * held regardless (the customer is still paused, C4), and the 72-hour
 * auto-accept is the backstop.
 *
 * False for every customer who existed before the brief shipped: they fail
 * canEditLeadBrief, and they never have a brief row at all.
 */
export function needsAreaConfirmation(
  customer: BriefGateFields | null | undefined,
  hasPending: boolean | null
): boolean {
  return canEditLeadBrief(customer) && hasPending === true;
}
