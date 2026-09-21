import { contrastRatio, luminance } from "@/lib/presentationBrand";
import { AD_AMBER, AD_AMBER_SOFT, AD_THEMES } from "./theme";
import { AD_FONT_BODY, AD_FONT_DISPLAY, sanitiseForFont } from "./fonts";
import { AD_RATIO_SIZES, type AdRatio } from "./storagePaths";
import { stripEmphasis } from "./emphasis";
import type { AdTemplate } from "./templates";

/**
 * The card, as a plain tree (§65). `render.tsx` walks this into JSX; nothing
 * here imports `next/og`.
 *
 * ⚠️ THE SPLIT EARNS ITS PLACE FOR TWO REASONS, AND NEITHER IS "you cannot
 * test JSX". You can — `createElement` is pure. It is here because:
 *
 *   1. §7's figure check has to run over the IMAGE as well as the copy, and
 *      that needs the text flattened out of a data structure.
 *   2. `style` is typed as a narrowed `SatoriStyle` rather than
 *      `React.CSSProperties`, which would happily accept `display: 'grid'`,
 *      `position: 'fixed'`, `float` and `calc()` — none of which satori
 *      supports, two of which throw, and the rest of which silently do
 *      nothing. The compiler becomes the guard.
 *
 * ⚠️ RESOLVED HEX ONLY. Satori has no CSS cascade, so `var(--sf-accent)`
 * renders as nothing at all — and every branded surface in this app is built
 * on exactly those tokens, which teaches the wrong habit. A test asserts no
 * spec ever carries a `var(`.
 */

/** The ~60 properties satori 0.10.9 actually implements, narrowed to what we use. */
export type SatoriStyle = {
  display?: "flex" | "none";
  flexDirection?: "row" | "column";
  flexWrap?: "wrap" | "nowrap";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch" | "baseline";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around";
  flexGrow?: number;
  flexBasis?: number | string;
  flexShrink?: number;
  gap?: number;
  width?: number | string;
  height?: number | string;
  maxWidth?: number | string;
  minWidth?: number | string;
  padding?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  margin?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  backgroundColor?: string;
  color?: string;
  borderRadius?: number;
  border?: string;
  borderTop?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRight?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 400 | 700;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right";
  textTransform?: "uppercase" | "lowercase" | "capitalize" | "none";
  opacity?: number;
  overflow?: "hidden" | "visible";
  objectFit?: "contain" | "cover";
  transform?: string;
  lineClamp?: number;
  textOverflow?: "ellipsis" | "clip";
  position?: "relative" | "absolute";
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
};

export type SpecNode =
  | { kind: "box"; style: SatoriStyle; children: SpecNode[] }
  | { kind: "text"; text: string; style: SatoriStyle }
  /** A headline with `*emphasis*`, laid out as word tokens. */
  | { kind: "rich"; source: string; style: SatoriStyle; emphasisStyle: SatoriStyle; space: number }
  | { kind: "image"; src: string; width: number; height: number; style: SatoriStyle }
  /**
   * ⚠️ DRAWN, NEVER TYPED. U+2713 is in none of the three faces, and a glyph
   * no font has makes satori fetch one from Google mid-render.
   */
  | { kind: "tick"; size: number; colour: string };

export type LayoutSpec = { width: number; height: number; root: SpecNode };

// ---------------------------------------------------------------------------
// Readability
// ---------------------------------------------------------------------------

function hex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}
function parse(h: string): [number, number, number] {
  const s = h.replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}
function mix(from: string, towards: string, amount: number): string {
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(towards);
  const t = Math.max(0, Math.min(1, amount));
  return `#${hex(r1 + (r2 - r1) * t)}${hex(g1 + (g2 - g1) * t)}${hex(b1 + (b2 - b1) * t)}`;
}

/**
 * ⚠️ `derivePalette`'s GUARD IS NOT THIS GUARD. It checks the accent against
 * WHITE only, and an accent at that threshold sits at about 4.15:1 on `tint`
 * and 4.0:1 on `tintDeep` — both below AA for body text, and a light or paper
 * card with small accent type on a tinted panel is precisely T3, T6 and T7.
 *
 * So the check runs against the ACTUAL GROUND the text sits on, and darkens
 * locally rather than changing the brand. Stepwise rather than solved, as
 * `derivePalette` says: the steps are small and the loop is bounded, and a
 * solve would be exact about a threshold that is itself a judgement.
 */
export function readableOn(fg: string, bg: string, min: number): string {
  if (contrastRatio(fg, bg) >= min) return fg;
  const towards = luminance(bg) > 0.4 ? "#000000" : "#ffffff";
  for (let i = 1; i <= 24; i++) {
    const candidate = mix(fg, towards, i / 24);
    if (contrastRatio(candidate, bg) >= min) return candidate;
  }
  return towards;
}

