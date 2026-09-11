import type { CSSProperties } from "react";

// Customer-facing content page describing how a lead can be ended, which of
// those endings returns a credit, and how lead data is handled.
//
// ⚠️ THIS PAGE WAS ALMOST ENTIRELY FICTION UNTIL 0138 (CLAUDE.md §51.11). It
// described a reject-reason popup that ran an automated contact-detail check
// and assigned a REPLACEMENT LEAD. None of it existed: the feature was built on
// a branch that was abandoned in July 2026, leaving three orphaned columns in
// production that 0138 has since dropped. What replaced it is a credit, never a
// replacement — §39.1 and §51.5 both refuse one, and
// `lead_quality_claims.resolution` has no such value.
//
// ⚠️ NOTHING HERE MAY NAME THE CLAIM ALLOWANCE (§51.3). The number of automatic
// upholds a customer gets each cycle is deliberately unpublished: an operator
// told they have two a month has been handed the count of leads it is safe to
// write off without evidence.
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
    "How a lead can be ended, when a credit goes back on your account, and how your data is handled on the Stayful Lead Marketplace.",
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
          <Heading>When a lead doesn&apos;t work out</Heading>
          <P>
            When you end a lead, you&apos;re asked why in a word or two. There
            are four ways to end one, and only one of them puts a credit back.
          </P>
          <List
            items={[
              <>
                <strong>Reject it</strong> — you&apos;re passing on it before
                you&apos;ve built anything on it. It still counts toward your
                leads for the month.
              </>,
              <>
                <strong>Discard it</strong> — available only while you
                haven&apos;t written a note or moved the status. It goes back
                for another operator, and it still counts toward your month.
              </>,
              <>
                <strong>It didn&apos;t work out</strong> — you reached the
                landlord and it&apos;s finished, either because they&apos;ve
                since gone elsewhere or because they were never interested. We
                stop offering that landlord to anyone else.
              </>,
              <>
                <strong>The landlord was already gone</strong> — they had
                already appointed someone, had stopped letting, or the contact
                details don&apos;t reach them at all. This is the one that
                returns a credit.
              </>,
            ]}
          />
          <P>
            The first three don&apos;t return a credit, and that&apos;s
            deliberate — a lead you&apos;ve been given and decided against is
            still a lead we sourced and delivered.
          </P>

          <Heading>If the landlord had already gone</Heading>
          <P>
            This covers a lead that was spent before you got to it: the landlord
            had already appointed another operator, is no longer letting the
            property, or cannot be reached on the details we supplied.
          </P>
          <P>
            You can report it on any lead you&apos;ve actually worked, within
            two weeks of it being assigned to you. We ask for the reason, what
            the landlord said, and when you spoke to them. That last part
            matters more than it looks: it&apos;s what lets us trace the lead
            back to where it came from and stop the same thing happening again.
          </P>
          <P>
            If the report stands up, the credit goes back on your account and
            your next lead comes through in the normal way. It is a credit, not
            a specific replacement lead — we don&apos;t hold one back to swap
            in, and leads are allocated in the order they arrive.
          </P>
          <P>
            Some reports are looked at by a person before the credit is
            returned, particularly where another operator is visibly still
            working the same landlord. Either way the outcome, and the reason
            for it, shows on the lead itself.
          </P>
          <P>
            A lead that simply doesn&apos;t convert isn&apos;t grounds for a
            credit. Lead generation is a volume and consistency game, not a
            per-lead guarantee, and the 5% conversion rate is a long-run average
            across more than 1,100 enquiries.
          </P>

          {/* ── Section 2 ── */}
          <Heading>How your data is handled</Heading>
          <P>
            Leads are delivered to you via an encrypted, real-time connection.
            When a lead is assigned to you, we email the landlord to introduce
            you by name — so by the time you call, they know who you are and
            that you&apos;re expecting to speak to them.
          </P>
          <P>
            A lead is normally shared with up to three operators. One that
            nobody works can be passed on further, to no more than five, and a
            lead left untouched long enough can be opened to other subscribers
            to claim. Your own account data is never sold to third parties. For
            full legal detail, see our Privacy Policy.
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
