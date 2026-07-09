"use client";

import { useState, type CSSProperties } from "react";

// Section 5 — "How leads are qualified". A click-through stepper explaining the
// financial qualification process. Extracted into its own file (like the chart
// components) because it carries interactive step state. Palette is a
// deliberate monochrome sage/green — most text renders in #5D8156, not the
// app's standard near-black body colour.

interface Step {
  n: number;
  title: string;
  body: string;
  bullets?: string[];
}

const STEPS: Step[] = [
  {
    n: 1,
    title: "Enquiry received",
    body: "The landlord finds Stayful through Google and fills out our enquiry form.",
  },
  {
    n: 2,
    title: "Income report generated",
    body: "We generate an income report for the property and process the data internally, comparing their estimated short-term let income against their current long-term let income.",
  },
  {
    n: 3,
    title: "Costs deducted",
    body: "From the short-term let estimate, we deduct:",
    bullets: [
      "OTA (booking platform) commissions",
      "A buffer for cleaning",
      "A buffer for bills",
      "A buffer for maintenance",
      "Our management charge of 15% + VAT",
    ],
  },
  {
    n: 4,
    title: "Qualification decision",
    body: "If there is still an uplift after all these deductions — meaning the property would be more profitable as a short-term let than it currently is as a long-term let — the lead is considered qualified and passed over.",
  },
];

// Palette (kept as literals to preserve the exact monochrome spec).
const GREEN = "#5D8156";
const OLIVE = "#CFD5B9";
const MUTED = "rgba(93,129,86,0.6)";
const TRACK_BORDER = "rgba(93,129,86,0.35)";
const CARD_BORDER = "rgba(93,129,86,0.45)";

const btnReset: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  fontFamily: "inherit",
};

function circleStyle(active: boolean): CSSProperties {
  return {
    width: 44,
    height: 44,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 15,
    fontWeight: 600,
    boxSizing: "border-box",
    flexShrink: 0,
    background: active ? GREEN : OLIVE,
    color: active ? "#fff" : MUTED,
    border: active ? `1px solid ${GREEN}` : `1px solid ${TRACK_BORDER}`,
  };
}

