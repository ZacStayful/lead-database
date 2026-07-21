import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { SupportForm } from "@/components/SupportForm";

export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");

  const defaults = customer
    ? {
        name: customer.contact_name,
        email: customer.email,
        business: customer.business_name,
      }
    : undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Support</h1>
        <p className="text-sm text-muted-foreground">
          Need help? Send the Stayful team a message and we&apos;ll get back to
          you by email.
        </p>
      </div>
      <SupportForm defaults={defaults} />
    </div>
  );
}
