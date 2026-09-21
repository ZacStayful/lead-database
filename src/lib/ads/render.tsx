import { createElement, type ReactElement } from "react";
import { ImageResponse } from "next/og";
import { AD_FONTS } from "./fonts";
import { emphasisWords } from "./emphasis";
import { checkRenderedBytes, type RenderFailure } from "./storagePaths";
import type { LayoutSpec, SatoriStyle, SpecNode } from "./layout";

/**
 * The only file in the repository that imports `next/og` (§65).
 *
 * ⚠️ AND IT MUST STAY THAT WAY. `next/og` drags in resvg.wasm and yoga.wasm —
 * about 2 MB — and they fail at FIRST INVOCATION with MODULE_NOT_FOUND rather
 * than at deploy, so a stray import from a shared module is a bundle that
 * builds, deploys, and then 500s on a page that has nothing to do with ads. A
 * guard greps the tree for it.
 */

/**
 * ⚠️ EVERY NON-TEXT NODE GETS `display: flex`, UNCONDITIONALLY.
 *
 * Satori's guard, read out of the shipped bundle, is:
 *
 *   if (h === "div" && v && typeof v != "string" && P !== "flex" && P !== "none")
 *     throw new Error('Expected <div> to have explicit "display: flex" …
 *                      if it has more than one child node.')
 *
 * Its message is a lie. The test is `typeof children !== "string"`, so ONE
 * `<span>` child throws, and so do two bare strings — which means
 * `<div>Landlords in {city}</div>` throws, because JSX interpolation makes
 * that an array. All three were proven by execution in step 1.
 *
 * ⚠️ `<span>` IS EXEMPT — the guard tests `h === "div"` only — and that
 * exemption is the entire reason the emphasis engine can put sub-spans inside
 * a word.
 */
function flexed(style: SatoriStyle): SatoriStyle {
  return pruned({ display: "flex", ...style });
}

/**
 * ⚠️ AN EXPLICITLY-UNDEFINED STYLE VALUE CRASHES SATORI, and the message tells
 * you nothing: `Cannot read properties of undefined (reading 'trim')`, thrown
 * from a minified style parser with no property name in it. A conditional like
 * `borderBottom: last ? undefined : "2px solid #eee"` is completely ordinary
 * React and completely fatal here, so the keys are dropped centrally rather
 * than at every call site that might grow one.
 */
function pruned(style: SatoriStyle): SatoriStyle {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style)) if (v !== undefined) out[k] = v;
  return out as SatoriStyle;
}

export function renderSpec(node: SpecNode, key?: number): ReactElement {
  switch (node.kind) {
    case "text":
      // A single string child does not trip the guard, so this stays a plain
      // block and keeps satori's ordinary text layout.
      return createElement("div", { key, style: pruned(node.style) }, node.text);

    case "rich": {
      const words = emphasisWords(node.source);
      return createElement(
        "div",
        { key, style: flexed(node.style) },
        ...words.map((segments, i) =>
          createElement(
            "span",
            { key: i, style: { marginRight: node.space } },
            ...segments.map((seg, j) =>
              seg.emphasised
                ? createElement("span", { key: j, style: node.emphasisStyle }, seg.text)
                : seg.text
            )
          )
        )
      );
    }

    case "image":
      // ⚠️ Explicit width AND height, plus objectFit. Satori's default is
      // `none`, and PresentationBrand stores no dimensions to fall back on.
      return createElement("img", {
        key,
        src: node.src,
        width: node.width,
        height: node.height,
        style: pruned({ objectFit: "contain", ...node.style }),
      });

    case "tick":
      // ⚠️ DRAWN, NOT TYPED. U+2713 is in none of the three faces, and a glyph
      // no registered font has makes satori fetch one from Google mid-render
      // — a 400, a tofu box, and a perfectly valid PNG.
      return createElement("div", {
        key,
        style: {
          display: "flex",
          width: Math.round(node.size * 0.55),
          height: node.size,
          borderRight: `${Math.max(3, Math.round(node.size * 0.18))}px solid ${node.colour}`,
          borderBottom: `${Math.max(3, Math.round(node.size * 0.18))}px solid ${node.colour}`,
          transform: "rotate(45deg)",
        },
      });

    default:
      return createElement(
        "div",
        { key, style: flexed(node.style) },
        ...node.children.map((child, i) => renderSpec(child, i))
      );
  }
}

export type RenderResult = { ok: true; bytes: Buffer } | { ok: false; reason: RenderFailure; size: number };
export type { RenderFailure };

/**
 * ⚠️ A FAILED RENDER IS A CLEAN 200 WITH AN EMPTY BODY, NOT A THROW.
 *
 * `ImageResponse` does all of its work inside the stream's `start()`, so the
 * constructor never throws synchronously — and when satori produces nothing,
 * `if (!imageResponse.body) return controller.close()` closes the stream
 * CLEANLY. `await res.arrayBuffer()` then resolves to zero bytes and every
 * `try/catch` in the world sees success.
 *
 * So the bytes are checked here rather than trusted: the PNG magic number and
 * a floor. Every real render in step 1 came out between 71 KB and 92 KB.
 */
export async function renderAdImage(spec: LayoutSpec): Promise<RenderResult> {
  const element = renderSpec(spec.root);
  const response = new ImageResponse(element, {
    width: spec.width,
    height: spec.height,
    fonts: AD_FONTS,
  });
  const bytes = Buffer.from(await response.arrayBuffer());

  const verdict = checkRenderedBytes(bytes);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, size: bytes.length };
  return { ok: true, bytes };
}
