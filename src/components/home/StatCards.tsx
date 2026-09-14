import Link from "next/link";
import { Clock, CreditCard } from "lucide-react";
import { Pill } from "./HomeCard";

export interface StatCard {
  key: string;
  label: string;
  value: string;
  unit?: string;
  caption?: string;
  /** Progress bar, 0–100, shown instead of the caption. */
  progressPct?: number;
  trailing?: "credit" | "clock" | "attention" | { pill: string; tone: "green" | "amber" | "grey" };
  href?: string;
  valueTone?: "amber";
}

function Trailing({ t }: { t: StatCard["trailing"] }) {
  if (!t) return null;
  if (t === "credit") return <CreditCard className="h-4 w-4" />;
  if (t === "clock") return <Clock className="h-4 w-4" />;
  if (t === "attention") return <span className="h-2 w-2 rounded-full bg-attention" aria-hidden />;
  return <Pill tone={t.tone}>{t.pill}</Pill>;
}

export function StatCards({ cards }: { cards: StatCard[] }) {
  return (
    <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
      {cards.map((c) => {
        const body = (
          <>
            <div className="flex items-center justify-between text-ink-2">
              <span>{c.label}</span>
              <Trailing t={c.trailing} />
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span
                className={
                  "font-display text-[32px] font-semibold leading-[1.1] " +
                  (c.valueTone === "amber" ? "text-amber-600" : "text-ink")
                }
              >
                {c.value}
              </span>
              {c.unit && <span className="font-body text-sm font-medium text-ink-2">{c.unit}</span>}
            </div>
            {c.progressPct !== undefined ? (
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-rail">
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, Math.max(0, c.progressPct))}%` }} />
              </div>
            ) : (
              c.caption && <p className="mt-1.5 text-xs text-ink-2">{c.caption}</p>
            )}
          </>
        );
        const cls = "block rounded-xl border border-line bg-white px-5 py-[18px] text-left";
        return c.href ? (
          <Link key={c.key} href={c.href} className={cls + " hover:border-control"}>
            {body}
          </Link>
        ) : (
          <div key={c.key} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
