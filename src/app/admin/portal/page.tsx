/**
 * Admin → Customer portal (§62): pick whose dashboard to open.
 *
 * The first option is the admin's own account and is the plain LIVE dashboard
 * — no impersonation, no read-only. Every other customer opens as a read-only
 * copy of what they see. Everyone is listed, archived rows included and
 * labelled: §18D says archived is "out of circulation", which is exactly why
 * the label matters here.
 */
import { cookies } from "next/headers";
import { getUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct } from "@/lib/products";
import { pendingCancellation } from "@/lib/cancelOptions";
import { VIEW_AS_COOKIE, isViewAsId } from "@/lib/viewAs";
import { ViewAsPicker, type PickerCustomer } from "@/components/admin/ViewAsPicker";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

function statusOf(c: Customer): string {
  if (c.paused_at) return "paused";
  if (pendingCancellation(c, "management") || pendingCancellation(c, "guaranteed_rent")) return "cancelling";
  if (c.subscription_status === "past_due" || c.gr_subscription_status === "past_due") return "declined";
  if (holdsProduct(c, "management") || holdsProduct(c, "guaranteed_rent")) return "active";
  return c.account_status ?? "waitlisted";
}

function productsOf(c: Customer): string {
  const out: string[] = [];
  if (holdsProduct(c, "management")) out.push("Management");
  if (holdsProduct(c, "guaranteed_rent")) out.push("Guaranteed Rent");
  return out.join(" · ");
}

const ORDER: Record<string, number> = { active: 0, paused: 1, cancelling: 2, declined: 3, invited: 4, waitlisted: 5, cancelled: 6 };

export default async function AdminPortalPage() {
  const user = await getUser();
  const admin = createAdminClient();
  const { data } = await admin.from("customers").select("*").order("business_name", { ascending: true });
  const all = ((data ?? []) as Customer[]);

  const selfRow = user ? all.find((c) => c.user_id === user.id) ?? null : null;
  const self = selfRow ? { id: selfRow.id, name: selfRow.business_name || selfRow.contact_name } : null;

  const viewedId = cookies().get(VIEW_AS_COOKIE)?.value;
  const viewed = isViewAsId(viewedId) ? all.find((c) => c.id === viewedId) ?? null : null;
  const current = viewed ? { id: viewed.id, name: viewed.business_name || viewed.contact_name } : null;

  const customers: PickerCustomer[] = all
    .filter((c) => c.id !== selfRow?.id)
    .map((c) => ({
      id: c.id,
      name: c.business_name || c.contact_name || c.email,
      contact: c.contact_name ?? "",
      email: c.email,
      status: statusOf(c),
      products: productsOf(c),
      archived: c.is_active === false,
    }))
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      const d = (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Customer portal</h1>
        <p className="text-sm text-muted-foreground">
          Open your own dashboard, or see exactly what a customer sees.
        </p>
      </div>
      <ViewAsPicker self={self} customers={customers} current={current} />
    </div>
  );
}
