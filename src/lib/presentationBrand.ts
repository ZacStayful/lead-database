/**
 * An operator's own branding for the income presentation (0112).
 *
 * §26 already argues that the management fee must never be taken from the
 * analysis PDF: the report charges 15% of gross because that is STAYFUL'S fee,
 * and the operator presenting is not Stayful. The colours are the same argument
 * one step further out — a deck in our green, with our palette, presented to
 * their landlord as their own business.
 *
 * ⚠️ ONE COLOUR IS STORED. Everything else is DERIVED from it here, on every
 * render, and that is deliberate: a customer who could store nine colours could
 * store nine colours that render a slide unreadable, in front of a landlord,
 * with no way for them to see it coming. `derivePalette` cannot produce an
 * illegible pair, because it fixes the lightness of every token and guards the
 * one relationship that a hue can still break (see CONTRAST below).
 *
 * ⚠️ THE PALETTE MIRRORS THE HEX LITERALS IN
 * public/income-presentation/index.html AND THE TWO MUST CHANGE TOGETHER. The
 * tool now reads them as CSS custom properties; the defaults below reproduce
 * the colours it shipped with, so an operator who has set nothing sees exactly
 * the deck they saw yesterday. `presentationBrand.test.ts` pins that.
 *
 * Neutrals are NOT here and are not brandable: the greys, the page ground, and
 * in particular the #c26b3d that marks a NEGATIVE delta — a warning colour that
 * must never become somebody's brand orange.
 */

/** What the customer stores. Small: `customers` is read with `select("*")`. */
export interface PresentationBrand {
  /** `#rrggbb`, lower case. The one colour a customer chooses. */
  accent: string;
  /** Null until they upload one. The bytes live in the bucket, never here. */
  logo: { path: string; mime: LogoMime; sizeBytes: number } | null;
}

export type LogoMime = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

/** The tool's colours as it shipped. `derivePalette` reproduces these. */
export const STAYFUL_ACCENT = "#2f7d4f";

export const DEFAULT_PRESENTATION_BRAND: PresentationBrand = {
  accent: STAYFUL_ACCENT,
  logo: null,
};

/**
 * Ready-made palettes, offered as swatches beside the custom colour input.
 *
 * A PRESET RESOLVES TO ITS HEX ON SAVE, and the hex is what is stored — never
 * the preset's name. Re-tuning "Slate" a year from now must not restyle a deck
 * an operator has already presented from and shown a landlord.
 *
 * Stayful's own green is first so "put it back" is one click.
 */
export const BRAND_PRESETS: { key: string; name: string; accent: string }[] = [
  { key: "stayful", name: "Stayful green", accent: STAYFUL_ACCENT },
  { key: "ink", name: "Midnight", accent: "#26456f" },
  { key: "slate", name: "Slate", accent: "#44546b" },
  { key: "plum", name: "Plum", accent: "#6b3f6e" },
  { key: "clay", name: "Clay", accent: "#9c5638" },
  { key: "teal", name: "Teal", accent: "#1f6f74" },
];

/**
 * Every colour the presentation needs, keyed to the CSS custom properties the
 * tool now reads. `--sf-` prefixed there; the names below map one to one.
 */
export interface BrandPalette {
  /** Buttons, links, eyebrow headings, bars. Guarded against white. */
  accent: string;
  /** Hover and pressed. */
  accentDark: string;
  /** The second bar tone and the positive delta. */
  accentMid: string;
  /** Small type on the dark slides. */
  accentSoft: string;
  /** The big money figure on the dark slides. */
  accentBright: string;
  /** The dark slide ground — cover and closing. */
  ink: string;
  /** Headline type on `ink`. */
  inkText: string;
  /** Panel tints on white slides. */
  tint: string;
  tintDeep: string;
  /**
   * True when the chosen colour was darkened to keep text on it readable. The
   * settings card says so rather than silently showing a different colour than
   * the one the operator picked.
   */
  adjusted: boolean;
}

/**
 * CONTRAST, and why one guard covers two uses.
 *
 * The accent is both a button fill with white text on it AND accent-coloured
 * text on a white slide. WCAG contrast is symmetric, so a single requirement —
 * accent against white ≥ 4.5:1 — makes both legible at once. A pale yellow
 * fails it; darkening the pick until it passes is the whole guard.
 */
const MIN_ACCENT_CONTRAST = 4.5;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return { h: (h + 360) % 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 1);
  const ln = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  const [r, g, b] =
    hn < 60 ? [c, x, 0] :
    hn < 120 ? [x, c, 0] :
    hn < 180 ? [0, c, x] :
    hn < 240 ? [0, x, c] :
    hn < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

