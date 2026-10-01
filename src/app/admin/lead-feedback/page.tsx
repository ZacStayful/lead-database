import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  conversionByArea,
  conversionByMonth,
  reasonsByArea,
  reasonsByMonth,
  responseByCustomer,
  shortfallLog,
  type AdminItem,
  type AdminReview,
  type ConversionRow,
  type ReasonRow,
} from "@/lib/batchReview/adminStats";
import { CONVERSION_BENCHMARK, DEAD_REASONS, DEAD_REASON_LABELS } from "@/lib/batchReview/answers";
import { formatRate, rate } from "@/lib/batchReview/metrics";
import { cycleLabel } from "@/lib/batchReview/settings";

export const dynamic = "force-dynamic";

/**
 * Admin → Lead feedback (§73).
 *
 * What customers say about each month's leads, read four ways: who answers,
 * how leads convert by area and month against the benchmark, why leads went
 * nowhere, and every cycle that came up short. Every figure is computed in
 * src/lib/batchReview/adminStats.ts, which is pure and tested.
 *
 * Admin-only, so customer names appear. Small groups are shown with their count
 * beside every rate, never as a bare percentage (§70.5).
 */

const CAUSE_LABEL = { hold: "Customer's hold", filter: "Their filter", supply: "Our supply" } as const;

function productShort(lt: string): string {
  return lt === "guaranteed_rent" ? "GR" : "Mgmt";
}

