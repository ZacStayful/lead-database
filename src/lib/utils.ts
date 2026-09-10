import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Best-effort "city" extraction from a free-text UK address. */
export function extractCity(address?: string | null): string {
  if (!address) return "";
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  // UK addresses commonly end with "... , City, POSTCODE". Prefer the
  // second-to-last segment; fall back to the last non-postcode segment.
  const postcodeLike = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
  const withoutPostcode = parts.filter((p) => !postcodeLike.test(p));
  if (withoutPostcode.length >= 1) {
    return withoutPostcode[withoutPostcode.length - 1];
  }
  return parts[parts.length - 1];
}

export function initials(name?: string | null): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatCurrencyPence(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

/** Format a whole-pound amount, e.g. 1890 → "£1,890". */
export function formatGBP(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Days since a lead's enquiry date.
 *
 * leads.enquiry_date is a free-text column fed from Monday, so anything
 * unparseable returns null rather than throwing or reporting a bogus age.
 * Dates in the future clamp to 0.
 */
export function daysSince(value?: string | null, now: Date = new Date()): number | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const days = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(days, 0);
}

/**
 * How old a lead is, in words, for display next to the enquiry date. Returns
 * an empty string when the date cannot be read, so callers can drop it.
 */
export function leadAgeLabel(enquiryDate?: string | null, now: Date = new Date()): string {
  const days = daysSince(enquiryDate, now);
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

/**
 * The enquiry date with its age appended, e.g. "3 Sep 2026 (7 days old)".
 * Age is the single most useful thing to know about a lead before working it:
 * a landlord who enquired three weeks ago has usually moved on. Falls back to
 * the plain date when enquiry_date cannot be parsed.
 */
export function enquiryDateWithAge(
  enquiryDate?: string | null,
  now: Date = new Date()
): string {
  const formatted = formatDate(enquiryDate);
  const age = leadAgeLabel(enquiryDate, now);
  return age ? `${formatted} (${age})` : formatted;
}