/** AA for body text; 3:1 is the floor for large display type. */
export const AA_BODY = 4.5;
export const AA_DISPLAY = 3;

// ---------------------------------------------------------------------------
// Per-ratio geometry
// ---------------------------------------------------------------------------

/**
 * ⚠️ 9:16 IS NOT 4:5 STRETCHED. Stories reserve roughly the top 14% for the
 * profile chip and the bottom 20% for the CTA sticker and the reply bar, so a
 * full-canvas layout puts the headline underneath somebody's profile name.
 *
 * ⚠️ These figures are OURS and are not yet checked against Meta's published
 * placement spec — §65 records that as open.
 */
export const RATIO_GEOMETRY: Record<AdRatio, { inset: { t: number; r: number; b: number; l: number }; scale: number }> = {
  "4x5": { inset: { t: 72, r: 72, b: 72, l: 72 }, scale: 1 },
  "9x16": { inset: { t: 280, r: 72, b: 400, l: 72 }, scale: 1.02 },
  "1x1": { inset: { t: 64, r: 64, b: 64, l: 64 }, scale: 0.86 },
};

/**
 * ⚠️ SIZING, NOT TRUNCATING. A character cap does not map to a pixel width,
 * and on T6 — where "the councils listed beneath" IS the claim — cutting the
 * list understates the coverage the customer is paying to advertise. Three
 * steps, which is the part worth unit-testing, with `lineClamp` as a backstop.
 */
