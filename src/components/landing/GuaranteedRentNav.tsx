"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";

const LOGO = "/logo.png";

// Responsive header for the Guaranteed Rent landing page. Mirrors the main
// landing nav (app/page.tsx): a desktop link row that collapses into a
// hamburger + full-width dropdown on narrow screens, driven by the shared
// `.sf-nav-desktop` / `.sf-nav-hamburger` / `.sf-nav-mobile` classes in
// globals.css. Extracted into a client component so the GR page itself can stay
// a server component (and keep its `metadata` export).
export function GuaranteedRentNav() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
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

      {/* Desktop nav row (hidden on mobile via CSS) */}
      <div className="sf-nav-desktop">
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
        <Link href="/login" style={navGhostBtn}>
          Log in
        </Link>
        <Link href="/enquiry?product=guaranteed-rent" style={navCta}>
          Start receiving leads →
        </Link>
      </div>

      {/* Hamburger (shown on mobile via CSS) */}
      <button
        type="button"
        className="sf-nav-hamburger"
        aria-label="Toggle menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          {menuOpen ? (
            <>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </>
          ) : (
            <>
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </>
          )}
        </svg>
      </button>

      {/* Mobile dropdown panel */}
      <div className={"sf-nav-mobile" + (menuOpen ? " open" : "")}>
        <Link href="/" style={navMobileLink} onClick={() => setMenuOpen(false)}>
          Management Leads
        </Link>
        <a href="#how" style={navMobileLink} onClick={() => setMenuOpen(false)}>
          How it works
        </a>
        <a
          href="#numbers"
          style={navMobileLink}
          onClick={() => setMenuOpen(false)}
        >
          The numbers
        </a>
        <a
          href="#pricing"
          style={navMobileLink}
          onClick={() => setMenuOpen(false)}
        >
          Pricing
        </a>
        <Link
          href="/login"
          style={navMobileGhost}
          onClick={() => setMenuOpen(false)}
        >
          Log in
        </Link>
        <Link
          href="/enquiry?product=guaranteed-rent"
          style={navMobileSolid}
          onClick={() => setMenuOpen(false)}
        >
          Start receiving leads →
        </Link>
      </div>
    </nav>
  );
}

const navLink: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--sf-secondary)",
  textDecoration: "none",
};

const navGhostBtn: CSSProperties = {
  color: "var(--sf-dark)",
  fontSize: 13,
  fontWeight: 600,
  padding: "9px 16px",
  borderRadius: 8,
  border: "1px solid var(--sf-border)",
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

// Mobile dropdown items (full-width variants of the same styling).
const navMobileLink: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--sf-body)",
  textDecoration: "none",
  padding: "10px 4px",
};

const navMobileGhost: CSSProperties = {
  display: "block",
  textAlign: "center",
  color: "var(--sf-dark)",
  fontSize: 14,
  fontWeight: 600,
  padding: "12px",
  borderRadius: 8,
  border: "1px solid var(--sf-border)",
  textDecoration: "none",
};

const navMobileSolid: CSSProperties = {
  display: "block",
  textAlign: "center",
  background: "var(--sf-dark)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  padding: "12px",
  borderRadius: 8,
  textDecoration: "none",
};
