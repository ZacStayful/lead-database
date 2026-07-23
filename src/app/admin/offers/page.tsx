import { createAdminClient } from "@/lib/supabase/admin";
import { PostCallOfferPanel } from "@/components/admin/PostCallOfferPanel";
import type { PostCallOffer } from "@/lib/postCallOffers";

export const dynamic = "force-dynamic";

export default async function AdminOffersPage() {
  const admin = createAdminClient();
  const { data } = await admin
    .from("post_call_offers")
    .select("*")
    .order("created_at", { ascending: false });
  const offers = (data ?? []) as PostCallOffer[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Post-call offers</h1>
        <p className="text-sm text-muted-foreground">
          Single-use 10%-off discount links generated after web meetings —
          manually here, or automatically when a prospect enters the “Web meeting
          sat” group in Monday.
        </p>
      </div>
      <PostCallOfferPanel offers={offers} />
    </div>
  );
}
