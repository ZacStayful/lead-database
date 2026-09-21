import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdChat, type ChatQuestion } from "@/components/dashboard/ads/AdChat";
import { AdCreatives } from "@/components/dashboard/ads/AdCreatives";
import { adContext } from "@/lib/ads/context";
import { canSimplify } from "@/lib/ads/schemas";
import { loadDraft } from "@/lib/ads/session";
import { signCreative } from "@/lib/ads/storeCreative";
import { AD_TEMPLATES, templateById } from "@/lib/ads/templates";

export const dynamic = "force-dynamic";

/** One ad: the questions, then the words, then the images (§65). */
export default async function AdDraftPage({ params }: { params: { id: string } }) {
  const { user, customer, viewAs } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const draft = await loadDraft(admin, customer.id, params.id);
  if (!draft) notFound();

  const template = draft.template_id ? templateById(draft.template_id) : null;
  const { data } = await admin
    .from("ad_creatives")
    .select("ratio, path, size_bytes")
    .eq("draft_id", draft.id)
    .eq("customer_id", customer.id);

  const creatives = await Promise.all(
    (data ?? []).map(async (row) => {
      const r = row as { ratio: string; path: string; size_bytes: number };
      return {
        ratio: r.ratio,
        sizeBytes: r.size_bytes,
        // A 60-second link, minted per render of this page — never a stored URL.
        url: await signCreative(admin, r.path),
      };
    })
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <p className="text-xs text-[#6b706a]">
        <Link href="/dashboard/ads" className="underline">
          ← All your ads
        </Link>
      </p>

      <AdChat
        draftId={draft.id}
        initialPrompt={draft.prompt}
        templateId={draft.template_id}
        templateReason={draft.template_reason}
        questions={(draft.questions ?? []) as ChatQuestion[]}
        questionsVersion={draft.questions_version}
        status={draft.status}
        copy={draft.copy}
        fixed={template ? adContext(customer, template).ctx.fixed : null}
        canSimplify={canSimplify(draft.questions ?? [])}
        templates={AD_TEMPLATES.map((t) => ({ id: t.id, name: t.name, audience: t.audience }))}
        readOnly={viewAs !== null}
      />

      {draft.status === "failed" ? (
        <p className="rounded-lg border border-[#f0d9b8] bg-[#fdf8ef] px-3 py-2 text-xs text-[#7a5312]">
          That one did not finish. Try sending the answers again.
        </p>
      ) : null}

      {creatives.length ? <AdCreatives draftId={draft.id} creatives={creatives} /> : null}
    </div>
  );
}
