/**
 * The landlord's page (§41) — reached only from the referral email.
 *
 * ⚠️ PUBLIC. middleware.ts matches only /dashboard and /admin, so nothing
 * authenticates here. The token is the whole authorisation, and it permits
 * exactly one thing: answering three questions about one lead.
 *
 * ⚠️ IT REVEALS NOTHING ABOUT ANY OPERATOR — not who holds the lead, not how
 * many. §19.7 stripped precisely this from the pool row set "so no later UI
 * change can reach for it". The property address is shown so the landlord knows
 * they are in the right place, and that is all.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyReferralToken } from "@/lib/landlordReferralToken";
import { buildLandlordDeck } from "@/lib/landlordDeck";
import { landlordFirstName } from "@/lib/landlordReferral";
import LandlordDeckFlow from "@/components/landlord/LandlordDeckFlow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A landlord's own property figures have no business in a search index.
export const metadata: Metadata = {
  title: "Your enquiry — Stayful",
  robots: { index: false, follow: false },
};

const DECK_COLUMNS =
  "id, lead_name, address, bedrooms, lead_type, gross_annual_income, " +
  "avg_nightly_rate, occupancy_rate, monthly_revenue_profile, " +
  "market_occupancy_rate, comp_set_size, comp_set_radius_km, comp_avg_rating, " +
  "comp_avg_review_count, risk_label, landlord_referral_first_sent_at, " +
  "landlord_contact_method, landlord_contact_time, landlord_wants";

export default async function LandlordPrefsPage({
  params,
}: {
  params: { token: string };
}) {
  const leadId = verifyReferralToken(params.token);
  if (!leadId) notFound();

  const admin = createAdminClient();
  const { data } = await admin
    .from("leads")
    .select(DECK_COLUMNS)
    .eq("id", leadId)
    .maybeSingle();

  const lead = data as
    | (Parameters<typeof buildLandlordDeck>[0] & {
        lead_name?: string | null;
        landlord_referral_first_sent_at?: string | null;
        landlord_contact_method?: string | null;
        landlord_contact_time?: string | null;
        landlord_wants?: string[] | null;
      })
    | null;

  // A lead nobody was ever introduced to has no business being reachable here,
  // even with a valid token. Same 404 as a forged one.
  if (!lead || !lead.landlord_referral_first_sent_at) notFound();

  const deck = buildLandlordDeck(lead);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f5f6f5",
        fontFamily:
          "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
        color: "#1a1a1a",
        padding: "32px 16px",
      }}
    >
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ fontWeight: 700, fontSize: 20, color: "#5D8156", marginBottom: 16 }}>
          Stayful
        </div>
        <LandlordDeckFlow
          token={params.token}
          firstName={landlordFirstName(lead.lead_name)}
          address={lead.address ?? null}
          headline={deck.headline}
          cards={deck.cards}
          alreadyAnswered={Boolean(
            lead.landlord_contact_method ||
              lead.landlord_contact_time ||
              lead.landlord_wants?.length
          )}
        />
        <p style={{ color: "#8a8f88", fontSize: 12, marginTop: 24, lineHeight: 1.6 }}>
          You are seeing this because you made a property enquiry to Stayful. Your
          answers are shared only with the operator who is contacting you about it.
        </p>
      </div>
    </main>
  );
}
