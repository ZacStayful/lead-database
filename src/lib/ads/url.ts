/**
 * Reading a web address out of something an operator typed (§65).
 *
 * This replaces `asUrl` in `profile.ts`, which returned `undefined` for
 * everything it could not read and said nothing about why. That silence is
 * what broke the first real run: the model offered "Message straight to my
 * phone (WhatsApp or Messenger)" as an answer to `landing_url`, the coercer
 * binned it, and the operator was then told they still needed "a page for the
 * button to point at" — for a question they had answered exactly as asked.
 *
 * ⚠️ WHAT IS STORED IS STILL ALWAYS AN ABSOLUTE https URL, with a dotted
 * public hostname and no userinfo. §21.5's rule stands: the button on a live ad
 * must not send a landlord over http, and Meta would refuse it anyway. What
 * changes is the input grammar and the fact that a refusal now has a reason.
 *
 * ⚠️ AND IT NEVER TRUNCATES. The old code sliced to 400 characters, which turns
 * a long URL into a DIFFERENT, possibly still-valid one — silent corruption
 * pointing a paid ad somewhere the operator never chose. Over the cap is a
 * refusal.
 *
 * Import-free on purpose: `AdProfileForm` is a "use client" component and needs
 * the reasons to render them beside the field. The §21.8 split.
 */

export const MAX_AD_URL_LENGTH = 400;

export type UrlRefusal =
  | "empty"
  | "not_a_url"
  | "no_dot"
  | "unsupported_scheme"
  | "not_public"
  | "has_credentials"
  | "too_long";

export type UrlVerdict =
  | { ok: true; url: string; upgraded: boolean }
  | { ok: false; reason: UrlRefusal };

/** Zero-width characters and the BOM. A URL pasted out of email or a doc
 *  carries these invisibly, and they make an otherwise good address unparseable
 *  for a reason nobody can see on screen. */
const INVISIBLE = /[​-‍⁠﻿]/g;

/** Punctuation a paste picks up from the prose around it: "see https://x.com."
 *  The closing bracket family matters as much as the full stop. */
const TRAILING_JUNK = /[.,;:!?)\]}>'"»]+$/;

/**
 * ⚠️ CHECKED ON THE RAW INPUT, BEFORE ANY PREFIXING, AND THAT ORDERING IS THE
 * WHOLE POINT. `new URL("https://javascript:alert(1)")` parses perfectly well —
 * it reads `javascript` as the host and `alert(1)` as the port — so a scheme
 * check that ran after the https prefix would wave a script URL straight
 * through. The old code prefixed first and checked nothing.
 */
const BAD_SCHEME = /^(javascript|data|mailto|tel|sms|file|ftp|wss?|vbscript|blob|about):/i;

/** Any other explicit scheme, e.g. `gopher://`. Refused rather than guessed at. */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const HTTP_SCHEME = /^(https?):\/\//i;

/** An IPv4 literal. A public website has a name; a bare address is a
 *  development machine or a mistake. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  // A bracketed IPv6 literal arrives as "[::1]" in URL.hostname.
  if (host.startsWith("[")) return false;
  if (IPV4.test(host)) return false;
  return true;
}

export function parseAdUrl(raw: string): UrlVerdict {
  let text = raw.replace(INVISIBLE, "").trim();
  if (!text) return { ok: false, reason: "empty" };

  text = text.replace(TRAILING_JUNK, "");
  if (!text) return { ok: false, reason: "empty" };

  if (BAD_SCHEME.test(text)) return { ok: false, reason: "unsupported_scheme" };

  let upgraded = false;
  const http = HTTP_SCHEME.exec(text);
  if (http) {
    if (http[1].toLowerCase() === "http") {
      // Upgrade rather than refuse. The rule protects whoever taps the button,
      // and https protects them identically while keeping what was typed.
      text = `https://${text.slice(http[0].length)}`;
      upgraded = true;
    }
  } else if (OTHER_SCHEME.test(text)) {
    return { ok: false, reason: "unsupported_scheme" };
  } else {
    // A bare domain. Already the old behaviour, now deliberate and tested.
    text = `https://${text}`;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "unsupported_scheme" };
  // ⚠️ A credential in a URL on a live ad is a different class of wrong from a
  // typo, and the old code accepted it without comment.
  if (url.username || url.password) return { ok: false, reason: "has_credentials" };
  if (!isPublicHost(url.hostname)) return { ok: false, reason: "not_public" };
  if (!url.hostname.includes(".")) return { ok: false, reason: "no_dot" };

  const out = url.toString();
  if (out.length > MAX_AD_URL_LENGTH) return { ok: false, reason: "too_long" };

  return { ok: true, url: out, upgraded };
}

/**
 * What the operator is told. Plain, and never naming the slot key — §65's rule
 * that a raw key must not reach a customer surface (`slotCopy.ts:114`).
 */
export const URL_REFUSAL_COPY: Record<UrlRefusal, string> = {
  empty: "I didn't get a web address there.",
  not_a_url: "I couldn't read that as a web address.",
  no_dot: "That needs to look like a web address — something with a dot in it, like yourcompany.co.uk.",
  unsupported_scheme: "That needs to be a web address the button can open, not an email address or a phone link.",
  not_public: "That address only works on your own machine, so a landlord tapping the button wouldn't reach it.",
  has_credentials: "That address has a username and password in it, which shouldn't go on an ad.",
  too_long: "That address is too long to put on an ad.",
};

/** Said when a typed `http://` was stored as `https://`, so the change is never
 *  silent. */
export const URL_UPGRADED_NOTE =
  "I've saved that as https, which is what the button needs.";
