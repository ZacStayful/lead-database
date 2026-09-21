import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdChat } from "@/components/dashboard/ads/AdChat";
import { AD_TEMPLATES } from "@/lib/ads/templates";
import { adProfileOf } from "@/lib/ads/resolveSlots";

export const dynamic = "force-dynamic";

/**
 * The ad builder's front page (§65): the prompt already in the box, and
 * everything they have made underneath.
 *
 * The segment layout above this is what gates it (`notFound()` for anybody but
 * the owner), so this page does not repeat the check — one gate, one call site.
 */
export default async function AdsPage() {
  const { user, customer, viewAs } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const { data } = await admin
    .from("ad_drafts")
    .select("id, prompt, status, template_id, created_at")
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(20);

  const drafts = (data ?? []) as Array<{
    id: string;
    prompt: string;
    status: string;
    template_id: string | null;
    created_at: string;
  }>;

  const profile = adProfileOf(customer);
  const needsProfile = Object.keys(profile).length === 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <header>
        <h1 className="text-xl font-semibold text-[#1a1a19]">Make a Facebook advert</h1>
        <p className="mt-1 text-sm text-[#55564f]">
          Answer a few questions and you get the words and three images, ready to put
          in Ads Manager. Nothing is published from here.
        </p>
      </header>

      {needsProfile ? (
        <p className="rounded-xl border border-[#e4e6e0] bg-white p-4 text-sm text-[#55564f]">
          Worth doing first:{" "}
          <Link href="/dashboard/ads/profile" className="font-medium underline">
            your business details
          </Link>
          . Everything you put there stops being a question, so the second advert asks
          far less than the first.
        </p>
      ) : null}

      <AdChat
        draftId={null}
        templateId={null}
        templateReason={null}
        questions={[]}
        questionsVersion={0}
        status="new"
        copy={null}
        fixed={null}
        canSimplify={false}
        templates={AD_TEMPLATES.map((t) => ({ id: t.id, name: t.name, audience: t.audience }))}
        readOnly={viewAs !== null}
      />

      {drafts.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[#1a1a19]">Your adverts</h2>
          {drafts.map((d) => (
            <Link
              key={d.id}
              href={`/dashboard/ads/${d.id}`}
              className="block rounded-xl border border-[#e4e6e0] bg-white p-4 hover:border-[#c9ccc4]"
            >
              <p className="text-sm text-[#1a1a19]">{d.prompt}</p>
              <p className="mt-1 text-xs text-[#6b706a]">
                {statusLabel(d.status)} ·{" "}
                {new Date(d.created_at).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                })}
              </p>
            </Link>
          ))}
        </section>
      ) : null}

      <p className="text-xs text-[#6b706a]">
        <Link href="/dashboard/ads/profile" className="underline">
          Your business details
        </Link>
      </p>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "collecting":
      return "Answering questions";
    case "generating":
      return "Being written";
    case "ready":
      return "Ready";
    case "failed":
      return "Did not finish";
    default:
      return status;
  }
}
