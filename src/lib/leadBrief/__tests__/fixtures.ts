import { areaOfOutcode } from "@/lib/leadBrief/geo";
import type { BriefSupply, OtherBrief, SupplyLead } from "@/lib/leadBrief/types";

/** A lead in a real outcode, with typical figures unless overridden. */
export function lead(outcode: string | null, over: Partial<SupplyLead> = {}): SupplyLead {
  return {
    outcode,
    area: outcode ? areaOfOutcode(outcode) : null,
    bedrooms: 3,
    gross: 40000,
    nightly: 150,
    occupancy: 60,
    ...over,
  };
}

/** `n` copies of a lead. */
export function leads(n: number, outcode: string, over: Partial<SupplyLead> = {}): SupplyLead[] {
  return Array.from({ length: n }, () => lead(outcode, over));
}

export function supply(over: Partial<BriefSupply> = {}): BriefSupply {
  return {
    weeks: 13,
    leads: [],
    contention: null,
    filteredAreas: [],
    otherBriefs: [],
    competition: {},
    ...over,
  };
}

export function otherBrief(over: Partial<OtherBrief> = {}): OtherBrief {
  return {
    customerId: "other",
    baseOutcode: "LS1",
    capMiles: 75,
    serviceOutcodes: [],
    firstPickOutcodes: [],
    lockedUntil: null,
    ...over,
  };
}
