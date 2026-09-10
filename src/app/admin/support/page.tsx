/**
 * /admin/support — every support request and feature request, and what became
 * of it (CLAUDE.md §46).
 *
 * Until 0133 these were emailed and forgotten: two in-app forms, one inbox, no
 * table, and no way to answer how many requests there had been, who was asking,
 * or which of them we actually shipped.
 *
 * ⚠️ THIS PAGE DELIBERATELY SHOWS ARCHIVED AND CANCELLED CUSTOMERS, where every
 * other admin surface hides them (§18D). Of the nine backfilled tickets, three
 * belong to a customer who has since cancelled and one to a customer whose
 * other row is archived. A ticket is a record of something that happened, and
 * the customer's current circulation status does not unhappen it.
 */
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { SupportTicketsTable } from "@/components/admin/SupportTicketsTable";
import { planSnapshot, type TicketPlanFields } from "@/lib/supportTicketLog";
import type {
  SupportTicketRow,
  SupportTicketNoteRow,
} from "@/components/admin/SupportTicketsTable";
import type { TicketStatus } from "@/lib/supportTickets";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 300;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border-[0.5px] border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

type JoinedCustomer = {
  id: string;
  business_name: string;
  contact_name: string;
  is_active: boolean;
  account_status: string;
  subscription_status: string;
  gr_subscription_status: string;
  monthly_allocation: number | null;
  gr_monthly_allocation: number | null;
};

