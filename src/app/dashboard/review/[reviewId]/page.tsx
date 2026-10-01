/**
 * The monthly batch review inside the dashboard (§73), reached from the home
 * card. Same body as the one-tap link page, behind the session, and it follows
 * an admin's view-as like every other dashboard page (§62).
 */
import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadReview, reviewForCustomer, reviewResults } from "@/lib/batchReview/review";
import { BatchReviewView } from "@/components/batchReview/BatchReviewView";
import { productLabel } from "@/lib/topup";

export const dynamic = "force-dynamic";

export default async function DashboardBatchReviewPage({ params }: { params: { reviewId: string } }) {
  const { customer } = await getCurrentCustomer();
  if (!customer) redirect("/login");

  const admin = createAdminClient();
  const review = await reviewForCustomer(admin, params.reviewId, customer.id);
  if (!review) notFound();

  const loaded = await loadReview(admin, review);
  if (!loaded) {
    return <p className="text-sm text-muted-foreground">We couldn&apos;t load your leads just now. Please try again in a minute.</p>;
  }
  const results = review.submitted_at ? await reviewResults(admin, review, loaded.items) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <BatchReviewView
        loaded={loaded}
        results={results}
        productLabel={productLabel(review.lead_type)}
        submitUrl={`/api/customer/batch-review/${review.id}`}
        leadHrefBase="/dashboard/leads/"
      />
    </div>
  );
}
