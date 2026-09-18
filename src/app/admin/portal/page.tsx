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
import { PORTAL_STATUS_ORDER, portalProducts, portalStatus } from "@/lib/portalStatus";
import { VIEW_AS_COOKIE, isViewAsId } from "@/lib/viewAs";
import { ViewAsPicker, type PickerCustomer } from "@/components/admin/ViewAsPicker";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

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
      status: portalStatus(c),
      products: portalProducts(c),
      archived: c.is_active === false,
    }))
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      const d = PORTAL_STATUS_ORDER[a.status] - PORTAL_STATUS_ORDER[b.status];
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
