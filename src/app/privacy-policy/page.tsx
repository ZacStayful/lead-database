import type { CSSProperties } from "react";

// Draft privacy policy — reachable by direct URL only.
//
// This is a first draft, pending solicitor review. It is deliberately NOT
// linked from the nav or footer, and metadata below blocks indexing so it
// stays undiscoverable until Zac confirms it is ready to go live.
//
// Styling mirrors the static-page convention established in
// src/app/guaranteed-rent/page.tsx: inline styles using the --sf-* brand
// tokens, Bricolage headings via var(--sf-display), white cards bordered with
// var(--sf-border) (≈ black/10). No new design tokens introduced.

export const metadata = {
  title: "Privacy Policy — Stayful",
  robots: { index: false, follow: false },
};

const display = (extra?: CSSProperties): CSSProperties => ({
  fontFamily: "var(--sf-display)",
  ...extra,
});

export default function PrivacyPolicyPage() {
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
        {/* ── Draft notice — clearly distinct from the policy content ── */}
        <DraftNotice />

        {/* ── Policy content (white card, black/10 border) ── */}
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
              marginBottom: 8,
            })}
          >
            Stayful Ltd — Privacy Policy
          </h1>
          <p style={{ fontSize: 14, color: "var(--sf-muted)", marginBottom: 8 }}>
            Last updated: [date of publication]
          </p>

          {/* 1 */}
          <Heading n="1">Who we are</Heading>
          <P>
            This service is operated by <strong>Stayful Ltd</strong>, a company
            registered in England and Wales.
          </P>
          <List
            items={[
              <>Company number: 14791583</>,
              <>
                Registered office: 20–22 Wenlock Road, London, England, N1 7GU
              </>,
              <>ICO registration number: ZA00016946040</>,
              <>
                Contact for privacy and data protection matters:
                info@stayful.co.uk
              </>,
            ]}
          />
          <P>
            Stayful Ltd is the data controller for the personal data described
            in this policy.
          </P>

          {/* 2 */}
          <Heading n="2">Who this policy applies to</Heading>
          <P>
            This policy covers two distinct groups, because Stayful processes
            personal data about both:
          </P>
          <List
            items={[
              <>
                <strong>Landlords</strong> who submit a property management
                enquiry through Stayful&apos;s website, some of whom are later
                referred to a subscriber operator via the Lead Marketplace.
              </>,
              <>
                <strong>Subscribers</strong> — short-term rental (STR)
                management operators who hold an account on the Lead Marketplace
                platform to receive and manage those referred leads.
              </>,
            ]}
          />
          <P>
            Where something applies to only one group, this is stated
            explicitly.
          </P>

          {/* 3 */}
          <Heading n="3">The personal data we collect</Heading>
          <SubHeading>
            3.1 If you are a landlord who has submitted an enquiry
          </SubHeading>
          <List
            items={[
              <>Name</>,
              <>Property address</>,
              <>Phone number</>,
              <>Email address</>,
              <>Number of bedrooms</>,
              <>Date of enquiry</>,
              <>
                Estimated monthly income for the property, and other details
                from your enquiry (referred to internally as your &quot;lead
                profile&quot;)
              </>,
            ]}
          />
          <SubHeading>
            3.2 If you are a subscriber using the Lead Marketplace
          </SubHeading>
          <List
            items={[
              <>Business name and contact name</>,
              <>Email address and phone number</>,
              <>
                Billing and payment details (processed by our payment provider,
                Stripe — Stayful does not store your card details directly)
              </>,
              <>
                Account activity: which leads you&apos;ve been assigned, status
                updates you make on those leads, notes you add, and your
                subscription and payment history
              </>,
            ]}
          />

          {/* 4 */}
          <Heading n="4">How we collect your data</Heading>
          <List
            items={[
              <>
                <strong>Landlords:</strong> directly from you, when you complete
                an enquiry form on our website.
              </>,
              <>
                <strong>Subscribers:</strong> directly from you, when you create
                an account, and automatically as you use the platform (e.g.
                updating a lead&apos;s status).
              </>,
              <>
                <strong>Contact-detail verification:</strong> if a subscriber
                reports that a landlord&apos;s phone number or email address
                appears to be incorrect, we run an automated check against that
                phone number and email address using third-party verification
                services (see section 6). This does not involve contacting you —
                it&apos;s a technical check for validity, not a call or email to
                confirm.
              </>,
            ]}
          />

          {/* 5 */}
          <Heading n="5">Why we process your data, and how we use it</Heading>
          <SubHeading>5.1 Landlord data</SubHeading>
          <P>
            We process your enquiry details on the basis of{" "}
            <strong>legitimate interests</strong> — specifically, our legitimate
            interest (and yours) in connecting you with a suitable property
            management option, even where Stayful itself is not the right fit.
          </P>
          <P>
            If, after reviewing your enquiry, we determine we are not able to
            manage your property directly, we will:
          </P>
          <ol style={olStyle}>
            <li style={liStyle}>
              Send you an email explaining that Stayful is not the right fit,
              and that we work with a network of trusted local STR operators who
              may be a better match.
            </li>
            <li style={liStyle}>
              Refer your enquiry details to up to two of those operators, who
              will then contact you directly.
            </li>
          </ol>
          <P>
            We do not sell or share your enquiry to more than two operators, and
            we do not pass your details on for any purpose beyond this referral.
          </P>
          <SubHeading>5.2 Subscriber data</SubHeading>
          <P>We process your account data on the basis of:</P>
          <List
            items={[
              <>
                <strong>Performance of a contract</strong> — to provide the
                subscription service you&apos;ve signed up for (delivering
                leads, processing billing, maintaining your account).
              </>,
              <>
                <strong>Legal obligation</strong> — for tax, accounting, and
                invoicing records.
              </>,
              <>
                <strong>Legitimate interests</strong> — for basic platform
                security and service improvement.
              </>,
            ]}
          />
          <SubHeading>5.3 Contact-detail verification</SubHeading>
          <P>
            If you dispute the validity of a landlord&apos;s phone number or
            email address, we check that specific phone number and email address
            against third-party verification services to confirm whether they
            are genuinely invalid. This is a narrow, automated check limited to
            the disputed contact details — it does not involve broader profiling
            or verification of any other data.
          </P>

          {/* 6 */}
          <Heading n="6">Who we share your data with</Heading>
          <P>
            We use a number of third-party service providers to run the platform
            (&quot;processors&quot; in data protection terms). They only receive
            the data needed to perform their specific function, and are not
            permitted to use it for their own purposes.
          </P>
          <ProvidersTable />
          <P>
            Landlord data referred to subscriber operators is shared with a
            maximum of two subscribers per lead, and only after the referral
            email described in section 5.1 has been sent.
          </P>
          <P>
            We do not sell personal data to third parties for marketing
            purposes.
          </P>

          {/* 7 */}
          <Heading n="7">International data transfers</Heading>
          <P>
            Several of the providers listed in section 6 are based outside the
            UK, or may process data through infrastructure located outside the
            UK. Each relies on a recognised safeguard, per their current
            published terms:
          </P>
          <List
            items={[
              <>
                <strong>Stripe, Twilio, Vercel</strong> — certified under the UK
                Extension to the EU-U.S. Data Privacy Framework, backed by the
                UK International Data Transfer Addendum as a fallback.
              </>,
              <>
                <strong>ZeroBounce</strong> — certified under the EU-U.S. Data
                Privacy Framework, and processes and stores data primarily in
                the EU unless a different region is selected.
              </>,
              <>
                <strong>monday.com</strong> — relies on the UK&apos;s adequacy
                decision for Israel (where monday.com is headquartered), and on
                the UK Extension to the EU-U.S. Data Privacy Framework or the UK
                Addendum for the AWS regions it uses.
              </>,
              <>
                <strong>n8n</strong> — n8n GmbH is based in Germany and n8n Cloud
                is hosted in Frankfurt; no transfer outside the UK/EU arises from
                this provider in normal operation.
              </>,
              <>
                <strong>Resend</strong> — relies on the UK Addendum to the EU
                Standard Contractual Clauses.
              </>,
              <>
                <strong>Supabase</strong> — relies on Standard Contractual
                Clauses and the UK International Data Transfer Addendum; Supabase
                is not currently certified under the Data Privacy Framework.
              </>,
            ]}
          />
          <InternalNote>
            Supabase lets customers choose their project&apos;s hosting region at
            setup, and the default is outside the UK/EU. Confirm which region
            Stayful&apos;s actual project uses, since that determines whether
            this safeguard is even engaged.
          </InternalNote>
          <P>
            This reflects each provider&apos;s own published position as of the
            policy&apos;s drafting date, not a confirmation that Stayful has an
            executed, signed DPA in place with each one — a solicitor should
            verify that before publishing.
          </P>

          {/* 8 */}
          <Heading n="8">How long we keep your data</Heading>
          <P>
            We retain personal data for 90 days from the point it is no longer
            active in our systems, and delete or anonymise it after that.
            Specifically:
          </P>
          <List
            items={[
              <>
                <strong>
                  Landlord enquiry data not referred to a subscriber:
                </strong>{" "}
                deleted or anonymised 90 days after the enquiry is closed as not
                proceeding.
              </>,
              <>
                <strong>Landlord data that was referred to a subscriber:</strong>{" "}
                retained for 90 days after the assignment ends, to allow time for
                any dispute or audit process, then deleted or anonymised.
              </>,
              <>
                <strong>Subscriber account data:</strong> retained for 90 days
                after account closure, then deleted.
              </>,
            ]}
          />
          <P>
            <strong>One exception, not a choice:</strong> financial and invoicing
            records (including Stripe billing history) must be kept for{" "}
            <strong>6 years</strong> under UK tax law (HMRC record-keeping
            requirements), regardless of the 90-day period above. This
            isn&apos;t optional and applies on top of, not instead of, the
            90-day rule for other data.
          </P>

          {/* 9 */}
          <Heading n="9">Cookies and similar technologies</Heading>
          <P>
            This service does not use cookies or similar technologies for
            analytics, advertising, or tracking. Any strictly necessary
            technical mechanism used to keep you signed in is exempt from cookie
            consent requirements under UK PECR and does not require a cookie
            banner.
          </P>

          {/* 10 */}
          <Heading n="10">Your rights</Heading>
          <P>Under UK data protection law, you have the right to:</P>
          <List
            items={[
              <>Access the personal data we hold about you</>,
              <>Ask us to correct inaccurate data</>,
              <>Ask us to delete your data, in certain circumstances</>,
              <>Object to or restrict certain processing</>,
              <>Request a copy of your data in a portable format</>,
              <>
                Complain to the Information Commissioner&apos;s Office (ICO) at
                ico.org.uk if you believe your data has been mishandled
              </>,
            ]}
          />
          <P>
            To exercise any of these rights, contact info@stayful.co.uk.
          </P>

          {/* 11 */}
          <Heading n="11">Keeping your data secure</Heading>
          <P>
            Leads are delivered via an encrypted, real-time connection, and
            access to subscriber accounts and landlord data is restricted to
            what&apos;s needed for the platform to function.
          </P>
          <InternalNote>
            if there are other specific security measures worth naming (e.g.
            encryption at rest, access logging), add them here; a solicitor may
            also want this section expanded.
          </InternalNote>

          {/* 12 */}
          <Heading n="12">Children</Heading>
          <P>
            This service is not directed at, and should not be used by, anyone
            under 18. We do not knowingly collect data from children.
          </P>

          {/* 13 */}
          <Heading n="13">Changes to this policy</Heading>
          <P>
            We may update this policy from time to time. Material changes will be
            reflected with an updated &quot;last updated&quot; date at the top of
            this page.
          </P>

          {/* 14 */}
          <Heading n="14">Contact us</Heading>
          <P>
            For any question about this policy or how your data is handled,
            contact:
          </P>
          <P>
            <strong>Stayful Ltd</strong>
            <br />
            20–22 Wenlock Road, London, England, N1 7GU
            <br />
            info@stayful.co.uk
          </P>
        </div>
      </article>
    </main>
  );
}

