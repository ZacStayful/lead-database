/**
 * WHAT WE ACTUALLY SAY TO AN ENQUIRER WHO HAS NOT BOOKED (§55).
 *
 * ⚠️ THIS MODULE MUST STAY IMPORT-FREE. The admin preview panel is a
 * "use client" component, so these constants cannot live next to anything that
 * reaches supabase-js, Resend or the Monday client. The same split
 * featureRequest.ts makes from announcements.ts (§21.8) and deadLeadCopy.ts
 * from deadLeadPolicy.ts (§51.6). Adding one import here breaks the admin
 * build, and it breaks it at the bottom of a stack trace nobody enjoys.
 *
 * The tone is the brief: first person, no pitch, no feature list. The only job
 * of every one of these is one click back to the calendar.
 */

/**
 * ⚠️ ONE DEFINITION OF THE BOOKING LINK, and it is duplicated nowhere.
 *
 * src/app/enquiry/page.tsx redirects here after a successful submit, and every
 * message below sends them back to the same place. Two copies would drift the
 * first time the event type is renamed, and the failure is silent: the form
 * would keep working while every chase pointed at a dead link.
 */
export const BOOKING_URL =
  "https://calendly.com/zac-stayful/stayful-lead-database";

export type ProspectChannelName = "whatsapp" | "email";

export interface ProspectMessageInput {
  /** Their first name, already resolved and known good. */
  firstName: string;
  /** Unsubscribe link, email only. */
  optOutUrl?: string;
}

/**
 * A greeting that is safe to send.
 *
 * ⚠️ NOT a name parser of its own. `lead_name` on this board is whatever
 * somebody typed, and §36.3 already measured what that looks like: a lone
 * first name is the NORM (87 of 437), but real values include an email address
 * and "Dbncc". The caller runs §36.3's isJunkName / firstNameOf before getting
 * here; this is only the fallback for when they come back empty, because
 * "Hi ," sent from a real person's WhatsApp is worse than no name at all.
 */
export function greeting(firstName: string): string {
  const n = firstName.trim();
  return n ? `Hi ${n}, ` : "Hi, ";
}

/** Step 1, WhatsApp — about two minutes after they enquired. */
export function whatsappStepOne(p: ProspectMessageInput): string {
  return (
    `${greeting(p.firstName)}Zac from Stayful here — thanks for enquiring just now. ` +
    `I've got a couple of slots free this week to run through how the lead database works ` +
    `and whether there's the volume you need in your patch. ` +
    `Grab whichever suits: ${BOOKING_URL}`
  );
}

/** Step 2, WhatsApp — the next day. */
export function whatsappStepTwo(p: ProspectMessageInput): string {
  return (
    `${greeting(p.firstName)}didn't manage to get you in the diary yesterday. ` +
    `Still happy to walk you through it — 20 minutes and you'll know whether it's worth it either way: ` +
    `${BOOKING_URL}`
  );
}

export function whatsappForStep(
  step: number,
  p: ProspectMessageInput
): string | null {
  if (step === 1) return whatsappStepOne(p);
  if (step === 2) return whatsappStepTwo(p);
  return null;
}

export interface ProspectEmail {
  subject: string;
  /** Paragraphs. The sender escapes and wraps them. */
  paragraphs: string[];
  cta: { url: string; label: string };
}

/** Step 1, email — lands beside the WhatsApp. */
export function emailStepOne(p: ProspectMessageInput): ProspectEmail {
  return {
    subject: "Your Stayful lead database enquiry",
    paragraphs: [
      `${greeting(p.firstName)}thanks for getting in touch about the Stayful lead database.`,
      `The quickest way to work out whether it's any use to you is 20 minutes on a call — I'll show you the leads coming through in your area, what they cost, and how many a month you'd realistically get. If it's not right for you, I'll say so.`,
      `Pick a time that suits:`,
    ],
    cta: { url: BOOKING_URL, label: "Book a 20-minute call" },
  };
}

/**
 * Step 3, email — the last one, and it says so.
 *
 * ⚠️ Saying it is the last message is not a closing technique, it is the
 * truth: the ladder stops here. A "just circling back" that is followed by
 * nothing is the thing that makes the next one ignorable.
 */
export function emailStepThree(p: ProspectMessageInput): ProspectEmail {
  return {
    subject: "Closing off your lead database enquiry",
    paragraphs: [
      `${greeting(p.firstName)}I've not managed to catch you, so I'll leave it there — this is the last you'll hear from me about it.`,
      `If it's just bad timing, the link below stays open and you're welcome to grab a slot whenever suits. And if you'd rather ask something by email first, just reply to this.`,
    ],
    cta: { url: BOOKING_URL, label: "Book a call when you're ready" },
  };
}

export function emailForStep(
  step: number,
  p: ProspectMessageInput
): ProspectEmail | null {
  if (step === 1) return emailStepOne(p);
  if (step === 3) return emailStepThree(p);
  return null;
}