function ConversionTable({ rows, keyLabel }: { rows: ConversionRow[]; keyLabel: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No answered batches yet.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1 font-medium">{keyLabel}</th>
          <th className="py-1 font-medium">Product</th>
          <th className="py-1 text-right font-medium">Leads</th>
          <th className="py-1 text-right font-medium">Called</th>
          <th className="py-1 text-right font-medium">Interested</th>
          <th className="py-1 text-right font-medium">Meetings</th>
          <th className="py-1 text-right font-medium">Likely later</th>
          <th className="py-1 text-right font-medium">Signed</th>
          <th className="py-1 text-right font-medium">Benchmark</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const c = r.counts;
          const pct = (n: number) => `${n} (${formatRate(rate(n, c.delivered))})`;
          return (
            <tr key={`${r.leadType}-${r.key}`} className="border-t-[0.5px] border-border">
              <td className="py-1">{r.key}</td>
              <td className="py-1">{productShort(r.leadType)}</td>
              <td className="py-1 text-right">{c.delivered}</td>
              <td className="py-1 text-right">{pct(c.called)}</td>
              <td className="py-1 text-right">{pct(c.interested)}</td>
              <td className="py-1 text-right">{pct(c.meetings)}</td>
              <td className="py-1 text-right">{pct(c.likelyLater)}</td>
              <td className="py-1 text-right">{pct(c.signed)}</td>
              <td className="py-1 text-right text-muted-foreground">{formatRate(CONVERSION_BENCHMARK[r.leadType])}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ReasonTable({ rows, keyLabel }: { rows: ReasonRow[]; keyLabel: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No leads marked as going nowhere yet.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1 font-medium">{keyLabel}</th>
          <th className="py-1 text-right font-medium">Went nowhere</th>
          {DEAD_REASONS.map((r) => (
            <th key={r} className="py-1 text-right font-medium">
              {DEAD_REASON_LABELS[r]}
            </th>
          ))}
          <th className="py-1 text-right font-medium">No reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t-[0.5px] border-border">
            <td className="py-1">{r.key}</td>
            <td className="py-1 text-right">{r.total}</td>
            {DEAD_REASONS.map((d) => (
              <td key={d} className="py-1 text-right">
                {r.byReason[d] ?? 0}
              </td>
            ))}
            <td className="py-1 text-right text-muted-foreground">{r.unexplained}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * ⚠️ PostgREST caps every response at 1,000 rows whatever `.limit()` asks for,
 * and items grow at roughly a customer's allocation every month. So they are
 * read in pages with a stable order, as fetchLeadVolumeAggregate does (§28.8).
 * An error mid-way is returned, never a silently shorter list (§58.2).
 */
async function fetchAllItems(admin: ReturnType<typeof createAdminClient>) {
  const PAGE = 1000;
  const rows: AdminItem[] = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data, error } = await admin
      .from("lead_batch_review_items")
      .select("review_id, answer, dead_reason, postcode_area")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...((data ?? []) as unknown as AdminItem[]));
    if (!data || data.length < PAGE) break;
  }
  return { data: rows, error: null };
}

export default async function LeadFeedbackPage() {
  const admin = createAdminClient();
  const [reviewsRes, itemsRes] = await Promise.all([
    admin
      .from("lead_batch_reviews")
      .select(
        "id, customer_id, lead_type, cycle_start, cycle_end, allocation, delivered, balance_at_reset, next_allocation, pool_debit, filter_status, filter_expected_leads, filter_areas, filter_min_bedrooms, filter_max_bedrooms, filter_min_gross, release_hold_until, survey_sent_at, submitted_at, quality_rating, comment"
      )
      .order("cycle_end", { ascending: false })
      .limit(1000),
    fetchAllItems(admin),
  ]);

  if (reviewsRes.error || itemsRes.error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Lead feedback</h1>
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            Lead feedback is unavailable: the review tables could not be read. Try again in a moment.
          </CardContent>
        </Card>
      </div>
    );
  }

  const reviews = (reviewsRes.data ?? []) as unknown as AdminReview[];
  const items = (itemsRes.data ?? []) as unknown as AdminItem[];

  const customerIds = Array.from(new Set(reviews.map((r) => r.customer_id)));
  const names = new Map<string, string>();
  if (customerIds.length > 0) {
    const { data } = await admin.from("customers").select("id, business_name, contact_name").in("id", customerIds);
    for (const c of (data ?? []) as { id: string; business_name: string | null; contact_name: string | null }[]) {
      names.set(c.id, c.business_name || c.contact_name || c.id.slice(0, 8));
    }
  }
  const nameOf = (id: string) => names.get(id) ?? id.slice(0, 8);

  const response = responseByCustomer(reviews);
  const sent = reviews.filter((r) => r.survey_sent_at).length;
  const submitted = reviews.filter((r) => r.submitted_at).length;
  const ratings = reviews.map((r) => r.quality_rating).filter((n): n is number => n != null);
  const comments = reviews.filter((r) => r.comment).slice(0, 20);
  const shortfalls = shortfallLog(reviews);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Lead feedback</h1>
        <p className="text-sm text-muted-foreground">
          What customers say about each month&apos;s leads. {reviews.length} months recorded, {sent} review
          {sent === 1 ? "" : "s"} sent, {submitted} answered ({formatRate(rate(submitted, sent))})
          {ratings.length > 0
            ? `, average quality ${(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)} of 5 from ${ratings.length}`
            : ""}
          . Conversion is counted over answered batches only. Switch and timings are on{" "}
          <Link href="/admin/allocation" className="underline">
            Allocation
          </Link>
          .
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Response rate by customer</h2>
        {response.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reviews sent yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-medium">Customer</th>
                <th className="py-1 text-right font-medium">Sent</th>
                <th className="py-1 text-right font-medium">Answered</th>
                <th className="py-1 text-right font-medium">Rate</th>
                <th className="py-1 text-right font-medium">Days to answer</th>
              </tr>
            </thead>
            <tbody>
              {response.map((r) => (
                <tr key={r.customerId} className="border-t-[0.5px] border-border">
                  <td className="py-1">
                    <Link href={`/admin/customers/${r.customerId}`} className="underline">
                      {nameOf(r.customerId)}
                    </Link>
                  </td>
                  <td className="py-1 text-right">{r.sent}</td>
                  <td className="py-1 text-right">{r.submitted}</td>
                  <td className="py-1 text-right">{formatRate(r.rate)}</td>
                  <td className="py-1 text-right">{r.avgDaysToSubmit == null ? "—" : r.avgDaysToSubmit.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Conversion by month</h2>
        <ConversionTable rows={conversionByMonth(reviews, items)} keyLabel="Month ending" />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Conversion by area</h2>
        <ConversionTable rows={conversionByArea(reviews, items)} keyLabel="Postcode area" />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Why leads went nowhere, by area</h2>
        <ReasonTable rows={reasonsByArea(reviews, items)} keyLabel="Postcode area" />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Why leads went nowhere, by month</h2>
        <ReasonTable rows={reasonsByMonth(reviews, items)} keyLabel="Month ending" />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Short months</h2>
        {shortfalls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No customer has been delivered less than their plan yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-medium">Customer</th>
                <th className="py-1 font-medium">Product</th>
                <th className="py-1 font-medium">Month ending</th>
                <th className="py-1 text-right font-medium">Delivered</th>
                <th className="py-1 text-right font-medium">Owed</th>
                <th className="py-1 font-medium">Cause</th>
              </tr>
            </thead>
            <tbody>
              {shortfalls.map((s) => (
                <tr key={s.reviewId} className="border-t-[0.5px] border-border">
                  <td className="py-1">{nameOf(s.customerId)}</td>
                  <td className="py-1">{productShort(s.leadType)}</td>
                  <td className="py-1">{s.cycleEnd}</td>
                  <td className="py-1 text-right">
                    {s.delivered} of {s.allocation}
                  </td>
                  <td className="py-1 text-right">{s.owed}</td>
                  <td className="py-1">{CAUSE_LABEL[s.cause]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {comments.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Latest comments</h2>
          <ul className="space-y-2 text-sm">
            {comments.map((r) => (
              <li key={r.id} className="rounded-md border-[0.5px] border-border p-3">
                <p className="text-xs text-muted-foreground">
                  {nameOf(r.customer_id)} · {productShort(r.lead_type)} · {cycleLabel(r.cycle_start, r.cycle_end)}
                  {r.quality_rating != null ? ` · rated ${r.quality_rating}/5` : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{r.comment}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
