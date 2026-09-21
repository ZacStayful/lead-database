import { AD_COPY } from "@/lib/ads/copy";
import { adContext, preflight } from "@/lib/ads/context";
import { validatePresentationBrand } from "@/lib/presentationBrand";
import { brandLogoDataUrl } from "@/lib/presentationBrandStorage";
import { figuresAreSupplied, allowedFigures } from "@/lib/ads/validateAdCopy";
import { flattenSpecText, layoutInputFrom, layoutSpec } from "@/lib/ads/layout";
import { renderAdImage } from "@/lib/ads/render";
import { adJson, adWriteSession, loadDraft, spendBudget } from "@/lib/ads/session";
import { signCreative, storeCreative } from "@/lib/ads/storeCreative";
import { AD_RATIOS } from "@/lib/ads/storagePaths";
import { DEFAULT_TEMPLATE_ID, templateById } from "@/lib/ads/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The three statics (§65).
 *
 * ⚠️ IT NEVER RETURNS AN `ImageResponse`. That class self-sets
 * `cache-control: public, immutable, max-age=31536000`, so a regenerable
 * creative served straight out of one would be cached by every proxy between
 * here and the operator for a year — and their second render would never
 * reach them.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  const draft = await loadDraft(admin, customer.id, params.id);
  if (!draft) return adJson({ error: "Not found" }, 404);
  if (draft.status !== "ready" || !draft.copy) {
    return adJson({ error: "There is no advert to draw yet." }, 409);
  }

  const template = templateById(draft.template_id ?? DEFAULT_TEMPLATE_ID)!;
  const context = adContext(customer, template);
  // ⚠️ THE SAME SENTENCE THE ANSWERS ROUTE GIVES. This showed only `generic`
  // for the identical condition, so which explanation a customer met depended
  // on where they were standing — and neither said what to do about it.
  const check = preflight(context);
  if (!check.ok) {
    return adJson(
      { error: AD_COPY.errors.unresolved(check.labels), code: "unresolved", missing: check.missing },
      409
    );
  }

  const spent = await spendBudget(admin, customer.id, draft.id, "render");
  if (spent === null) {
    return adJson({ error: AD_COPY.errors.renders, code: "render_cap" }, 429);
  }

  // ⚠️ A `data:` URI, NEVER A SIGNED URL. The tool this borrows from vendors
  // React locally so it survives a bad network; a signed URL puts back a
  // second request to a host that may be unreachable, for an asset that
  // EXPIRES on a clock — so the failure lands mid-render rather than up front.
  const logo = await brandLogoDataUrl(validatePresentationBrand(customer.presentation_brand));

  const results: Array<{ ratio: string; ok: boolean; url: string | null; reason?: string }> = [];
  for (const ratio of AD_RATIOS) {
    const spec = layoutSpec(
      layoutInputFrom({
        template,
        ratio,
        accent: context.accent,
        logo,
        slots: context.resolution.slots,
        selected: context.selected,
        headline: context.ctx.fixed.headline,
        sub: context.ctx.fixed.sub,
        cta: context.cta,
      })
    );

    // ⚠️ THE FIGURE CHECK RUNS OVER THE IMAGE TOO. Every other rule reads copy,
    // but a card renders values of its own — and a "Current rent: £950/mo" put
    // there to look concrete is a figure, in the creative, from nobody, which
    // never passes through the model at all.
    const figures = figuresAreSupplied(flattenSpecText(spec.root), allowedFigures(context.ctx));
    if (!figures.ok) {
      console.error(`ads/render: refusing ${ratio} — ${figures.detail}`);
      results.push({ ratio, ok: false, url: null, reason: "figure_not_in_slots" });
      continue;
    }

    const rendered = await renderAdImage(spec);
    if (!rendered.ok) {
      results.push({ ratio, ok: false, url: null, reason: rendered.reason });
      continue;
    }

    const stored = await storeCreative(admin, {
      customerId: customer.id,
      draftId: draft.id,
      ratio,
      bytes: rendered.bytes,
    });
    if (!stored.ok) {
      // ⚠️ A FAILED UPLOAD NEVER COSTS THE COPY (§25). The words are already
      // stored; the operator gets a Retry rather than a failed advert.
      results.push({ ratio, ok: false, url: null, reason: stored.reason });
      continue;
    }
    results.push({ ratio, ok: true, url: await signCreative(admin, stored.path) });
  }

  return adJson({ creatives: results, renders_used: spent });
}
