/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import type { CSSProperties } from "react";

// Operator-facing landing page for the Guaranteed Rent (rent-to-rent) product.
//
// NOTE: the main landing page (app/page.tsx) inlines its nav and footer rather
// than exposing shared components, so they are replicated here using the same
// brand tokens (--sf-*) and style patterns to keep the look identical.

const LOGO = "/logo.png";

export const metadata = {
  title: "Guaranteed Rent leads for R2R operators — Stayful",
  description:
    "Qualified landlord leads open to a guaranteed rent arrangement, financially modelled against live Airbnb data before assignment.",
};

const display = (extra?: CSSProperties): CSSProperties => ({
  fontFamily: "var(--sf-display)",
  ...extra,
});

interface FinancialRow {
  size: string;
  gross: string;
  net: string;
  rent: string;
  monthlyNet: string;
  annualNet: string;
  margin: string;
}

const FINANCIALS: FinancialRow[] = [
  { size: "1-bed", gross: "£26,455", net: "£22,487", rent: "£954", monthlyNet: "£523", annualNet: "£6,277", margin: "23.7%" },
  { size: "2-bed", gross: "£37,584", net: "£31,946", rent: "£1,182", monthlyNet: "£916", annualNet: "£10,997", margin: "29.2%" },
  { size: "3-bed", gross: "£47,520", net: "£40,392", rent: "£1,394", monthlyNet: "£1,259", annualNet: "£15,110", margin: "31.8%" },
  { size: "4-bed", gross: "£58,433", net: "£49,668", rent: "£1,683", monthlyNet: "£1,580", annualNet: "£18,954", margin: "32.4%" },
  { size: "5-bed", gross: "£65,698", net: "£55,843", rent: "£1,913", monthlyNet: "£1,756", annualNet: "£21,067", margin: "32.1%" },
];

// Compounding model: at a 10% conversion rate, 10 leads/month is one new
// guaranteed-rent property per month. Average net across 1–5 bed = £1,207/mo
// (£523, £916, £1,259, £1,580, £1,756 — the Monthly net column above).
const AVG_MONTHLY_NET = 1207;

// Cumulative monthly recurring net (properties × avg net) by month.
const COMPOUNDING_BARS: { month: string; value: number }[] = [
  { month: "M3", value: 3 * AVG_MONTHLY_NET },
  { month: "M6", value: 6 * AVG_MONTHLY_NET },
  { month: "M9", value: 9 * AVG_MONTHLY_NET },
  { month: "M12", value: 12 * AVG_MONTHLY_NET },
  { month: "M18", value: 18 * AVG_MONTHLY_NET },
  { month: "M24", value: 24 * AVG_MONTHLY_NET },
];

interface Milestone {
  month: string;
  properties: number;
  monthlyNet: string;
  spent: string;
  earned: string;
  roi: string;
}

// Cumulative net earned through month M = avg × (1+2+…+M); spend = £100 × M.
const MILESTONES: Milestone[] = [
  { month: "Month 6", properties: 6, monthlyNet: "£7,242", spent: "£600", earned: "£25,347", roi: "42×" },
  { month: "Month 12", properties: 12, monthlyNet: "£14,484", spent: "£1,200", earned: "£94,146", roi: "78×" },
  { month: "Month 24", properties: 24, monthlyNet: "£28,968", spent: "£2,400", earned: "£362,100", roi: "151×" },
];

const STEPS: { n: string; title: string; body: React.ReactNode }[] = [
  {
    n: "01",
    title: "Subscribe",
    body: "£100/month for 10 leads per month. No lock-in, cancel anytime.",
  },
  {
    n: "02",
    title: "Leads arrive",
    body: "Within minutes of assignment, by email and in your dashboard. Each landlord has been emailed by Stayful and is expecting contact from a local operator.",
  },
  {
    n: "03",
    title: "Run the numbers",
    body: (
      <>
        Use <AnalyserLink /> to model gross STR income, guaranteed rent, and
        operating costs against live Airbnb data for the property&apos;s
        postcode, before you pick up the phone.
      </>
    ),
  },
  {
    n: "04",
    title: "Make contact",
    body: "Call, email, or meet. The landlord already knows who Stayful is and that they are being passed to a trusted operator.",
  },
];