export function fontStep(text: string, steps: [number, number, number], bands: [number, number]): number {
  const n = stripEmphasis(text).length;
  if (n <= bands[0]) return steps[0];
  if (n <= bands[1]) return steps[1];
  return steps[2];
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export type LayoutInput = {
  template: AdTemplate;
  ratio: AdRatio;
  accent: string;
  /** A data: URI, or null. Never a signed URL — see §65. */
  logo: string | null;
  companyName: string;
  headline: string;
  sub: string;
  cta: string;
  /** T3/T6 only: the ticked items, already filtered to what they selected. */
  checklist?: string[];
  /** T6 only. */
  councils?: string | null;
  /** T8 only. */
  stats?: Array<{ value: string; label: string; note?: string }>;
  /** T7 only: the field labels, with NO values. */
  fields?: string[];
};

const box = (style: SatoriStyle, children: SpecNode[]): SpecNode => ({ kind: "box", style, children });
const text = (t: string, style: SatoriStyle): SpecNode => ({ kind: "text", text: sanitiseForFont(t), style });

export function layoutSpec(input: LayoutInput): LayoutSpec {
  const { width, height } = AD_RATIO_SIZES[input.ratio];
  const geo = RATIO_GEOMETRY[input.ratio];
  const px = (n: number) => Math.round(n * geo.scale);
  const th = AD_THEMES[input.template.theme];

  // Readability against the ACTUAL grounds, not against white.
  const accentOnGround = readableOn(input.accent, th.ground, AA_DISPLAY);
  const accentOnPanel = readableOn(input.accent, th.panel, AA_DISPLAY);
  const inkOnGround = readableOn(th.ink, th.ground, AA_BODY);
  const mutedOnGround = readableOn(th.muted, th.ground, AA_BODY);
  const mutedOnPanel = readableOn(th.muted, th.panel, AA_BODY);
  const onAccent = readableOn(th.onAccent, input.accent, AA_BODY);

  const header = box({ alignItems: "center" }, [
    ...(input.logo
      ? [
          box(
            {
              width: px(72), height: px(72), borderRadius: px(16),
              backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center",
              marginRight: px(20),
            },
            // ⚠️ Explicit width/height and objectFit: contain. Satori's default
            // is `none`, so a non-square logo overflows its box at intrinsic
            // size — and PresentationBrand stores no dimensions to check.
            [{ kind: "image", src: input.logo, width: px(48), height: px(48), style: { objectFit: "contain" } }]
          ),
        ]
      : []),
    box({ flexDirection: "column" }, [
      text(input.companyName, { fontSize: px(28), fontWeight: 700, color: inkOnGround, fontFamily: AD_FONT_BODY }),
      // ⚠️ addressed_to, on the CARD. The spec puts it in "the first line of
      // the static" — and T8's headline names no audience at all.
      text(input.template.addressedTo, {
        fontSize: px(24), color: mutedOnGround, marginTop: px(2), fontFamily: AD_FONT_BODY,
        lineClamp: 2, overflow: "hidden",
      }),
    ]),
  ]);

  const headline: SpecNode = {
    kind: "rich",
    source: sanitiseForFont(input.headline),
    style: {
      flexWrap: "wrap",
      fontFamily: AD_FONT_DISPLAY,
      fontWeight: 700,
      fontSize: fontStep(input.headline, [px(64), px(56), px(48)], [58, 84]),
      color: inkOnGround,
      lineHeight: 1.16,
    },
    emphasisStyle: { color: accentOnGround },
    space: px(16),
  };

  const tickRow = (label: string): SpecNode =>
    box({ alignItems: "center", marginBottom: px(18) }, [
      box({ width: px(40), alignItems: "center", justifyContent: "center" }, [
        { kind: "tick", size: px(26), colour: accentOnPanel },
      ]),
      text(label, {
        fontSize: px(32), color: inkOnGround, fontFamily: AD_FONT_BODY,
        marginLeft: px(12), lineClamp: 1, overflow: "hidden",
      }),
    ]);

  let middle: SpecNode;
  switch (input.template.layout) {
    // T3 — "We handle" ticked down the left, "You handle" with one line.
    case "checklist_two_col":
      middle = box({ marginTop: px(48), justifyContent: "space-between" }, [
        box({ flexDirection: "column", flexGrow: 1, flexBasis: 0, paddingRight: px(24) }, [
          text("We handle", {
            fontSize: px(26), fontWeight: 700, color: mutedOnGround, fontFamily: AD_FONT_BODY,
            textTransform: "uppercase", letterSpacing: 1, marginBottom: px(22),
          }),
          ...(input.checklist ?? []).map(tickRow),
        ]),
        box(
          {
            flexDirection: "column", flexGrow: 1, flexBasis: 0,
            backgroundColor: th.panel, borderRadius: px(24), padding: px(32),
          },
          [
            text("You handle", {
              fontSize: px(26), fontWeight: 700, color: mutedOnPanel, fontFamily: AD_FONT_BODY,
              textTransform: "uppercase", letterSpacing: 1, marginBottom: px(22),
            }),
            text("Nothing. We send you the statement.", {
              fontSize: px(34), color: readableOn(th.ink, th.panel, AA_BODY),
              fontFamily: AD_FONT_BODY, lineHeight: 1.25,
            }),
          ]
        ),
      ]);
      break;

    // T6 — a document-style checklist with the councils beneath as plain text.
    case "document_checklist":
      middle = box(
        {
          flexDirection: "column", marginTop: px(48),
          backgroundColor: th.panel, borderRadius: px(24), padding: px(40),
        },
        [
          ...(input.checklist ?? []).map(tickRow),
          ...(input.councils
            ? [
                box({ marginTop: px(12), paddingTop: px(24), borderTop: `2px solid ${th.rule}` }, [
                  text(input.councils, {
                    fontSize: px(26), color: mutedOnPanel, fontFamily: AD_FONT_BODY,
                    lineHeight: 1.35, lineClamp: 3, overflow: "hidden",
                  }),
                ]),
              ]
            : []),
        ]
      );
      break;

    // T7 — a form card with the fields NAMED and the estimate row left open.
    case "form_card":
      middle = box(
        {
          flexDirection: "column", marginTop: px(48),
          backgroundColor: th.panel, borderRadius: px(24), padding: px(36),
        },
        [
          // ⚠️ LABELS WITH NO VALUES. "the property fields filled" cannot mean
          // filled with numbers: a specific figure in the creative is a claim
          // regardless of the disclaimer beneath it, and one put there to look
          // concrete comes from nobody and never passes through the model.
          ...(input.fields ?? []).map((label, i) =>
            box(
              {
                justifyContent: "space-between", alignItems: "center",
                paddingTop: px(20), paddingBottom: px(20),
                borderBottom: i < (input.fields ?? []).length - 1 ? `2px solid ${th.rule}` : undefined,
              },
              [
                text(label, { fontSize: px(30), color: mutedOnPanel, fontFamily: AD_FONT_BODY }),
                box({ width: px(180), height: px(4), backgroundColor: th.rule, borderRadius: px(2) }, []),
              ]
            )
          ),
          box(
            {
              justifyContent: "space-between", alignItems: "center", marginTop: px(24),
              backgroundColor: AD_AMBER_SOFT, borderRadius: px(16),
              paddingTop: px(22), paddingBottom: px(22), paddingLeft: px(24), paddingRight: px(24),
            },
            [
              text("Your estimate", { fontSize: px(30), fontWeight: 700, color: readableOn(AD_AMBER, AD_AMBER_SOFT, AA_BODY), fontFamily: AD_FONT_BODY }),
              text("Waiting on your postcode", { fontSize: px(26), color: readableOn(AD_AMBER, AD_AMBER_SOFT, AA_BODY), fontFamily: AD_FONT_BODY }),
            ]
          ),
        ]
      );
      break;

    // T8 — three stat blocks, the review count small beneath its score.
    default:
      middle = box(
        {
          marginTop: px(56), justifyContent: "space-between",
          backgroundColor: th.panel, borderRadius: px(28), padding: px(44),
        },
        (input.stats ?? []).map((s) =>
          box({ flexDirection: "column", alignItems: "flex-start", flexGrow: 1, flexBasis: 0 }, [
            text(s.value, {
              fontFamily: AD_FONT_DISPLAY, fontWeight: 700, fontSize: px(112),
              color: readableOn(th.ink, th.panel, AA_BODY), lineHeight: 1,
            }),
            text(s.label, { fontSize: px(30), color: mutedOnPanel, fontFamily: AD_FONT_BODY, marginTop: px(12) }),
            ...(s.note
              ? [text(s.note, { fontSize: px(22), color: mutedOnPanel, opacity: 0.85, marginTop: px(4), fontFamily: AD_FONT_BODY })]
              : []),
          ])
        )
      );
  }

  const footer = box({ flexDirection: "column" }, [
    {
      kind: "rich",
      source: sanitiseForFont(input.sub),
      style: {
        flexWrap: "wrap", fontFamily: AD_FONT_BODY,
        fontSize: fontStep(input.sub, [px(32), px(29), px(26)], [70, 110]),
        color: mutedOnGround, lineHeight: 1.35,
      },
      emphasisStyle: { color: accentOnGround },
      space: px(9),
    },
    box({ marginTop: px(34), alignItems: "center" }, [
      box(
        {
          backgroundColor: input.accent, borderRadius: px(999),
          paddingTop: px(22), paddingBottom: px(22), paddingLeft: px(44), paddingRight: px(44),
        },
        [text(input.cta, { color: onAccent, fontWeight: 700, fontSize: px(32), fontFamily: AD_FONT_BODY })]
      ),
    ]),
    // T6's fixed footer, required by the spec's claims note.
    ...(input.template.footerLine
      ? [
          text(input.template.footerLine, {
            fontSize: px(20), color: mutedOnGround, opacity: 0.9,
            marginTop: px(22), fontFamily: AD_FONT_BODY, lineClamp: 2, overflow: "hidden",
          }),
        ]
      : []),
  ]);

  return {
    width,
    height,
    root: box(
      {
        width, height, backgroundColor: th.ground, flexDirection: "column",
        justifyContent: "space-between", fontFamily: AD_FONT_BODY,
        paddingTop: geo.inset.t, paddingRight: geo.inset.r,
        paddingBottom: geo.inset.b, paddingLeft: geo.inset.l,
      },
      [header, box({ flexDirection: "column" }, [headline, middle]), footer]
    ),
  };
}

/**
 * Every word the card will show.
 *
 * ⚠️ THIS IS WHAT LETS THE FIGURE CHECK READ THE IMAGE. Every other guardrail
 * inspects copy, and T7's card is a form — a number put on it to look concrete
 * never passes through the model at all.
 */
export function flattenSpecText(node: SpecNode): string {
  switch (node.kind) {
    case "text":
      return node.text;
    case "rich":
      return stripEmphasis(node.source);
    case "box":
      return node.children.map(flattenSpecText).filter(Boolean).join(" ");
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// From resolved slots to a layout input
// ---------------------------------------------------------------------------

/**
 * ⚠️ T7'S FIELDS ARE LABELS. The spec says "property fields filled", which
 * cannot mean filled with numbers — see the form_card branch above.
 */
const T7_FIELDS = ["Postcode", "Bedrooms", "Current rent"];

export function layoutInputFrom(args: {
  template: AdTemplate;
  ratio: AdRatio;
  accent: string;
  logo: string | null;
  slots: Record<string, string | undefined>;
  selected: string[];
  headline: string;
  sub: string;
  cta: string;
}): LayoutInput {
  const { template, slots } = args;
  const base: LayoutInput = {
    template,
    ratio: args.ratio,
    accent: args.accent,
    logo: args.logo,
    companyName: slots.company_name ?? "",
    headline: args.headline,
    sub: args.sub,
    cta: args.cta,
  };

  switch (template.layout) {
    case "checklist_two_col":
    case "document_checklist":
      return {
        ...base,
        // ⚠️ Only what they ticked, in the template's own order. The spec's
        // claims note for T6: "Only items they tick may appear."
        checklist: (template.services?.options ?? [])
          .filter((o) => args.selected.includes(o.key))
          .map((o) => o.label.charAt(0).toUpperCase() + o.label.slice(1)),
        councils: slots.councils ?? null,
      };
    case "form_card":
      return { ...base, fields: T7_FIELDS };
    default:
      return {
        ...base,
        stats: [
          { value: slots.years_trading ?? "", label: "years" },
          { value: slots.properties_managed ?? "", label: "properties" },
          {
            value: slots.review_score ?? "",
            label: "on Google",
            // ⚠️ The spec: "The review score always renders with its count."
            note: slots.review_count ? `from ${slots.review_count} reviews` : undefined,
          },
        ].filter((s) => s.value.length > 0),
      };
  }
}
