/**
 * What the landlord was told, and what they said back (§41).
 *
 * This is what makes the referral pay off for the operator. Without it Stayful
 * writes to the landlord, the landlord answers three questions, and the person
 * about to ring them can see none of it — so they open cold anyway and the
 * whole feature buys nothing.
 *
 * ⚠️ KEYS ON `landlord_referral_sent_at`, NEVER `claimed_at`. The claim is
 * stamped before the send, so keying on it would tell an operator the landlord
 * had been introduced to them off the back of an email that 429'd.
 *
 * ⚠️ THE ANSWERS COME FROM THE LEAD, NOT THE ASSIGNMENT. Every operator holding
 * this lead sees the same ones, including any assigned later — that is the
 * fairness property, and it is why they are phrased as what the landlord ASKED
 * FOR rather than as an instruction. Three operators can hold one lead and all
 * read this; "call Tuesday morning" read as a directive by all three is the
 * pile-on §40.12 exists to prevent.
 */
import { describeAnswers } from "@/lib/landlordQuestions";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function LandlordHandoff({
  sentAt,
  lead,
}: {
  sentAt: string | null;
  lead: {
    landlord_contact_method?: string | null;
    landlord_contact_time?: string | null;
    landlord_wants?: string[] | null;
    landlord_note?: string | null;
    landlord_prefs_submitted_at?: string | null;
  };
}) {
  // No referral, nothing to say. A lead delivered before this shipped looks
  // exactly as it did — the same rule IncomeProjection follows.
  if (!sentAt) return null;

  const answers = describeAnswers(lead);
  const note = lead.landlord_note?.trim();

  return (
    <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/60 p-3 text-sm">
      <p className="mb-1 font-medium text-emerald-900">
        We introduced you to this landlord
      </p>
      <p className="text-emerald-900/80">
        Stayful emailed them about you on {shortDate(sentAt)}. They are expecting
        to hear from you.
      </p>

      {answers.length > 0 || note ? (
        <div className="mt-3 border-t border-emerald-200 pt-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-emerald-900/70">
            What they told us
          </p>
          <ul className="space-y-1 text-emerald-900">
            {answers.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          {note && (
            <p className="mt-2 italic text-emerald-900/90">&ldquo;{note}&rdquo;</p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-emerald-900/70">
          They haven&apos;t answered our questions about how to reach them yet.
        </p>
      )}
    </div>
  );
}
