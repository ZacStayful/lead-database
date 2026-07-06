"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { BucketChart } from "@/components/landing/BucketChart";
import { RevenueChart } from "@/components/landing/RevenueChart";

// Local copy of the dark-green wordmark (sourced from the Squarespace CDN).
const LOGO = "/logo.png";

const display = (extra?: CSSProperties): CSSProperties => ({
  fontFamily: "var(--sf-display)",
  ...extra,
});

// Reveal-on-scroll wrapper (fallback: forced visible after 1.8s in effect).
function Reveal({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      data-reveal
      style={{
        opacity: 0,
        transform: "translateY(18px)",
        transition: "opacity .7s, transform .7s",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// Count-up number; the effect animates it on view. Renders the final value so
// it is correct even without JS.
function Count({ n }: { n: number }) {
  return (
    <span className="sf-count" data-count={n}>
      {n}
    </span>
  );
}

const FAQ: { q: string; a: string }[] = [
  {
    q: "Can you guarantee 20 leads a month?",
    a: "We only take on customers when we know we can fill the demand. Stayful assesses available lead volume before onboarding anyone new, so what's estimated is what's delivered. In the rare event we fall short in a billing period, the shortfall is credited and those leads are owed to you — you never pay for leads you don't receive.",
  },
  {
    q: "Are these genuinely interested landlords or just anyone who filled in a form?",
    a: "Every lead comes from an organic Google search for STR property management followed by a completed enquiry form. Before reaching subscribers, each lead is run through a financial model comparing projected STR income against their current arrangement using live Airbnb data for their postcode. These are people who went looking for what you do.",
  },
  {
    q: "What happens if I receive a poor-quality lead?",
    a: "Every lead is delivered with the full information received — name, address, phone, email, bedroom count, estimated income, and a written profile. If a lead's contact details are factually incorrect, contact the Stayful team and it will be reviewed. Leads that simply don't convert are not refundable — the 5% conversion rate is a long-run average across thousands of enquiries, not a per-lead guarantee.",
  },
  {
    q: "Can I cancel? Is there a minimum commitment?",
    a: "Cancel anytime from your billing settings. There is no minimum term and no cancellation penalty. If your monthly allocation isn't met in any billing period, the shortfall carries forward to the following month — you always receive the leads you have paid for.",
  },
  {
    q: "How is this different from running my own Google Ads?",
    a: "A Google Ads click on a property management keyword in a competitive UK city costs £8–25 — a click, not a name, phone number, or completed enquiry with property details and estimated income. At £15 per financially modelled, Google-intent enquiry, the cost is for the output of a campaign, not a step within one. And you don't need to build, manage, or optimise a campaign to receive the leads.",
  },
  {
    q: "What if I get a lead I want to pass on immediately?",
    a: "If you haven't updated the lead's status or added any notes, you can discard it and it will be reassigned to another operator. Once you've made any update — a status change or a note — the lead is yours to see through, win or lose. This keeps the system fair: a landlord who has been contacted by one operator won't also hear from a second. Discarded leads still count toward your monthly allocation, since the lead itself was still delivered and qualified — discard reflects lead fit, not lead delivery.",
  },
];

export default function LandingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  useEffect(() => {
    const revealEls = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]")
    );
    const show = (el: HTMLElement) => {
      el.style.opacity = "1";
      el.style.transform = "none";
    };

    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const runCount = (el: HTMLElement) => {
      const target = parseFloat(el.getAttribute("data-count") || "0");
      const dur = 1200;
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / dur);
        el.textContent = Math.round(target * ease(p)).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = target.toLocaleString();
      };
      requestAnimationFrame(tick);
    };
    const countEls = Array.from(
      document.querySelectorAll<HTMLElement>(".sf-count")
    );

    let fallback: ReturnType<typeof setTimeout> | undefined;
    if ("IntersectionObserver" in window) {
      const rio = new IntersectionObserver(
        (entries) =>
          entries.forEach((e) => {
            if (e.isIntersecting) {
              show(e.target as HTMLElement);
              rio.unobserve(e.target);
            }
          }),
        { threshold: 0.15 }
      );
      revealEls.forEach((el) => rio.observe(el));
      fallback = setTimeout(() => revealEls.forEach(show), 1800);

      const cio = new IntersectionObserver(
        (entries) =>
          entries.forEach((e) => {
            if (e.isIntersecting) {
              runCount(e.target as HTMLElement);
              cio.unobserve(e.target);
            }
          }),
        { threshold: 0.6 }
      );
      countEls.forEach((el) => cio.observe(el));

      return () => {
        rio.disconnect();
        cio.disconnect();
        if (fallback) clearTimeout(fallback);
      };
    } else {
      revealEls.forEach(show);
    }
  }, []);

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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
            Lead Database
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <a href="#how" style={navLink}>
            How it works
          </a>
          <a href="#pipeline" style={navLink}>
            Pipeline
          </a>
          <a href="#data" style={navLink}>
            The data
          </a>
          <a href="#pricing" style={navLink}>
            Pricing
          </a>
          <Link
            href="/enquiry"
            style={{
              color: "var(--sf-green)",
              fontSize: 13,
              fontWeight: 600,
              padding: "9px 16px",
              borderRadius: 8,
              border: "1px solid var(--sf-green)",
              textDecoration: "none",
            }}
          >
            Book a call
          </Link>
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
          <Link
            href="/enquiry"
            style={{
              background: "var(--sf-dark)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              padding: "10px 18px",
              borderRadius: 8,
              textDecoration: "none",
            }}
          >
            Claim your place
          </Link>
        </div>
      </nav>

      {/* ============ HERO ============ */}
      <section style={{ background: "var(--sf-sage)", padding: "64px 32px 72px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto", textAlign: "center" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(93,129,86,.16)",
              border: "1px solid rgba(93,129,86,.32)",
              borderRadius: 100,
              padding: "6px 16px",
              fontSize: 11,
              fontWeight: 700,
              color: "var(--sf-dark)",
              letterSpacing: ".06em",
              textTransform: "uppercase",
              marginBottom: 22,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--sf-dark)",
                animation: "sfpulse 1.8s infinite",
              }}
            />
            For STR operators · founding places limited
          </div>
          <h1
            style={display({
              fontSize: "clamp(32px,4.6vw,50px)",
              fontWeight: 700,
              lineHeight: 1.04,
              letterSpacing: "-.03em",
              color: "var(--sf-green)",
              marginBottom: 20,
            })}
          >
            You manage the property. We bring you the landlords.
          </h1>
          <p
            style={{
              fontSize: 17,
              fontWeight: 500,
              color: "var(--sf-green)",
              opacity: 0.85,
              maxWidth: 600,
              margin: "0 auto 28px",
              lineHeight: 1.65,
            }}
          >
            You&apos;re brilliant at running properties — winning them is a
            different job. Stayful generates the enquiries and hands you a
            steady flow of <Count n={20} /> financially modelled, consented
            landlord leads a month, for a fixed price. No campaigns, no
            marketing team. We handle how the leads get found; you close them.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginBottom: 14,
              justifyContent: "center",
            }}
          >
            <Link href="/enquiry" style={heroPrimary}>
              Claim your founding membership
            </Link>
            <a href="#how" style={heroSecondary}>
              See how it works →
            </a>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--sf-green)", opacity: 0.7 }}>
            From £150/month · 10 or 20 leads · cancel anytime · allocation
            carries forward
          </p>
        </div>
      </section>

      {/* ============ PAIN ============ */}
      <section style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-green)">
            The problem this solves
          </Eyebrow>
          <h2 style={centerHeadline()}>
            Growing a portfolio is a different problem to running one.
          </h2>
          <div style={cardGrid(260)}>
            {[
              {
                title: "Unpredictable growth",
                body: "Referrals arrive when they arrive. Ads are expensive and competitive on every keyword. Most months, you don't know how many new landlord conversations are coming.",
              },
              {
                title: "The leaking bucket",
                body: "Every portfolio loses clients — landlords sell, switch, or move back in. Without a steady inflow, a portfolio doesn't stay flat. It quietly shrinks year on year.",
              },
              {
                title: "A different skill set",
                body: "Paid search, SEO, and nurture sequences are a full-time specialism. You're an expert at managing properties. Acquiring them at volume is a different job entirely.",
              },
            ].map((c) => (
              <Reveal
                key={c.title}
                style={{
                  background: "#fff",
                  border: "1px solid var(--sf-border)",
                  borderRadius: 16,
                  padding: 26,
                }}
              >
                <h3 style={display({ fontSize: 17, fontWeight: 700, marginBottom: 8 })}>
                  {c.title}
                </h3>
                <p style={{ fontSize: 14, color: "var(--sf-secondary)", lineHeight: 1.65 }}>
                  {c.body}
                </p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ MECHANISM ============ */}
      <section style={{ background: "var(--sf-sage)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-dark)">
            A different model
          </Eyebrow>
          <h2 style={centerHeadline({ color: "var(--sf-green)", maxWidth: 760 })}>
            Stayful generates the enquiry. You buy the conversation.
          </h2>
          <p style={centerLede()}>
            Getting found by landlords searching for STR management is a
            specialism of its own — and it&apos;s the part most operators
            don&apos;t have time to run. Stayful does that work and hands the
            enquiries it generates to STR operators in a steady flow, at a
            fixed and predictable cost.
          </p>

          <div style={cardGrid(280)}>
            {[
              {
                n: "01",
                title: "The lead",
                body: "A landlord searches Google for STR management and submits an enquiry. Not cold — they've decided to explore. They just haven't found their operator.",
              },
              {
                n: "02",
                title: "The filter",
                body: "A full financial model runs first — projected net STR income vs. their current income, using live Airbnb data for their postcode. Every lead is modelled before it reaches you.",
              },
            ].map((s) => (
              <div
                key={s.n}
                style={{ background: "#fff", borderRadius: 16, padding: 24 }}
              >
                <StepHead n={s.n} title={s.title} />
                <p style={{ fontSize: 13.5, color: "var(--sf-secondary)", lineHeight: 1.6 }}>
                  {s.body}
                </p>
              </div>
            ))}
            <div style={{ background: "var(--sf-green)", borderRadius: 16, padding: 24 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 14,
                }}
              >
                <span style={stepNum("#fff", "var(--sf-green)")}>03</span>
                <h3 style={display({ fontSize: 16, fontWeight: 700, color: "#fff" })}>
                  The warm hand-off
                </h3>
              </div>
              <span
                style={{
                  display: "inline-block",
                  background: "rgba(255,255,255,.16)",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  padding: "3px 9px",
                  borderRadius: 100,
                  marginBottom: 10,
                }}
              >
                Your key differentiator
              </span>
              <p style={{ fontSize: 13.5, color: "#fff", opacity: 0.92, lineHeight: 1.6 }}>
                Before any assignment fires, the landlord gets a Stayful email
                introducing you. They've consented. They're expecting your call.
                This is a structured introduction — not cold outreach.
              </p>
            </div>
          </div>

          {/* email mock */}
          <Reveal
            style={{
              background: "#fff",
              borderRadius: 16,
              overflow: "hidden",
              maxWidth: 600,
              boxShadow: "0 20px 50px -28px rgba(59,109,17,.5)",
              marginTop: 16,
            }}
          >
            <div
              style={{
                background: "var(--sf-dark)",
                padding: "14px 20px",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: "rgba(255,255,255,.35)",
                  }}
                />
              ))}
              <span style={{ marginLeft: 8, fontSize: 12, color: "#fff", fontWeight: 600 }}>
                New message — from Stayful
              </span>
            </div>
            <div style={{ padding: "22px 24px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 16,
                  paddingBottom: 16,
                  borderBottom: "1px solid var(--sf-border)",
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "var(--sf-sage)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--sf-display)",
                    fontWeight: 700,
                    color: "var(--sf-dark)",
                  }}
                >
                  S
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Stayful</div>
                  <div style={{ fontSize: 12, color: "var(--sf-muted)" }}>
                    to Sarah Mitchell · 2 min ago
                  </div>
                </div>
              </div>
              <div style={display({ fontSize: 17, fontWeight: 700, marginBottom: 12 })}>
                We&apos;ve arranged for a local STR operator to be in touch
              </div>
              <p
                style={{
                  fontSize: 14,
                  color: "var(--sf-secondary)",
                  lineHeight: 1.7,
                  marginBottom: 16,
                }}
              >
                Hi Sarah — thanks for your enquiry. We aren&apos;t able to take on
                your Darlington property directly right now, but we&apos;ve
                arranged for a{" "}
                <strong style={{ color: "var(--sf-green)" }}>
                  trusted local STR operator
                </strong>{" "}
                to contact you shortly about managing it. They already have the
                details you shared. Expect a call in the next day or two.
              </p>
              <div
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
                ✓ Landlord consented &amp; expecting your call
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section id="how" style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-green)">
            What happens after you subscribe
          </Eyebrow>
          <h2 style={centerHeadline({ marginBottom: 48, maxWidth: 700 })}>
            From signup to first conversation.
          </h2>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <Timeline n={1} title="You subscribe via Stripe">
              <p style={timelineBody}>
                Your dashboard is live immediately — allocation, billing dates,
                and a pacing indicator showing how many leads you should have
                received by today.
              </p>
              <div
                style={{
                  background: "#fff",
                  border: "1px solid var(--sf-border)",
                  borderRadius: 12,
                  padding: 16,
                  maxWidth: 360,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    fontWeight: 600,
                    marginBottom: 8,
                  }}
                >
                  <span style={{ color: "var(--sf-muted)" }}>Monthly pacing</span>
                  <span style={{ color: "var(--sf-dark)" }}>7 / 20 leads</span>
                </div>
                <div
                  style={{
                    height: 8,
                    background: "var(--sf-olive)",
                    borderRadius: 100,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: "35%",
                      height: "100%",
                      background: "var(--sf-green)",
                      borderRadius: 100,
                    }}
                  />
                </div>
              </div>
            </Timeline>

            <Timeline n={2} title="An enquiry is financially modelled">
              <p style={{ ...timelineBody, marginBottom: 0 }}>
                Each new landlord enquiry is run through the model — projected net
                STR income vs. current income. If the numbers make a case for STR,
                the lead enters the assignment queue.
              </p>
            </Timeline>

            <Timeline n={3} title="You receive it in real time">
              <p style={timelineBody}>
                The moment a lead is assigned, your dashboard notifies you and an
                email lands with full details. Delivery is within minutes of
                assignment — never batched or delayed.
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  background: "#fff",
                  border: "1px solid var(--sf-border)",
                  borderLeft: "3px solid var(--sf-green)",
                  borderRadius: 10,
                  padding: "12px 16px",
                  maxWidth: 360,
                  animation: "sffloat 3s ease-in-out infinite",
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "var(--sf-sage)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
                  }}
                >
                  🔔
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>New lead assigned</div>
                  <div style={{ fontSize: 12, color: "var(--sf-muted)" }}>
                    Sarah M. · Darlington · just now
                  </div>
                </div>
              </div>
            </Timeline>

            <Timeline n={4} title="Everything you need before you dial">
              <p style={timelineBody}>
                Name, address, direct phone, email, bedroom count, estimated
                monthly STR income, and a written profile of their situation,
                current arrangement, and motivations.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {[
                  "Name & address",
                  "Direct phone",
                  "Email",
                  "Est. STR income",
                  "Lead profile",
                ].map((t) => (
                  <span key={t} style={oliveChip}>
                    {t}
                  </span>
                ))}
              </div>
            </Timeline>

            <Timeline n={5} title="You call. They're expecting it.">
              <p style={{ ...timelineBody, marginBottom: 0 }}>
                The landlord has been told a trusted local operator will be in
                touch. The profile gives you a relevant opening — their income,
                their mortgage, what they asked about. Not a stranger.
              </p>
            </Timeline>

            <Timeline n={6} title="Track progress, reset monthly" last>
              <p style={timelineBody}>
                Mark each lead as you go. On your billing date, your count resets
                and the next 20 begin arriving throughout the month. Shortfalls
                carry forward automatically.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                <span style={statusChip()}>Contacted</span>
                <span style={statusChip()}>In discussion</span>
                <span style={statusChip(true)}>Won</span>
                <span style={statusChip(false, "var(--sf-muted)")}>Not relevant</span>
              </div>
            </Timeline>
          </div>
        </div>
      </section>

      {/* ============ SAMPLE LEAD ============ */}
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
            <Eyebrow center color="var(--sf-dark)">
              What a lead looks like
            </Eyebrow>
            <h2
              style={display({
                fontSize: "clamp(24px,3.4vw,34px)",
                fontWeight: 700,
                letterSpacing: "-.02em",
                lineHeight: 1.1,
                color: "var(--sf-green)",
                marginBottom: 16,
                textAlign: "center",
              })}
            >
              Full contact details, property profile, financial context.
            </h2>
            <p
              style={{
                fontSize: 15.5,
                color: "var(--sf-green)",
                opacity: 0.82,
                lineHeight: 1.7,
                marginBottom: 20,
                textAlign: "center",
              }}
            >
              Delivered to your dashboard and by email within minutes of
              assignment. Phone and email are visible immediately on subscription.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                "Every field visible — nothing paywalled per-lead",
                "A written profile, not just a row in a spreadsheet",
                "Estimated monthly STR income modelled up front",
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
              overflow: "hidden",
              borderLeft: "3px solid var(--sf-green)",
              boxShadow: "0 20px 50px -30px rgba(59,109,17,.55)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "15px 22px",
                borderBottom: "1px solid var(--sf-border)",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 700 }}>New lead assigned</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span
                  style={{
                    background: "var(--sf-sage)",
                    color: "var(--sf-dark)",
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "4px 10px",
                    borderRadius: 100,
                  }}
                >
                  New
                </span>
                <span style={{ fontSize: 12, color: "var(--sf-muted)" }}>3 Jul 2026</span>
              </div>
            </div>
            <div style={{ padding: 22 }}>
              <div style={display({ fontSize: 20, fontWeight: 700, marginBottom: 3 })}>
                Sarah Mitchell
              </div>
              <div style={{ fontSize: 14, color: "var(--sf-secondary)", marginBottom: 14 }}>
                3-bed terraced · Darlington, County Durham
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <span style={sageChip}>3 bedrooms</span>
                <span style={sageChip}>Est. £1,890/mo</span>
              </div>
              <LeadRow label="Phone">
                07███ ██████{" "}
                <span style={unlockedPill}>Unlocked on subscription</span>
              </LeadRow>
              <LeadRow label="Email">
                s.mitchell@███████.com{" "}
                <span style={unlockedPill}>Unlocked on subscription</span>
              </LeadRow>
              <LeadRow label="Estimated monthly STR income">£1,890/month</LeadRow>
              <div style={{ padding: "12px 0 0" }}>
                <div style={leadLabel}>Lead profile</div>
                <div
                  style={{
                    fontSize: 13.5,
                    color: "var(--sf-secondary)",
                    lineHeight: 1.65,
                    padding: 12,
                    background: "#fafafa",
                    borderRadius: 8,
                    border: "1px solid var(--sf-border)",
                  }}
                >
                  Currently renting long-term at £750/month, mortgage £420/month.
                  Enquired about holiday letting before but didn&apos;t proceed.
                  Interested in STR but wants reassurance on void periods and
                  management reliability. Two Airbnb stays as a guest.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ PIPELINE TRACKING ============ */}
      <section id="pipeline" style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-green)">
            Track every lead
          </Eyebrow>
          <h2 style={centerHeadline({ marginBottom: 20, maxWidth: 760 })}>
            A mini CRM for your pipeline — track every lead from first contact
            to a signed management agreement.
          </h2>
          <p
            style={{
              textAlign: "center",
              maxWidth: 680,
              margin: "0 auto 40px",
              color: "var(--sf-muted)",
              fontSize: 16,
            }}
          >
            Every lead gets its own pipeline. Move it through the stages as you
            work it, set a date for when it is due to be called, and let the
            priority list order who to call next. Store your STR Analyser
            reports and income figures against each lead, keep timestamped
            notes, and watch your whole funnel — with your conversion rate at
            every stage — on one dashboard you can export to PDF.
          </p>
          {/* Visual pipeline flow */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              alignItems: "center",
              marginBottom: 14,
            }}
          >
            {[
              { label: "Cold", bg: "#dbeafe", fg: "#1d4ed8" },
              { label: "Interested", bg: "#dcfce7", fg: "#15803d" },
              { label: "Web meeting booked", bg: "#fef3c7", fg: "#92400e" },
              { label: "Web meeting attended", bg: "#fee2e2", fg: "#b91c1c" },
            ].flatMap((s, i, arr) => {
              const chip = (
                <span
                  key={s.label}
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 100,
                    padding: "8px 16px",
                    background: s.bg,
                    color: s.fg,
                  }}
                >
                  {s.label}
                </span>
              );
              return i < arr.length - 1
                ? [
                    chip,
                    <span key={s.label + "-a"} style={{ color: "var(--sf-muted)" }}>
                      →
                    </span>,
                  ]
                : [chip];
            })}
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              alignItems: "center",
              marginBottom: 48,
              fontSize: 13,
              color: "var(--sf-muted)",
            }}
          >
            <span>Off-track at any time:</span>
            <span
              style={{
                fontWeight: 600,
                borderRadius: 100,
                padding: "6px 14px",
                background: "#1e3a8a",
                color: "#fff",
              }}
            >
              Booked — did not attend
            </span>
            <span
              style={{
                fontWeight: 600,
                borderRadius: 100,
                padding: "6px 14px",
                background: "#4b5563",
                color: "#fff",
              }}
            >
              Abandoned
            </span>
          </div>

          {/* Feature cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap: 16,
            }}
          >
            {[
              {
                t: "Your own pipeline",
                d: "Move each lead through its stages, set a due-to-call date, and the priority list surfaces who is due next.",
              },
              {
                t: "Funnel analytics",
                d: "See how many leads sit at each status and stage — in numbers and percentages — with your conversion rate through the funnel, exportable to PDF.",
              },
              {
                t: "Everything on the lead",
                d: "Attach your STR Analyser PDF and income figures, and keep timestamped notes, so the full picture is there when you call.",
              },
            ].map((f) => (
              <div
                key={f.t}
                style={{
                  background: "#fff",
                  border: "1px solid var(--sf-border)",
                  borderRadius: 12,
                  padding: 20,
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--sf-dark)",
                    marginBottom: 6,
                  }}
                >
                  {f.t}
                </div>
                <p style={{ fontSize: 14, color: "var(--sf-muted)", margin: 0 }}>
                  {f.d}
                </p>
              </div>
            ))}
          </div>

          {/* Analytics dashboard preview */}
          <div
            style={{
              background: "#fff",
              border: "1px solid var(--sf-border)",
              borderRadius: 12,
              padding: 24,
              maxWidth: 600,
              margin: "32px auto 0",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <span
                style={{ fontSize: 14, fontWeight: 700, color: "var(--sf-dark)" }}
              >
                Your lead funnel
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--sf-green)",
                  background: "rgba(93,129,86,.12)",
                  borderRadius: 100,
                  padding: "4px 12px",
                }}
              >
                Live in your dashboard
              </span>
            </div>
            {[
              { label: "New", pct: 100, n: 12 },
              { label: "Contacted", pct: 58, n: 7 },
              { label: "In discussion", pct: 33, n: 4 },
              { label: "Won", pct: 8, n: 1 },
            ].map((row) => (
              <div key={row.label} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "var(--sf-muted)",
                    marginBottom: 4,
                  }}
                >
                  <span>{row.label}</span>
                  <span>
                    {row.n} · {row.pct}%
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    background: "var(--sf-sage)",
                    borderRadius: 100,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: 8,
                      width: `${row.pct}%`,
                      background: "var(--sf-green)",
                      borderRadius: 100,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ DATA / ROI ============ */}
      <section id="data" style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-green)">
            The numbers behind the model
          </Eyebrow>
          <h2 style={centerHeadline({ maxWidth: 640 })}>
            Three years of data. Real portfolio performance.
          </h2>
          <p style={centerLede({ color: "var(--sf-secondary)" })}>
            Not projections. Derived from the qualification model powering this
            marketplace, validated across thousands of Google-sourced enquiries
            and live portfolio data from UK operators at 12–15% fees.
          </p>

          <div style={{ ...cardGrid(260), marginBottom: 44 }}>
            <div style={statCard}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <span
                  style={display({
                    fontSize: 44,
                    fontWeight: 700,
                    color: "var(--sf-dark)",
                    letterSpacing: "-.03em",
                    lineHeight: 1,
                  })}
                >
                  1 in 20
                </span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--sf-green)",
                    background: "var(--sf-sage)",
                    padding: "4px 11px",
                    borderRadius: 100,
                  }}
                >
                  = 5% avg
                </span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                Enquiries convert to a managed client
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--sf-secondary)",
                  lineHeight: 1.55,
                  marginBottom: 16,
                }}
              >
                A 5% average conversion rate, measured across three years of lead
                data and thousands of enquiries.
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                {[
                  { y: "2023", v: "5.3%", h: 46, dark: false },
                  { y: "2024", v: "5.7%", h: 50, dark: false },
                  { y: "2025", v: "4.7%", h: 41, dark: false },
                  { y: "Avg", v: "5.0%", h: 44, dark: true },
                ].map((b) => (
                  <div key={b.y} style={{ flex: 1, textAlign: "center" }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--sf-dark)",
                        marginBottom: 4,
                      }}
                    >
                      {b.v}
                    </div>
                    <div
                      style={{
                        height: 52,
                        display: "flex",
                        alignItems: "flex-end",
                        justifyContent: "center",
                      }}
                    >
                      <div
                        style={{
                          width: "100%",
                          maxWidth: 30,
                          height: b.h,
                          background: b.dark ? "var(--sf-dark)" : "var(--sf-green)",
                          borderRadius: "4px 4px 0 0",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--sf-muted)",
                        fontWeight: 600,
                        marginTop: 5,
                      }}
                    >
                      {b.y}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={statCard}>
              <div
                style={display({
                  fontSize: 44,
                  fontWeight: 700,
                  color: "var(--sf-dark)",
                  letterSpacing: "-.03em",
                  lineHeight: 1,
                  marginBottom: 8,
                })}
              >
                £<Count n={289} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                Avg monthly revenue per property
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--sf-secondary)",
                  lineHeight: 1.55,
                  marginBottom: 16,
                }}
              >
                Live UK portfolio data at 12–15% fees. June 2026 actuals.
              </div>
              <StatRow k="Management fee (13%)" v="£247/mo" />
              <StatRow k="Software recharge" v="£42/mo" />
              <StatRow k="Total per property" v="£289/mo" bold />
            </div>

            <div style={statCard}>
              <div
                style={display({
                  fontSize: 44,
                  fontWeight: 700,
                  color: "var(--sf-dark)",
                  letterSpacing: "-.03em",
                  lineHeight: 1,
                  marginBottom: 8,
                })}
              >
                <Count n={31} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                Days payback on one acquisition
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--sf-secondary)",
                  lineHeight: 1.55,
                  marginBottom: 16,
                }}
              >
                One converted property recovers the full £300 subscription within
                its first month.
              </div>
              <StatRow k="Year 1 net return" v="£3,168" />
              <StatRow k="Year 2 net return" v="£3,468" bold />
              <StatRow k="Year 2 ROI" v="10×" bold />
            </div>
          </div>

          {/* payback flow */}
          <h3
            style={display({
              fontSize: 20,
              fontWeight: 700,
              marginBottom: 20,
              textAlign: "center",
            })}
          >
            One conversion pays for itself in 31 days.
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
              gap: 14,
              marginBottom: 20,
            }}
          >
            <FlowCard big="£300" small="per month" sub="20 leads included" />
            <FlowCard big="1" small="property / 20 leads" sub="5% conversion rate" />
            <FlowCard big="£289" small="recurring / month" sub="per managed property" />
            <FlowCard
              big="31"
              small="days payback"
              sub="then compounds indefinitely"
              green
            />
          </div>

          {/* ads comparison */}
          <div style={{ background: "var(--sf-sage)", borderRadius: 16, padding: 28 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "var(--sf-dark)",
                marginBottom: 6,
              }}
            >
              What you pay for, vs. what running ads buys
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--sf-green)",
                opacity: 0.82,
                lineHeight: 1.55,
                marginBottom: 20,
                maxWidth: 660,
              }}
            >
              Paid ads aren&apos;t just costly — they&apos;re a specialism. All of
              that campaign work is stripped away and replaced with one simple
              monthly price per lead.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <AdBar
                label="Google Ads — one click on a management keyword"
                price="£8–25"
                pct="64%"
                note="A click — not a name, a number, or a completed enquiry. And the campaign is technical to build, measure, and optimise."
              />
              <AdBar
                label="Facebook Ads — one lead"
                price="£10–25"
                pct="78%"
                note="Even harder — constant testing of creatives, angles, hooks, and CTAs just to keep cost per lead down."
              />
              <AdBar
                label="Stayful — one financially modelled, consented enquiry"
                price="£15 flat"
                pct="44%"
                note="No campaigns, no creative testing — a simple monthly price per lead. The output of a campaign with none of the work."
                green
              />
            </div>
          </div>
        </div>
      </section>

      {/* ============ LEAKING BUCKET CHART ============ */}
      <section style={{ background: "var(--sf-sage)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-dark)">
            Solving the leaking bucket
          </Eyebrow>
          <h2 style={centerHeadline({ color: "var(--sf-green)", maxWidth: 680 })}>
            A 25-property portfolio, over 24 months.
          </h2>
          <p style={centerLede({ maxWidth: 640, marginBottom: 36 })}>
            Same starting point, same 10–12% annual churn. The only difference is
            a steady supply of new leads.
          </p>
          <div style={{ background: "#fff", borderRadius: 16, padding: "26px 24px 20px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginBottom: 14 }}>
              <LegendItem color="var(--sf-green)" label="With the marketplace" value="→ 30 properties" valueColor="var(--sf-dark)" />
              <LegendItem color="var(--sf-muted)" label="Without" value="→ 21 properties" valueColor="#b45309" />
            </div>
            <div style={{ position: "relative", height: 300 }}>
              <BucketChart />
            </div>
          </div>
          <p
            style={{
              fontSize: 12,
              color: "var(--sf-green)",
              opacity: 0.72,
              marginTop: 16,
              lineHeight: 1.6,
              maxWidth: 760,
            }}
          >
            Conservative model: 20 leads/month at 5% conversion = ~12 potential
            properties per year, shown at 25–50% of that rate to reflect realistic
            4–12 week close timelines.
          </p>
        </div>
      </section>

      {/* ============ COMPOUNDING CHART ============ */}
      <section style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-green)">
            What consistency builds
          </Eyebrow>
          <h2 style={centerHeadline({ maxWidth: 680 })}>
            Recurring revenue added, month by month.
          </h2>
          <p style={centerLede({ color: "var(--sf-secondary)", maxWidth: 660, marginBottom: 32 })}>
            At roughly one new property every two months from month three —
            conservative for 4–12 week close timelines.
          </p>
          <div
            style={{
              background: "#fff",
              border: "1px solid var(--sf-border)",
              borderRadius: 16,
              padding: "26px 24px 18px",
              marginBottom: 24,
            }}
          >
            <div style={{ position: "relative", height: 270 }}>
              <RevenueChart />
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
              gap: 16,
            }}
          >
            <MilestoneCard month="Month 6" big="3 new properties" mrr="£867/mo recurring" sub="Subscription paid 3×" />
            <MilestoneCard month="Month 12" big="5 new properties" mrr="£1,445/mo recurring" sub="Subscription paid 5×" />
            <MilestoneCard month="Month 24" big="11 new properties" mrr="£3,179/mo recurring" sub="Subscription paid 10×" green />
          </div>
        </div>
      </section>

      {/* ============ FOUNDING MEMBER ============ */}
      <section id="founding" style={{ background: "var(--sf-green)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <div style={{ textAlign: "center" }}>
            <span
              style={{
                display: "inline-block",
                background: "rgba(185,213,198,.18)",
                border: "1px solid rgba(185,213,198,.32)",
                borderRadius: 100,
                padding: "6px 16px",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--sf-sage)",
                letterSpacing: ".07em",
                textTransform: "uppercase",
                marginBottom: 18,
              }}
            >
              Founding member access
            </span>
            <h2
              style={display({
                fontSize: "clamp(26px,4vw,38px)",
                fontWeight: 700,
                letterSpacing: "-.02em",
                lineHeight: 1.08,
                color: "#fff",
                marginBottom: 14,
                maxWidth: 620,
                marginLeft: "auto",
                marginRight: "auto",
              })}
            >
              Lock your rate. Join before this fills.
            </h2>
            <p
              style={{
                fontSize: 16,
                color: "var(--sf-sage)",
                opacity: 0.9,
                lineHeight: 1.65,
                maxWidth: 600,
                margin: "0 auto 40px",
              }}
            >
              The first cohort receives founding member pricing — the rate you
              join at is guaranteed for as long as you stay subscribed. When
              founding membership closes, standard pricing applies.
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
              gap: 14,
              marginBottom: 40,
            }}
          >
            <FoundingCard
              title="Founding rate guaranteed"
              body="Your £300/month is locked regardless of future pricing, for as long as you stay subscribed."
            />
            <FoundingCard
              title="Priority pacing position"
              body="Prioritised in the lead queue throughout your subscription — ahead of all future standard subscribers."
            />
            <FoundingCard
              title="Shape the product"
              body="Founding members influence which cities, lead types, and features are prioritised next."
            />
          </div>

          <div style={{ textAlign: "center" }}>
            <Link
              href="/enquiry"
              style={{
                display: "inline-block",
                background: "#fff",
                color: "var(--sf-dark)",
                fontSize: 15,
                fontWeight: 700,
                padding: "16px 36px",
                borderRadius: 9,
                textDecoration: "none",
                marginBottom: 20,
              }}
            >
              Claim your founding membership
            </Link>
          </div>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", justifyContent: "center" }}>
            {[
              "Cancel anytime — no lock-in",
              "Allocation carries forward",
              "Leads distributed through the month",
            ].map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 12.5,
                  color: "#fff",
                  opacity: 0.85,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                ✓ {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============ PRICING ============ */}
      <section id="pricing" style={{ padding: "88px 32px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", textAlign: "center" }}>
          <Eyebrow center color="var(--sf-green)">
            Pricing
          </Eyebrow>
          <h2
            style={display({
              fontSize: "clamp(26px,4vw,38px)",
              fontWeight: 700,
              letterSpacing: "-.02em",
              lineHeight: 1.08,
              marginBottom: 10,
            })}
          >
            Two plans. Fixed cost. No hidden fees.
          </h2>
          <p style={{ fontSize: 15, color: "var(--sf-secondary)", marginBottom: 40 }}>
            A steady flow of landlord leads for a fixed monthly price — you
            manage, we handle the lead generation. Everything included: full
            contact details, real-time delivery, tracking dashboard. Pick the
            volume that fits.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 24,
              justifyContent: "center",
              alignItems: "stretch",
            }}
          >
            {[
              {
                plan: "lead_10",
                price: "£150",
                leads: 10,
                highlight: false,
              },
              {
                plan: "lead_20",
                price: "£300",
                leads: 20,
                highlight: true,
              },
            ].map((tier) => (
              <div
                key={tier.plan}
                style={{
                  background: "#fff",
                  border: tier.highlight
                    ? "2px solid var(--sf-green)"
                    : "1px solid var(--sf-border)",
                  borderRadius: 18,
                  padding: 36,
                  width: 380,
                  maxWidth: "100%",
                  textAlign: "left",
                  boxShadow: tier.highlight
                    ? "0 24px 60px -34px rgba(59,109,17,.4)"
                    : "0 16px 40px -34px rgba(59,109,17,.3)",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                  <span
                    style={display({
                      fontSize: 48,
                      fontWeight: 700,
                      color: "var(--sf-dark)",
                      letterSpacing: "-.03em",
                      lineHeight: 1,
                    })}
                  >
                    {tier.price}
                  </span>
                  <span style={{ fontSize: 18, color: "var(--sf-muted)", fontWeight: 500 }}>
                    /month
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--sf-muted)", marginBottom: 24 }}>
                  {tier.leads} leads / month · + VAT
                </div>
                <ul style={{ listStyle: "none", marginBottom: 28 }}>
                  {[
                    `${tier.leads} financially modelled leads per month`,
                    "Full contact details: name, address, phone, email, profile",
                    "Estimated monthly STR income per lead",
                    "Real-time in-portal and email notification",
                    "Leads carry forward if allocation isn't met",
                    "Cancel anytime — no lock-in, no penalty",
                  ].map((f, i, arr) => (
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
                      <span style={{ color: "var(--sf-green)", fontWeight: 700, flexShrink: 0 }}>
                        ✓
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/enquiry?plan=${tier.plan}`}
                  style={{
                    display: "block",
                    background: tier.highlight ? "var(--sf-dark)" : "#fff",
                    color: tier.highlight ? "#fff" : "var(--sf-dark)",
                    border: tier.highlight ? "none" : "1px solid var(--sf-dark)",
                    fontSize: 15,
                    fontWeight: 700,
                    padding: 16,
                    borderRadius: 9,
                    textAlign: "center",
                    textDecoration: "none",
                  }}
                >
                  Enquire about {tier.leads} leads
                </Link>
              </div>
            ))}
          </div>
          <p
            style={{
              fontSize: 12.5,
              color: "var(--sf-muted)",
              textAlign: "center",
              lineHeight: 1.55,
              marginTop: 28,
              maxWidth: 480,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            Exclusive leads (one operator only) available at £25/lead. Contact
            the Stayful team to discuss exclusive allocation.
          </p>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section style={{ background: "var(--sf-olive)", padding: "88px 32px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <Eyebrow center color="var(--sf-dark)">
            Common questions
          </Eyebrow>
          <h2
            style={display({
              fontSize: "clamp(26px,4vw,38px)",
              fontWeight: 700,
              letterSpacing: "-.02em",
              lineHeight: 1.08,
              color: "var(--sf-green)",
              marginBottom: 36,
              textAlign: "center",
            })}
          >
            Answers before you ask.
          </h2>
          <div>
            {FAQ.map((item, i) => {
              const open = openFaq === i;
              return (
                <div key={item.q} style={{ borderBottom: "1px solid rgba(93,129,86,.28)" }}>
                  <button
                    onClick={() => setOpenFaq(open ? null : i)}
                    style={{
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 15.5,
                      fontWeight: 600,
                      color: "var(--sf-green)",
                      padding: "20px 0",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 16,
                      textAlign: "left",
                      fontFamily: "var(--sf-sans)",
                    }}
                  >
                    {item.q}
                    <span
                      style={{
                        fontSize: 22,
                        color: "var(--sf-green)",
                        flexShrink: 0,
                        transition: "transform .2s",
                        transform: open ? "rotate(45deg)" : "none",
                        fontWeight: 300,
                      }}
                    >
                      +
                    </span>
                  </button>
                  <div
                    style={{
                      fontSize: 14,
                      color: "var(--sf-green)",
                      opacity: 0.85,
                      lineHeight: 1.75,
                      maxHeight: open ? 400 : 0,
                      overflow: "hidden",
                      transition: "max-height .3s ease, padding .2s",
                      paddingBottom: open ? 20 : 0,
                    }}
                  >
                    {item.a}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============ FINAL CTA ============ */}
      <section
        id="signup"
        style={{ background: "var(--sf-olive)", padding: "88px 32px", textAlign: "center" }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: 40,
              flexWrap: "wrap",
              marginBottom: 40,
            }}
          >
            <FinalStat prefix="£" n={15} label="per lead" />
            <div>
              <div
                style={display({
                  fontSize: 32,
                  fontWeight: 700,
                  color: "var(--sf-dark)",
                  lineHeight: 1,
                })}
              >
                1 in 20
              </div>
              <div style={{ fontSize: 12, color: "var(--sf-green)", marginTop: 4, fontWeight: 600 }}>
                converts to a client
              </div>
            </div>
            <FinalStat prefix="£" n={289} label="avg monthly per property" />
          </div>
          <h2
            style={display({
              fontSize: "clamp(24px,3.6vw,34px)",
              fontWeight: 700,
              letterSpacing: "-.02em",
              color: "var(--sf-green)",
              marginBottom: 14,
              lineHeight: 1.1,
            })}
          >
            A fixed cost. A known return. A growing portfolio.
          </h2>
          <p
            style={{
              fontSize: 15.5,
              color: "var(--sf-green)",
              opacity: 0.82,
              marginBottom: 32,
              lineHeight: 1.65,
            }}
          >
            From £150 per month for a steady flow of financially modelled leads.
            No campaigns to run, no algorithms to manage — you focus on managing
            and winning property, we handle finding the landlords. Just a
            consistent pipeline of people who searched for what you do.
          </p>
          <Link
            href="/enquiry"
            style={{
              display: "inline-block",
              background: "var(--sf-dark)",
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              padding: "16px 42px",
              borderRadius: 9,
              textDecoration: "none",
              marginBottom: 18,
            }}
          >
            Claim your founding membership
          </Link>
          <div style={{ display: "flex", gap: 22, justifyContent: "center", flexWrap: "wrap" }}>
            {["Cancel anytime", "Allocation carries forward", "Founding rate locked"].map(
              (t) => (
                <span
                  key={t}
                  style={{
                    fontSize: 13,
                    color: "var(--sf-green)",
                    opacity: 0.8,
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  ✓ {t}
                </span>
              )
            )}
          </div>
        </div>
      </section>

      {/* ============ FOOTER ============ */}
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

// ── Small style helpers & sub-components ────────────────────────────────────

const navLink: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--sf-secondary)",
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

const heroSecondary: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  border: "1.5px solid rgba(93,129,86,.45)",
  color: "var(--sf-green)",
  fontSize: 15,
  fontWeight: 600,
  padding: "15px 26px",
  borderRadius: 9,
  textDecoration: "none",
};

const oliveChip: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  background: "var(--sf-olive)",
  color: "var(--sf-dark)",
  padding: "5px 11px",
  borderRadius: 100,
};

const sageChip: CSSProperties = {
  background: "var(--sf-sage)",
  color: "var(--sf-dark)",
  fontSize: 12,
  fontWeight: 600,
  padding: "4px 10px",
  borderRadius: 7,
};

const unlockedPill: CSSProperties = {
  fontSize: 10.5,
  color: "var(--sf-dark)",
  fontWeight: 600,
  background: "var(--sf-sage)",
  padding: "2px 8px",
  borderRadius: 100,
};

const leadLabel: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: ".07em",
  color: "var(--sf-muted)",
  marginBottom: 6,
};

const statCard: CSSProperties = {
  background: "#fff",
  border: "1px solid var(--sf-border)",
  borderRadius: 16,
  padding: 26,
};

const timelineBody: CSSProperties = {
  fontSize: 14,
  color: "var(--sf-secondary)",
  lineHeight: 1.65,
  marginBottom: 14,
};

const footerLink: CSSProperties = {
  fontSize: 13,
  color: "var(--sf-muted)",
  textDecoration: "none",
};

function cardGrid(min: number): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))`,
    gap: 18,
  };
}

function Eyebrow({
  children,
  color = "var(--sf-green)",
}: {
  children: React.ReactNode;
  center?: boolean;
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
    maxWidth: 700,
    marginBottom: 44,
    textAlign: "center",
    marginLeft: "auto",
    marginRight: "auto",
    ...extra,
  };
}

function stepNum(bg: string, fg: string): CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: bg,
    color: fg,
    fontFamily: "var(--sf-display)",
    fontWeight: 700,
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function StepHead({ n, title }: { n: string; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
      <span style={stepNum("var(--sf-green)", "#fff")}>{n}</span>
      <h3 style={display({ fontSize: 16, fontWeight: 700, color: "var(--sf-green)" })}>
        {title}
      </h3>
    </div>
  );
}

function Timeline({
  n,
  title,
  children,
  last,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", gap: 22 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: last ? "var(--sf-dark)" : "var(--sf-green)",
            color: "#fff",
            fontFamily: "var(--sf-display)",
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {n}
        </span>
        {!last && <span style={{ flex: 1, width: 2, background: "var(--sf-border)" }} />}
      </div>
      <div style={{ paddingBottom: last ? 0 : 34 }}>
        <h3 style={display({ fontSize: 17, fontWeight: 700, marginBottom: 6 })}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function statusChip(won?: boolean, color?: string): CSSProperties {
  if (won) {
    return {
      fontSize: 12,
      fontWeight: 700,
      background: "var(--sf-green)",
      color: "#fff",
      padding: "5px 12px",
      borderRadius: 7,
    };
  }
  return {
    fontSize: 12,
    fontWeight: 700,
    background: "#fff",
    border: "1px solid var(--sf-border)",
    color: color || "var(--sf-secondary)",
    padding: "5px 12px",
    borderRadius: 7,
  };
}

function LeadRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "9px 0", borderBottom: "1px solid var(--sf-border)" }}>
      <div style={leadLabel}>{label}</div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function StatRow({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 13,
        padding: "7px 0",
        borderBottom: "1px solid var(--sf-border)",
      }}
    >
      <span style={{ color: "var(--sf-secondary)", fontWeight: bold ? 700 : 400 }}>{k}</span>
      <span style={{ fontWeight: bold ? 700 : 600, color: bold ? "var(--sf-dark)" : undefined }}>
        {v}
      </span>
    </div>
  );
}

function FlowCard({
  big,
  small,
  sub,
  green,
}: {
  big: string;
  small: string;
  sub: string;
  green?: boolean;
}) {
  return (
    <div
      style={{
        background: green ? "var(--sf-green)" : "#fff",
        border: green ? "none" : "1px solid var(--sf-border)",
        borderRadius: 14,
        padding: "22px 18px",
        textAlign: "center",
      }}
    >
      <div
        style={display({
          fontSize: 30,
          fontWeight: 700,
          color: green ? "#fff" : "var(--sf-dark)",
          lineHeight: 1,
          marginBottom: 5,
        })}
      >
        {big}
      </div>
      <div style={{ fontSize: 12, color: green ? "var(--sf-sage)" : "var(--sf-muted)", marginBottom: 8 }}>
        {small}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: green ? "#fff" : "var(--sf-secondary)",
          opacity: green ? 0.9 : 1,
          lineHeight: 1.45,
        }}
      >
        {sub}
      </div>
    </div>
  );
}

function AdBar({
  label,
  price,
  pct,
  note,
  green,
}: {
  label: string;
  price: string;
  pct: string;
  note: string;
  green?: boolean;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, marginBottom: 6 }}>
        <span style={{ color: "var(--sf-green)", fontWeight: green ? 700 : 600 }}>{label}</span>
        <span style={{ fontWeight: 700, color: green ? "var(--sf-dark)" : "var(--sf-green)" }}>
          {price}
        </span>
      </div>
      <div style={{ height: 14, background: "rgba(93,129,86,.18)", borderRadius: 100, overflow: "hidden" }}>
        <div
          style={{
            width: pct,
            height: "100%",
            background: green ? "var(--sf-green)" : "var(--sf-muted)",
            borderRadius: 100,
          }}
        />
      </div>
      <div style={{ fontSize: 12, color: "var(--sf-green)", opacity: 0.75, marginTop: 5 }}>{note}</div>
    </div>
  );
}

