/**
 * Composing and sending one message as the customer (§40).
 *
 * NO STAYFUL BRANDING. This deliberately does not reuse shell(), button(),
 * BRAND or fromAddress() from src/lib/emails.ts — the entire point of the
 * customer's own domain is that the landlord sees the operator, not us. What it
 * DOES reuse is esc(), because §22.5 makes escaping load-bearing and a second
 * copy of it is how the two drift.
 */
import { esc } from "@/lib/emails";

/**
 * An operator's plain text, rendered as a plain email.
 *
 * Split on blank lines into paragraphs, exactly as §22.5 treats announcement
 * bodies and /dashboard/training treats body_markdown, so the email and the
 * on-screen thread break the text in the same places. Every paragraph goes
 * through esc() — this text is typed by a person and lands in HTML.
 */
export function renderOperatorHtml(bodyText: string): string {
  const paragraphs = (bodyText ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.6">${esc(p).replace(/\n/g, "<br />")}</p>`)
    .join("");

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;color:#111">${paragraphs}</div>`;
}

/**
 * Header values must never contain CR or LF. An operator typing a newline into a
 * subject is not an attack, but the same path would carry one — so strip rather
 * than trust, at the last point before it becomes a header.
 */
export function sanitiseHeaderValue(value: string, max = 200): string {
  return (value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

/** Resend restricts tag characters; anything else is rejected at the API. */
export function sanitiseTagValue(value: string): string {
  return (value ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
}

export function buildFromAddress(domain: {
  domain: string;
  from_local_part: string;
  from_display_name: string | null;
}): string {
  const address = `${domain.from_local_part}@${domain.domain}`;
  const name = domain.from_display_name
    ? sanitiseHeaderValue(domain.from_display_name, 80).replace(/["\\]/g, "")
    : null;
  return name ? `${name} <${address}>` : address;
}
