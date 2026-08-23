"use client";

import { Input } from "@/components/ui/input";

/**
 * The bedroom min/max pair, with both pieces of guidance that go with it.
 *
 * Lifted verbatim out of LeadFilteringPanel. The public estimator hardcoded
 * `minBedrooms: null, maxBedrooms: null` and so was missing the dimension
 * entirely — a visitor who only wants 4-beds was quoted the whole market.
 *
 * `idPrefix` exists because the panel scopes its input ids by product and the
 * estimator needs its own: two mounted copies sharing an id break the htmlFor
 * labels silently, which is the kind of accessibility bug nothing catches.
 */
export function BedroomRange({
  idPrefix,
  min,
  max,
  onMinChange,
  onMaxChange,
}: {
  idPrefix: string;
  min: string;
  max: string;
  onMinChange: (v: string) => void;
  onMaxChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-sm font-medium">Bedroom range</label>
      <p className="text-xs text-muted-foreground">
        Leave both blank to accept any bedroom size. Setting the minimum
        and maximum to the same number requests an exact bedroom count.
      </p>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <label
            htmlFor={`${idPrefix}-min`}
            className="block text-xs text-muted-foreground"
          >
            Minimum bedrooms
          </label>
          <Input
            id={`${idPrefix}-min`}
            type="number"
            min={0}
            inputMode="numeric"
            value={min}
            onChange={(e) => onMinChange(e.target.value)}
            placeholder="Any"
          />
        </div>
        <div className="flex-1">
          <label
            htmlFor={`${idPrefix}-max`}
            className="block text-xs text-muted-foreground"
          >
            Maximum bedrooms
          </label>
          <Input
            id={`${idPrefix}-max`}
            type="number"
            min={0}
            inputMode="numeric"
            value={max}
            onChange={(e) => onMaxChange(e.target.value)}
            placeholder="Any"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Requesting bedroom sizes beyond 5 will reduce the accuracy of
            comparable data, as properties of this size are rarer to come
            across.
          </p>
        </div>
      </div>
    </div>
  );
}
