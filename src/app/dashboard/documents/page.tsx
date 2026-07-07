import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { CompanyLetAgreement } from "@/components/dashboard/CompanyLetAgreement";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const hasGuaranteedRent = customer.gr_subscription_status === "active";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Templates and agreements available with your subscription.
        </p>
      </div>

      {hasGuaranteedRent ? (
        <CompanyLetAgreement />
      ) : (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            The company let tenancy agreement is included with a Guaranteed Rent
            subscription. Subscribe to Guaranteed Rent to download it.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
