import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cityForArea } from "@/lib/postcode";
import type { AreaContention } from "@/lib/filterPrediction";

/**
 * Which postcode areas are crowded with filtered customers.
 *
 * The existing capacity panels answer "how many more customers can we take on"
 * product-wide, correctly and more carefully than anything worth replacing
 * (§18.1: supply that REFILLS sets the ceiling, supply that clears once is
 * reported beside it and never added). What they cannot answer is WHERE, and
 * that question only started mattering when filters began carrying guarantees:
 * a lead reaches at most four filtered customers, so an area at the ceiling
 * cannot absorb another one at full volume however healthy the national figure
 * looks.
 *
 * Reporting only. Nothing here gates a sale — §16 settled that deliberately:
 * "Running short on leads is a supply problem to solve by sourcing more, not by
 * refusing revenue."
 */
export function FilteredAreaDensity({
  contention,
  title,
}: {
  contention: AreaContention;
  title: string;
}) {
  const everywhere = contention.everywhere ?? 0;
  const rows = Object.entries(contention.filteredCustomers)
    .map(([area, count]) => ({ area, count }))
    .filter((r) => r.count >= contention.maxPerLead - 1)
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area))
    .slice(0, 12);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.length === 0 ? (
          <p className="text-muted-foreground">
            No area is close to the {contention.maxPerLead}-customer ceiling.
            Every filtered customer can currently receive every matching lead.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              A lead reaches at most {contention.maxPerLead} filtered customers.
              At or past that, each one is quoted a share of the area rather
              than all of it.
            </p>
            <ul className="space-y-1">
              {rows.map((r) => {
                const full = r.count >= contention.maxPerLead;
                return (
                  <li
                    key={r.area}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span>
                      <span className="font-medium">{r.area}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {cityForArea(r.area) || ""}
                      </span>
                    </span>
                    <span
                      className={
                        "tabular-nums text-xs " +
                        (full ? "font-medium text-amber-700" : "text-muted-foreground")
                      }
                    >
                      {r.count} / {contention.maxPerLead}
                      {full ? " — full" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {everywhere > 0 && (
          // A bedroom-only filter names no areas but competes in all of them,
          // so it is a floor under every row above — easy to miss, and it is
          // what makes an apparently quiet area contended.
          <p className="text-xs text-muted-foreground">
            Includes {everywhere} bedroom-only filter
            {everywhere === 1 ? "" : "s"} competing in every area.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
