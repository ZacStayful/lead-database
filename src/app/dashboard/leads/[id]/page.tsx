import { notFound, redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadLeadWorkspace } from "@/lib/leadWorkspace";
import { LeadWorkspace } from "@/components/lead/LeadWorkspace";

export const dynamic = "force-dynamic";

/**
 * One lead's workspace (§56.7): Lead details · Thread · Activity. Everything
 * is loaded by `loadLeadWorkspace`, shared with the inbox's thread page so
 * the two screens read the same data the same way.
 */
export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { from?: string; report?: string };
}) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const data = await loadLeadWorkspace(admin, customer, params.id, {
    from: searchParams.from,
    isAdmin: isAdminUser(user),
  });
  if (!data) notFound();

  return (
    <LeadWorkspace
      data={data}
      userId={user.id}
      mode="lead"
      // The leads list deep-links here rather than carrying claim state per
      // card. Eligibility is still resolved server-side, so arriving with
      // ?report=1 on an ineligible lead opens nothing.
      openReport={searchParams.report === "1"}
      initialPane="list"
    />
  );
}
