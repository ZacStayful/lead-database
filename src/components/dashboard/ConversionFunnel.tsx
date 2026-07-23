import { Card, CardContent } from "@/components/ui/card";

/**
 * The customer's ROI at a glance: of the leads delivered to them, how many
 * they worked and how many they signed. Built entirely from data already
 * captured on lead_assignments (status) — no new tracking required.
 *
 *   Received  → every delivered lead (refunded invalid-contact leads excluded
 *               upstream, so they never inflate the denominator)
 *   Contacted → status advanced past 'new' into contacted / in discussion / won
 *   Signed    → status = 'won' (landlord onboarded)
 *
 * The headline conversion rate is signed ÷ received — the single number the
 * operator watches climb.
 */
/** Human-friendly response time from a minutes value. */
function formatMinutes(mins: number): string {
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function ConversionFunnel({
  received,
  contacted,
  signed,
  medianResponseMinutes,
}: {
  received: number;
  contacted: number;
  signed: number;
  /** Median time from lead delivery to first contact; null until data exists. */
  medianResponseMinutes: number | null;
}) {
  // Nothing to show until at least one lead has been delivered.
  if (received <= 0) return null;

  const rate = Math.round((signed / received) * 100);
  const rows = [
    { label: "Received", value: received, tone: "bg-[#C9D9BE]" },
    { label: "Contacted", value: contacted, tone: "bg-[#8FAE82]" },
    { label: "Signed", value: signed, tone: "bg-[#5D8156]" },
  ];

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium">Your conversion</p>
          <div className="text-right">
            <span className="text-2xl font-semibold text-[#3B6D11]">
              {rate}%
            </span>
            <span className="ml-1.5 text-xs text-muted-foreground">
              of leads signed
            </span>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {rows.map((r) => {
            // Bars are scaled against the top of the funnel (received) so the
            // shape reads as a funnel narrowing toward signed.
            const pct = received > 0 ? (r.value / received) * 100 : 0;
            return (
              <div key={r.label} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {r.label}
                </span>
                <div className="h-6 flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className={"h-full rounded " + r.tone}
                    style={{ width: `${Math.max(pct, r.value > 0 ? 4 : 0)}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums">
                  {r.value}
                </span>
              </div>
            );
          })}
        </div>

        {medianResponseMinutes !== null && (
          <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">
              Your median response time
            </span>
            <span className="text-sm font-semibold tabular-nums">
              {formatMinutes(medianResponseMinutes)}
            </span>
          </div>
        )}

        {medianResponseMinutes !== null && (
          <p className="mt-2 text-xs text-muted-foreground">
            The faster you reach a landlord, the more you sign — you’re racing
            one other operator for every lead.
          </p>
        )}

        {signed === 0 && (
          <p className="mt-4 text-xs text-muted-foreground">
            Sign your first landlord to start your conversion rate. Mark a lead
            as signed from its detail page once they’re onboarded.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
