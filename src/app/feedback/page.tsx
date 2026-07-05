import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { FeedbackForm } from "@/components/FeedbackForm";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: { type?: string };
}) {
  const initialType = searchParams.type === "bug" ? "bug" : "feature";

  // Prefill from the signed-in customer, if there is one.
  const { customer } = await getCurrentCustomer();
  const defaults = customer
    ? {
        name: customer.contact_name,
        email: customer.email,
        business: customer.business_name,
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