// ── Draft banner ────────────────────────────────────────────────────────────
// Amber/warning callout, deliberately styled apart from the policy body so a
// reader cannot mistake it for policy text.
function DraftNotice() {
  return (
    <div
      style={{
        background: "#fef6e7",
        border: "1px solid #e0a93b",
        borderLeft: "4px solid #e0a93b",
        borderRadius: 12,
        padding: "16px 20px",
        marginBottom: 28,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <span aria-hidden style={{ fontSize: 18, lineHeight: 1.3 }}>
        ⚠️
      </span>
      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: ".08em",
            color: "#8a5a00",
            marginBottom: 4,
          }}
        >
          Draft — not published
        </div>
        <p style={{ fontSize: 14, color: "#5a4302", lineHeight: 1.6 }}>
          This is a first draft, pending solicitor review. It has not yet been
          published or linked from the site.
        </p>
      </div>
    </div>
  );
}

// ── Internal note ───────────────────────────────────────────────────────────
// Visually distinct callout for editorial notes that are NOT part of the final
// policy. Clearly separated from surrounding legal text.
function InternalNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#f4f4f5",
        border: "1px dashed #9ca3af",
        borderRadius: 10,
        padding: "14px 18px",
        margin: "18px 0",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          color: "#6b7280",
          marginBottom: 6,
        }}
      >
        Internal note — not part of the final policy
      </div>
      <p style={{ fontSize: 13.5, color: "#4b5563", lineHeight: 1.6 }}>
        {children}
      </p>
    </div>
  );
}

