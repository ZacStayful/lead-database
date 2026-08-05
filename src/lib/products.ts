import { GR_PLANS, PLANS, type PlanKey } from "@/lib/plans";
import type { Customer, LeadType } from "@/lib/types";

/**
 * The two lead products as the CUSTOMER sees them.
 *
 * This is presentation and cross-sell copy — what a lead of each type actually
 * is, so somebody who holds one product understands what they would be buying
 * with the other. The operational meaning of a product lives in the `gr_`
 * column split and in `plans.ts`; nothing here gates behaviour.
 *
 * Kept beside the plan definitions rather than inline in the page so the price
 * shown on the cross-sell card and the price actually charged at checkout come
 * from the same source. A description that drifts from the invoice is how a
 * customer ends up feeling mis-sold.
 */

export interface ProductPlanOption {
  key: PlanKey;
  /** Leads per month. */
  leads: number;
  /** Headline monthly price in GBP (ex VAT). */
  priceGbp: number;
  label: string;
}

export interface ProductCopy {
  leadType: LeadType;
  /** Product name as the customer knows it. */
  name: string;
  /** One line under the name. */
  tagline: string;
  /** What a lead of this type IS — the thing a cross-sell must explain. */
  whatALeadIs: string;
  /** How the lead is qualified before it reaches them. */
  qualification: string;
  /** What the operator does with it — the commercial model. */
  outcome: string;
  /** Bullet points for the card. */
  highlights: string[];
  /** Plans the customer may buy. */
  plans: ProductPlanOption[];
}

export const PRODUCT_COPY: Record<LeadType, ProductCopy> = {
  management: {
    leadType: "management",
    name: "Management leads",
    tagline: "Landlords looking for a short-term-let management company.",
    whatALeadIs:
      "A landlord who searched Google for short-term-let property management and completed an enquiry form — name, phone, email, property address and bedrooms. They have decided to explore letting someone else run their property; they just have not chosen an operator yet.",
    qualification:
      "Before a lead is released, the property is run through a financial model comparing projected short-term-let income against the landlord's current arrangement, using live Airbnb data for their postcode. The landlord is also emailed to say a trusted local operator will be in touch, so your call is expected rather than cold.",
    outcome:
      "You win a management agreement and earn an ongoing management fee on the property for as long as you run it. One signed landlord typically pays for many months of leads.",
    highlights: [
      "Organic Google intent — not a bought list or a cold database",
      "Financially modelled against live Airbnb data before you get it",
      "Landlord pre-warned that an operator will call",
      "Shared with at most two other operators",
    ],
    plans: [
      {
        key: "lead_10",
        leads: PLANS.lead_10.leads,
        priceGbp: PLANS.lead_10.priceGbp,
        label: `${PLANS.lead_10.leads} leads a month`,
      },
      {
        key: "lead_20",
        leads: PLANS.lead_20.leads,
        priceGbp: PLANS.lead_20.priceGbp,
        label: `${PLANS.lead_20.leads} leads a month`,
      },
    ],
  },
  guaranteed_rent: {
    leadType: "guaranteed_rent",
    name: "Guaranteed Rent leads",
    tagline: "Landlords open to a guaranteed rent (rent-to-rent) arrangement.",
    whatALeadIs:
      "A landlord who has enquired specifically about guaranteed rent — handing you the property on a fixed monthly rent rather than a management fee. They already accept the idea of a company taking the property on; you are not explaining rent-to-rent from scratch.",
    qualification:
      "Each lead is modelled against live Airbnb data for the postcode, showing projected gross short-term-let income, a guaranteed rent figure, and the margin between them. The analysis, tenancy agreement and sourcing agreement are attached to the lead in your portal.",
    outcome:
      "You take the property on a guaranteed rent basis and keep the difference between the rent you pay the landlord and what the property earns on Airbnb or Booking.com. It is a recurring monthly margin per property rather than a percentage fee.",
    highlights: [
      "Landlord already open to guaranteed rent — no cold education needed",
      "Projected income, guaranteed rent and margin modelled per property",
      "Tenancy and sourcing agreements included in the portal",
      "Shared with at most two other operators",
    ],
    plans: [
      {
        key: "lead_10",
        leads: GR_PLANS.lead_10.leads,
        priceGbp: GR_PLANS.lead_10.priceGbp,
        label: `${GR_PLANS.lead_10.leads} leads a month`,
      },
      {
        key: "lead_20",
        leads: GR_PLANS.lead_20.leads,
        priceGbp: GR_PLANS.lead_20.priceGbp,
        label: `${GR_PLANS.lead_20.leads} leads a month`,
      },
    ],
  },
};

/** The other product — the one to cross-sell to somebody holding this one. */
export function otherProduct(leadType: LeadType): LeadType {
  return leadType === "management" ? "guaranteed_rent" : "management";
}

/** Customer fields the product-holding helpers read. */
export type ProductCustomerFields = Pick<
  Customer,
  "account_status" | "subscription_status" | "gr_subscription_status"
>;

/**
 * Whether the customer currently HOLDS this product.
 *
 * Strictly per-product, for the reason set out in CLAUDE.md invariant 6:
 * `account_status` and `subscription_status` are management-only columns that
 * the Stripe webhook deliberately leaves untouched on a GR cancellation, so
 * reading them for GR would report a departed GR subscriber as still holding
 * it — and would offer a management-only customer nothing to buy.
 *
 * 'past_due' counts as held. The customer genuinely has the product and is in a
 * billing problem, not a buying decision; offering them a second checkout for
 * something they already own would be wrong.
 */
export function holdsProduct(
  customer: ProductCustomerFields,
  leadType: LeadType
): boolean {
  if (leadType === "guaranteed_rent") {
    return (
      customer.gr_subscription_status === "active" ||
      customer.gr_subscription_status === "past_due"
    );
  }
  return (
    customer.account_status === "active" ||
    customer.subscription_status === "active" ||
    customer.subscription_status === "past_due"
  );
}

/** Narrow an untrusted string to a lead type, or null. */
export function toLeadType(value: unknown): LeadType | null {
  if (value === "management" || value === "guaranteed_rent") return value;
  // The signup page and marketing links use the hyphenated spelling.
  if (value === "guaranteed-rent") return "guaranteed_rent";
  return null;
}