function channelLuminance(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** WCAG contrast ratio, 1–21. Symmetric in its arguments. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The whole palette, from one colour.
 *
 * Each token fixes its own LIGHTNESS and borrows only the hue and (a fraction
 * of) the saturation. That is what makes the result predictable: the dark slide
 * ground is dark whatever is chosen, the near-white text stays near-white, and
 * the only thing a hostile pick can move is the accent itself — which is
 * guarded.
 */
export function derivePalette(accentInput: string): BrandPalette {
  const rgb = hexToRgb(accentInput) ?? hexToRgb(STAYFUL_ACCENT)!;
  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  let { l } = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // Darken until white-on-accent (and accent-on-white) clears 4.5:1. Stepwise
  // rather than solved, because the steps are 1% of lightness and the loop is
  // bounded — a solve would be exact about a threshold that is itself a
  // judgement.
  let accent = hslToHex(h, s, l);
  let adjusted = false;
  while (contrastRatio(accent, "#ffffff") < MIN_ACCENT_CONTRAST && l > 0.12) {
    l -= 0.01;
    accent = hslToHex(h, s, l);
    adjusted = true;
  }

  return {
    accent,
    accentDark: hslToHex(h, s, l - 0.08),
    accentMid: hslToHex(h, s * 0.97, l + 0.07),
    // On the dark slides. Fixed lightness, so these clear the ground below
    // whatever hue arrives.
    accentSoft: hslToHex(h - 6, s * 0.6, 0.655),
    accentBright: hslToHex(h - 8, Math.min(1, s * 1.25), 0.72),
    ink: hslToHex(h + 1, Math.min(s * 0.53, 0.35), 0.114),
    inkText: hslToHex(h, 0.3, 0.961),
    tint: hslToHex(h, 0.28, 0.953),
    tintDeep: hslToHex(h, 0.22, 0.941),
    adjusted,
  };
}

/** The custom properties the static tool reads, ready to set on :root. */
export function paletteCssVars(palette: BrandPalette): Record<string, string> {
  return {
    "--sf-accent": palette.accent,
    "--sf-accent-dark": palette.accentDark,
    "--sf-accent-mid": palette.accentMid,
    "--sf-accent-soft": palette.accentSoft,
    "--sf-accent-bright": palette.accentBright,
    "--sf-ink": palette.ink,
    "--sf-ink-text": palette.inkText,
    "--sf-tint": palette.tint,
    "--sf-tint-deep": palette.tintDeep,
  };
}

const MAX_PATH = 200;

/**
 * Coerce whatever was stored or sent into a usable brand.
 *
 * A WHITELIST, NOT A FILTER, and it never throws — the same rule
 * `validatePresentationSettings` follows, for the same reason: this is read on
 * the path that opens a presentation, and a malformed blob must degrade to the
 * default palette rather than 500 at an operator with a landlord waiting.
 */
export function validatePresentationBrand(input: unknown): PresentationBrand {
  const raw = (input ?? {}) as Record<string, unknown>;
  const accentRaw = typeof raw.accent === "string" ? raw.accent.trim().toLowerCase() : "";
  const accent = /^#[0-9a-f]{6}$/.test(accentRaw) ? accentRaw : DEFAULT_PRESENTATION_BRAND.accent;

  const logoRaw = (raw.logo ?? null) as Record<string, unknown> | null;
  let logo: PresentationBrand["logo"] = null;
  if (logoRaw && typeof logoRaw === "object") {
    const path = typeof logoRaw.path === "string" ? logoRaw.path.trim() : "";
    const mime = logoRaw.mime;
    const size = Number(logoRaw.sizeBytes);
    if (path && path.length <= MAX_PATH && !path.includes("..") && isLogoMime(mime)) {
      logo = {
        path,
        mime,
        sizeBytes: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
      };
    }
  }

  return { accent, logo };
}

export function isLogoMime(value: unknown): value is LogoMime {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/svg+xml"
  );
}

/** 2 MB for a raster logo. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 512 KB for SVG. A vector logo is a few kilobytes; anything approaching this
 * is a pasted-in bitmap or an embedded font dump, neither of which is what the
 * format was accepted for.
 */
export const LOGO_SVG_MAX_BYTES = 512 * 1024;

/**
 * What the bytes ACTUALLY are, regardless of what the upload claimed.
 *
 * The declared content-type is the client's word for it, and the bucket's
 * allowed_mime_types checks the same client-supplied string — so neither is
 * evidence. PNG, JPEG and WebP have magic numbers; SVG has none, so it is
 * recognised by its opening tag after any byte-order mark or whitespace, which
 * is also the only shape a browser will render.
 *
 * Returns null for anything unrecognised, and null is a refusal.
 */
export function sniffLogoMime(bytes: Uint8Array): LogoMime | null {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  // SVG: skip a UTF-8 BOM and any leading whitespace, then require a tag.
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.slice(i, i + 512))
    .toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!doctype svg")) {
    // An XML preamble is only an SVG if an <svg> element actually follows.
    if (head.includes("<svg")) return "image/svg+xml";
  }
  return null;
}

/** The cap that applies to a given type. */
export function logoMaxBytes(mime: LogoMime): number {
  return mime === "image/svg+xml" ? LOGO_SVG_MAX_BYTES : LOGO_MAX_BYTES;
}

/** `<customer_id>/logo` — fixed, so a replacement overwrites (0112). */
export function logoStoragePath(customerId: string): string {
  return `${customerId}/logo`;
}
