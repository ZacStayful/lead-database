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
  // Null on the 'you' row, which is always live, and on the cohort rows before
  // the first weekly capture has run (0082 falls back to live state).
  as_of: string | null;
  // Null until a second week has been captured — the honest state for the first
  // week after launch, and the one the UI has to handle rather than assume away.
  prev_as_of: string | null;
  prev_open_rate: number | null;
  prev_contact_rate: number | null;
  prev_meeting_rate: number | null;
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

  // The cohort figures are captured weekly (0081); the "you" row stays live, so
  // take the date off a cohort row. Null before the first capture, in which
  // case the page simply omits the date rather than inventing one.
  const asOfLabel = winners.as_of
    ? new Date(winners.as_of).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
      })
    : null;

  // Week-on-week movement in the meeting rate among operators who have NOT
  // signed anyone. That is the group the reader is most likely in, and the one
  // whose improvement means the page is working.
  const movement = (() => {
    if (!others?.prev_as_of) return null;
    const now = others.meeting_rate;
    const before = others.prev_meeting_rate;
    if (now === null || before === null) return null;
    const deltaPts = Math.round((Number(now) - Number(before)) * 1000) / 10;
    if (Math.abs(deltaPts) < 0.1) {
      return "Meeting rate across everyone else held steady this week.";
    }
    return deltaPts > 0
      ? `Meeting rate across everyone else is up ${deltaPts} points on last week.`
      : `Meeting rate across everyone else is down ${Math.abs(deltaPts)} points on last week.`;
  })();

  const measures: {
    label: string;
    help: string;
    format: (r: ProofRow | undefined) => string;
  }[] = [
    {
      label: "They open every lead they're sent",
      help: "Of the management leads delivered to them, the share they looked at. Almost everyone does this — it's the rows below that separate them.",
      format: (r) => pct(r?.open_rate ?? null),
    },
    {
      label: "They ring every one of them",
      help: "The share they actually went after — called, emailed, or recorded what happened. This is the biggest gap in the table.",
      format: (r) => pct(r?.contact_rate ?? null),
    },
    {
      // The row the other two are for, and where the funnel actually breaks —
      // over half of leads get chased and well under a tenth reach a diary.
      label: "They get the web meeting booked",
      help: "The share that reached a booked web meeting. A no-show still counts: getting it in the diary is the part you control.",
      format: (r) => pct(r?.meeting_rate ?? null),
    },
    {
      label: "They write it down",
      help: "Notes logged against their leads, so nothing is dropped between calls.",
      format: (r) => num(r?.avg_notes ?? null),
    },
  ];

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-1 text-lg font-semibold">
          What the operators winning management clients do differently
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Everyone in this table is a subscriber here, buying the same
          management leads you are.{" "}
          <span className="font-medium text-foreground">
            {winners.operators} of them
            {winners.operators === 1 ? " has" : " have"} signed a landlord onto
            a management contract
          </span>
          {fastest !== null && Number.isFinite(fastest)
            ? fastest <= 1
              ? " — the quickest inside a day of the lead arriving."
              : ` — the quickest ${fastest} days after the lead arrived.`
            : "."}{" "}
          These are the four things they do that the {others?.operators ?? 0}{" "}
          who haven&rsquo;t signed anyone yet mostly don&rsquo;t.
        </p>
        <p className="mb-4 text-sm text-muted-foreground">
          Every one of them is copyable this afternoon. Nobody is named, nobody
          is ranked, and nobody else can see your figures.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr className="border-b-[0.5px] border-border text-left">
                <th className="pb-2 font-medium">What they do</th>
                <th className="pb-2 text-right font-medium">
                  Signed a management client
                </th>
                <th className="pb-2 text-right font-medium">
                  Not signed one yet
                </th>
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

        {/* Movement, once there are two readings to compare. Shown for the
            group that has not signed anyone: the whole point of the page is
            that the gap is closable, so the number worth watching is theirs.
            Silent until a second week exists — a trend line drawn through one
            point is a decoration. */}
        {movement && (
          <p className="mt-3 text-sm">
            <span className="font-medium">{movement}</span>
          </p>
        )}

        {/* State the size of the evidence plainly rather than letting three
            operators read as a law of nature. */}
        <p className="mt-3 text-xs text-muted-foreground">
          {asOfLabel ? `Updated ${asOfLabel}. ` : ""}
          Measured across management leads delivered to every subscriber on the
          platform. Based on {winners.operators} operator
          {winners.operators === 1 ? "" : "s"} who have signed a management
          client so far against {others?.operators ?? 0} who haven&rsquo;t — a
          small group, so read it as what they did rather than a guarantee of
          what will happen.
        </p>

        {wins.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-1 text-sm font-medium">
              Management clients signed from these leads
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Each one is a landlord another subscriber signed onto a management
              contract, from a lead the marketplace sent them.
            </p>
            <ul className="space-y-1.5">
              {wins.map((w, i) => (
                <li
                  key={`${w.won_month}-${i}`}
                  className="flex items-baseline justify-between gap-4 text-sm"
                >
                  <span>{winDescription(w)}</span>
                  <span className="text-xs text-muted-foreground">
                    {w.days_to_win <= 1
                      ? "signed within a day of the lead arriving"
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
