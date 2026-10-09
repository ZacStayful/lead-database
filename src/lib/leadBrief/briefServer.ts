import type { SupabaseClient } from "@supabase/supabase-js";
import { briefPlanFor } from "@/lib/leadBrief/gate";
import type { BriefInputIssue } from "@/lib/leadBrief/input";
import { computeBriefPreview, type BriefPreview } from "@/lib/leadBrief/preview";
import type { ParsedBriefBody } from "@/lib/leadBrief/briefRequest";
import { loadBriefSupply } from "@/lib/leadBrief/supply";
import type { Customer } from "@/lib/types";

/**
 * The questionnaire's one server-side computation, shared by the preview and
 * confirm routes so they cannot disagree. SERVER-SIDE ONLY.
 *
 * - The plan comes from the customer's row (`briefPlanFor`), never the body.
 * - The supply excludes this customer, so their own legacy rows (if any) do
 *   not count against them.
 * - `autoTickRecommended`: on the first preview the body carries no similar
 *   areas; the engine's recommended area is then ticked and the preview
 *   recomputed, so the radius shown already includes it (A8: pre-ticked).
 *
 * Throws BriefSupplyUnavailableError when the book cannot be read: callers
 * answer 503, never an empty preview (§58).
 */
export type BriefComputation =
  | { ok: true; preview: BriefPreview }
  | { ok: false; issues: BriefInputIssue[] };

export async function computeBriefForCustomer(
  admin: SupabaseClient,
  customer: Pick<Customer, "id" | "monthly_allocation" | "pending_monthly_allocation">,
  parsed: ParsedBriefBody,
  opts: { autoTickRecommended: boolean }
): Promise<BriefComputation> {
  const supply = await loadBriefSupply(admin, { excludeCustomerId: customer.id });
  const plan = briefPlanFor(customer);

  const first = computeBriefPreview(parsed.input, plan, supply);
  if (!first.ok) return first;

  if (opts.autoTickRecommended && !parsed.similarAreasGiven) {
    const recommended = first.preview.similarAreas.find((s) => s.recommended);
    if (recommended) {
      const ticked = computeBriefPreview(
        { ...parsed.input, similarAreas: [recommended.area] },
        plan,
        supply
      );
      if (ticked.ok) return ticked;
    }
  }
  return first;
}
