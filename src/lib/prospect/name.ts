/**
 * The prospect's first name, or nothing (§55).
 *
 * ⚠️ NOT A THIRD NAME RULE. §40.14 already settled this exact question for
 * merge fields, and the reasoning carries over unchanged: `firstNameOf` alone
 * only asks for 2–40 characters containing a letter, which `natalyanaq@gmail.com`
 * and `Dbncc` both satisfy — and both are real values from the live book. That
 * is fair where it lives, because draftContext hands the name to a MODEL, which
 * is not going to paste an email address into a greeting. A template has no such
 * judgement, so §36.3's junk detector is asked first.
 *
 * Reusing both rather than writing one of my own is the point: two definitions
 * of "does this read as a person" drift, and §36.3 carries the measurement
 * (87 of 437 leads are a lone first name) that keeps this one honest.
 *
 * Returns "" rather than null so the caller can interpolate it directly —
 * greeting() in copy.ts already handles the empty case, because "Hi ," sent
 * from a real person's WhatsApp is worse than no name at all.
 */
import { isJunkName } from "@/lib/leadQuality";
import { firstNameOf } from "@/lib/messaging/draftContext";

export function prospectFirstName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!name || isJunkName(name)) return "";
  const first = firstNameOf(name);
  return first && !isJunkName(first) ? first : "";
}
