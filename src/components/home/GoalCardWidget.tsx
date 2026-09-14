import Link from "next/link";
import type { GoalCard } from "@/lib/home/goalCard";
import { CardTitleRow, HomeCard } from "./HomeCard";

export function GoalCardWidget({ goal }: { goal: GoalCard }) {
  return (
    <HomeCard>
      <CardTitleRow
        title="Goal"
        right={
          <Link href="/dashboard/goals" className="text-sm font-semibold text-brand hover:text-brand-dark">
            Edit
          </Link>
        }
      />
      <p className="mt-0.5 text-[13px] text-ink-2">{goal.subtitle}</p>
      <div className="mt-3.5 flex items-baseline gap-1.5">
        <span className="font-display text-4xl font-semibold leading-none">{goal.won}</span>
        <span className="text-ink-2">of {goal.goal} signed</span>
      </div>
      <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-rail">
        <div className="h-full rounded-full bg-brand" style={{ width: `${goal.pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-ink-2">{goal.caption}</p>
    </HomeCard>
  );
}
