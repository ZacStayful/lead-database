import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { holdsProduct } from "@/lib/products";
import { Card, CardContent } from "@/components/ui/card";
import { AddLeadsPanel } from "@/components/dashboard/AddLeadsPanel";
import type { LeadType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Bring your own leads: a spreadsheet import, or one at a time by hand.
 *
 * The leads created here belong to this customer alone. They are never pooled,
 * never escalated and never offered to another operator (enforced in the
 * database by migration 0102), which is what makes the platform usable as the
 * customer's own lead database rather than only a delivery channel.
 */
export default async function AddLeadsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const holdsManagement = holdsProduct(customer, "management");
  const holdsGuaranteedRent = holdsProduct(customer, "guaranteed_rent");

  const available: LeadType[] = [
    ...(holdsManagement ? (["management"] as const) : []),
    ...(holdsGuaranteedRent ? (["guaranteed_rent"] as const) : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Add your own leads</h1>
        <p className="text-sm text-muted-foreground">
          Bring landlord enquiries you have found yourself into the database, so
          you can work them alongside the leads we send you.
        </p>
      </div>

      {available.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h2 className="text-lg font-semibold">
              You need an active subscription to add leads
            </h2>
            <p className="text-sm text-muted-foreground">
              Adding your own leads is free and unlimited, but it uses the same
              pipeline, notes and analytics as your subscription. Once your
              management or guaranteed rent package is live, this page will let
              you import a spreadsheet or add leads one at a time.
            </p>
            <p className="text-sm text-muted-foreground">
              If you think this is wrong, get in touch from the Support page and
              we will sort it out.
            </p>
          </CardContent>
        </Card>
      ) : (
        <AddLeadsPanel available={available} />
      )}
    </div>
  );
}
