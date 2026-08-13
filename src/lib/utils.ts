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

/**
 * How long the CUSTOMER has held this lead, phrased from their side.
 *
 * Deliberately measured from lead_assignments.assigned_at, never from
 * leads.enquiry_date. A customer sees when the lead reached THEM and nothing
 * about how old the enquiry is — an escalated lead arriving on day 20 would
 * otherwise announce itself as three weeks stale before its new operator had
 * picked up the phone, which is both discouraging and none of their business.
 *
 * The enquiry date is no longer displayed anywhere, admin included: it is
 * free-text of uneven quality from Monday, and the assignment date answers
 * every question anyone was actually asking of it.
 *
 * Timestamps may arrive as "2026-07-27 09:29" — a space, not a T. V8 tolerates
 * that; Safari returns Invalid Date. This runs in the browser (LeadCard and
 * LeadDetail are client components), so the separator is normalised rather
 * than trusted.
 */
export function formatLeadAge(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value.trim().replace(" ", "T"));
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "Received today";
  if (days === 1) return "Received 1 day ago";
  return `Received ${days} days ago`;
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