const PRICING_FEATURES = [
  "10 leads per month included",
  "£10 per lead",
  "Maximum 2 operators per lead",
  "Every lead financially modelled before assignment",
  "Every landlord emailed in advance — warm hand-off guaranteed",
  "Free company let tenancy agreement to get landlords signed",
  "Cancel anytime, no lock-in",
  "No overflow tier",
];

export default function GuaranteedRentPage() {
  return (
    <main
      style={{
        fontFamily: "var(--sf-sans)",
        color: "var(--sf-body)",
        background: "#fff",
        lineHeight: 1.6,
      }}
    >
      {/* ============ NAV ============ */}
      <nav
        style={{
          background: "#fff",
          borderBottom: "1px solid var(--sf-border)",
          padding: "0 32px",
          position: "sticky",
          top: 0,
          zIndex: 100,
          height: 62,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
          }}
        >
          <img src={LOGO} alt="Stayful" style={{ height: 28 }} />
          <span
            style={{
              borderLeft: "1px solid var(--sf-line, #d9dbd8)",
              paddingLeft: 10,
              fontSize: 16,
              fontWeight: 600,
              color: "var(--sf-green)",
            }}
          >
            Guaranteed Rent
          </span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <Link href="/" style={navLink}>
            Management Leads
          </Link>
          <a href="#how" style={navLink}>
            How it works
          </a>
          <a href="#numbers" style={navLink}>
            The numbers
          </a>
          <a href="#pricing" style={navLink}>
            Pricing
          </a>
          <Link
            href="/login"
            style={{
              color: "var(--sf-dark)",
              fontSize: 13,
              fontWeight: 600,
              padding: "9px 16px",
              borderRadius: 8,
              border: "1px solid var(--sf-border)",
              textDecoration: "none",
            }}
          >
            Log in
          </Link>
          <Link href="/signup?product=guaranteed-rent" style={navCta}>
            Start receiving leads →
          </Link>
        </div>
      </nav>

      {/* ============ 2. HERO ============ */}
      <section style={{ background: "var(--sf-sage)", padding: "72px 32px 80px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto", textAlign: "center" }}>
          <h1
            style={display({
              fontSize: "clamp(32px,4.6vw,50px)",
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-.03em",
              color: "var(--sf-green)",
              marginBottom: 20,
            })}
          >
            10 guaranteed rent leads in your inbox every month.
          </h1>
          <p
            style={{
              fontSize: 17,
              fontWeight: 500,
              color: "var(--sf-green)",
              opacity: 0.85,
              maxWidth: 640,
              margin: "0 auto 30px",
              lineHeight: 1.65,
            }}
          >
            Every lead is a landlord who has enquired about guaranteed rent and
            has already consented to their property being listed on Airbnb in
            return for a fixed monthly rent. Pre-qualified, financially assessed
            against live Airbnb data for their postcode, and expecting a local
            operator to be in touch.
          </p>
          <Link href="/signup?product=guaranteed-rent" style={heroPrimary}>
            Start receiving leads →
          </Link>
        </div>
      </section>

      {/* ============ USP — THE HARD PART IS DONE ============ */}
      <section style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow>Why this is different</Eyebrow>
          <h2 style={centerHeadline({ marginBottom: 16 })}>
            The hard part is already done.
          </h2>
          <p style={centerLede()}>
            Building a rent-to-rent portfolio normally means cold-contacting
            letting agents and landlords, getting rejected again and again, and
            learning to sell before you can build a single relationship. Every
            lead here is a landlord who has already said yes.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))",
              gap: 18,
              marginBottom: 28,
            }}
          >
            <div
              style={{
                background: "#fff",
                border: "1px solid var(--sf-border)",
                borderRadius: 16,
                padding: 26,
              }}
            >
              <h3
                style={display({
                  fontSize: 17,
                  fontWeight: 700,
                  color: "var(--sf-green)",
                  marginBottom: 14,
                })}
              >
                The usual rent-to-rent grind
              </h3>
              {[
                "Cold-contacting letting agents and landlords one by one",
                "Constant rejection while you try to build a database",
                "Needing to understand sales before anyone says yes",
                "Explaining, and justifying, guaranteed rent and Airbnb from scratch every time",
                "Weeks of outreach for a handful of maybes",
              ].map((t) => (
                <div
                  key={t}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    fontSize: 14,
                    color: "var(--sf-secondary)",
                    lineHeight: 1.55,
                    marginBottom: 10,
                  }}
                >
                  <span style={{ color: "var(--sf-muted)", flexShrink: 0 }}>✕</span>
                  {t}
                </div>
              ))}
            </div>

            <div
              style={{
                background: "var(--sf-green)",
                borderRadius: 16,
                padding: 26,
              }}
            >
              <h3
                style={display({
                  fontSize: 17,
                  fontWeight: 700,
                  color: "#fff",
                  marginBottom: 14,
                })}
              >
                What you get here
              </h3>
              {[
                "Landlords who have already enquired about guaranteed rent",
                "Already consenting to Airbnb / short-let use in return for a fixed rent",
                "Already vetted and financially qualified before assignment",
                "Already expecting a call from a trusted local operator",
                "No database to build, no sales process to learn — just conversations that start at yes",
              ].map((t) => (
                <div
                  key={t}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    fontSize: 14,
                    color: "#fff",
                    opacity: 0.95,
                    lineHeight: 1.55,
                    marginBottom: 10,
                  }}
                >
                  <span style={{ color: "var(--sf-sage)", flexShrink: 0 }}>✓</span>
                  {t}
                </div>
              ))}
            </div>
          </div>

          <p
            style={{
              textAlign: "center",
              maxWidth: 720,
              margin: "0 auto",
              fontSize: 15.5,
              fontWeight: 600,
              color: "var(--sf-green)",
              lineHeight: 1.65,
            }}
          >
            These leads are already vetted, already qualified, and the landlord
            has already approved Airbnb as a letting option for their property in
            return for a guaranteed rent. All the cold outreach, database
            building and selling is cut out — you just pick up the phone.
          </p>
        </div>
      </section>

      {/* ============ 3. HOW IT WORKS ============ */}
      <section id="how" style={{ background: "var(--sf-sage)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow>How it works</Eyebrow>
          <h2 style={centerHeadline({ marginBottom: 44 })}>
            From subscription to signed agreement.
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
              gap: 18,
            }}
          >
            {STEPS.map((s) => (
              <div
                key={s.n}
                style={{
                  background: "#fff",
                  border: "1px solid var(--sf-border)",
                  borderRadius: 16,
                  padding: 24,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 12,
                  }}
                >
                  <span style={stepNum}>{s.n}</span>
                  <h3
                    style={display({
                      fontSize: 16,
                      fontWeight: 700,
                      color: "var(--sf-green)",
                    })}
                  >
                    {s.title}
                  </h3>
                </div>
                <p
                  style={{
                    fontSize: 13.5,
                    color: "var(--sf-secondary)",
                    lineHeight: 1.6,
                  }}
                >
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 4. WHAT IS RENT-TO-RENT ============ */}
      <section style={{ background: "var(--sf-olive)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", textAlign: "center" }}>
          <Eyebrow color="var(--sf-dark)">What is rent-to-rent</Eyebrow>
          <h2
            style={centerHeadline({
              color: "var(--sf-green)",
              marginBottom: 20,
            })}
          >
            Certainty for the landlord. Upside for you.
          </h2>
          <p
            style={{
              fontSize: 16,
              color: "var(--sf-green)",
              opacity: 0.85,
              lineHeight: 1.75,
            }}
          >
            In a rent-to-rent arrangement, you take a property on a guaranteed
            rent basis — you pay the landlord a fixed monthly amount regardless
            of occupancy, and earn your income from the difference between that
            guaranteed rent and what you generate on Airbnb or Booking.com. The
            landlord gets certainty. You get the upside.
          </p>
        </div>
      </section>

      {/* ============ 5. FINANCIAL MODEL ============ */}
      <section id="numbers" style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow>The numbers</Eyebrow>
          <h2 style={centerHeadline({ marginBottom: 16 })}>
            What the numbers look like.
          </h2>
          <p style={centerLede()}>
            Based on a sample of properties in the Stayful portfolio. Net profit
            shown after 15% booking platform fee, guaranteed rent at 85% of ONS
            PIPR average market rent, and operating costs at 18% of gross income.
          </p>

          <div
            style={{
              overflowX: "auto",
              border: "1px solid var(--sf-border)",
              borderRadius: 16,
              background: "#fff",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 14,
                minWidth: 720,
              }}
            >
              <thead>
                <tr style={{ background: "var(--sf-sage)" }}>
                  <Th>Size</Th>
                  <Th right>Avg gross (annual)</Th>
                  <Th right>Net STR income</Th>
                  <Th right>Guaranteed rent/mo</Th>
                  <Th right>Monthly net</Th>
                  <Th right>Annual net</Th>
                  <Th right>Margin</Th>
                </tr>
              </thead>
              <tbody>
                {FINANCIALS.map((r) => (
                  <tr
                    key={r.size}
                    style={{ borderTop: "1px solid var(--sf-border)" }}
                  >
                    <Td bold>{r.size}</Td>
                    <Td right>{r.gross}</Td>
                    <Td right>{r.net}</Td>
                    <Td right>{r.rent}</Td>
                    <Td right>{r.monthlyNet}</Td>
                    <Td right bold>
                      {r.annualNet}
                    </Td>
                    <Td right>{r.margin}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p
            style={{
              fontSize: 14,
              color: "#898781",
              lineHeight: 1.6,
              marginTop: 16,
              maxWidth: 900,
            }}
          >
            Net STR income is gross income after 15% booking platform fee.
            Guaranteed rent is 85% of ONS PIPR average market rate (May 2026).
            Operating costs cover cleaning, consumables, and laundry at 18% of
            gross. Market rents: 1-bed £1,123/mo (ONS); 2-bed, 3-bed, 4-bed,
            5-bed interpolated from ONS trajectory and Rightmove/Zoopla new-let
            data. Use <AnalyserLink /> to model your specific property.
          </p>
        </div>
      </section>

      {/* ============ COMPOUNDING EFFECT ============ */}
      <section style={{ background: "var(--sf-sage)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow color="var(--sf-dark)">The compounding effect</Eyebrow>
          <h2 style={centerHeadline({ color: "var(--sf-green)", marginBottom: 16 })}>
            One in ten leads compounds into a portfolio.
          </h2>
          <p style={centerLede({ marginBottom: 20 })}>
            At a 10% conversion rate, 10 leads a month is one new guaranteed rent
            property every month. Each property earns an average of £1,207/mo net
            across 1&ndash;5 bed. Here is what that builds &mdash; and what it
            returns on your £100/month &mdash; over two years.
          </p>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 8,
              marginBottom: 40,
            }}
          >
            {[
              "10 leads / month",
              "10% convert",
              "= 1 new property / month",
              "£1,207 avg net / property / mo",
            ].map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  background: "#fff",
                  color: "var(--sf-dark)",
                  padding: "6px 14px",
                  borderRadius: 100,
                }}
              >
                {t}
              </span>
            ))}
          </div>

          {/* Recurring monthly net, month by month */}
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: "26px 24px 18px",
              marginBottom: 24,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "var(--sf-dark)",
                marginBottom: 18,
              }}
            >
              Recurring monthly net, month by month
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 14,
                height: 200,
              }}
            >
              {COMPOUNDING_BARS.map((b, i) => {
                const max = COMPOUNDING_BARS[COMPOUNDING_BARS.length - 1].value;
                const last = i === COMPOUNDING_BARS.length - 1;
                return (
                  <div
                    key={b.month}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      height: "100%",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--sf-dark)",
                        marginBottom: 6,
                      }}
                    >
                      £{b.value.toLocaleString()}
                    </div>
                    <div
                      style={{
                        width: "100%",
                        maxWidth: 54,
                        height: `${Math.round((b.value / max) * 100)}%`,
                        background: last ? "var(--sf-dark)" : "var(--sf-green)",
                        borderRadius: "6px 6px 0 0",
                      }}
                    />
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--sf-muted)",
                        marginTop: 8,
                      }}
                    >
                      {b.month}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Milestone cards: portfolio, spend, return */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
              gap: 16,
            }}
          >
            {MILESTONES.map((m, i) => {
              const highlight = i === MILESTONES.length - 1;
              return (
                <div
                  key={m.month}
                  style={{
                    background: highlight ? "var(--sf-green)" : "#fff",
                    borderRadius: 16,
                    padding: 24,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: ".07em",
                      color: highlight ? "var(--sf-sage)" : "var(--sf-muted)",
                      marginBottom: 8,
                    }}
                  >
                    {m.month}
                  </div>
                  <div
                    style={display({
                      fontSize: 26,
                      fontWeight: 700,
                      color: highlight ? "#fff" : "var(--sf-dark)",
                      lineHeight: 1,
                      marginBottom: 12,
                    })}
                  >
                    {m.properties} properties
                  </div>
                  <MilestoneRow k="Monthly net" v={m.monthlyNet} highlight={highlight} />
                  <MilestoneRow k="Software spent" v={m.spent} highlight={highlight} />
                  <MilestoneRow k="Net earned to date" v={m.earned} highlight={highlight} />
                  <MilestoneRow
                    k="Return on subscription"
                    v={m.roi}
                    highlight={highlight}
                    bold
                  />
                </div>
              );
            })}
          </div>

          <p
            style={{
              fontSize: 12.5,
              color: "var(--sf-green)",
              opacity: 0.75,
              marginTop: 16,
              lineHeight: 1.6,
              maxWidth: 820,
            }}
          >
            Straight-line model at 10% lead-to-signed conversion (1 property per
            month) and £1,207 average monthly net per property &mdash; the mean of
            the 1&ndash;5 bed figures in the table above, already net of the 15%
            platform fee, guaranteed rent, and operating costs. Net earned to date
            is the running total of monthly net across the portfolio; return on
            subscription compares it to the cumulative £100/month spend. Real close
            timelines vary; treat this as illustrative, not a forecast.
          </p>
        </div>
      </section>

      {/* ============ CHURN / REPLACEMENT ============ */}
      <section style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow>Always growing</Eyebrow>
          <h2 style={centerHeadline({ marginBottom: 16 })}>
            You won&apos;t keep every landlord &mdash; so keep the pipeline full.
          </h2>
          <p style={centerLede()}>
            Guaranteed rent arrangements end. Landlords sell, move back in, or
            decide not to renew. Without new deals coming in, a rent-to-rent
            portfolio quietly shrinks. A steady flow of pre-qualified guaranteed
            rent leads means you can always replace the landlords who leave &mdash;
            and keep growing rather than standing still.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))",
              gap: 18,
            }}
          >
            {[
              {
                title: "Landlords leave",
                body: "Even a well-run book loses properties every year as owners sell, return, or change plans. It is a normal part of rent-to-rent.",
              },
              {
                title: "Leads replace them",
                body: "A consistent inflow of consented, financially modelled landlords means every departure can be backfilled without a cold-outreach scramble.",
              },
              {
                title: "The portfolio keeps growing",
                body: "Replace faster than you lose and the portfolio compounds instead of leaking. Your guaranteed rent income base only moves one way.",
              },
            ].map((c) => (
              <div
                key={c.title}
                style={{
                  background: "#fff",
                  border: "1px solid var(--sf-border)",
                  borderRadius: 16,
                  padding: 26,
                }}
              >
                <h3
                  style={display({
                    fontSize: 17,
                    fontWeight: 700,
                    color: "var(--sf-green)",
                    marginBottom: 8,
                  })}
                >
                  {c.title}
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    color: "var(--sf-secondary)",
                    lineHeight: 1.65,
                  }}
                >
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 6. ANALYSER CTA ============ */}
      <section style={{ background: "var(--sf-green)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", textAlign: "center" }}>
          <h2
            style={display({
              fontSize: "clamp(26px,4vw,38px)",
              fontWeight: 700,
              letterSpacing: "-.02em",
              lineHeight: 1.08,
              color: "#fff",
              marginBottom: 16,
            })}
          >
            Know your numbers before you call.
          </h2>
          <p
            style={{
              fontSize: 16,
              color: "var(--sf-sage)",
              opacity: 0.95,
              lineHeight: 1.7,
              marginBottom: 32,
            }}
          >
            Every lead comes with an address. Before you pick up the phone, run
            it through the Stayful STR Analyser. It pulls live Airbnb data for
            that postcode and tells you in 60 seconds whether the numbers work
            for a guaranteed rent arrangement.
          </p>
          <a
            href="https://intelligence.stayful.co.uk"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              background: "#fff",
              color: "var(--sf-dark)",
              fontSize: 15,
              fontWeight: 700,
              padding: "16px 36px",
              borderRadius: 9,
              textDecoration: "none",
            }}
          >
            Open the analyser →
          </a>
        </div>
      </section>

      {/* ============ INCLUDED — COMPANY LET AGREEMENT ============ */}
      <section style={{ background: "var(--sf-olive)", padding: "88px 32px" }}>
        <div
          style={{
            maxWidth: 1040,
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))",
            gap: 44,
            alignItems: "center",
          }}
        >
          <div>
            <Eyebrow color="var(--sf-dark)">Included with your subscription</Eyebrow>
            <h2
              style={display({
                fontSize: "clamp(24px,3.4vw,34px)",
                fontWeight: 700,
                letterSpacing: "-.02em",
                lineHeight: 1.1,
                color: "var(--sf-green)",
                marginBottom: 16,
              })}
            >
              A free company let tenancy agreement to get landlords signed.
            </h2>
            <p
              style={{
                fontSize: 15.5,
                color: "var(--sf-green)",
                opacity: 0.85,
                lineHeight: 1.7,
                marginBottom: 20,
              }}
            >
              Every subscriber can download a ready-to-use company let tenancy
              agreement — the contract landlords sign to let their property to
              your company on a guaranteed rent basis, so you can place occupiers
              and run it as short-let accommodation. It is waiting in your
              dashboard the moment you subscribe, with a plain-English summary of
              exactly what the landlord and your company are each responsible for.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                "Drafted as a company let — outside assured-tenancy rules",
                "Landlord signs; your company holds the tenancy and places occupiers",
                "Clear landlord and tenant liabilities, explained in the dashboard",
              ].map((t) => (
                <div
                  key={t}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 14,
                    color: "var(--sf-green)",
                    fontWeight: 600,
                  }}
                >
                  <span style={{ color: "var(--sf-dark)" }}>✓</span>
                  {t}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              borderLeft: "3px solid var(--sf-green)",
              padding: 28,
              boxShadow: "0 20px 50px -30px rgba(59,109,17,.55)",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: ".07em",
                color: "var(--sf-muted)",
                marginBottom: 8,
              }}
            >
              Company Letting Agreement
            </div>
            <div
              style={display({
                fontSize: 20,
                fontWeight: 700,
                color: "var(--sf-green)",
                marginBottom: 10,
              })}
            >
              Ready to download, ready to sign
            </div>
            <p
              style={{
                fontSize: 13.5,
                color: "var(--sf-secondary)",
                lineHeight: 1.65,
                marginBottom: 16,
              }}
            >
              For letting a residential property to your company for a fixed
              term. Covers rent, deposit, approved occupiers, repairs, and how
              the tenancy ends — with the landlord&apos;s and your company&apos;s
              obligations set out in full.
            </p>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "var(--sf-sage)",
                color: "var(--sf-dark)",
                fontSize: 12.5,
                fontWeight: 700,
                padding: "8px 14px",
                borderRadius: 100,
              }}
            >
              ✓ Free for every subscriber
            </span>
          </div>
        </div>
      </section>

      {/* ============ 7. PRICING ============ */}
      <section id="pricing" style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", textAlign: "center" }}>
          <Eyebrow>Pricing</Eyebrow>
          <h2
            style={display({
              fontSize: "clamp(26px,4vw,38px)",
              fontWeight: 700,
              letterSpacing: "-.02em",
              lineHeight: 1.08,
              marginBottom: 40,
            })}
          >
            One subscription. Ten leads a month.
          </h2>
          <div
            style={{
              background: "#fff",
              border: "1px solid var(--sf-border)",
              borderRadius: 18,
              padding: 40,
              maxWidth: 480,
              margin: "0 auto",
              textAlign: "left",
              boxShadow: "0 24px 60px -34px rgba(59,109,17,.4)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                marginBottom: 24,
              }}
            >
              <span
                style={display({
                  fontSize: 52,
                  fontWeight: 700,
                  color: "var(--sf-dark)",
                  letterSpacing: "-.03em",
                  lineHeight: 1,
                })}
              >
                £100
              </span>
              <span
                style={{ fontSize: 18, color: "var(--sf-muted)", fontWeight: 500 }}
              >
                /month
              </span>
            </div>
            <ul style={{ listStyle: "none", marginBottom: 28 }}>
              {PRICING_FEATURES.map((f, i, arr) => (
                <li
                  key={f}
                  style={{
                    fontSize: 14,
                    padding: "10px 0",
                    borderBottom:
                      i === arr.length - 1 ? "none" : "1px solid var(--sf-border)",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <span
                    style={{
                      color: "var(--sf-green)",
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    ✓
                  </span>
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/signup?product=guaranteed-rent"
              style={{
                display: "block",
                background: "var(--sf-dark)",
                color: "#fff",
                fontSize: 15,
                fontWeight: 700,
                padding: 16,
                borderRadius: 9,
                textAlign: "center",
                textDecoration: "none",
              }}
            >
              Start receiving leads →
            </Link>
          </div>
        </div>
      </section>

      {/* ============ 8. FOOTER ============ */}
      <footer
        style={{
          background: "#fff",
          borderTop: "1px solid var(--sf-border)",
          padding: "40px 32px",
          textAlign: "center",
        }}
      >
        <img
          src={LOGO}
          alt="Stayful"
          style={{ height: 26, margin: "0 auto 16px", display: "block" }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 24,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <a href="https://www.stayful.co.uk" style={footerLink}>
            stayful.co.uk
          </a>
          <Link href="/login" style={footerLink}>
            Sign in
          </Link>
          <Link href="/feedback?type=feature" style={footerLink}>
            Request a feature
          </Link>
          <Link href="/feedback?type=bug" style={footerLink}>
            Report a bug
          </Link>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--sf-muted)" }}>
          © 2026 Stayful. All rights reserved.
        </p>
      </footer>
    </main>
  );
}

// ── Style helpers & sub-components (mirroring app/page.tsx) ──────────────────

const navLink: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--sf-secondary)",
  textDecoration: "none",
};

const navCta: CSSProperties = {
  background: "var(--sf-dark)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  padding: "10px 18px",
  borderRadius: 8,
  textDecoration: "none",
};

const heroPrimary: CSSProperties = {
  display: "inline-block",
  background: "var(--sf-dark)",
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
  padding: "15px 30px",
  borderRadius: 9,
  textDecoration: "none",
};

const footerLink: CSSProperties = {
  fontSize: 13,
  color: "var(--sf-muted)",
  textDecoration: "none",
};

const stepNum: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  background: "var(--sf-green)",
  color: "#fff",
  fontFamily: "var(--sf-display)",
  fontWeight: 700,
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

function Eyebrow({
  children,
  color = "var(--sf-green)",
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <p
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: ".12em",
        color,
        marginBottom: 12,
        textAlign: "center",
      }}
    >
      {children}
    </p>
  );
}

function centerHeadline(extra?: CSSProperties): CSSProperties {
  return display({
    fontSize: "clamp(26px,4vw,38px)",
    fontWeight: 700,
    letterSpacing: "-.02em",
    lineHeight: 1.08,
    marginBottom: 44,
    maxWidth: 720,
    textAlign: "center",
    marginLeft: "auto",
    marginRight: "auto",
    ...extra,
  });
}

function centerLede(extra?: CSSProperties): CSSProperties {
  return {
    fontSize: 16,
    color: "var(--sf-green)",
    opacity: 0.82,
    lineHeight: 1.7,
    maxWidth: 760,
    marginBottom: 32,
    textAlign: "center",
    marginLeft: "auto",
    marginRight: "auto",
    ...extra,
  };
}

/** Inline hyperlink to the STR Analyser, styled to sit within body copy. */
function AnalyserLink() {
  return (
    <a
      href="https://intelligence.stayful.co.uk"
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: "var(--sf-dark)",
        fontWeight: 600,
        textDecoration: "underline",
      }}
    >
      intelligence.stayful.co.uk
    </a>
  );
}

function MilestoneRow({
  k,
  v,
  highlight,
  bold,
}: {
  k: string;
  v: string;
  highlight?: boolean;
  bold?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "7px 0",
        borderTop: `1px solid ${
          highlight ? "rgba(255,255,255,.18)" : "var(--sf-border)"
        }`,
      }}
    >
      <span
        style={{
          fontSize: 13,
          color: highlight ? "var(--sf-sage)" : "var(--sf-secondary)",
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontSize: bold ? 15 : 13.5,
          fontWeight: 700,
          color: highlight ? "#fff" : "var(--sf-dark)",
        }}
      >
        {v}
      </span>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      style={{
        textAlign: right ? "right" : "left",
        padding: "14px 16px",
        fontSize: 12,
        fontWeight: 700,
        color: "var(--sf-dark)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  bold,
}: {
  children: React.ReactNode;
  right?: boolean;
  bold?: boolean;
}) {
  return (
    <td
      style={{
        textAlign: right ? "right" : "left",
        padding: "13px 16px",
        fontWeight: bold ? 700 : 500,
        color: bold ? "var(--sf-dark)" : "var(--sf-secondary)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
