import { cn } from "@/lib/utils";

/** A redesign card: white, 1px `line` border, 12px radius, no shadow (§56.7). */
export function HomeCard({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("rounded-xl border border-line bg-white p-5", className)}>
      {children}
    </section>
  );
}

export function CardTitleRow({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
      {right}
    </div>
  );
}

export function Pill({
  children,
  tone = "green",
  className,
}: {
  children: React.ReactNode;
  tone?: "green" | "amber" | "red" | "blue" | "purple" | "grey";
  className?: string;
}) {
  const tones: Record<string, string> = {
    green: "bg-brand-light text-brand-dark",
    amber: "bg-[#fef3c7] text-[#92400e]",
    red: "bg-[#fee2e2] text-[#991b1b]",
    blue: "bg-[#dbeafe] text-[#1d4ed8]",
    purple: "bg-[#ede9fe] text-[#5b21b6]",
    grey: "bg-page text-ink-3",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-[3px] text-xs font-semibold",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
