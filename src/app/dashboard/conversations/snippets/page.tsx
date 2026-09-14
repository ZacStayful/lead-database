import { redirect } from "next/navigation";
import { getCurrentCustomer, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { enabledChannels } from "@/lib/messaging/service";
import { SNIPPET_COLUMNS, type Snippet } from "@/lib/messaging/snippets";
import { SnippetsPanel } from "@/components/conversations/SnippetsPanel";

export const dynamic = "force-dynamic";

/** Saved replies (0150, §56.7). Customer rows only; Stayful's own templates are never listed. */
export default async function SnippetsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const admin = createAdminClient();
  const [{ data }, channels] = await Promise.all([
    admin.from("message_templates").select(SNIPPET_COLUMNS).eq("customer_id", customer.id).order("title"),
    enabledChannels(admin, isAdminUser(user)),
  ]);

  return <SnippetsPanel initial={(data ?? []) as Snippet[]} emailEnabled={channels.includes("email")} />;
}
