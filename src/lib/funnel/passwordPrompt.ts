/**
 * The "set a password for next time" card (batch 02 Phase 5, C2).
 *
 * A funnel payer signs in the first time with a magic link and has no
 * password they know. Once their brief is confirmed, the dashboard offers to
 * set one, so a second visit does not need another email. It goes away when
 * they set a password, which stamps `password_set_at`
 * (POST /api/customer/password-set, from /reset-password).
 *
 * Keyed on `signup_source = 'funnel'`: password_set_at is null on every
 * customer who existed before 0165, and they all have a password already.
 * IMPORT-FREE, so a client component may use it too.
 */
export interface PasswordPromptFields {
  signup_source?: string | null;
  password_set_at?: string | null;
  lead_brief_completed_at?: string | null;
}

export function offerSetPassword(customer: PasswordPromptFields | null | undefined): boolean {
  return (
    !!customer &&
    customer.signup_source === "funnel" &&
    !customer.password_set_at &&
    !!customer.lead_brief_completed_at
  );
}