export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: { status?: string; kind?: string; product?: string; customer?: string };
}) {
  const admin = createAdminClient();

  let query = admin
    .from("support_tickets")
    .select(
      "id, reference, source, kind, status, channel, subject, body, page, product, " +
        "plan_snapshot, visible_to_customer, submitted_at, resolved_at, " +
        "shipped_migration, shipped_claude_section, submitter_name, submitter_email, " +
        "submitter_business, backfill_key, " +
        // §47. Admin-only — never add these to CUSTOMER_TICKET_COLUMNS on
        // /dashboard/support; supportTicketBoundary.test.ts fails if you do.
        "ai_status, clarifications, brief, generated_prompt, severity, " +
        "customer:customers!support_tickets_customer_id_fkey(" +
        "id, business_name, contact_name, is_active, account_status, " +
        "subscription_status, gr_subscription_status, monthly_allocation, " +
        "gr_monthly_allocation)",
      { count: "exact" }
    )
    .order("submitted_at", { ascending: false })
    .limit(LIST_LIMIT);

  // Server-side filters change WHICH ROWS ARE FETCHED, so they are links rather
  // than client state — the imported-leads split.
  if (searchParams.status) query = query.eq("status", searchParams.status);
  if (searchParams.kind) query = query.eq("kind", searchParams.kind);
  if (searchParams.product === "platform") {
    query = query.is("product", null);
  } else if (searchParams.product) {
    query = query.eq("product", searchParams.product);
  }
  if (searchParams.customer) query = query.eq("customer_id", searchParams.customer);

  const { data: ticketData, count, error } = await query;

  // Aggregates over the WHOLE table, never over the filtered page — a count
  // that moved when you clicked a filter would answer a different question
  // from the one the card's label asks.
  const { data: allData } = await admin
    .from("support_tickets")
    .select("status, kind, product, customer_id, submitted_at, shipped_migration, shipped_claude_section")
    .limit(5000);

  const all = (allData ?? []) as Array<{
    status: TicketStatus;
    kind: string;
    product: string | null;
    customer_id: string | null;
    submitted_at: string;
    shipped_migration: string | null;
    shipped_claude_section: string | null;
  }>;

  const open = all.filter((t) => t.status === "open" || t.status === "in_progress");
  const askers = new Set(all.filter((t) => t.customer_id).map((t) => t.customer_id));
  const oldestOpen = open.reduce<string | null>(
    (acc, t) => (acc === null || t.submitted_at < acc ? t.submitted_at : acc),
    null
  );
  const oldestOpenDays = oldestOpen
    ? Math.floor((Date.now() - new Date(oldestOpen).getTime()) / 86_400_000)
    : null;
  const doneWithoutRef = all.filter(
    (t) =>
      t.status === "done" && !t.shipped_migration && !t.shipped_claude_section
  ).length;
  const bugs = all.filter((t) => t.kind === "bug").length;
  const features = all.filter((t) => t.kind === "feature").length;
  const support = all.filter((t) => t.kind === "support").length;

  const rows: SupportTicketRow[] = (
    (ticketData ?? []) as unknown as Array<
      Omit<SupportTicketRow, "customer_name" | "customer_id" | "customer_state" | "live_plan"> & {
        customer: JoinedCustomer | null;
      }
    >
  ).map((t) => {
    const c = t.customer;
    return {
      id: t.id,
      reference: t.reference,
      source: t.source,
      kind: t.kind,
      status: t.status,
      channel: t.channel,
      subject: t.subject,
      body: t.body,
      page: t.page,
      product: t.product,
      plan_snapshot: t.plan_snapshot,
      visible_to_customer: t.visible_to_customer,
      submitted_at: t.submitted_at,
      resolved_at: t.resolved_at,
      shipped_migration: t.shipped_migration,
      shipped_claude_section: t.shipped_claude_section,
      submitter_name: t.submitter_name,
      submitter_email: t.submitter_email,
      submitter_business: t.submitter_business,
      backfill_key: t.backfill_key,
      // §47. Null on every pre-0134 ticket, which is the shape the panel
      // treats as "no questions were ever offered" and renders nothing for.
      ai_status: t.ai_status,
      clarifications: t.clarifications,
      brief: t.brief,
      generated_prompt: t.generated_prompt,
      severity: t.severity,
      customer_id: c?.id ?? null,
      customer_name: c?.business_name ?? null,
      // Archived and cancelled are shown, not hidden — see the file header.
      customer_state: c
        ? c.is_active === false
          ? "archived"
          : c.account_status === "cancelled"
            ? "cancelled"
            : null
        : null,
      // ⚠️ The LIVE plan, beside the snapshot taken when they asked. §21's
      // "always two numbers, never one": Leslie Rogers raised three tickets
      // while paying and has since cancelled, and both facts matter.
      live_plan: c ? planSnapshot(c as unknown as TicketPlanFields) : null,
    };
  });

  const ids = rows.map((r) => r.id);
  const { data: noteData } = ids.length
    ? await admin
        .from("support_ticket_notes")
        .select("id, ticket_id, body, author_email, created_at")
        .in("ticket_id", ids)
        .order("created_at", { ascending: true })
    : { data: [] };
  const notes = (noteData ?? []) as SupportTicketNoteRow[];

  const filtered =
    searchParams.status || searchParams.kind || searchParams.product || searchParams.customer;

  // Distinct customers who have written in, for the filter links.
  const customerLinks = Array.from(
    new Map(
      rows
        .filter((r) => r.customer_id)
        .map((r) => [r.customer_id as string, r.customer_name ?? "—"])
    ).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Support</h1>
        <p className="text-sm text-muted-foreground">
          Every support request and feature request, and what became of it. A
          customer who writes in is a customer using the product.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600">
          Could not read the tickets: {error.message}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Open"
          value={String(open.length)}
          hint={
            oldestOpenDays === null
              ? "nothing waiting"
              : `oldest waiting ${oldestOpenDays} day${oldestOpenDays === 1 ? "" : "s"}`
          }
        />
        <Stat
          label="Tickets all time"
          value={String(all.length)}
          hint={`${support} support · ${features} feature · ${bugs} bug`}
        />
        <Stat
          label="Customers who have written in"
          value={String(askers.size)}
          hint="the engagement signal this page is for"
        />
        <Stat
          label="Done with nothing recording it"
          value={String(doneWithoutRef)}
          hint="closed, but a future session cannot pick it up"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {count ?? rows.length} ticket{(count ?? rows.length) === 1 ? "" : "s"}
            {filtered ? " matching" : ""}
          </CardTitle>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs">
            <FilterRow
              label="Status"
              current={searchParams.status}
              params={searchParams}
              name="status"
              options={[
                ["open", "Open"],
                ["in_progress", "In progress"],
                ["done", "Done"],
                ["wont_do", "Won't do"],
              ]}
            />
            <FilterRow
              label="Kind"
              current={searchParams.kind}
              params={searchParams}
              name="kind"
              options={[
                ["support", "Support"],
                ["feature", "Feature"],
                ["bug", "Bug"],
              ]}
            />
            <FilterRow
              label="Service"
              current={searchParams.product}
              params={searchParams}
              name="product"
              options={[
                ["management", "Management"],
                ["guaranteed_rent", "Guaranteed Rent"],
                ["platform", "Platform-wide"],
              ]}
            />
            <FilterRow
              label="Customer"
              current={searchParams.customer}
              params={searchParams}
              name="customer"
              options={customerLinks}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <SupportTicketsTable tickets={rows} notes={notes} />
        </CardContent>
      </Card>
    </div>
  );
}

/** One row of server-side filter links. Selecting one narrows the query. */
function FilterRow({
  label,
  name,
  current,
  options,
  params,
}: {
  label: string;
  name: string;
  current?: string;
  options: Array<[string, string]>;
  params: Record<string, string | undefined>;
}) {
  if (options.length === 0) return null;
  const href = (value: string | null) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v && k !== name) next.set(k, v);
    }
    if (value) next.set(name, value);
    const qs = next.toString();
    return qs ? `/admin/support?${qs}` : "/admin/support";
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{label}:</span>
      <Link
        href={href(null)}
        className={!current ? "font-medium text-brand" : "text-muted-foreground hover:underline"}
      >
        All
      </Link>
      {options.map(([value, text]) => (
        <Link
          key={value}
          href={href(value)}
          className={
            current === value
              ? "font-medium text-brand"
              : "text-muted-foreground hover:underline"
          }
        >
          {text}
        </Link>
      ))}
    </div>
  );
}