// ── Section 6 providers table ───────────────────────────────────────────────
const PROVIDERS: { provider: string; purpose: string }[] = [
  { provider: "Stripe", purpose: "Payment processing and subscription billing" },
  {
    provider: "Resend",
    purpose:
      "Sending transactional emails (lead assignment notices, the landlord referral email)",
  },
  {
    provider: "Supabase",
    purpose: "Database hosting and real-time lead delivery",
  },
  {
    provider: "Twilio",
    purpose:
      "Verifying whether a disputed phone number is a genuine, active UK mobile number",
  },
  {
    provider: "ZeroBounce",
    purpose:
      "Verifying whether a disputed email address is genuine and deliverable",
  },
  {
    provider: "Monday.com",
    purpose: "Internal lead management prior to a lead entering the marketplace",
  },
  {
    provider: "n8n",
    purpose:
      "Workflow automation moving lead data between our internal systems and the platform",
  },
  { provider: "Vercel", purpose: "Application hosting" },
];

function ProvidersTable() {
  return (
    <div
      style={{
        overflowX: "auto",
        border: "1px solid var(--sf-border)",
        borderRadius: 12,
        margin: "16px 0",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 14,
          minWidth: 480,
        }}
      >
        <thead>
          <tr style={{ background: "var(--sf-green-light, #eaf3de)" }}>
            <th style={thStyle}>Provider</th>
            <th style={thStyle}>Purpose</th>
          </tr>
        </thead>
        <tbody>
          {PROVIDERS.map((row) => (
            <tr
              key={row.provider}
              style={{ borderTop: "1px solid var(--sf-border)" }}
            >
              <td style={{ ...tdStyle, fontWeight: 700, whiteSpace: "nowrap" }}>
                {row.provider}
              </td>
              <td style={tdStyle}>{row.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Prose helpers ───────────────────────────────────────────────────────────
function Heading({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <h2
      style={display({
        fontSize: "clamp(18px, 2.4vw, 22px)",
        fontWeight: 700,
        letterSpacing: "-.01em",
        lineHeight: 1.25,
        marginTop: 34,
        marginBottom: 12,
      })}
    >
      {n}. {children}
    </h2>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={display({
        fontSize: 16,
        fontWeight: 700,
        color: "var(--sf-secondary)",
        marginTop: 20,
        marginBottom: 8,
      })}
    >
      {children}
    </h3>
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

const olStyle: CSSProperties = {
  listStyle: "decimal",
  paddingLeft: 22,
  margin: "0 0 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const liStyle: CSSProperties = { fontSize: 15, lineHeight: 1.65 };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  fontSize: 12,
  fontWeight: 700,
  color: "var(--sf-dark)",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  fontSize: 14,
  color: "var(--sf-secondary)",
  lineHeight: 1.55,
  verticalAlign: "top",
};
