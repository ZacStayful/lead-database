import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { SupportForm } from "@/components/SupportForm";
import {
  customerStatusLabel,
  kindLabel,
  ticketReference,
  type TicketKind,
  type TicketStatus,
} from "@/lib/supportTickets";

export const dynamic = "force-dynamic";

/**
 * ⚠️ THE COLUMN LIST IS THE SECURITY BOUNDARY, NOT RLS.
 *
 * This read runs on the SERVICE ROLE (the §8 pattern: authenticate on the
 * session client, read on the service role), so row-level security is not
 * protecting anything here — `support_tickets` and `support_ticket_notes` are
 * both RLS-on with no policies, deny-all to the browser, and the service role
 * bypasses both. What keeps an admin's working notes away from the customer is
 * that this query names six columns on ONE table and never mentions the other.
 *
 * So: never `select("*")` here, and never join the notes. §32.8's lesson is
 * that stripping a field at the page boundary is a presentation control; the
 * fixed column list on a table that does not contain the sensitive data is a
 * structural one.
 */
const CUSTOMER_TICKET_COLUMNS =
  "reference, kind, status, subject, submitted_at, resolved_at";

type CustomerTicket = {
  reference: number;
  kind: TicketKind;
  status: TicketStatus;
  subject: string;
  submitted_at: string;
  resolved_at: string | null;
};

const STATUS_STYLE: Record<TicketStatus, string> = {
  open: "bg-muted text-muted-foreground",
  in_progress: "bg-amber-100 text-amber-800",
  done: "bg-[#EAF3DE] text-[#3B6D11]",
  wont_do: "bg-muted text-muted-foreground",
};

export default async function SupportPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");

  const defaults = customer
    ? {
        name: customer.contact_name,
        email: customer.email,
        business: customer.business_name,
      }
    : undefined;

  let tickets: CustomerTicket[] = [];
  if (customer) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("support_tickets")
      .select(CUSTOMER_TICKET_COLUMNS)
      .eq("customer_id", customer.id)
      .eq("visible_to_customer", true)
      .order("submitted_at", { ascending: false })
      .limit(50);
    tickets = (data ?? []) as unknown as CustomerTicket[];
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Support</h1>
        <p className="text-sm text-muted-foreground">
          Need help? Send the Stayful team a message and we&apos;ll get back to
          you by email.
        </p>
      </div>
      <SupportForm defaults={defaults} />

      {/*
        Renders NOTHING when there is nothing to show, rather than "you have no
        requests". A customer whose only ticket we chose not to share must not
        be told they have none.
      */}
      {tickets.length > 0 && (
        <div className="rounded-lg border-[0.5px] border-border bg-card p-5">
          <h2 className="text-base font-semibold">What you&apos;ve sent us</h2>
          <p className="text-xs text-muted-foreground">
            We reply by email. This is just so you can see we have it.
          </p>
          <ul className="divide-y divide-border/60 pt-3">
            {tickets.map((t) => (
              <li
                key={t.reference}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {ticketReference(t.reference)}
                </span>
                <span className="flex-1 text-sm">{t.subject}</span>
                <span className="text-xs text-muted-foreground">
                  {kindLabel(t.kind)} ·{" "}
                  {new Date(t.submitted_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[t.status]}`}
                >
                  {customerStatusLabel(t.status)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
