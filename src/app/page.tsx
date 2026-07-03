import Link from "next/link";
import { CompoundingChart } from "@/components/landing/CompoundingChart";
import { FaqAccordion } from "@/components/landing/FaqAccordion";
import { LeadCardSample } from "@/components/landing/LeadCardSample";

/* eslint-disable @next/next/no-img-element */

// ── Shared building blocks ──────────────────────────────────────────────────

function Eyebrow({
  children,
  className = "text-[#898781]",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`mb-8 text-xs uppercase tracking-widest ${className}`}>
      {children}
    </p>
  );
}

function SectionHeadline({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-8 text-2xl font-medium leading-snug text-[#1a1a19]">
      {children}
    </h2>
  );
}

function Section({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className="border-b border-black/10">
      <div className={`mx-auto max-w-5xl px-6 py-20 ${className}`}>{children}</div>
    </section>
  );
}

const PRIMARY_BTN =
  "inline-block rounded-lg bg-[#3B6D11] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d5409]";

// ── Page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <main className="bg-white text-[#1a1a19]">
      {/* 1. Nav */}
      <header className="sticky top-0 z-50 border-b border-black/10 bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <Link href="/" aria-label="Stayful home">
            <img
              src="/logo.png"
              alt="Stayful"
              width={62}
              height={36}
              className="h-9 w-auto"
            />
          </Link>
          <nav className="flex items-center gap-5">
            <Link
              href="/login"
              className="hidden text-sm text-[#52514e] hover:text-[#1a1a19] sm:inline"
            >
              Sign in
            </Link>
            <Link href="/signup" className={PRIMARY_BTN}>
              Claim founding membership
            </Link>
          </nav>
        </div>
      </header>

      {/* 2. Hero */}
      <section className="border-b border-black/10">
        <div className="mx-auto max-w-3xl px-6 py-28 text-center md:text-left">
          <p className="mb-4 text-xs font-medium uppercase tracking-widest text-[#5D8156]">
            Founding member access · limited places
          </p>
          <h1 className="text-4xl font-medium leading-tight text-[#1a1a19] md:text-5xl">
            20 landlords are looking for an STR operator this month.
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[#52514e]">
            {
              "The Stayful Lead Marketplace delivers financially modelled, Google-intent landlord enquiries to STR management companies at a fixed monthly cost. No campaigns to run. No marketing expertise required. Just leads from people who searched for what you do."
            }
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link href="/signup" className={PRIMARY_BTN}>
              Claim your founding membership
            </Link>
          </div>
          <p className="mt-3 text-sm text-[#898781]">
            £300/month · 20 leads included · cancel anytime
          </p>

          <div className="mt-10 flex flex-wrap gap-8">
            {[
              { n: "1,100+", l: "enquiries validated" },
              { n: "5%", l: "long-run conversion rate" },
              { n: "£289", l: "avg monthly management revenue per property" },
            ].map((s) => (
              <div key={s.l}>
                <div className="text-2xl font-medium text-[#3B6D11]">{s.n}</div>
                <div className="mt-1 max-w-[9rem] text-xs text-[#898781]">
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 3. Pain recognition */}
      <Section>
        <Eyebrow>The problem this solves</Eyebrow>
        <h2 className="mb-10 text-2xl font-medium text-[#1a1a19]">
          Growing a managed property portfolio has one persistent problem.
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <PainCard
            title="Unpredictable growth"
            body="Referrals arrive when they arrive. Google Ads are expensive to run, hard to measure, and competitive on every relevant keyword. Most months, you don't know how many new landlord conversations are coming in."
          />
          <PainCard
            accent
            title="The leaking bucket"
            body="Every portfolio loses clients. Landlords sell properties, switch operators, or move in themselves. Without a steady source of new enquiries, your portfolio doesn't stay flat — it quietly shrinks year on year."
          />
          <PainCard
            title="A different skill set"
            body="Running lead generation at scale — paid search, SEO, nurturing sequences — is a full-time specialism. You are an expert at managing properties. Acquiring them at volume is a different job entirely."
          />
        </div>
      </Section>

      {/* 4. Mechanism */}
      <Section>
        <Eyebrow>A different model</Eyebrow>
        <SectionHeadline>
          Stayful generates landlord enquiries. You buy the conversation.
        </SectionHeadline>
        <div className="max-w-2xl space-y-4 text-base leading-relaxed text-[#52514e]">
          <p>
            {
              "Stayful receives approximately 150 landlord enquiries each month from people who searched Google for STR property management and filled out an enquiry form. Around 60% don't qualify for Stayful's own management service — wrong geography, wrong income profile, or already working with another operator."
            }
          </p>
          <p>
            {
              "Instead of discarding those conversations, we make them available to STR management companies at a fixed, predictable cost. You don't run campaigns. You don't optimise keywords. You follow up on leads from people who are already in the market."
            }
          </p>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
          <StepCard
            step="Step 01 — the lead"
            title="A landlord searches Google"
            body={`They type 'short-term rental management [city]' and submit an enquiry form. They are not cold. They have already decided they want to explore STR management. They just haven't found their operator yet.`}
          />
          <StepCard
            step="Step 02 — the filter"
            title="Every lead is financially modelled"
            body="Before any lead reaches you, a full financial model is run. Projected net STR income — using live Airbnb data for their postcode — is compared against their current income. Leads available in the marketplace typically show a positive financial case for switching to STR."
          />
          <StepCard
            highlight
            step="Step 03 — the warm hand-off"
            title="The landlord is expecting your call"
            body="Before assignment fires, the landlord receives an email explaining that Stayful couldn't take them on directly, but has arranged for a trusted local STR operator to be in touch. They have consented. They are waiting. This is not cold outreach."
          />
        </div>
      </Section>

      {/* 5. Subscriber experience timeline */}
      <Section>
        <Eyebrow>What happens after you subscribe</Eyebrow>
        <SectionHeadline>
          From signup to first conversation — here is the exact experience.
        </SectionHeadline>

        <div className="relative mt-10 before:absolute before:bottom-8 before:left-[19px] before:top-8 before:w-px before:bg-[#EAF3DE]">
          <TimelineStep
            n={1}
            title="You subscribe through Stripe checkout"
            body="Your dashboard is live immediately after payment. You see your monthly allocation, your billing cycle dates, and your pacing indicator — showing how many leads you should expect to have received by today based on where you are in the cycle. Before your first lead arrives, everything is set up and waiting."
          />
          <TimelineStep
            n={2}
            title="A landlord enquiry is financially modelled"
            body="When a landlord submits an enquiry to Stayful, it is run through a financial model comparing projected net STR income against their current income. If the numbers make a case for STR, the lead enters the assignment queue. The pacing system identifies which subscribers are most behind their expected allocation and routes the lead to them first."
          />
          <TimelineStep
            n={3}
            highlight
            title="You receive the lead in real time"
            body="The moment a lead is assigned to you, two things happen simultaneously. Your dashboard shows a notification and the lead card appears at the top of your feed. You receive an email with the full lead details. The landlord has already received a Stayful email explaining they will be contacted shortly by a trusted local STR operator. They are expecting your call."
            note="Lead delivery is within minutes of assignment — not batched or delayed."
          />
          <TimelineStep
            n={4}
            title="Everything you need before you dial"
            body="Your dashboard reveals the lead in full — name, address, direct phone number, email address, bedroom count, estimated monthly STR income, and a written lead profile covering the landlord's situation, their current arrangement, and any concerns or motivations they raised during the enquiry. You know who you are calling and what matters to them before you pick up the phone."
          />
          <TimelineStep
            n={5}
            title="You call. They are expecting it."
            body="The landlord has been told a trusted local operator will be in touch. This is not a cold call. The lead profile gives you the context for a relevant opening — their current income, their mortgage, what they asked about. You are not introducing yourself to a stranger. You are following up on a conversation Stayful has already started on your behalf."
          />
          <TimelineStep
            n={6}
            title="Mark progress and keep your pipeline clean"
            body="From your dashboard, mark each lead as Contacted, In Discussion, Won, or Not Relevant. Your full lead history is visible at any time — every lead you have ever received, its current status, and when it was assigned. Nothing gets lost and nothing goes cold without you knowing."
          />
          <TimelineStep
            n={7}
            last
            title="Twenty fresh leads, every billing cycle"
            body="On your billing cycle date, your lead count resets and your next 20 leads begin arriving. Leads are distributed throughout the month as they are qualified — you will not receive everything on day one and then wait three weeks. If your allocation is not met in any month, the shortfall carries forward automatically to the next cycle."
          />
        </div>

        <div className="mt-6 flex items-start gap-4 rounded-xl bg-[#EAF3DE] p-5">
          <span className="mt-0.5 flex-shrink-0 text-lg leading-none text-[#3B6D11]">
            ℹ
          </span>
          <p className="text-sm leading-relaxed text-[#5D8156]">
            If you opt in to overflow leads from your account settings, you
            receive additional leads beyond your 20-lead allocation at £20 each.
            Useful during months when lead volume is higher than usual and you
            want to capture more of the pipeline.
          </p>
        </div>
      </Section>

      {/* 6. Sample lead card */}
      <Section>
        <Eyebrow>What a lead looks like</Eyebrow>
        <SectionHeadline>
          Full contact details, property profile, and financial context —
          delivered the moment the lead is assigned.
        </SectionHeadline>
        <p className="mb-8 max-w-xl text-sm text-[#52514e]">
          You receive each lead in your dashboard and by email within minutes of
          it being assigned. Phone number and email address are visible
          immediately on subscription. Below is an example of what you receive.
        </p>
        <LeadCardSample />
        <p className="mt-4 text-xs text-[#898781]">
          Lead profile, phone, and email are included with every lead. All leads
          are maximum 2 operators simultaneously.
        </p>
      </Section>

      {/* 7. Data */}
      <Section>
        <Eyebrow>The numbers behind the model</Eyebrow>
        <SectionHeadline>
          Three years of data. Real portfolio performance.
        </SectionHeadline>
        <p className="mb-10 max-w-xl text-sm text-[#52514e]">
          The conversion rates and revenue figures below are not projections.
          They are derived from the qualification model that powers this
          marketplace, validated across more than 1,100 Google-sourced STR
          management enquiries, and from live portfolio data across UK operators
          running at 12–15% management fees.
        </p>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Conversion card */}
          <div className="rounded-xl border border-black/10 bg-white p-6">
            <div className="text-4xl font-medium text-[#3B6D11]">1 in 20</div>
            <div className="mt-1 text-sm text-[#52514e]">
              enquiries converts to a managed property client
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[#898781]">
              Across two full calendar years and 480 mature enquiries. 2024:
              5.7%. 2025: 4.7%. Long-run average: 5.0%. 2026 figure excluded —
              year in progress, rate immature.
            </p>
            <div className="mt-5 space-y-2">
              <YearBar year="2024" pct={57} label="5.7%" fill="#5D8156" />
              <YearBar year="2025" pct={47} label="4.7%" fill="#5D8156" />
              <YearBar year="Avg" pct={50} label="5.0%" fill="#3B6D11" />
            </div>
          </div>
          {/* Revenue card */}
          <div className="rounded-xl border border-black/10 bg-white p-6">
            <div className="text-4xl font-medium text-[#3B6D11]">£289</div>
            <div className="mt-1 text-sm text-[#52514e]">
              average monthly management revenue per managed property
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[#898781]">
              Based on live portfolio data from UK STR operators, 12–15%
              management rates, including software recharge. June 2026 actuals.
            </p>
            <div className="mt-5 text-sm text-[#52514e]">
              <BreakdownRow label="Management fee (avg 13% on STR income)" value="£247/mo" />
              <BreakdownRow label="Software recharge" value="£42/mo" />
              <div className="mt-3 border-t border-black/10 pt-3">
                <BreakdownRow label="Total per property" value="£289/mo" bold />
                <BreakdownRow label="Annual per property" value="£3,468/yr" bold />
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* 8. Acquisition model */}
      <Section>
        <Eyebrow>The cost-per-acquisition model</Eyebrow>
        <SectionHeadline>One conversion pays for itself in 31 days.</SectionHeadline>

        <div className="mt-8 flex flex-col items-stretch gap-2 md:flex-row md:items-center">
          <EquationBox big="£300" sub="per month" note="20 leads included" />
          <Arrow />
          <EquationBox big="1 property" sub="per 20 leads" note="5% conversion rate" />
          <Arrow />
          <EquationBox big="£289/mo" sub="recurring revenue" note="per managed property" />
          <Arrow />
          <EquationBox
            highlight
            big="31 days"
            sub="payback period"
            note="then it compounds"
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
          <MiniStat value="31 days" label="Payback on one acquisition" />
          <MiniStat value="£3,168" label="Year 1 net return per acquired property" />
          <MiniStat value="£3,468" label="Year 2 net return (no acquisition cost)" />
          <MiniStat value="10×" label="Year 2 return on subscription" />
        </div>
      </Section>

      {/* 9. Leaking bucket comparison */}
      <Section>
        <Eyebrow>Solving the leaking bucket</Eyebrow>
        <SectionHeadline>
          What happens to a typical 25-property portfolio — with and without a
          steady lead supply.
        </SectionHeadline>
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Without */}
          <div className="rounded-xl border border-black/10 bg-white p-6">
            <div className="mb-3 text-xs uppercase tracking-widest text-[#898781]">
              Without steady leads
            </div>
            <div className="mb-4 text-sm font-medium text-[#1a1a19]">
              A typical 25-property portfolio
            </div>
            <div className="divide-y divide-black/10">
              <BucketRow label="Starting portfolio" value="25 properties" />
              <BucketRow
                label="Annual churn (typical 10–12%)"
                value="−3 properties"
                valueClass="text-[#A32D2D] font-medium"
              />
              <BucketRow label="New from referrals / ads" value="+1 (unpredictable)" />
              <BucketRow
                label="New from marketplace"
                value="none"
                valueClass="text-[#898781]"
              />
            </div>
            <div className="mt-4 flex items-center justify-between rounded-lg bg-red-50 p-3">
              <span className="text-sm text-[#A32D2D]">Year-end portfolio</span>
              <span className="text-sm font-medium text-[#A32D2D]">
                23 properties — shrinking
              </span>
            </div>
          </div>
          {/* With */}
          <div className="rounded-xl border border-[#C0DD97] bg-[#EAF3DE] p-6">
            <div className="mb-3 text-xs uppercase tracking-widest text-[#5D8156]">
              With the marketplace
            </div>
            <div className="mb-4 text-sm font-medium text-[#3B6D11]">
              Same 25-property portfolio
            </div>
            <div className="divide-y divide-[#C0DD97]">
              <BucketRow label="Starting portfolio" value="25 properties" />
              <BucketRow
                label="Annual churn (typical 10–12%)"
                value="−3 properties"
                valueClass="text-[#A32D2D] font-medium"
              />
              <BucketRow
                label="New from referrals / ads"
                value="+1 (still comes in)"
                valueClass="text-[#3B6D11] font-medium"
              />
              <BucketRow
                label="New from marketplace (conservative)"
                value="+3 to 6 properties"
                valueClass="text-[#3B6D11] font-medium"
              />
            </div>
            <div className="mt-4 flex items-center justify-between rounded-lg bg-white/60 p-3">
              <span className="text-sm text-[#3B6D11]">Year-end portfolio</span>
              <span className="text-sm font-medium text-[#3B6D11]">
                27–29 properties — growing
              </span>
            </div>
          </div>
        </div>
        <p className="mt-4 text-xs text-[#898781]">
          Conservative model: 20 leads/month at 5% conversion = 12 potential
          properties per year. Shown at 25–50% of that rate to reflect realistic
          close timelines of 4–12 weeks.
        </p>
      </Section>

      {/* 10. Compounding chart */}
      <Section>
        <Eyebrow>What consistency builds</Eyebrow>
        <SectionHeadline>
          Properties added from the marketplace over 24 months — at one new
          property every two months from month three.
        </SectionHeadline>

        <div className="rounded-xl border border-black/10 bg-white p-4">
          <CompoundingChart />
          <div className="mt-4 flex flex-wrap gap-6 px-2 text-xs text-[#52514e]">
            <span className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-5 bg-[#3B6D11]" />
              Monthly management revenue from marketplace properties
            </span>
            <span className="flex items-center gap-2">
              <span className="inline-block h-0 w-5 border-t border-dashed border-[#898781]" />
              Monthly subscription cost (£300)
            </span>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Milestone month="Month 6" count="3 new properties" rev="£867/mo recurring" note="Subscription paying for itself 3×" />
          <Milestone month="Month 12" count="5 new properties" rev="£1,445/mo recurring" note="Subscription paying for itself 5×" />
          <Milestone
            highlight
            month="Month 24"
            count="11 new properties"
            rev="£3,179/mo recurring"
            note="Subscription paying for itself 10×"
          />
        </div>

        <div className="mt-6 rounded-r-xl border-l-4 border-[#EF9F27] bg-amber-50 py-4 pl-4 pr-5">
          <div className="text-sm font-medium text-amber-800">
            Leads take time to close — plan for the long term
          </div>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">
            STR management is not an instant-return vehicle. Landlords typically
            take 4 to 12 weeks from first contact to a signed management
            agreement. The model above is conservative and reflects this. The
            operators who benefit most treat the marketplace as a long-term
            acquisition channel: each month of leads adds to a growing pipeline,
            and each property won generates recurring revenue indefinitely.
            Consistency is the only requirement.
          </p>
        </div>
      </Section>

      {/* 11. Founding member (dark) */}
      <section className="border-b border-black/10 bg-[#3B6D11] px-6 py-20">
        <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-12 md:grid-cols-2">
          <div>
            <p className="mb-4 text-xs uppercase tracking-widest text-[#9FE1CB]">
              Founding member access
            </p>
            <h2 className="text-3xl font-medium leading-tight text-white">
              Lock your rate. Join before this fills.
            </h2>
            <div className="mt-4 space-y-4 text-sm leading-relaxed text-[#C0DD97]">
              <p>
                The first cohort of Stayful Lead Marketplace subscribers
                receives founding member pricing — the rate you join at is
                guaranteed for as long as you remain subscribed. As the lead
                volume and subscriber base grows, founding members maintain
                priority position in the pacing queue.
              </p>
              <p>
                This cohort is limited. When founding membership closes, standard
                pricing and standard terms apply.
              </p>
            </div>
            <Link
              href="/signup"
              className="mt-8 inline-block rounded-lg bg-white px-6 py-3 text-sm font-medium text-[#3B6D11] transition-colors hover:bg-[#EAF3DE]"
            >
              Claim your founding membership
            </Link>
            <p className="mt-3 text-xs text-[#9FE1CB]">
              £300/month · 20 leads/month · cancel anytime · allocation carries
              forward
            </p>
          </div>

          <div className="space-y-4">
            {[
              {
                t: "Founding rate guaranteed",
                d: "Your £300/month rate is locked regardless of future pricing changes.",
              },
              {
                t: "Priority pacing position",
                d: "Founding members are prioritised in the lead queue throughout their subscription.",
              },
              {
                t: "Direct access",
                d: "Questions about a lead, a landlord's situation, or the platform? Reach Zac directly.",
              },
              {
                t: "Shape the product",
                d: "Founding members influence which cities, lead types, and features are prioritised next.",
              },
            ].map((item) => (
              <div key={item.t} className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#9FE1CB]" />
                <div>
                  <div className="text-sm font-medium text-white">{item.t}</div>
                  <div className="mt-0.5 text-sm text-[#C0DD97]">{item.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 12. Pricing */}
      <Section>
        <Eyebrow>Pricing</Eyebrow>
        <SectionHeadline>
          One subscription. Fixed cost. No hidden fees.
        </SectionHeadline>

        <div className="mx-auto mt-10 max-w-md rounded-xl border border-black/10 bg-white p-8">
          <div>
            <span className="text-5xl font-medium text-[#1a1a19]">£300</span>
            <span className="text-xl text-[#898781]">/month</span>
          </div>
          <div className="text-sm text-[#898781]">+ VAT</div>

          <div className="my-6 border-t border-black/10" />

          <ul className="space-y-3">
            {[
              "20 financially modelled leads per month",
              "Full contact details: name, address, phone, email, lead profile",
              "Estimated monthly STR income per lead",
              "Maximum 2 operators per lead — you are never in a crowd",
              "Real-time in-portal and email notification on each assignment",
              "Leads carry forward if your monthly allocation is not met",
              "Cancel anytime — no lock-in, no penalty",
              "Overflow leads available at £20/lead if you opt in",
            ].map((f) => (
              <li key={f} className="flex items-start gap-3 text-sm text-[#52514e]">
                <span className="font-medium text-[#3B6D11]">✓</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>

          <Link href="/signup" className={`mt-8 w-full text-center ${PRIMARY_BTN}`}>
            Start your subscription
          </Link>
        </div>

        <p className="mx-auto mt-4 max-w-sm text-center text-xs text-[#898781]">
          Exclusive leads (one operator only) are available at £25/lead. Contact
          Zac directly to discuss exclusive allocation.
        </p>
      </Section>

      {/* 13. FAQ */}
      <Section>
        <Eyebrow>Common questions</Eyebrow>
        <SectionHeadline>Answers before you ask.</SectionHeadline>
        <div className="mt-2">
          <FaqAccordion />
        </div>
      </Section>

      {/* 14. Final CTA */}
      <section className="border-b border-black/10 bg-[#EAF3DE] px-6 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-4 text-3xl font-medium text-[#3B6D11]">
            A fixed cost. A known return. A growing portfolio.
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-base leading-relaxed text-[#5D8156]">
            £300 per month for 20 financially modelled leads. Each lead goes to a
            maximum of two operators. No campaigns to run, no algorithms to
            manage, no expertise required. Just a consistent pipeline of
            landlords who searched for what you do.
          </p>
          <div className="mb-10 flex flex-wrap justify-center gap-8">
            {[
              { n: "£15", l: "per lead" },
              { n: "1 in 20", l: "converts to a managed property" },
              { n: "£289", l: "avg monthly revenue per property" },
              { n: "max 2", l: "operators per lead" },
            ].map((s) => (
              <div key={s.l}>
                <div className="text-2xl font-medium text-[#3B6D11]">{s.n}</div>
                <div className="text-xs text-[#5D8156]">{s.l}</div>
              </div>
            ))}
          </div>
          <Link href="/signup" className={PRIMARY_BTN}>
            Claim your founding membership
          </Link>
          <p className="mt-3 text-xs text-[#5D8156]">
            Cancel anytime · allocation carries forward · founding rate locked
          </p>
        </div>
      </section>

      {/* 15. Footer */}
      <footer className="px-6 py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 sm:flex-row">
          <div className="flex items-center gap-3 text-xs text-[#898781]">
            <img
              src="/logo.png"
              alt="Stayful"
              width={35}
              height={20}
              className="h-5 w-auto"
            />
            <span>© 2026 Stayful. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-5 text-xs text-[#898781]">
            <Link href="/login" className="hover:text-[#52514e]">
              Sign in
            </Link>
            <a href="#" className="hover:text-[#52514e]">
              Privacy
            </a>
            <a href="#" className="hover:text-[#52514e]">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

// ── Small presentational helpers ────────────────────────────────────────────

function PainCard({
  title,
  body,
  accent = false,
}: {
  title: string;
  body: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-black/10 bg-white p-6 ${
        accent ? "border-l-4 border-l-[#5D8156]" : ""
      }`}
    >
      <div className="mb-2 text-sm font-medium text-[#1a1a19]">{title}</div>
      <p className="text-sm leading-relaxed text-[#52514e]">{body}</p>
    </div>
  );
}

function StepCard({
  step,
  title,
  body,
  highlight = false,
}: {
  step: string;
  title: string;
  body: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-6 ${
        highlight
          ? "border-[#C0DD97] bg-[#EAF3DE]"
          : "border-black/10 bg-white"
      }`}
    >
      <div className="mb-2 text-xs uppercase tracking-widest text-[#5D8156]">
        {step}
      </div>
      <div className="mb-2 text-sm font-medium text-[#1a1a19]">{title}</div>
      <p className="text-sm leading-relaxed text-[#52514e]">{body}</p>
    </div>
  );
}

function TimelineStep({
  n,
  title,
  body,
  note,
  highlight = false,
  last = false,
}: {
  n: number;
  title: string;
  body: string;
  note?: string;
  highlight?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`relative flex items-start gap-5 ${last ? "" : "pb-8"}`}>
      <div
        className={`z-10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium ${
          highlight ? "bg-[#3B6D11] text-white" : "bg-[#EAF3DE] text-[#3B6D11]"
        }`}
      >
        {n}
      </div>
      <div>
        <div className="mb-1 text-sm font-medium text-[#1a1a19]">{title}</div>
        <p className="text-sm leading-relaxed text-[#52514e]">{body}</p>
        {note && (
          <p className="mt-2 text-xs font-medium text-[#5D8156]">{note}</p>
        )}
      </div>
    </div>
  );
}

function YearBar({
  year,
  pct,
  label,
  fill,
}: {
  year: string;
  pct: number;
  label: string;
  fill: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-10 text-xs text-[#52514e]">{year}</span>
      <div className="h-5 flex-1 rounded-sm bg-[#EAF3DE]">
        <div
          className="flex h-full items-center rounded-sm px-2"
          style={{ width: `${pct}%`, backgroundColor: fill }}
        >
          <span className="text-xs font-medium text-white">{label}</span>
        </div>
      </div>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  bold = false,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className={`flex justify-between py-1 ${bold ? "font-medium text-[#1a1a19]" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function EquationBox({
  big,
  sub,
  note,
  highlight = false,
}: {
  big: string;
  sub: string;
  note: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex-1 rounded-xl border p-5 text-center ${
        highlight ? "border-[#C0DD97] bg-[#EAF3DE]" : "border-black/10 bg-white"
      }`}
    >
      <div
        className={`text-3xl font-medium ${
          highlight ? "text-[#3B6D11]" : "text-[#1a1a19]"
        }`}
      >
        {big}
      </div>
      <div className="mt-1 text-xs text-[#52514e]">{sub}</div>
      <div className="mt-1 text-xs text-[#898781]">{note}</div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="hidden items-center justify-center text-[#898781] md:flex">
      →
    </div>
  );
}

function MiniStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-black/10 bg-white p-4">
      <div className="text-xl font-medium text-[#1a1a19]">{value}</div>
      <div className="mt-1 text-xs text-[#52514e]">{label}</div>
    </div>
  );
}

function BucketRow({
  label,
  value,
  valueClass = "text-[#1a1a19]",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <span className="text-[#52514e]">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function Milestone({
  month,
  count,
  rev,
  note,
  highlight = false,
}: {
  month: string;
  count: string;
  rev: string;
  note: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-5 ${
        highlight ? "border-[#C0DD97] bg-[#EAF3DE]" : "border-black/10 bg-white"
      }`}
    >
      <div className="mb-2 text-xs uppercase tracking-widest text-[#898781]">
        {month}
      </div>
      <div className="mb-1 text-2xl font-medium text-[#3B6D11]">{count}</div>
      <div className="mb-2 text-sm font-medium text-[#1a1a19]">{rev}</div>
      <div className="text-xs text-[#898781]">{note}</div>
    </div>
  );
}
