import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";

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
    </div>
  );
}
