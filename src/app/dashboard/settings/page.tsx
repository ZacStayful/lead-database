import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { PresentationSettingsCard } from "@/components/dashboard/PresentationSettingsCard";
import { validatePresentationSettings } from "@/lib/presentationSettings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your subscription.
        </p>
      </div>
      <SettingsPanel customer={customer} />

      {/*
        Management only. A Guaranteed Rent operator earns the margin between the
        rent they pay and what the property makes, so a management fee and a
        management agreement are not what they sell (invariant 6).
      */}
      {customer.subscription_status === "active" && (
        <PresentationSettingsCard
          initial={validatePresentationSettings(customer.presentation_settings)}
          configured={customer.presentation_settings_updated_at != null}
        />
      )}
    </div>
  );
}
