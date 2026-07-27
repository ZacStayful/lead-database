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
 * How long ago an enquiry came in, phrased for a lead-age badge:
 * "Enquired today", "Enquired 1 day ago", "Enquired 5 days ago".
 *
 * Shown on reclaimed leads so the second operator knows exactly what they are
 * getting before they ring — a five-day-old enquiry is a different conversation
 * from a fresh one, and finding that out mid-call is worse than being told.
 * Whole days only; hour-level precision would imply a freshness the lead does
 * not have.
 */
export function formatLeadAge(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "Enquired today";
  if (days === 1) return "Enquired 1 day ago";
  return `Enquired ${days} days ago`;
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
