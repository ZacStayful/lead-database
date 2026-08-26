import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { availableLeadTypes } from "@/lib/products";
import { Card, CardContent } from "@/components/ui/card";
import { AddLeadsPanel } from "@/components/dashboard/AddLeadsPanel";
import type { LeadType } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Bring your own leads: a spreadsheet import, or one at a time by hand.
 *
 * The leads created here belong to this customer. They are never pooled and
 * never escalated (enforced in the database by 0102 and 0107), which is what
 * makes the platform usable as the customer's own lead database rather than
 * only a delivery channel.
 *
 * ⚠️ "never offered to another operator" was true until §32. One that has been
 * through a PAID analysis and come back with trustworthy figures is offered to
 * exactly ONE further operator — never back to the person who added it, and
 * never into the pool. Their own working notes do not travel with it: see
 * `viewerScopedLead`.
 */
export default async function AddLeadsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  // Held OR previously held: adding your own leads is free and survives a pause
  // or a cancellation, so the gate is "is this a pipeline you have ever run"
  // rather than "are you paying". Empty only for an account that has never held
  // anything, which is the card below.
  const available: LeadType[] = availableLeadTypes(customer);

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
              Your account isn&apos;t live yet
            </h2>
            <p className="text-sm text-muted-foreground">
              Adding your own leads is free and unlimited, and it stays free if
              you ever pause or cancel. It uses the same pipeline, notes and
              analytics as a subscription, so this page opens as soon as your
              management or guaranteed rent package goes live for the first
              time.
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
