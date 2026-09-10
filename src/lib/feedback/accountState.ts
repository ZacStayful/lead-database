import { holdsProduct } from "@/lib/products";
import { computeGrPacing, computePacing } from "@/lib/pacing";
import { planSnapshot } from "@/lib/supportTicketLog";
import type { Customer, LeadType } from "@/lib/types";

/**
 * What is actually true of this customer, right now, in words a model can use.
 *
 * ⚠️ THIS IS THE HALF THAT MAKES THE QUESTIONS WORTH ASKING. The customer's
 * paragraph says what they noticed; this says what is going on. "I'm not
 * getting any leads any more" reads as a bug from the text alone and as an
 * empty balance from the account — and those are completely different
 * conversations. Without this the model is a helpdesk script.
 *
 * ⚠️ VARIES PER REQUEST, so it goes in the USER turn, after the cache
 * breakpoint. Putting it in `system` alongside the product pack would cost a
 * cache miss on every single call.
 *
 * ⚠️ NO PERSONAL DATA. Business name is the most identifying thing here on
 * purpose: no contact name, no email, no phone, no landlord details. The
 * account shape is what informs a question; who they are does not, and
 * `contactValidation.ts`'s rule about never logging raw contact details applies
 * to a prompt as much as to a log line.
 */
export function accountState(customer: Customer | null): string {
  if (!customer) {
    return [
      "The person reporting this is NOT SIGNED IN, so nothing is known about",
      "their account. Do not ask account-specific questions; you cannot check",
      "any answer they give.",
    ].join("\n");
  }

  const lines: string[] = [];
  const held: LeadType[] = (["management", "guaranteed_rent"] as LeadType[]).filter((t) =>
    holdsProduct(customer, t)
  );

  lines.push(`Business: ${customer.business_name}`);
  lines.push(`Plan: ${planSnapshot(customer) ?? "no active product"}`);
  lines.push(
    held.length
      ? `Products held: ${held.join(" and ")}`
      : "Products held: NONE. They are not currently a paying subscriber."
  );

  if (holdsProduct(customer, "management")) {
    const p = computePacing(customer);
    lines.push(
      [
        "Management:",
        `  credits left (lead_balance): ${customer.lead_balance ?? 0}`,
        `  received this month: ${customer.leads_received_this_month ?? 0} of ${customer.monthly_allocation ?? 0}`,
        `  pacing: ${p.status}`,
      ].join("\n")
    );
  }

  if (holdsProduct(customer, "guaranteed_rent")) {
    const p = computeGrPacing(customer);
    lines.push(
      [
        "Guaranteed Rent:",
        `  credits left (gr_lead_balance): ${customer.gr_lead_balance ?? 0}`,
        `  received this month: ${customer.gr_leads_received_this_month ?? 0} of ${customer.gr_monthly_allocation ?? 0}`,
        `  pacing: ${p.status}`,
      ].join("\n")
    );
  }

  // The two shapes that most often masquerade as a bug. Spelling them out is
  // cheaper and more reliable than hoping the model infers them from numbers.
  const flags: string[] = [];
  if (holdsProduct(customer, "management") && (customer.lead_balance ?? 0) <= 0) {
    flags.push(
      "Their Management credits are at zero. If they are reporting that leads have stopped, that is WHY — it is a billing or plan matter, not a fault."
    );
  }
  if (holdsProduct(customer, "guaranteed_rent") && (customer.gr_lead_balance ?? 0) <= 0) {
    // Deliberately self-contained rather than "same as above": for a GR-only
    // customer the Management flag never fires, so a back-reference would point
    // at nothing and the model would be reading a dangling sentence.
    flags.push(
      "Their Guaranteed Rent credits are at zero. If they are reporting that leads have stopped, that is WHY — it is a billing or plan matter, not a fault."
    );
  }
  if (!held.includes("management")) {
    flags.push(
      "They do NOT hold Management, so they cannot see any Management-only screen. Never ask about one."
    );
  }
  if (!held.includes("guaranteed_rent")) {
    flags.push(
      "They do NOT hold Guaranteed Rent, so they cannot see the company let agreement or any GR-only screen. Never ask about one."
    );
  }
  if (flags.length) lines.push("", "What this means for your questions:", ...flags.map((f) => `  - ${f}`));

  return lines.join("\n");
}
