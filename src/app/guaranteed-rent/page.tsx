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

const STEPS: { n: string; title: string; body: string }[] = [
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
    body: "Use intelligence.stayful.co.uk to model gross STR income, guaranteed rent, and operating costs against live Airbnb data for the property's postcode, before you pick up the phone.",
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
            Find landlords open to a guaranteed rent arrangement.
          </h1>
          <p
            style={{
              fontSize: 17,
              fontWeight: 500,
              color: "var(--sf-green)",
              opacity: 0.85,
              maxWidth: 620,
              margin: "0 auto 30px",
              lineHeight: 1.65,
            }}
          >
            Qualified leads from operators who searched for STR management and
            passed our financial model. Every lead has been financially assessed
            against live Airbnb data for their postcode.
          </p>
          <Link href="/signup?product=guaranteed-rent" style={heroPrimary}>
            Start receiving leads →
          </Link>
        </div>
      </section>

      {/* ============ 3. HOW IT WORKS ============ */}
      <section id="how" style={{ padding: "88px 32px" }}>
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
            data. Use intelligence.stayful.co.uk to model your specific property.
          </p>
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
