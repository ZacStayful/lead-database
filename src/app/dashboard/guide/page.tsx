import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import {
  PIPELINE_STAGES,
  GR_PIPELINE_STAGES,
  pipelineBadgeClass,
} from "@/components/dashboard/pipelineStage";
import { statusBadge } from "@/components/dashboard/leadStatus";

export const dynamic = "force-dynamic";

const STATUSES: { key: string; blurb: string }[] = [
  { key: "new", blurb: "Just arrived and not yet actioned. Your unread count on the dashboard tracks these." },
  { key: "contacted", blurb: "You've reached out — call, email, or message. Use “Mark as contacted” on the lead." },
  { key: "in_discussion", blurb: "An active back-and-forth is underway." },
  { key: "won", blurb: "Converted — a signed management agreement or guaranteed-rent deal. Counts toward your win rate." },
  { key: "not_relevant", blurb: "Not a fit for you. Closes the lead without marking it won." },
  { key: "rejected", blurb: "You passed on it. The lead still counts and is not refunded — it's a record that you're not pursuing it." },
];

const MGMT_STAGE_BLURBS: Record<string, string> = {
  cold: "Not yet engaged — early contact or no response yet.",
  interested_in_the_future: "Interested, but not right now. Set a call-back date and revisit.",
  web_meeting_booked: "A web meeting is in the diary.",
  web_meeting_no_show: "They booked but didn't attend — chase to rebook.",
  web_meeting_attended: "The web meeting happened. Follow up to close.",
  abandoned: "No longer progressing — parked as a dead end (you can revive it any time).",
};

const GR_STAGE_BLURBS: Record<string, string> = {
  cold: "Not yet engaged — early contact or no response yet.",
  viewing_booked: "A property viewing is booked with the landlord.",
  contract_sent: "You've sent the guaranteed-rent agreement for signature.",
  contract_signed: "Signed — the property is yours to run. Mark the lead Won.",
};

