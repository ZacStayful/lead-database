import { notFound } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { adsEnabledFor } from "@/lib/ads/gate";

/**
 * The gate on the pages (§65).
 *
 * ⚠️ ITS OWN LAYOUT, RATHER THAN A CHECK IN `dashboard/layout.tsx`. That one
 * is a server component with no pathname, so it cannot gate one route — and a
 * check placed in the page instead would leave a future
 * `/dashboard/ads/[id]/preview` ungated the day somebody adds it. A segment
 * layout covers everything under it, including the pages nobody has written.
 *
 * ⚠️ `notFound()`, NEVER A "you may not" PAGE. A refusal that confirms the
 * surface exists tells anybody who guessed the URL that it is there.
 */
export default async function AdsLayout({ children }: { children: React.ReactNode }) {
  const { user, customer } = await getCurrentCustomer();
  if (!adsEnabledFor(user, customer)) notFound();
  return <>{children}</>;
}
