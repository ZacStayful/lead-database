/**
 * The monthly batch review, opened from the email with no login (§73).
 *
 * The token is the authorisation and opens exactly one review. A bad or expired
 * token gets one page saying so with a sign-in link, and the same answer either
 * way, so the page cannot be used to probe which tokens existed.
 */
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadReview, reviewByToken, reviewResults } from "@/lib/batchReview/review";
import { BatchReviewView } from "@/components/batchReview/BatchReviewView";
import { productLabel } from "@/lib/topup";

export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <Link href="/" aria-label="Stayful home" className="mb-6 flex justify-center">
          <Logo height={36} priority />
        </Link>
        {children}
      </div>
    </main>
  );
}

export default async function BatchReviewTokenPage({ params }: { params: { token: string } }) {
  const admin = createAdminClient();
  const lookup = await reviewByToken(admin, params.token);

  if (lookup.status !== "valid") {
    return (
      <Shell>
        <div className="rounded-xl border border-black/10 bg-white p-8 text-center">
          <h1 className="mb-3 text-lg font-semibold">This link has expired</h1>
          <p className="text-sm text-muted-foreground">
            Review links last a few weeks. Sign in to see your leads and update their stages there.
          </p>
          <Link href="/login" className="mt-4 inline-block text-sm font-medium underline">
            Sign in
          </Link>
        </div>
      </Shell>
    );
  }

  const loaded = await loadReview(admin, lookup.review);
  if (!loaded) {
    return (
      <Shell>
        <div className="rounded-xl border border-black/10 bg-white p-8 text-center">
          <h1 className="mb-3 text-lg font-semibold">We couldn&apos;t load your leads just now</h1>
          <p className="text-sm text-muted-foreground">Please try again in a minute.</p>
        </div>
      </Shell>
    );
  }
  const results = loaded.review.submitted_at ? await reviewResults(admin, loaded.review, loaded.items) : null;

  return (
    <Shell>
      <div className="rounded-xl border border-black/10 bg-white p-6">
        <BatchReviewView
          loaded={loaded}
          results={results}
          productLabel={productLabel(loaded.review.lead_type)}
          submitUrl={`/api/review/${params.token}`}
          leadHrefBase="/l/"
        />
      </div>
    </Shell>
  );
}
