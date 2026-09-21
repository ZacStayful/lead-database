import { describe, expect, it } from "vitest";
import { createElement } from "react";
import {
  AA_BODY, AA_DISPLAY, RATIO_GEOMETRY, flattenSpecText, fontStep,
  layoutInputFrom, layoutSpec, readableOn, type SpecNode,
} from "../layout";
import { renderSpec } from "../render";
import { AD_TEMPLATES, templateById } from "../templates";
import { AD_RATIOS, AD_RATIO_SIZES, checkRenderedBytes, AD_CREATIVE_MIN_BYTES, PNG_MAGIC } from "../storagePaths";
import { contrastRatio } from "@/lib/presentationBrand";
import { AD_THEMES } from "../theme";
import { allowedFigures, figuresAreSupplied } from "../validateAdCopy";
import { serviceListPhrase } from "../resolveSlots";
import { fillPattern } from "../resolveSlots";

const SLOTS: Record<string, string> = {
  company_name: "Northside Lets", city: "Leeds", areas: "LS, WF and BD",
  years_trading: "8", properties_managed: "140", review_score: "4.9", review_count: "63",
  councils: "Leeds, Wakefield, Bradford, Kirklees, Calderdale and Harrogate",
};
const SELECTED: Record<string, string[]> = {
  "never-see-the-messages": ["guest_messaging", "cleaning"],
  "rules-keep-changing": ["licensing", "insurance"],
};

function specFor(id: string, ratio: (typeof AD_RATIOS)[number], over: Record<string, string> = {}) {
  const t = templateById(id)!;
  const selected = SELECTED[id] ?? [];
  const list = serviceListPhrase(t, selected) ?? undefined;
  const slots = { ...SLOTS, ...over, included_list: list, handled_list: list };
  return layoutSpec(
    layoutInputFrom({
      template: t, ratio, accent: "#2f6fed", logo: null, slots, selected,
      headline: fillPattern(t.headlineLocated, slots as never)!,
      sub: fillPattern(t.subLocated, slots as never)!,
      cta: fillPattern(t.ctaPattern, slots as never)!,
    })
  );
}

function walk(node: SpecNode, visit: (n: SpecNode) => void) {
  visit(node);
  if (node.kind === "box") node.children.forEach((c) => walk(c, visit));
}

describe("every template at every ratio", () => {
  it("builds a spec at the right canvas size", () => {
    for (const t of AD_TEMPLATES) {
      for (const ratio of AD_RATIOS) {
        const spec = specFor(t.id, ratio);
        expect(spec.width).toBe(AD_RATIO_SIZES[ratio].width);
        expect(spec.height).toBe(AD_RATIO_SIZES[ratio].height);
      }
    }
  });

  it("⚠️ carries resolved hex and never a var() — satori has no CSS cascade", () => {
    for (const t of AD_TEMPLATES) {
      for (const ratio of AD_RATIOS) {
        expect(JSON.stringify(specFor(t.id, ratio))).not.toContain("var(");
      }
    }
  });

  it("⚠️ never leaves an explicitly-undefined style value", () => {
    // Satori throws "Cannot read properties of undefined (reading 'trim')"
    // from a minified parser with no property name in it.
    for (const t of AD_TEMPLATES) {
      const spec = specFor(t.id, "4x5");
      walk(spec.root, (n) => {
        if (n.kind === "box" || n.kind === "text" || n.kind === "rich") {
          const rendered = renderSpec(n) as { props: { style?: Record<string, unknown> } };
          for (const [k, v] of Object.entries(rendered.props.style ?? {})) {
            expect(v, `${t.id} ${k}`).not.toBeUndefined();
          }
        }
      });
    }
  });

  it("names the audience on the card — T8's headline does not", () => {
    for (const t of AD_TEMPLATES) {
      expect(flattenSpecText(specFor(t.id, "4x5").root)).toContain(t.addressedTo);
    }
  });

  it("puts T6's fixed footer on the card, and nobody else's", () => {
    const t6 = templateById("rules-keep-changing")!;
    expect(flattenSpecText(specFor("rules-keep-changing", "4x5").root)).toContain(t6.footerLine);
    expect(flattenSpecText(specFor("years-properties-review", "4x5").root)).not.toContain("Responsibility stays");
  });

  it("⚠️ shows only ticked items on the checklist templates", () => {
    const flat = flattenSpecText(specFor("rules-keep-changing", "4x5").root);
    expect(flat).toContain("Licensing");
    expect(flat).toContain("Insurance");
    expect(flat).not.toContain("Registration");
    expect(flat).not.toContain("Fire safety");
  });

  it("⚠️ renders T8's review score WITH its count, as the spec requires", () => {
    const flat = flattenSpecText(specFor("years-properties-review", "4x5").root);
    expect(flat).toContain("4.9");
    expect(flat).toContain("from 63 reviews");
  });
});