function LegendItem({
  color,
  label,
  value,
  valueColor,
}: {
  color: string;
  label: string;
  value: string;
  valueColor: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 22, height: 4, borderRadius: 2, background: color }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--sf-body)" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: valueColor }}>{value}</span>
    </div>
  );
}

function MilestoneCard({
  month,
  big,
  mrr,
  sub,
  green,
}: {
  month: string;
  big: string;
  mrr: string;
  sub: string;
  green?: boolean;
}) {
  return (
    <div
      style={{
        background: green ? "var(--sf-green)" : "#fff",
        border: green ? "none" : "1px solid var(--sf-border)",
        borderRadius: 14,
        padding: 22,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: ".07em",
          color: green ? "var(--sf-sage)" : "var(--sf-muted)",
          marginBottom: 8,
        }}
      >
        {month}
      </div>
      <div style={display({ fontSize: 24, fontWeight: 700, color: green ? "#fff" : "var(--sf-dark)" })}>
        {big}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: green ? "var(--sf-sage)" : "var(--sf-green)",
          marginBottom: 4,
        }}
      >
        {mrr}
      </div>
      <div style={{ fontSize: 12, color: green ? "#fff" : "var(--sf-secondary)", opacity: green ? 0.85 : 1 }}>
        {sub}
      </div>
    </div>
  );
}

function FoundingCard({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        padding: 22,
        background: "rgba(255,255,255,.08)",
        border: "1px solid rgba(185,213,198,.22)",
        borderRadius: 14,
      }}
    >
      <div style={{ fontSize: 14.5, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--sf-sage)", opacity: 0.88, lineHeight: 1.55 }}>
        {body}
      </div>
    </div>
  );
}

function FinalStat({ prefix, n, label }: { prefix?: string; n: number; label: string }) {
  return (
    <div>
      <div style={display({ fontSize: 32, fontWeight: 700, color: "var(--sf-dark)", lineHeight: 1 })}>
        {prefix}
        <Count n={n} />
      </div>
      <div style={{ fontSize: 12, color: "var(--sf-green)", marginTop: 4, fontWeight: 600 }}>
        {label}
      </div>
    </div>
  );
}
