import { redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { PresentationSettingsCard } from "@/components/dashboard/PresentationSettingsCard";
import { PresentationBrandCard } from "@/components/dashboard/PresentationBrandCard";
import { validatePresentationSettings } from "@/lib/presentationSettings";
import { validatePresentationBrand } from "@/lib/presentationBrand";
import { brandLogoDataUrl } from "@/lib/presentationBrandStorage";
import { ApiAccessPanel, type ApiKeyRow } from "@/components/dashboard/ApiAccessPanel";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getEmailDomain, getWhatsappConnection, messagingEnabled } from "@/lib/messaging/service";
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
  // §28 messaging connection state, for the status pills on the card below.
  let emailDomain: Awaited<ReturnType<typeof getEmailDomain>> = null;
  let whatsappConnection: Awaited<ReturnType<typeof getWhatsappConnection>> = null;
  let showMessaging = false;

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

    // §28 is hidden from ordinary customers until messaging_enabled is flipped;
    // admins see it throughout so the flow can be tested on production first.
    showMessaging = (await messagingEnabled(admin)) || isAdminUser(user);
    if (showMessaging) {
      [emailDomain, whatsappConnection] = await Promise.all([
        getEmailDomain(admin, customer.id),
        getWhatsappConnection(admin, customer.id),
      ]);
    }
  }

  const brand = validatePresentationBrand(customer.presentation_brand);
  // Read here rather than in an effect, so the card renders with the logo
  // already on screen instead of flashing an empty preview.
  const brandLogoUrl = await brandLogoDataUrl(brand);

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
        Branding is for ANY subscriber, which is why it sits outside the
        management gate below rather than inside it. The presentation a lead
        seeds is management-only (invariant 6), but a GR operator opens the
        blank tool from Documents and their logo is theirs either way (0112).

        Gated on holding a product, like API access above it — and for the same
        reason that gate is about CREATING rather than using: the routes stay
        open to any customer row, so somebody who later cancels does not have
        their logo pulled out from under a presentation mid-meeting.
      */}
      {holdsAny && (
        <PresentationBrandCard initial={brand} initialLogoUrl={brandLogoUrl} />
      )}

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

      {/*
        Messaging (§28). A link rather than an inline card: the setup needs room
        for seven DNS records, and the same page is deep-linked from a lead's
        "Begin setup" button with ?channel= and ?return=.
      */}
      {showMessaging && (
        <Card>
          <CardHeader>
            <CardTitle>Messaging</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Send emails and WhatsApp messages to landlords from inside a lead,
              from your own domain and your own number, and see their replies here.
            </p>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full border px-3 py-1">
                Email: {emailDomain?.status === "verified" ? "connected" : emailDomain ? "setup started" : "not set up"}
              </span>
              <span className="rounded-full border px-3 py-1">
                WhatsApp: {whatsappConnection?.status === "connected" ? "connected" : "not set up"}
              </span>
            </div>
            <Button asChild variant="outline">
              <Link href="/dashboard/settings/messaging">
                {emailDomain || whatsappConnection ? "Manage messaging" : "Set up messaging"}
              </Link>
            </Button>
          </CardContent>
        </Card>
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
