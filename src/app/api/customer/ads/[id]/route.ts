import { AD_COPY } from "@/lib/ads/copy";
import { adJson, adSession, adWriteSession, loadDraft } from "@/lib/ads/session";
import { removeCreatives, signCreative } from "@/lib/ads/storeCreative";
import { templateById } from "@/lib/ads/templates";
import { adContext } from "@/lib/ads/context";
import { canSimplify, maxSimplify, simplifySpent } from "@/lib/ads/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One draft (§65).
 *
 * ⚠️ NO MODEL CALL ON THIS PATH, EVER. It is the page load and the poll, so a
 * generation here would be paid for on every refresh — and would race the one
 * the answers route is running.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const gate = await adSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  const draft = await loadDraft(admin, customer.id, params.id);
  if (!draft) return adJson({ error: "Not found" }, 404);

  const template = draft.template_id ? templateById(draft.template_id) : null;
  const { data } = await admin
    .from("ad_creatives")
    .select("ratio, path, size_bytes")
    .eq("draft_id", draft.id)
    .eq("customer_id", customer.id);

  const creatives = await Promise.all(
    (data ?? []).map(async (row) => {
      const r = row as { ratio: string; path: string; size_bytes: number };
      return { ratio: r.ratio, size_bytes: r.size_bytes, url: await signCreative(admin, r.path) };
    })
  );

  return adJson({
    draft: {
      id: draft.id,
      prompt: draft.prompt,
      status: draft.status,
      template_id: draft.template_id,
      template_reason: draft.template_reason,
      questions: draft.questions,
      questions_version: draft.questions_version,
      copy: draft.copy,
      error: draft.error,
      created_at: draft.created_at,
      budgets: {
        template_switches: draft.template_switches,
        regenerations: draft.regenerations,
        renders: draft.renders,
        simplify_spent: simplifySpent(draft.questions ?? []),
        simplify_max: maxSimplify((draft.questions ?? []).length),
        can_simplify: canSimplify(draft.questions ?? []),
      },
    },
    template: template
      ? { id: template.id, name: template.name, audience: template.audience }
      : null,
    // What the image will say, so the chat can show it before it is rendered.
    fixed: template ? adContext(customer, template).ctx.fixed : null,
    creatives,
  });
}

/**
 * ⚠️ OBJECTS FIRST, THEN THE ROW. `ad_creatives` cascades from `ad_drafts`, so
 * deleting the draft first destroys the only list of which objects exist —
 * and this is the first bucket here where an object can outlive its only
 * pointer. The tombstone trigger catches a delete that fails halfway; this
 * ordering is what stops it happening.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const gate = await adWriteSession();
  if (!gate.ok) return gate.response;
  const { admin, customer } = gate.session;

  const draft = await loadDraft(admin, customer.id, params.id);
  if (!draft) return adJson({ error: "Not found" }, 404);

  const removal = await removeCreatives(admin, { customerId: customer.id, draftId: draft.id });

  const { error } = await admin
    .from("ad_drafts")
    .delete()
    .eq("id", draft.id)
    .eq("customer_id", customer.id);
  if (error) {
    console.error("ads: could not delete draft", error.message);
    return adJson({ error: AD_COPY.errors.generic }, 500);
  }

  return adJson({ deleted: true, objects_removed: removal.removed, objects_failed: removal.failed });
}
