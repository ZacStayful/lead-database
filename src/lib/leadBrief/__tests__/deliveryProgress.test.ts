import { describe, expect, it } from "vitest";
import { deliveryProgress } from "@/lib/leadBrief/routing";
import type { Customer } from "@/lib/types";

/**
 * The "You're on x of N, with d days left" figures stored on a routed Nearby
 * lead (Phase 5). x includes the lead just delivered, N is the dashboard's
 * effective allocation, and d counts to the renewal date every other message
 * prints (nextGrantDate).
 */
const customer = (over: Partial<Customer> = {}) =>
  ({
    created_at: "2026-01-02T10:00:00Z",
    billing_cycle_anchor: "2026-01-20",
    gr_billing_cycle_anchor: null,
    monthly_allocation: 20,
    pool_debit: 0,
    leads_received_this_month: 7,
    ...over,
  }) as unknown as Customer;

describe("deliveryProgress", () => {
  const now = new Date("2026-10-08T14:00:00Z");

  it("reads the customer's own cycle", () => {
    expect(deliveryProgress(customer(), now)).toEqual({ received: 7, allocation: 20, days_left: 12 });
  });

  it("uses the allocation net of any pool debit, as the dashboard card does", () => {
    expect(deliveryProgress(customer({ pool_debit: 2 } as Partial<Customer>), now)?.allocation).toBe(18);
    expect(deliveryProgress(customer({ monthly_allocation: 10 } as Partial<Customer>), now)?.allocation).toBe(10);
  });

  it("counts a renewal tomorrow as one day", () => {
    expect(deliveryProgress(customer({ billing_cycle_anchor: "2026-01-09" } as Partial<Customer>), now)?.days_left).toBe(1);
  });

  it("is null when there is no usable count or date", () => {
    expect(
      deliveryProgress(customer({ leads_received_this_month: null } as unknown as Partial<Customer>), now)
    ).toBeNull();
    expect(
      deliveryProgress(
        customer({ billing_cycle_anchor: null, created_at: null } as unknown as Partial<Customer>),
        now
      )
    ).toBeNull();
  });
});
