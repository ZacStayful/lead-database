"use client";

import { useEffect, useState, type CSSProperties } from "react";

// Public, anonymised marketplace-activity ledger + counter.
//
// This reads ONLY the cached singleton served by /api/stats/public — it never
// touches lead_assignments directly. The cache is refreshed monthly by the
// cron route; the "assigned X days ago" captions below are computed against
// real time on the client, so they stay accurate between refreshes.
//
// Privacy: the API returns only region (a broad UK region, never an exact
// city), bedroom count, and assignment date. No lead name, address, phone,
// email, or lead profile is ever fetched or rendered here.

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
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
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
        <p style={eyebrow}>Live marketplace activity</p>
        <h2 style={headline}>
          {stats.totalDistributed.toLocaleString("en-GB")} leads distributed
          since {sinceDate}
        </h2>
        <p style={updatedCaption}>Updated monthly — last updated {generatedDate}</p>

        {stats.ledger.length > 0 && (
          <ul style={ledgerCard}>
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
      </div>
    </section>
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
  marginBottom: 32,
};

const ledgerCard: CSSProperties = {
  background: "#fff",
  border: "1px solid var(--sf-border)",
  borderRadius: 16,
  padding: "8px 24px",
  listStyle: "none",
  margin: 0,
};

const ledgerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: "14px 0",
  fontSize: 14,
};
