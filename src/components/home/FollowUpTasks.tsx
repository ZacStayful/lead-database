import Link from "next/link";
import { Mail, MessageCircle, Phone } from "lucide-react";
import type { DueAttempt } from "@/lib/contact/followUpSummary";
import { attemptByNumber, channelLabel, TOTAL_ATTEMPTS } from "@/lib/contact/contactStrategy";
import { CardTitleRow, HomeCard, Pill } from "./HomeCard";

export interface FollowUpTask extends DueAttempt {
  /** The landlord's latest reply on this lead, when a connected channel has one. */
  lastReply: string | null;
}

/**
 * Today's contact-plan attempts (§42), the same scan the 08:15 digest runs.
 * The lead page is where an attempt is completed, so each row links there.
 */
export function FollowUpTasks({ tasks }: { tasks: FollowUpTask[] }) {
  return (
    <HomeCard id="follow-up-tasks">
      <CardTitleRow title="Follow-up tasks" right={<span className="text-xs text-ink-2">Due today</span>} />
      {tasks.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2">Nothing due today.</p>
      ) : (
        <ul className="mt-1">
          {tasks.slice(0, 6).map((t) => {
            const Icon = t.channel === "call" ? Phone : t.channel === "whatsapp" ? MessageCircle : Mail;
            const verb = t.channel === "call" ? "Call" : t.channel === "whatsapp" ? "WhatsApp" : "Email";
            const objective = attemptByNumber(t.stepNumber)?.objective;
            const detail = t.lastReply
              ? `Attempt ${t.stepNumber} of ${TOTAL_ATTEMPTS} · replied “${t.lastReply}”`
              : `Attempt ${t.stepNumber} of ${TOTAL_ATTEMPTS}${objective ? ` · ${objective}` : ""}`;
            return (
              <li key={`${t.assignmentId}:${t.stepNumber}`} className="border-b border-rail last:border-b-0">
                <Link href={`/dashboard/leads/${t.leadId}`} className="flex items-center gap-3 py-3">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-page text-brand-dark">
                    <Icon className="h-[15px] w-[15px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {verb} {t.leadName ?? "the landlord"}
                    </span>
                    <span className="block truncate text-xs text-ink-2">{detail}</span>
                  </span>
                  {t.overdueDays > 0 ? (
                    <Pill tone="red">{t.overdueDays === 1 ? "1 day overdue" : `${t.overdueDays} days overdue`}</Pill>
                  ) : (
                    <Pill tone="amber">Due today</Pill>
                  )}
                  <span className="sr-only">{channelLabel(t.channel)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </HomeCard>
  );
}
