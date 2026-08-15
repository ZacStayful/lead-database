import { Card, CardContent } from "@/components/ui/card";
import { cityForArea } from "@/lib/postcode";
import { normalizeBedrooms } from "@/lib/publicStats";

/**
 * What the operators who have signed a landlord do differently — and where the
 * reader sits against them.
 *
 * This is social proof, not a scorecard and emphatically not a leaderboard.
 * Nobody is ranked, nobody is named, and no operator can be identified: every
 * figure is an average over a group, and the group is hidden entirely until at
 * least three operators are in it (0078).
 *
 * The copy describes habits rather than people, and describes them as things
 * three operators DID — never as a formula that produces a signing. Three wins
 * is not a study, and promising a causal link on that evidence would be the one
 * thing guaranteed to destroy the trust this block exists to build.
 *
 * Speed of opening is deliberately absent. It looks like it should be the
 * headline, but both groups open a new lead within about six hours — the gap is
 * entirely in what happens next. Showing a "get there faster" message would be
 * inventing a difference the data does not contain.
 */

export type ProofRow = {
  group_key: "winners" | "others" | "you";
  operators: number;
  open_rate: number | null;
  contact_rate: number | null;
  meeting_rate: number | null;
  avg_notes: number | null;
  operators_no_notes: number;
  median_hours_to_open: number | null;
  suppressed: boolean;
};

export type AnonymisedWin = {
  won_month: string;
  days_to_win: number;
  bedrooms: string | null;
  postcode_area: string | null;
};

function pct(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(Number(value) * 100)}%`;
}

function num(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return String(Math.round(Number(value) * 10) / 10);
}

/**
 * "3-bed in Leicester" / "3-bed" / "A property" — whatever the row supports.
 * postcode_area arrives null until there are enough wins to show a location
 * without exposing whose it was (0078), so the bare bed label is the normal
 * case today, not a fallback for bad data.
 */
function winDescription(win: AnonymisedWin): string {
  // leads.bedrooms is free text off Monday and genuinely holds things like
  // "5-77 bedrooms". normalizeBedrooms already solves this for the public
  // ledger — take the first integer, bucket 5+ — so reuse it rather than
  // rendering the raw string at an operator.
  const bedLabel = normalizeBedrooms(win.bedrooms) ?? "A property";
  const place = win.postcode_area ? cityForArea(win.postcode_area) : "";
  return place ? `${bedLabel} in ${place}` : bedLabel;
}

export function OperatorProof({
  rows,
  wins,
}: {
  rows: ProofRow[];
  wins: AnonymisedWin[];
}) {
  const winners = rows.find((r) => r.group_key === "winners");
  const others = rows.find((r) => r.group_key === "others");
  const you = rows.find((r) => r.group_key === "you");

  // Too few winners to describe as a group — showing it anyway would be
  // reporting on named individuals with the names taken off.
  if (!winners || winners.suppressed) return null;

  const fastest = wins.length
    ? wins.reduce((min, w) => Math.min(min, w.days_to_win), Infinity)
    : null;

  const measures: {
    label: string;
    help: string;
    format: (r: ProofRow | undefined) => string;
  }[] = [
    {
      label: "Open the leads they're sent",
      help: "Everyone does this. It's the next row that separates them.",
      format: (r) => pct(r?.open_rate ?? null),
    },
    {
      label: "Actually go after them",
      help: "Called, emailed, or logged what happened.",
      format: (r) => pct(r?.contact_rate ?? null),
    },
    {
      // The row the other two are for. It is also where the funnel actually
      // breaks — more than half of leads get chased and well under a tenth
      // reach a diary — so it is the one worth leading somebody towards.
      label: "Get a web meeting booked",
      help: "Booked counts even if the landlord didn't turn up — that part isn't yours.",
      format: (r) => pct(r?.meeting_rate ?? null),
    },
    {
      label: "Notes written",
      help: "Keeping a record of each conversation.",
      format: (r) => num(r?.avg_notes ?? null),
    },
  ];

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-1 text-lg font-semibold">
          What's working for other operators
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {winners.operators} operator
          {winners.operators === 1 ? " has" : "s have"} signed a landlord from a
          marketplace lead
          {fastest !== null && Number.isFinite(fastest)
            ? fastest <= 1
              ? " — the quickest inside a day of receiving it."
              : ` — the quickest ${fastest} days after receiving it.`
            : "."}{" "}
          Here's how they worked their leads. Nobody is named, and nobody can see
          your figures.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] border-collapse text-sm">
            <thead>
              <tr className="border-b-[0.5px] border-border text-left">
                <th className="pb-2 font-medium">Habit</th>
                <th className="pb-2 text-right font-medium">
                  Operators who've signed
                </th>
                <th className="pb-2 text-right font-medium">Everyone else</th>
                {you && <th className="pb-2 text-right font-medium">You</th>}
              </tr>
            </thead>
            <tbody>
              {measures.map((m) => (
                <tr
                  key={m.label}
                  className="border-b-[0.5px] border-border last:border-0"
                >
                  <td className="py-2.5">
                    <span className="font-medium">{m.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {m.help}
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-semibold">
                    {m.format(winners)}
                  </td>
                  <td className="py-2.5 text-right text-muted-foreground">
                    {m.format(others)}
                  </td>
                  {you && (
                    <td className="py-2.5 text-right font-semibold">
                      {m.format(you)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* State the size of the evidence plainly rather than letting three
            operators read as a law of nature. */}
        <p className="mt-3 text-xs text-muted-foreground">
          Based on {winners.operators} operator
          {winners.operators === 1 ? "" : "s"} who have signed a landlord so far,
          against {others?.operators ?? 0} who haven't yet. That's a small group
          — it's what they did, not a guarantee of what will happen.
        </p>

        {wins.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">Recently signed</h3>
            <ul className="space-y-1.5">
              {wins.map((w, i) => (
                <li
                  key={`${w.won_month}-${i}`}
                  className="flex items-baseline justify-between gap-4 text-sm"
                >
                  <span>{winDescription(w)}</span>
                  <span className="text-xs text-muted-foreground">
                    {w.days_to_win <= 1
                      ? "signed within a day"
                      : `signed ${w.days_to_win} days after the lead arrived`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
