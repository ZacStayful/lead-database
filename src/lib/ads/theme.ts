import type { AdTheme } from "./templates";

/**
 * The grounds a card is drawn on (§65). ⚠️ IMPORT-FREE apart from a type.
 *
 * ⚠️ THESE ARE RESOLVED HEX, NEVER `var(--sf-*)`. Satori has no CSS cascade:
 * a custom property renders as nothing at all. The whole branded surface of
 * this app is built on those nine tokens, which teaches exactly the wrong
 * habit here, so a test asserts no spec ever carries a `var(`.
 *
 * ⚠️ AND THEY ARE NOT `derivePalette`'s. That function has no paper and no
 * amber: its `tint` and `tintDeep` are cool near-whites derived from the
 * ACCENT'S HUE, so a blue brand would get blue-grey "paper" — and T3 and T6
 * are both paper. The repo's one warm neutral, #c26b3d, is reserved for a
 * negative delta and must not become somebody's brand orange.
 *
 * So this file is small, deliberately non-brandable, and kept out of
 * presentationBrand.ts, which pins the presentation deck.
 */
export type AdGround = {
  /** The canvas. */
  ground: string;
  /** A raised block on it — the stat panel, the form card. */
  panel: string;
  /** Body text on `ground`. */
  ink: string;
  /** Secondary text on `ground` and on `panel`. */
  muted: string;
  /** Hairlines and the ruled field on paper. */
  rule: string;
  /** Text on a filled accent pill. */
  onAccent: string;
};

export const AD_THEMES: Record<AdTheme, AdGround> = {
  dark: {
    ground: "#0f1319",
    panel: "#181f29",
    ink: "#f5f7fa",
    muted: "#94a2b4",
    rule: "#252e3b",
    onAccent: "#ffffff",
  },
  light: {
    ground: "#ffffff",
    panel: "#f4f6f8",
    ink: "#111827",
    muted: "#5b6472",
    rule: "#e4e8ee",
    onAccent: "#ffffff",
  },
  // A warm off-white with a ruled field, which is what the spec means by
  // "document-style" and "ruled paper" for T3 and T6.
  paper: {
    ground: "#faf7f1",
    panel: "#f3eee3",
    ink: "#1c1a16",
    muted: "#5d574b",
    rule: "#e0d8c8",
    onAccent: "#ffffff",
  },
};

/**
 * T7's open estimate row. ⚠️ Deliberately NOT the brand accent: the row means
 * "waiting on you", and painting it in the operator's colour would make the
 * one element that is not an assertion look like the one that is.
 */
export const AD_AMBER = "#b45309";
export const AD_AMBER_SOFT = "#fdf3e3";
