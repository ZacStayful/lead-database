/** Goal card arithmetic (§56.7). PURE. */
export interface GoalCard {
  goal: number;
  won: number;
  pct: number;
  due: string | null;
  /** Whole days from today to `due` (London date), negative when passed. */
  daysLeft: number | null;
  subtitle: string;
  caption: string;
}

function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getUTCFullYear() ? ` ${y}` : ""}`;
}

export function buildGoalCard(
  goal: number | null,
  due: string | null,
  won: number,
  today: string
): GoalCard | null {
  if (!goal || goal <= 0) return null;
  const pct = Math.min(100, Math.round((won / goal) * 100));
  let daysLeft: number | null = null;
  if (due) {
    const a = Date.UTC(...(today.split("-").map(Number) as [number, number, number]).map((n, i) => (i === 1 ? n - 1 : n)) as [number, number, number]);
    const b = Date.UTC(...(due.split("-").map(Number) as [number, number, number]).map((n, i) => (i === 1 ? n - 1 : n)) as [number, number, number]);
    daysLeft = Math.round((b - a) / 86_400_000);
  }
  const noun = goal === 1 ? "landlord" : "landlords";
  const subtitle = due ? `Sign ${goal} ${noun} by ${dateLabel(due)}` : `Sign ${goal} ${noun}`;
  let caption: string;
  if (won >= goal) caption = "Goal reached.";
  else if (daysLeft === null) caption = `${goal - won} to go`;
  else if (daysLeft > 0) caption = `${daysLeft} day${daysLeft === 1 ? "" : "s"} left · ${goal - won} to go`;
  else if (daysLeft === 0) caption = `Due today · ${goal - won} to go`;
  else caption = `${-daysLeft} day${daysLeft === -1 ? "" : "s"} past the date · ${goal - won} to go`;
  return { goal, won, pct, due, daysLeft, subtitle, caption };
}