// Body + bullets, shared by both layouts. On desktop it also carries the
// "STEP n" label and the step title (the shared card stands alone); on mobile
// the title already sits in the row, so only the body + bullets expand inline.
function StepDetail({
  step,
  variant,
}: {
  step: Step;
  variant: "card" | "inline";
}) {
  const bulletSize = variant === "card" ? 15 : 14;
  return (
    <>
      {variant === "card" && (
        <>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: GREEN,
              marginBottom: 8,
            }}
          >
            Step {step.n}
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: GREEN,
              marginBottom: 8,
            }}
          >
            {step.title}
          </div>
        </>
      )}
      <p
        style={{
          fontSize: 16,
          lineHeight: 1.6,
          color: GREEN,
          maxWidth: 640,
          margin: 0,
        }}
      >
        {step.body}
      </p>
      {step.bullets && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
            marginTop: 12,
          }}
        >
          {step.bullets.map((b) => (
            <div
              key={b}
              style={{
                fontSize: bulletSize,
                lineHeight: 1.4,
                color: GREEN,
                display: "flex",
                gap: 8,
              }}
            >
              <span aria-hidden>–</span>
              <span>{b}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function QualificationProcess() {
  // Default active step is 1. Desktop click sets the active step; mobile click
  // toggles (an open step can be collapsed), so this can be null on mobile.
  const [active, setActive] = useState<number | null>(1);
  const shown = active ?? 1;
  const shownStep = STEPS[shown - 1];

  return (
    <section
      style={{
        background: "#ffffff",
        padding: "clamp(40px, 6vw, 72px) clamp(22px, 5vw, 64px)",
        fontFamily: "var(--sf-sans)",
      }}
    >
      <style>{`
        .qp-wrap { max-width: 1040px; margin: 0 auto; }
        .qp-desktop { display: block; }
        .qp-mobile { display: none; }
        @keyframes qp-fade {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: none; }
        }
        @media (max-width: 768px) {
          .qp-desktop { display: none; }
          .qp-mobile { display: block; }
        }
      `}</style>

      <div className="qp-wrap">
        <p
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: MUTED,
            marginBottom: 10,
          }}
        >
          How leads are qualified
        </p>
        <h2
          style={{
            fontFamily: "var(--sf-display)",
            fontSize: "clamp(22px, 3vw, 26px)",
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: GREEN,
            margin: "0 0 14px",
          }}
        >
          The qualification process
        </h2>
        <p
          style={{
            fontSize: "clamp(15px, 2vw, 16px)",
            lineHeight: 1.55,
            color: GREEN,
            maxWidth: 620,
            margin: "0 0 40px",
          }}
        >
          Every lead has been financially modelled against the landlord&apos;s
          current income using live Airbnb data for their postcode.
        </p>

        {/* ── Desktop: horizontal stepper + shared detail card ── */}
        <div className="qp-desktop">
          <div
            style={{
              position: "relative",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            {/* progress track */}
            <div
              style={{
                position: "absolute",
                top: 22,
                left: "12.5%",
                width: "75%",
                height: 2,
                background: TRACK_BORDER,
                transform: "translateY(-1px)",
              }}
            />
            {/* progress fill */}
            <div
              style={{
                position: "absolute",
                top: 22,
                left: "12.5%",
                width: `${((shown - 1) / 3) * 75}%`,
                height: 2,
                background: GREEN,
                transform: "translateY(-1px)",
                transition: "width .28s ease",
              }}
            />
            {STEPS.map((s) => {
              const isActive = s.n === active;
              return (
                <button
                  key={s.n}
                  type="button"
                  onClick={() => setActive(s.n)}
                  style={{
                    ...btnReset,
                    position: "relative",
                    zIndex: 1,
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span style={circleStyle(isActive)}>{s.n}</span>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? GREEN : MUTED,
                      textAlign: "center",
                      maxWidth: 150,
                    }}
                  >
                    {s.title}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            key={shown}
            style={{
              marginTop: 32,
              background: OLIVE,
              border: `1px solid ${CARD_BORDER}`,
              borderRadius: 12,
              padding: 28,
              animation: "qp-fade .28s ease",
            }}
          >
            <StepDetail step={shownStep} variant="card" />
          </div>
        </div>

        {/* ── Mobile: vertical stepper with per-step inline accordion ── */}
        <div className="qp-mobile">
          {STEPS.map((s, i) => {
            const isActive = s.n === active;
            const isLast = i === STEPS.length - 1;
            const connectorDone = s.n < shown;
            return (
              <div key={s.n} style={{ display: "flex", gap: 14 }}>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Step ${s.n}: ${s.title}`}
                    onClick={() => setActive(isActive ? null : s.n)}
                    style={btnReset}
                  >
                    <span style={circleStyle(isActive)}>{s.n}</span>
                  </button>
                  {!isLast && (
                    <span
                      style={{
                        flex: 1,
                        width: 2,
                        minHeight: 24,
                        background: connectorDone ? GREEN : TRACK_BORDER,
                      }}
                    />
                  )}
                </div>
                <div style={{ flex: 1, paddingBottom: isLast ? 0 : 20 }}>
                  <button
                    type="button"
                    onClick={() => setActive(isActive ? null : s.n)}
                    style={{
                      ...btnReset,
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      paddingTop: 11,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 16,
                        fontWeight: isActive ? 600 : 500,
                        color: isActive ? GREEN : MUTED,
                      }}
                    >
                      {s.title}
                    </span>
                  </button>
                  <div
                    style={{
                      maxHeight: isActive ? 600 : 0,
                      opacity: isActive ? 1 : 0,
                      overflow: "hidden",
                      transition: "max-height .3s ease, opacity .3s ease",
                    }}
                  >
                    <div style={{ paddingTop: 12 }}>
                      <StepDetail step={s} variant="inline" />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
