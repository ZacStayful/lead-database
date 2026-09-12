import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import type { TodayLine } from "@/lib/todaySummary";

/**
 * "Today" — what to do this morning, in the order the morning goes (§54).
 *
 * The one block that says the word today. Every line names a thing rather
 * than a rate and links to where that thing is. It sits above "Picked up and
 * left" because new work outranks loose ends, and above the feed because the
 * feed is where you go once you know what you are looking for.
 *
 * Renders nothing when there are no lines at all — which, with the daily
 * release on, is rare: the next-lead line is there on a quiet day precisely
 * so there is a reason to come back tomorrow.
 */
export function TodayPanel({ lines }: { lines: TodayLine[] }) {
  if (lines.length === 0) return null;

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-1 text-lg font-semibold">Today</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          The morning in one place. Start at the top.
        </p>
        <ul className="space-y-3">
          {lines.map((l) => (
            <li key={`${l.key}:${l.text}`}>
              {l.href ? (
                <Link href={l.href} className="font-medium underline underline-offset-4">
                  {l.text}
                </Link>
              ) : (
                <span className="font-medium">{l.text}</span>
              )}
              {l.detail && (
                <span className="block text-xs text-muted-foreground">{l.detail}</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