export default async function GuidePage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");

  const gr = customer.gr_subscription_status === "active";
  const hasManagement = customer.subscription_status === "active";
  // Default to the management guide if the customer holds neither product flag.
  const mgmt = hasManagement || !gr;

  const toc: { id: string; label: string }[] = [
    { id: "overview", label: "Getting started" },
    { id: "leads", label: "Your leads feed" },
    { id: "credits", label: "Leads, credits & pacing" },
    { id: "lead", label: "Working a lead" },
    { id: "crm", label: "Status vs pipeline" },
    { id: "notes", label: "Notes & files" },
    { id: "reject", label: "Reject vs discard" },
    { id: "priority", label: "Priority call list" },
    { id: "analytics", label: "Analytics" },
    { id: "analyser", label: "STR Analyser" },
    ...(gr ? [{ id: "documents", label: "Documents" }] : []),
    { id: "billing", label: "Billing & renewal" },
    { id: "tips", label: "Tips" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Guide</h1>
        <p className="text-sm text-muted-foreground">
          Everything you need to work your leads and get the most out of the
          portal.
        </p>
      </div>

      <div className="lg:grid lg:grid-cols-[210px_1fr] lg:gap-10">
        {/* Quick nav */}
        <nav className="mb-6 lg:mb-0 lg:sticky lg:top-20 lg:self-start">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            On this page
          </p>
          <ul className="space-y-1">
            {toc.map((t) => (
              <li key={t.id}>
                <a
                  href={`#${t.id}`}
                  className="block rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Content */}
        <div className="min-w-0 space-y-10">
          <Section id="overview" title="Getting started">
            <p>
              This portal is where every lead we send you lands, and a lightweight
              CRM to work each one from first contact to a signed deal. New leads
              arrive <strong>within minutes of assignment</strong> — you&apos;ll
              get an email and a real-time notification in the portal (the bell in
              the top bar shows your unread count).
            </p>
            <p>
              Use the navigation at the top: <NavRef>Dashboard</NavRef> for an
              overview, <NavRef>Leads</NavRef> for your full list,{" "}
              <NavRef>Priority</NavRef> for who to call next,{" "}
              <NavRef>Analytics</NavRef> for your funnel, and{" "}
              <NavRef>Settings</NavRef> for billing.
            </p>
            {mgmt && gr && (
              <Callout>
                You&apos;re subscribed to <strong>both</strong> Management and
                Guaranteed Rent. Every lead is clearly badged with its type, and
                you can filter your list by product.
              </Callout>
            )}
          </Section>

          <Section id="leads" title="Your leads feed">
            <p>
              Open <NavRef>Leads</NavRef> to see everything you&apos;ve received,
              newest first. Each row is a lead — click it to expand contact
              details inline, or open the full lead page to work it.
            </p>
            <List>
              <li>
                <strong>Search</strong> by name, address, email, or bedrooms.
              </li>
              <li>
                <strong>Filter</strong> by <Pill>All</Pill> <Pill>New</Pill>{" "}
                <Pill>Viewed</Pill> <Pill>Contacted</Pill>.
              </li>
              {mgmt && gr && (
                <li>
                  <strong>Filter by product</strong> —{" "}
                  <Pill>Management</Pill> <Pill>Guaranteed Rent</Pill> — appears
                  automatically when you hold both.
                </li>
              )}
              <li>
                A lead is marked <strong>viewed</strong> the moment you open it,
                so the “New” count reflects what you still haven&apos;t seen.
              </li>
              <li>
                <strong>Export</strong> your leads to a spreadsheet any time with
                the Export button.
              </li>
            </List>
          </Section>

          <Section id="credits" title="Leads, credits & pacing">
            <p>
              Your dashboard shows how many leads you have{" "}
              <strong>remaining</strong> and how many you&apos;ve{" "}
              <strong>received</strong>
              {mgmt && gr ? ", split by product" : ""}. A few things worth
              knowing:
            </p>
            <List>
              <li>
                Leads are delivered steadily across your billing cycle — the{" "}
                <strong>pacing</strong> line tells you whether you&apos;re on
                track, ahead, or behind for the month. If you fall behind,
                you&apos;re prioritised in the queue.
              </li>
              <li>
                Any allocation you don&apos;t receive in a month{" "}
                <strong>carries forward</strong> — you always get the leads you
                paid for.
              </li>
              <li>
                Every delivered lead is chargeable. Rejecting a lead does{" "}
                <strong>not</strong> refund a credit (see{" "}
                <a href="#reject" className="text-brand hover:underline">
                  Reject vs discard
                </a>
                ).
              </li>
            </List>
          </Section>

          <Section id="lead" title="Working a lead">
            <p>
              Open a lead to see the full picture and everything you need before
              you pick up the phone:
            </p>
            <List>
              <li>
                <strong>Contact &amp; property details</strong> — name, phone,
                email, full address, bedrooms, enquiry date
                {mgmt ? ", and a written lead profile" : ""}.
              </li>
              <li>
                <strong>Due to call</strong> — set a call-back date; it feeds the{" "}
                <a href="#priority" className="text-brand hover:underline">
                  Priority call list
                </a>
                .
              </li>
              <li>
                <strong>Estimated monthly income</strong> — record your own
                figure for the property; it rolls up in your analytics.
              </li>
              <li>
                <strong>Prev / next</strong> arrows (or the ← → keys) move you
                through the list you opened the lead from, so you can work
                through them quickly.
              </li>
            </List>
          </Section>

          <Section id="crm" title="Status vs pipeline — the mini-CRM">
            <p>
              Each lead has <strong>two independent tracks</strong>. Keeping both
              up to date is what powers your analytics and priority list.
            </p>

            <SubHeading>1 · Status — how the relationship is going</SubHeading>
            <p>
              Set from the lead. It answers “where is this conversation?”
            </p>
            <div className="mt-3 space-y-2">
              {STATUSES.map((s) => {
                const b = statusBadge(s.key);
                return (
                  <div key={s.key} className="flex items-start gap-3">
                    <span
                      className={
                        "mt-0.5 inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs font-medium " +
                        b.className
                      }
                    >
                      {b.label}
                    </span>
                    <p className="text-sm text-muted-foreground">{s.blurb}</p>
                  </div>
                );
              })}
            </div>

            <SubHeading>
              2 · Pipeline stage — where they are in your process
            </SubHeading>
            <p>
              Click the stage badge on a lead to change it. It&apos;s a separate
              axis from status — a lead can be at any stage regardless of whether
              it&apos;s new, contacted, or won.
            </p>

            {mgmt && (
              <StageBlock
                title={gr ? "Management pipeline" : "Your pipeline"}
                stages={PIPELINE_STAGES}
                blurbs={MGMT_STAGE_BLURBS}
              />
            )}
            {gr && (
              <StageBlock
                title={mgmt ? "Guaranteed Rent pipeline" : "Your pipeline"}
                stages={GR_PIPELINE_STAGES}
                blurbs={GR_STAGE_BLURBS}
              />
            )}

            <Callout>
              Set a <strong>Due to call</strong> date as you go — it&apos;s what
              orders your Priority list so you always know who to ring next.
            </Callout>
          </Section>

          <Section id="notes" title="Notes & files">
            <p>
              Everything about a lead lives on its page so the full history is
              there when you call back:
            </p>
            <List>
              <li>
                <strong>Notes</strong> — add timestamped notes of every
                conversation. Once you&apos;ve added a note or changed the
                status, the lead is “yours” and can no longer be discarded.
              </li>
              <li>
                <strong>Files</strong> — upload documents against a lead, such as
                your STR Analyser report or figures, so they&apos;re attached to
                the property.
              </li>
            </List>
          </Section>

          <Section id="reject" title="Reject vs discard">
            <p>Two different actions for a lead you don&apos;t want to pursue:</p>
            <List>
              <li>
                <strong>Reject</strong> — records that you&apos;re passing on the
                lead. It still counts toward your leads for the month and is not
                refunded or replaced. Use it as a pipeline/feedback signal.
              </li>
              <li>
                <strong>Discard</strong> — only available before you&apos;ve added
                a note or changed the status. It releases an untouched lead so it
                can go to another operator. It still counts toward your monthly
                allocation, since the lead was delivered and qualified.
              </li>
            </List>
            <Callout variant="warn">
              If a lead&apos;s <strong>contact details are factually
              incorrect</strong>, don&apos;t just reject it — contact the Stayful
              team and we&apos;ll review it.
            </Callout>
          </Section>

          <Section id="priority" title="Priority call list">
            <p>
              <NavRef>Priority</NavRef> lists your active leads in call order —
              soonest and overdue call-backs first, based on the{" "}
              <strong>Due to call</strong> dates you set. Won and not-relevant
              leads drop off. Work top to bottom and you&apos;ll never miss a
              follow-up.
            </p>
          </Section>

          <Section id="analytics" title="Analytics">
            <p>
              <NavRef>Analytics</NavRef> turns your activity into a picture of
              your funnel:
            </p>
            <List>
              <li>
                Headline stats — total leads, won, <strong>win rate</strong>, and
                notes logged.
              </li>
              <li>
                <strong>Status funnel</strong> and <strong>pipeline stages</strong>{" "}
                — how many leads sit at each step, in numbers and percentages.
              </li>
              <li>
                <strong>Estimated monthly income</strong> — totalled from the
                figures you enter per lead, split across in-pipeline, won, and all
                leads.
              </li>
              <li>
                Your activity — leads actioned, meetings booked/attended, files
                uploaded — and a one-click <strong>PDF export</strong>.
              </li>
            </List>
            <Callout>
              The more consistently you set statuses, stages, and income figures,
              the more useful these numbers become.
            </Callout>
          </Section>

          <Section id="analyser" title="STR Analyser">
            <p>
              Every lead comes with an address. Before you call, run it through
              the Stayful STR Analyser at{" "}
              <a
                href="https://intelligence.stayful.co.uk"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand hover:underline"
              >
                intelligence.stayful.co.uk
              </a>{" "}
              — it pulls live Airbnb data for that postcode and tells you in about
              60 seconds whether the numbers work
              {gr ? " for a guaranteed rent arrangement" : ""}. There&apos;s a
              shortcut to it on every lead
              {gr ? " (“Run figures on this property”)" : ""}.
            </p>
          </Section>

          {gr && (
            <Section id="documents" title="Documents">
              <p>
                As a Guaranteed Rent subscriber you get a free, ready-to-sign{" "}
                <strong>company let tenancy agreement</strong> to get landlords
                onto a guaranteed-rent arrangement. Find it under{" "}
                <NavRef>Documents</NavRef> (and on your dashboard) — download the
                agreement and read the plain-English FAQ that explains exactly
                what the landlord and your company are each responsible for.
              </p>
            </Section>
          )}

          <Section id="billing" title="Billing & renewal">
            <p>
              Open <NavRef>Settings</NavRef> to see your plan and manage billing.
            </p>
            <List>
              <li>
                <strong>Manage billing</strong> opens the secure Stripe portal —
                update your card, view invoices, or cancel.
              </li>
              <li>
                Your <strong>next renewal</strong> date is on the dashboard. On
                that date your monthly count resets and the next batch begins
                arriving through the month.
              </li>
              <li>
                <strong>Cancel any time</strong> — there&apos;s no minimum term or
                penalty.
              </li>
            </List>
          </Section>

          <Section id="tips" title="Tips to get the most out of it">
            <Card>
              <CardContent className="pt-6">
                <List className="space-y-2">
                  <li>Open new leads promptly — speed to contact wins deals.</li>
                  <li>
                    Set a <strong>Due to call</strong> date on every lead so your
                    Priority list always tells you who&apos;s next.
                  </li>
                  <li>
                    Log a quick <strong>note</strong> after every conversation —
                    future-you will thank you.
                  </li>
                  <li>
                    Keep <strong>status</strong> and <strong>pipeline stage</strong>{" "}
                    current so your analytics reflect reality.
                  </li>
                  <li>
                    Run the <strong>STR Analyser</strong> before you dial so you
                    can talk numbers with confidence.
                  </li>
                  <li>
                    Enter an <strong>estimated income</strong> per lead to see the
                    value sitting in your pipeline.
                  </li>
                </List>
              </CardContent>
            </Card>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-5 text-sm font-semibold">{children}</h3>;
}

function List({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <ul className={"list-disc space-y-1.5 pl-5 text-muted-foreground " + className}>
      {children}
    </ul>
  );
}

function Callout({
  children,
  variant = "tip",
}: {
  children: React.ReactNode;
  variant?: "tip" | "warn";
}) {
  const styles =
    variant === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-brand/20 bg-brand/5 text-foreground/90";
  return (
    <div className={"rounded-lg border-[0.5px] p-3 text-sm " + styles}>
      {children}
    </div>
  );
}

function NavRef({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1 inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

function StageBlock({
  title,
  stages,
  blurbs,
}: {
  title: string;
  stages: { value: string; label: string }[];
  blurbs: Record<string, string>;
}) {
  return (
    <div className="mt-4">
      <p className="mb-2 text-sm font-medium">{title}</p>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {stages.map((s, i) => (
          <span key={s.value} className="flex items-center gap-1.5">
            <span
              className={
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
                pipelineBadgeClass(s.value)
              }
            >
              {s.label}
            </span>
            {i < stages.length - 1 && (
              <span className="text-muted-foreground">→</span>
            )}
          </span>
        ))}
      </div>
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        {stages.map((s) => (
          <li key={s.value}>
            <span className="font-medium text-foreground/90">{s.label}:</span>{" "}
            {blurbs[s.value]}
          </li>
        ))}
      </ul>
    </div>
  );
}
