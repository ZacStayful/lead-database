import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { FeedbackForm } from "@/components/FeedbackForm";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

/** Cap on the ?page= prefill. Tidiness, not a security boundary: the value is
 *  escaped on its way into the email and never stored. */
const MAX_PAGE_PREFILL = 80;

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: { type?: string; page?: string };
}) {
  const initialType = searchParams.type === "bug" ? "bug" : "feature";

  // Which screen the request came from, when a link says so — the announcement
  // banner and email both pass ?page=Announcement, which is what tells the team
  // inbox that this button is doing something.
  //
  // ⚠️ On a FEATURE request this value is never shown: FeedbackForm renders the
  // "Which page or screen?" input under `isBug &&`, so the field is bug-only.
  // The value is still seeded into form state and still posted — the submit body
  // is `{ type, ...form }` — so `Page: Announcement` reaches the team email
  // either way. Verified end to end against the real form. That is deliberate:
  // the attribution is ours, not a question we are asking the customer, and
  // surfacing a prefilled box they did not fill would only invite them to
  // wonder about it. Do not "fix" this by widening the field to feature
  // requests without deciding you want that box on the feature form.
  //
  // Guarded on typeof: a repeated ?page=a&page=b arrives as string[] at runtime,
  // and the declared type above does not stop that. The sibling `type` handling
  // gets away with it only because it compares against a literal.
  const pagePrefill =
    typeof searchParams.page === "string"
      ? searchParams.page.trim().slice(0, MAX_PAGE_PREFILL)
      : "";

  // Prefill from the signed-in customer, if there is one.
  const { customer } = await getCurrentCustomer();
  const defaults =
    customer || pagePrefill
      ? {
          name: customer?.contact_name,
          email: customer?.email,
          business: customer?.business_name,
          page: pagePrefill || undefined,
        }
      : undefined;

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link href="/" aria-label="Stayful home" className="mb-8 flex justify-center">
        <Logo height={32} priority />
      </Link>
      <h1 className="text-center text-2xl font-bold">
        {initialType === "bug" ? "Report a bug" : "Request a feature"}
      </h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
        Tell us what you need and we&apos;ll get it actioned. The more detail,
        the faster we can build the fix or feature.
      </p>
      <div className="mt-8">
        <FeedbackForm initialType={initialType} defaults={defaults} />
      </div>
    </main>
  );
}
