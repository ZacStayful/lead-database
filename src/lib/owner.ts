/**
 * Owner override. Emails in this allowlist bypass the Stripe payment wall at
 * signup and are provisioned as active, admin-level accounts so the whole
 * platform (customer portal + admin panel) is visible without paying.
 *
 * Configurable via OWNER_EMAILS (comma-separated). Defaults to the Stayful
 * owner address.
 */
export function ownerEmails(): string[] {
  const raw = process.env.OWNER_EMAILS ?? "zac@stayful.co.uk";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerEmail(email: string): boolean {
  return ownerEmails().includes(email.trim().toLowerCase());
}
