/**
 * The self-serve funnel's entry, opened from the link n8n sends an enquirer
 * (batch 02). No sign-in: the token is the credential and opens exactly one
 * session (funnel/token.ts).
 *
 * Phase 2 settles who may be here and nothing else:
 *   - an unknown or malformed token is a 404, the same answer either way, so
 *     the page cannot be used to probe;
 *   - somebody already set up, or a paid session, goes to /login with "You're
 *     already set up" (02 Phase 2);
 *   - with funnel_enabled off, the page says so and offers a call.
 * The screens themselves are Phase 3.
 *
 * ⚠️ The token is in the path, so the page sends no referrer: a link clicked
 * from here must not carry the token to another site.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Logo } from "@/components/Logo";
import { createAdminClient } from "@/lib/supabase/admin";
import { BRIEF_BOOKING_URL } from "@/lib/leadBrief/briefCopy";
import { FUNNEL_COPY } from "@/lib/funnel/copy";
import { isAlreadySetUp } from "@/lib/funnel/session";
import { customersByEmail, loadSessionByToken, readFunnelEnabled } from "@/lib/funnel/server";
import { ALREADY_SET_UP_LOGIN_PATH } from "@/lib/funnel/token";

export const dynamic = "force-dynamic";

export const metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 flex justify-center">
          <Logo height={36} priority />
        </div>
        {children}
      </div>
    </main>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <div className="rounded-xl border border-black/10 bg-white p-8 text-center">
        <h1 className="mb-3 text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
        <Link
          href={BRIEF_BOOKING_URL}
          rel="noreferrer"
          className="mt-4 inline-block text-sm font-medium underline"
        >
          {FUNNEL_COPY.bookCall}
        </Link>
      </div>
    </Shell>
  );
}

export default async function FunnelStartPage({ params }: { params: { token: string } }) {
  const admin = createAdminClient();
  const [enabled, lookup] = await Promise.all([
    readFunnelEnabled(admin),
    loadSessionByToken(admin, params.token),
  ]);

  if (!lookup.ok) {
    console.error("[funnel/start] session lookup failed", lookup.message);
    return <Notice title={FUNNEL_COPY.unavailableTitle} body={FUNNEL_COPY.unavailableBody} />;
  }
  const session = lookup.session;
  if (!session) notFound();

  if (session.step === "paid") redirect(ALREADY_SET_UP_LOGIN_PATH);
  const customers = await customersByEmail(admin, session.email);
  if (customers.ok && customers.customers.some(isAlreadySetUp)) redirect(ALREADY_SET_UP_LOGIN_PATH);

  if (!enabled || !customers.ok) {
    return <Notice title={FUNNEL_COPY.unavailableTitle} body={FUNNEL_COPY.unavailableBody} />;
  }

  return <Notice title={FUNNEL_COPY.comingSoonTitle} body={FUNNEL_COPY.comingSoonBody} />;
}
