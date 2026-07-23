import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CompanyLetAgreement } from "@/components/dashboard/CompanyLetAgreement";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const hasGuaranteedRent = customer.gr_subscription_status === "active";
  const isManagement = customer.subscription_status === "active";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Templates and agreements available with your subscription.
        </p>
      </div>

      {isManagement && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div>
              <h2 className="text-lg font-semibold">Income presentation tool</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Build a tailored income presentation to walk a landlord through
                the figures on a web meeting — the income analysis, the 12-month
                picture, the best, likely and worst cases, and how you work.
                Enter your own numbers (or bring them across from the STR
                Analyser); they&apos;re saved in your browser as you go.
              </p>
            </div>
            <Button asChild>
              <a
                href="/income-presentation/index.html"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open presentation tool
              </a>
            </Button>
          </CardContent>
        </Card>
      )}

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
