/**
 * One definition of "is this a usable email address, and what is its canonical
 * form" — shared by the password-reset route and the admin email-change route
 * (§43), which must agree or the second can write a row the first cannot find.
 *
 * Lowercasing is load-bearing because the lookups this feeds are inconsistent
 * across the codebase: provisioning and enquiry lowercase, invite and
 * reset-password pass through verbatim, and `customers.email` is a
 * case-SENSITIVE unique column with no `lower()` index. Measured before this
 * shipped: 0 of 41 customer rows carry a mixed-case or untrimmed address and
 * there are no case-collisions, so normalising is a no-op on today's data and a
 * guard on tomorrow's.
 *
 * Deliberately not a full RFC 5322 validator. It rejects the shapes that would
 * break a lookup or a Stripe call and accepts everything else — an over-strict
 * address check turns away real customers, which is the failure mode this whole
 * change exists to reduce.
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const email = raw.trim().toLowerCase();
  if (!email.includes("@")) return null;
  if (/\s/.test(email)) return null;

  const parts = email.split("@");
  if (parts.length !== 2) return null;

  const [local, domain] = parts as [string, string];
  if (!local || !domain) return null;
  // A bare hostname (`user@localhost`) is not deliverable and not something a
  // customer will have signed up with.
  if (!domain.includes(".")) return null;
  if (domain.startsWith(".") || domain.endsWith(".")) return null;

  return email;
}
