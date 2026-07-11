"use client";

import { useEffect, useState, type CSSProperties } from "react";

// Public, anonymised marketplace-activity ledger + counter.
//
// This reads ONLY the cached singleton served by /api/stats/public — it never
// touches lead_assignments directly. The cache is refreshed daily by the
// cron route; the "assigned X days ago" captions below are computed against
// real time on the client, so they stay accurate between refreshes.
//
// Privacy: the API returns only the postcode district (outward code, never a
// full postcode or exact city), bedroom count, and assignment date. No lead
// name, address, phone, email, or lead profile is ever fetched or rendered.

type LedgerEntry = {
  location: string;
  bedrooms: string | number | null;
  assigned_at: string;
};

// The bedrooms value may already carry its own unit (e.g. "3 Bed"), so only
// append "-bed" when it's a bare number ("3"). Falls back to "Property" when
// bedroom count is unknown.
function bedroomLabel(bedrooms: string | number | null): string {
  if (bedrooms === null || bedrooms === undefined || bedrooms === "") {
    return "Property";
  }
  const value = String(bedrooms).trim();
  return /bed/i.test(value) ? value : `${value}-bed`;
}

type PublicStats = {
  totalDistributed: number;
  sinceDate: string;
  ledger: LedgerEntry[];
  generatedAt: string | null;
};

function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

export default function LiveActivity() {
  const [stats, setStats] = useState<PublicStats | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/stats/public")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active) setStats(data);
      })
      .catch(() => {
        if (active) setStats(null);
      });
    return () => {
      active = false;
    };
  }, []);

  // No cron run yet (or fetch failed) — hide the section entirely rather than
  // render zeroed or broken stats.
  if (!stats || !stats.generatedAt) {
    return null;
  }

  const generatedDate = new Date(stats.generatedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const sinceDate = new Date(stats.sinceDate).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <section style={{ background: "var(--sf-olive)", padding: "88px 32px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        {/* WebKit/Blink ignore scrollbar-width; style the ledger scrollbar to
            match the brand rather than showing the chunky OS default. */}
        <style>{`
          .sf-ledger-scroll::-webkit-scrollbar { width: 6px; }
          .sf-ledger-scroll::-webkit-scrollbar-track { background: transparent; }
          .sf-ledger-scroll::-webkit-scrollbar-thumb {
            background: var(--sf-border);
            border-radius: 999px;
          }
        `}</style>
        <p style={eyebrow}>Live marketplace activity</p>
        <h2 style={headline}>
          {stats.totalDistributed.toLocaleString("en-GB")} leads distributed
          since {sinceDate} — and counting
        </h2>
        <p style={updatedCaption}>Updated daily — last updated {generatedDate}</p>

        {/* Qualification pillars — the real qualifiers every lead passes,
            already stated elsewhere on the page. */}
        <div style={pillarsRow}>
          {["Google-sourced", "Financially modelled", "Consent-confirmed"].map(
            (pillar, i) => (
              <span key={pillar} style={pillar_} >
                {i > 0 && <span style={pillarDot}>·</span>}
                {pillar}
              </span>
            )
          )}
        </div>

        {stats.ledger.length > 0 && (
          <ul className="sf-ledger-scroll" style={ledgerCard}>
            {stats.ledger.map((entry, i) => (
              <li
                key={i}
                style={{
                  ...ledgerRow,
                  borderTop: i === 0 ? "none" : "1px solid var(--sf-border)",
                }}
              >
                <span style={{ color: "var(--sf-body)", fontWeight: 600 }}>
                  {bedroomLabel(entry.bedrooms)} · {entry.location}
                </span>
                <span style={{ color: "var(--sf-muted)" }}>
                  {timeAgo(entry.assigned_at)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Privacy-by-design note — frames the anonymity as deliberate. */}
        <p style={privacyNote}>
          <LockIcon />
          Landlord identities are never shown. We display only property size,
          postcode district, and when each lead was matched — by design.
        </p>
      </div>
    </section>
  );
}

function LockIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, marginTop: 1 }}
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

const eyebrow: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: ".12em",
  color: "var(--sf-dark)",
  marginBottom: 12,
  textAlign: "center",
};

const headline: CSSProperties = {
  fontFamily: "var(--sf-display)",
  fontSize: "clamp(24px,3.4vw,34px)",
  fontWeight: 700,
  letterSpacing: "-.02em",
  lineHeight: 1.12,
  color: "var(--sf-green)",
  textAlign: "center",
  marginBottom: 10,
};

const updatedCaption: CSSProperties = {
  fontSize: 13,
  color: "var(--sf-green)",
  opacity: 0.72,
  textAlign: "center",
  marginBottom: 20,
};

const pillarsRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  alignItems: "center",
  gap: 8,
  marginBottom: 28,
};

const pillar_: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: ".01em",
  color: "var(--sf-dark)",
};

const pillarDot: CSSProperties = {
  color: "var(--sf-green)",
  opacity: 0.5,
  fontWeight: 400,
};

const privacyNote: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  maxWidth: 560,
  margin: "18px auto 0",
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--sf-green)",
  opacity: 0.78,
  textAlign: "left",
};

// The ledger now holds up to 20 entries. We keep the card compact by showing
// five rows at a time and scrolling the rest. LEDGER_ROW_PX is one row's
// height (14px top + 14px bottom padding + ~20px line); LEDGER_CARD_CHROME_PX
// covers the card's own 8px top + 8px bottom padding and 1px top + 1px bottom
// border (Tailwind's preflight makes every element border-box, so max-height
// must include them). The trailing third-of-a-row lets the sixth entry peek
// below the fold as a scroll affordance.
const LEDGER_ROW_PX = 48;
const LEDGER_VISIBLE_ROWS = 5;
const LEDGER_CARD_CHROME_PX = 18;

const ledgerCard: CSSProperties = {
  background: "#fff",
  border: "1px solid var(--sf-border)",
  borderRadius: 16,
  padding: "8px 24px",
  listStyle: "none",
  margin: 0,
  maxHeight:
    LEDGER_ROW_PX * LEDGER_VISIBLE_ROWS +
    LEDGER_CARD_CHROME_PX +
    Math.round(LEDGER_ROW_PX / 3),
  overflowY: "auto",
  scrollbarWidth: "thin",
  scrollbarColor: "var(--sf-border) transparent",
};

const ledgerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: "14px 0",
  fontSize: 14,
};