describe("⚠️ 9:16 is not 4:5 stretched", () => {
  it("reserves the Stories chrome top and bottom", () => {
    const story = RATIO_GEOMETRY["9x16"];
    const feed = RATIO_GEOMETRY["4x5"];
    expect(story.inset.t).toBeGreaterThan(feed.inset.t * 3);
    expect(story.inset.b).toBeGreaterThan(feed.inset.b * 4);
    // Roughly Meta's reserved bands: ~14% top, ~20% bottom of 1920.
    expect(story.inset.t / 1920).toBeGreaterThan(0.12);
    expect(story.inset.b / 1920).toBeGreaterThan(0.18);
  });

  it("leaves a usable band on every ratio", () => {
    for (const ratio of AD_RATIOS) {
      const { inset } = RATIO_GEOMETRY[ratio];
      const usable = AD_RATIO_SIZES[ratio].height - inset.t - inset.b;
      expect(usable, ratio).toBeGreaterThan(900);
    }
  });
});

describe("⚠️ readability against the ACTUAL ground, not against white", () => {
  it("leaves a colour that already clears the bar alone", () => {
    expect(readableOn("#111827", "#ffffff", AA_BODY)).toBe("#111827");
  });

  it("darkens an accent that fails on a tinted panel", () => {
    // derivePalette checks the accent against WHITE only; a light or paper
    // card with small accent type on a tinted panel is T3, T6 and T7.
    const pale = "#8fd0ff";
    const fixed = readableOn(pale, "#faf7f1", AA_BODY);
    expect(contrastRatio(pale, "#faf7f1")).toBeLessThan(AA_BODY);
    expect(contrastRatio(fixed, "#faf7f1")).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("lightens against a dark ground instead", () => {
    const dark = "#1d2b53";
    const fixed = readableOn(dark, AD_THEMES.dark.ground, AA_DISPLAY);
    expect(contrastRatio(fixed, AD_THEMES.dark.ground)).toBeGreaterThanOrEqual(AA_DISPLAY);
  });

  it("every theme's own body text clears AA on its own ground", () => {
    for (const [name, th] of Object.entries(AD_THEMES)) {
      expect(contrastRatio(th.ink, th.ground), `${name} ink`).toBeGreaterThanOrEqual(AA_BODY);
      expect(contrastRatio(th.muted, th.ground), `${name} muted`).toBeGreaterThanOrEqual(AA_BODY);
      expect(contrastRatio(th.muted, th.panel), `${name} muted on panel`).toBeGreaterThanOrEqual(AA_BODY);
    }
  });
});

describe("⚠️ sizing, not truncating", () => {
  it("steps the font down as the text gets longer", () => {
    expect(fontStep("short", [64, 56, 48], [58, 84])).toBe(64);
    expect(fontStep("x".repeat(70), [64, 56, 48], [58, 84])).toBe(56);
    expect(fontStep("x".repeat(120), [64, 56, 48], [58, 84])).toBe(48);
  });

  it("measures the text a reader SEES, not the emphasis markers", () => {
    expect(fontStep("*" + "x".repeat(56) + "*", [64, 56, 48], [58, 84])).toBe(64);
  });

  it("⚠️ does not cut T6's council list, where the list IS the claim", () => {
    const flat = flattenSpecText(specFor("rules-keep-changing", "1x1").root);
    expect(flat).toContain("Harrogate");
  });
});

describe("⚠️ the figure check reads the IMAGE", () => {
  it("T7's card carries no figure at all", () => {
    // "property fields filled" cannot mean filled with numbers: a specific
    // figure in the creative is a claim regardless of the disclaimer beneath.
    const flat = flattenSpecText(specFor("what-would-it-earn", "4x5").root);
    expect(flat).toContain("Postcode");
    expect(flat).toContain("Waiting on your postcode");
    expect(flat).not.toMatch(/[£$€]\s*\d/);
  });

  it("T8's three numbers all come from the customer's own slots", () => {
    const t8 = templateById("years-properties-review")!;
    const allowed = allowedFigures({
      template: t8,
      slots: { years_trading: "8", properties_managed: "140", review_score: "4.9", review_count: "63" } as never,
      profile: {},
      targeting: { kind: "areas", areas: ["LS"] },
      fixed: { headline: "", sub: "" },
    });
    const flat = flattenSpecText(specFor("years-properties-review", "4x5").root);
    expect(figuresAreSupplied(flat, allowed).ok).toBe(true);
    expect(figuresAreSupplied(flat.replace("140", "400"), allowed).ok).toBe(false);
  });
});

describe("⚠️ renderSpec and the flex guard", () => {
  const props = (n: SpecNode) => (renderSpec(n) as { props: Record<string, unknown> }).props;

  it("puts display:flex on every non-text node, unconditionally", () => {
    // The guard is `typeof children !== "string"`, not "more than one child",
    // so one span throws and so do two bare strings.
    for (const t of AD_TEMPLATES) {
      walk(specFor(t.id, "4x5").root, (n) => {
        if (n.kind === "box" || n.kind === "rich" || n.kind === "tick") {
          expect((props(n).style as { display?: string }).display, `${t.id} ${n.kind}`).toBe("flex");
        }
      });
    }
  });

  it("leaves a text node as a plain block with a single string child", () => {
    const el = renderSpec({ kind: "text", text: "hello", style: { fontSize: 20 } }) as {
      props: { children: unknown; style: Record<string, unknown> };
    };
    expect(typeof el.props.children).toBe("string");
    expect(el.props.style.display).toBeUndefined();
  });

  it("⚠️ builds a rich node as word spans, which is what keeps the spaces", () => {
    const el = renderSpec({
      kind: "rich", source: "a *b* c.", style: {}, emphasisStyle: { color: "#f00" }, space: 9,
    }) as { props: { children: unknown[] } };
    expect(el.props.children).toHaveLength(3);
  });

  it("⚠️ draws the tick rather than typing it", () => {
    const el = renderSpec({ kind: "tick", size: 26, colour: "#2f6fed" }) as {
      props: { children?: unknown; style: Record<string, string> };
    };
    expect(el.props.children).toBeUndefined();
    expect(el.props.style.transform).toContain("rotate");
    expect(el.props.style.borderRight).toContain("#2f6fed");
  });

  it("⚠️ gives an image explicit width, height and objectFit", () => {
    const el = renderSpec({ kind: "image", src: "data:image/png;base64,AA", width: 48, height: 48, style: {} }) as {
      props: { width: number; height: number; style: Record<string, string> };
    };
    expect(el.props.width).toBe(48);
    expect(el.props.height).toBe(48);
    expect(el.props.style.objectFit).toBe("contain");
  });

  it("returns a real React element for the whole tree", () => {
    const el = renderSpec(specFor("years-properties-review", "4x5").root);
    expect(el).toEqual(expect.objectContaining({ type: "div" }));
    expect(createElement("div", null, el)).toBeTruthy();
  });
});

describe("⚠️ a failed render is a clean 200 with no body", () => {
  it("refuses zero bytes, non-PNG bytes and a suspiciously small PNG", () => {
    expect(checkRenderedBytes(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
    expect(checkRenderedBytes(Buffer.from("not a png at all, but long enough".repeat(400))))
      .toEqual({ ok: false, reason: "not_png" });
    expect(checkRenderedBytes(Buffer.concat([PNG_MAGIC, Buffer.alloc(100)])))
      .toEqual({ ok: false, reason: "too_small" });
  });

  it("accepts a plausible one", () => {
    expect(checkRenderedBytes(Buffer.concat([PNG_MAGIC, Buffer.alloc(AD_CREATIVE_MIN_BYTES)])))
      .toEqual({ ok: true });
  });
});
