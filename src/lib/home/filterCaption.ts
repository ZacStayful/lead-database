import { formatGrossThreshold } from "@/lib/filterPrediction";

/**
 * The criteria clause of the dashboard home's filter sentence:
 * "areas and beds", or "areas, beds and a projected gross of at least £50k a
 * year" once §68's revenue floor is set.
 *
 * ⚠️ EXTRACTED SO THE NO-FLOOR CASE IS PINNED. Everything else about that
 * sentence is guarded by file text, but this is arithmetic on a list and the
 * regression it invites — "areas, and beds", or a dropped criterion — would be
 * read by every filtered customer on every dashboard load, which is precisely
 * the §66.2 shape: a change nothing in a React-free suite can see.
 *
 * ⚠️ The prose is LOCAL, not `leadFilter.ts`'s `revenuePhrase`. That one returns
 * the compact table form ("£50k+ revenue") for admin rows; this sentence speaks
 * to the customer, exactly as `bedroomPhrase` is already duplicated in the home
 * page for the same reason. What is shared is `formatGrossThreshold`, because
 * the threshold FORMATTING is the half that would drift.
 */
export function filterCriteriaPhrase(
  areas: string,
  beds: string,
  minGross: number | null
): string {
  const criteria = [areas, beds];
  if (minGross != null) {
    criteria.push(
      `a projected gross of at least ${formatGrossThreshold(minGross)} a year`
    );
  }
  const last = criteria[criteria.length - 1];
  return `${criteria.slice(0, -1).join(", ")} and ${last}`;
}
