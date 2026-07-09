import type { CSSProperties } from "react";

// Customer-facing content page describing the reject-reason / contact-detail
// verification flow and how lead data is handled.
//
// Styling mirrors the static-page convention (src/app/privacy-policy/page.tsx,
// src/app/guaranteed-rent/page.tsx): inline styles using the --sf-* brand
// tokens, Bricolage headings via var(--sf-display), white cards bordered with
// var(--sf-border) (≈ black/10). No new design tokens introduced.
//
// Note: "our Privacy Policy" in the second section is intentionally plain text,
// not a link — the Privacy Policy page is unpublished pending review.

export const metadata = {
  title: "If something's not right — Stayful",
  description:
    "How lead rejections, contact-detail checks, and your data are handled on the Stayful Lead Marketplace.",
};

const display = (extra?: CSSProperties): CSSProperties => ({
  fontFamily: "var(--sf-display)",
  ...extra,
});

export default function LeadQualityAndDataPage() {
  return (
    <main
      style={{
        fontFamily: "var(--sf-sans)",
        color: "var(--sf-body)",
        background: "#fff",
        lineHeight: 1.65,
        padding: "48px 24px 80px",
      }}
    >
      <article style={{ maxWidth: 780, margin: "0 auto" }}>
        <div
          style={{
            background: "#fff",
            border: "1px solid var(--sf-border)",
            borderRadius: 16,
            padding: "clamp(24px, 4vw, 44px)",
          }}
        >
          <h1
            style={display({
              fontSize: "clamp(28px, 4vw, 38px)",
              fontWeight: 700,
              letterSpacing: "-.02em",
              lineHeight: 1.1,
              marginBottom: 24,
            })}
          >
            If something&apos;s not right
          </h1>

          {/* ── Section 1 ── */}
          <Heading>If a lead&apos;s contact details are wrong</Heading>
          <P>When you reject a lead, you&apos;re asked why.</P>
          <P>
            If you select <strong>does not fit my needs</strong>, the lead is
            removed from your queue and a replacement is assigned — no further
            steps.
          </P>
          <P>
            If you select <strong>invalid email or mobile</strong>, we check the
            phone number and email address on file immediately — confirming
            whether the number is a genuine, active UK mobile, and whether the
            email address is real and able to receive mail. You get an outcome
            straight away, not after a manual review:
          </P>
          <List
            items={[
              <>
                If either check confirms the details are genuinely wrong, your
                allocation is restored automatically and a replacement is
                assigned.
              </>,
              <>
                If both check out as valid, the lead stays assigned, and
                you&apos;re told plainly that the contact details on file are
                correct.
              </>,
            ]}
          />
          <P>
            This covers the accuracy of the phone number and email address only.
            A lead that simply doesn&apos;t convert isn&apos;t grounds for review
            — lead generation is a volume and consistency game, not a per-lead
            guarantee, and the 5% conversion rate is a long-run average across
            more than 1,100 enquiries.
          </P>

          {/* ── Section 2 ── */}
          <Heading>How your data is handled</Heading>
          <P>
            Leads are delivered to you via an encrypted, real-time connection,
            and every landlord referred to you has already been sent a message
            before assignment explaining that a trusted local operator will be
            in touch — their consent is already in place by the time you receive
            their details.
          </P>
          <P>
            If you dispute a lead&apos;s contact details, we run an automated
            check against that specific phone number and email address using a
            verification service. This is limited to confirming validity — it
            isn&apos;t used for anything else.
          </P>
          <P>
            Leads are never resold beyond a maximum of two operators, and your
            own account data is never sold to third parties. For full legal
            detail, see our Privacy Policy.
          </P>
        </div>
      </article>
    </main>
  );
}

// ── Prose helpers (mirroring the static-page convention) ────────────────────
function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={display({
        fontSize: "clamp(18px, 2.4vw, 22px)",
        fontWeight: 700,
        letterSpacing: "-.01em",
        lineHeight: 1.25,
        marginTop: 32,
        marginBottom: 12,
      })}
    >
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: 15,
        color: "var(--sf-body)",
        lineHeight: 1.7,
        margin: "0 0 14px",
      }}
    >
      {children}
    </p>
  );
}

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul
      style={{
        listStyle: "disc",
        paddingLeft: 22,
        margin: "0 0 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {items.map((item, i) => (
        <li key={i} style={{ fontSize: 15, lineHeight: 1.65 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}
