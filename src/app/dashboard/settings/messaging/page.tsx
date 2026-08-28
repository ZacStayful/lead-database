/**
 * Messaging setup (§28) — where "Begin setup" from a lead lands.
 *
 * A page of its own rather than a card on /dashboard/settings, because seven
 * DNS records need room to breathe and because the flow deep-links into it with
 * ?channel= and ?return=.
 */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct } from "@/lib/products";
import { getEmailDomain, getWhatsappConnection, messagingEnabled } from "@/lib/messaging/service";
import { MessagingSetupPanel } from "@/components/dashboard/MessagingSetupPanel";

export const dynamic = "force-dynamic";

/** A sensible default for the wizard's "your website domain" field. */
function domainFromEmail(email: string | null | undefined): string | null {
  const at = (email ?? "").split("@")[1];
  if (!at) return null;
  const free = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.co.uk"];
  return free.includes(at.toLowerCase()) ? null : at.toLowerCase();
}

export default async function MessagingSettingsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const holdsAny =
    holdsProduct(customer, "management") || holdsProduct(customer, "guaranteed_rent");
  if (!holdsAny) redirect("/dashboard/settings");

  const admin = createAdminClient();

  // Hidden from ordinary customers until messaging_enabled is flipped. Admins
  // reach it throughout, which is what makes a production rehearsal possible.
  if (!(await messagingEnabled(admin)) && !isAdminUser(user)) {
    redirect("/dashboard/settings");
  }

  const [domain, whatsapp] = await Promise.all([
    getEmailDomain(admin, customer.id),
    getWhatsappConnection(admin, customer.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <Link
          href="/dashboard/settings"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Messaging</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Send emails and WhatsApp messages to landlords from inside a lead, and
          see their replies here.
        </p>
      </div>

      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <MessagingSetupPanel
          initialDomain={domain}
          initialWhatsapp={whatsapp}
          companyDomainGuess={domainFromEmail(customer.email)}
        />
      </Suspense>
    </div>
  );
}
