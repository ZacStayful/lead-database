import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { PresentationSettingsCard } from "@/components/dashboard/PresentationSettingsCard";
import { validatePresentationSettings } from "@/lib/presentationSettings";
import { ApiAccessPanel, type ApiKeyRow } from "@/components/dashboard/ApiAccessPanel";
import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct } from "@/lib/products";
import { recentRequestsForCustomer, usageForKeys } from "@/lib/api/usage";
import { APP_URL } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  // API access is offered to anyone holding a product. Note the asymmetry that
  // is deliberate: holding a product gates CREATING a key, not using one, so a
  // customer who later cancels keeps a working integration.
  const holdsAny =
    holdsProduct(customer, "management") ||
    holdsProduct(customer, "guaranteed_rent");

  let apiKeys: ApiKeyRow[] = [];
  let apiUsage: Awaited<ReturnType<typeof usageForKeys>> = {};
  let apiRecent: Awaited<ReturnType<typeof recentRequestsForCustomer>> = [];

  if (holdsAny) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("customer_api_keys")
      .select(
        "id, name, key_prefix, scopes, expires_at, created_at, last_used_at, revoked_at"
      )
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false });

    apiKeys = (data ?? []) as ApiKeyRow[];
    [apiUsage, apiRecent] = await Promise.all([
      usageForKeys(apiKeys.filter((k) => !k.revoked_at).map((k) => k.id), admin),
      recentRequestsForCustomer(customer.id, 20, admin),
    ]);
  }

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

      {holdsAny && (
        <ApiAccessPanel
          apiBaseUrl={`${APP_URL}/api/v1`}
          mcpUrl={`${APP_URL}/api/mcp`}
          initialKeys={apiKeys}
          usage={apiUsage}
          recent={apiRecent}
        />
      )}
    </div>
  );
}
