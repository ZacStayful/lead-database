import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { AdProfileForm } from "@/components/dashboard/ads/AdProfileForm";
import { PresentationBrandCard } from "@/components/dashboard/PresentationBrandCard";
import { adProfileOf, citySuggestions, resolveSlots, targetingFor } from "@/lib/ads/resolveSlots";
import { validatePresentationBrand } from "@/lib/presentationBrand";
import { brandLogoDataUrl } from "@/lib/presentationBrandStorage";
import { AD_TEMPLATES, DEFAULT_TEMPLATE_ID, templateById } from "@/lib/ads/templates";

export const dynamic = "force-dynamic";

/**
 * The business details, and the brand card above them (§65).
 *
 * ⚠️ THE BRAND CARD LEADS, AND IT IS THE EXISTING §37 ONE. `derivePalette`
 * falls back to Stayful green, so an operator who has never set a colour would
 * otherwise put OUR brand on their own advert — and a file upload cannot be a
 * chat question. That split is what keeps the chat short: the card takes the
 * colour and the logo, this form takes the text, and the chat asks only what
 * is still missing when an advert is actually being made.
 */
export default async function AdProfilePage() {
  const { user, customer, viewAs } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const template = templateById(DEFAULT_TEMPLATE_ID)!;
  const resolution = resolveSlots(customer, template);
  const targeting = targetingFor(customer);
  const brand = validatePresentationBrand(customer.presentation_brand);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <p className="text-xs text-[#6b706a]">
        <Link href="/dashboard/ads" className="underline">
          ← Back to your adverts
        </Link>
      </p>

      <header>
        <h1 className="text-xl font-semibold text-[#1a1a19]">Your business details</h1>
        <p className="mt-1 text-sm text-[#55564f]">
          Everything here goes on your adverts, in your name. Fill it in once and the
          questions get shorter every time.
        </p>
      </header>

      <PresentationBrandCard initial={brand} initialLogoUrl={await brandLogoDataUrl(brand)} />

      <AdProfileForm
        profile={adProfileOf(customer) as Record<string, unknown>}
        inherited={{
          company_name: resolution.slots.company_name ?? null,
          landing_url: resolution.slots.landing_url ?? null,
          areas: resolution.slots.areas ?? null,
          fee_pct: resolution.slots.fee_pct ?? null,
          fee_basis: resolution.slots.fee_basis ?? null,
        }}
        services={AD_TEMPLATES.filter((t) => t.services).map((t) => ({
          templateId: t.id,
          slot: t.services!.slot,
          options: t.services!.options.map((o) => ({ key: o.key, label: o.label })),
        }))}
        citySuggestions={targeting.kind === "areas" ? citySuggestions(targeting.areas) : []}
        readOnly={viewAs !== null}
      />
    </div>
  );
}
