import { cityForArea } from "@/lib/postcode";
import type {
  ExpansionSuggestion,
  ProductVolume,
  VolumePrediction,
} from "@/lib/filterPrediction";
import { VolumeBar } from "@/components/filtering/VolumeBar";

/**
 * The live prediction for the draft selection. Three variants: reliable and at
 * or above the plan (neutral), reliable but below it (amber warning +
 * expansion chips), and too little data to extrapolate (no number shown —
 * a precise rate built on a handful of leads would be false confidence).
 */
export function PredictionBox({
  prediction,
  allocation,
  volume,
  productLabel,
  isBelow,
  nothingSelected,
  suggestions,
  onAddArea,
}: {
  prediction: VolumePrediction;
  allocation: number;
  volume: ProductVolume;
  productLabel: string;
  isBelow: boolean;
  nothingSelected: boolean;
  suggestions: ExpansionSuggestion[];
  onAddArea: (area: string) => void;
}) {
  const basis = (
    <p className="text-xs text-muted-foreground">
      Based on {prediction.matchingLeads} matching lead
      {prediction.matchingLeads === 1 ? "" : "s"} since 1 July. Filtered
      matching can only consider leads with a readable postcode and bedroom
      count — {volume.matchableLeads} of {volume.totalLeads}{" "}
      {productLabel.toLowerCase()} leads so far.
    </p>
  );

  const chips = suggestions.length > 0 && (
    <div>
      <p className="text-xs font-medium">
        Nearby areas that would get you closer:
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s.area}
            type="button"
            onClick={() => onAddArea(s.area)}
            className="rounded-full border-[0.5px] border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
          >
            + Add {s.area}
            {s.city !== s.area ? ` (${s.city})` : ""} · +~{s.monthlyRate}/mo
            {s.distanceKm != null &&
              ` · ${Math.max(1, Math.round(s.distanceKm * 0.621))} mi from ${
                s.nearestSelectedArea
                  ? cityForArea(s.nearestSelectedArea) || s.nearestSelectedArea
                  : "your areas"
              }`}
          </button>
        ))}
      </div>
    </div>
  );

  if (!prediction.reliable) {
    return (
      <div className="space-y-3 rounded-md border-[0.5px] border-border bg-muted/40 px-4 py-3">
        <p className="text-sm">
          Only {prediction.matchingLeads} lead
          {prediction.matchingLeads === 1 ? "" : "s"} matching this selection
          {prediction.matchingLeads === 1 ? " has" : " have"} arrived since 1
          July — too little data to predict monthly volume reliably.
        </p>
        {chips}
        {basis}
      </div>
    );
  }

  if (isBelow) {
    return (
      <div className="space-y-3 rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-amber-800">
        <p className="text-sm">
          This selection is predicted to produce{" "}
          <span className="font-semibold">
            ~{prediction.displayRate} lead
            {prediction.displayRate === 1 ? "" : "s"}/month — below your plan
            of {allocation}
          </span>
          . This selection is too small to support your full allocation, so the
          number we can guarantee drops with it. Adding areas raises the
          guarantee and lowers the cost per lead.
        </p>
        <VolumeBar
          rate={prediction.displayRate}
          allocation={allocation}
          amber
        />
        {chips}
        {basis}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border-[0.5px] border-border bg-muted/40 px-4 py-3">
      <p className="text-sm">
        <span className="font-semibold">
          ~{prediction.displayRate} lead
          {prediction.displayRate === 1 ? "" : "s"}/month
        </span>{" "}
        {nothingSelected
          ? "arrive across all areas and sizes — narrow your selection to see its prediction."
          : "match this selection."}{" "}
        {allocation > 0 && (
          <span className="text-muted-foreground">
            Your plan includes {allocation} leads/month.
          </span>
        )}
      </p>
      <VolumeBar
        rate={prediction.displayRate}
        allocation={allocation}
        amber={false}
      />
      {basis}
    </div>
  );
}
