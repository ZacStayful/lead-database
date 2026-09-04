/**
 * The consent screen.
 *
 * OUTSIDE THE DASHBOARD CHROME on purpose, following src/app/topup/[token]: a
 * customer arriving here has been sent by another application and is deciding
 * one thing. Nav, notifications and a sidebar are all invitations to wander off
 * mid-flow, and the client is holding a window open waiting.
 *
 * Every validation decision comes from validateAuthorizeRequest() so this page
 * and the POST that follows it cannot reach different verdicts.
 */
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Card, CardContent } from "@/components/ui/card";
import { ConsentForm } from "@/components/oauth/ConsentForm";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { oauthEnabled } from "@/lib/oauth/enabled";
import { holdsProduct } from "@/lib/products";
import { SCOPE_LABELS, type ApiScope } from "@/lib/api/scopes";
import { mintNonce } from "@/lib/oauth/tokens";
import {
  errorRedirectUrl,
  validateAuthorizeRequest,
  type ClientRecord,
} from "@/lib/oauth/authorizeRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The cookie half of the double-submit CSRF pair. */
export const CONSENT_NONCE_COOKIE = "sf_oauth_consent";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex justify-center">
          <Logo />
        </div>
        {children}
      </div>
    </div>
  );
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <Shell>
      <Card>
        <CardContent className="space-y-3 pt-6 text-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="text-muted-foreground">{detail}</p>
          <p className="text-muted-foreground">
            If you were not expecting this,{" "}
            <Link href="/dashboard" className="text-brand hover:underline">
              go to your dashboard
            </Link>{" "}
            instead.
          </p>
        </CardContent>
      </Card>
    </Shell>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const one = (k: string): string | null => {
    const v = searchParams[k];
    return typeof v === "string" ? v : null;
  };

  if (!(await oauthEnabled())) {
    return (
      <Problem
        title="Connections are not available right now"
        detail="Connecting an application is temporarily switched off. Please try again later."
      />
    );
  }

  const admin = createAdminClient();
  const clientId = one("client_id");

  let client: ClientRecord | null = null;
  if (clientId) {
    const { data } = await admin
      .from("oauth_clients")
      .select("client_id, client_name, redirect_uris, scope, disabled_at")
      .eq("client_id", clientId)
      .maybeSingle();
    client = (data as ClientRecord | null) ?? null;
  }

  const verdict = validateAuthorizeRequest(
    {
      client_id: clientId,
      redirect_uri: one("redirect_uri"),
      response_type: one("response_type"),
      code_challenge: one("code_challenge"),
      code_challenge_method: one("code_challenge_method"),
      scope: one("scope"),
      state: one("state"),
      resource: one("resource"),
    },
    client
  );

  if (verdict.kind === "fatal") {
    return <Problem title={verdict.title} detail={verdict.detail} />;
  }
  if (verdict.kind === "redirect") {
    redirect(errorRedirectUrl(verdict));
  }

  // Only now, with a trusted destination, is it safe to involve the customer.
  const { user, customer } = await getCurrentCustomer();
  if (!user) {
    // The whole query string is preserved so the flow resumes exactly here.
    // login/page.tsx's safe-redirect guard accepts a relative path and pushes it
    // verbatim, so nothing else is needed.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (typeof v === "string") params.set(k, v);
    }
    redirect(`/login?redirectedFrom=${encodeURIComponent(`/oauth/authorize?${params}`)}`);
  }

  if (!customer) {
    return (
      <Problem
        title="This account is not set up yet"
        detail="You are signed in, but there is no subscription on this account to connect an application to."
      />
    );
  }
  if (!customer.is_active) {
    // Archived (§18D) rather than cancelled: the row was superseded and should
    // be out of circulation entirely.
    return (
      <Problem
        title="This account cannot connect applications"
        detail="Please contact support and we will sort it out."
      />
    );
  }
  if (!holdsProduct(customer, "management") && !holdsProduct(customer, "guaranteed_rent")) {
    // Mirrors the gate on /dashboard/api and on key creation. A customer who has
    // CANCELLED keeps any connection they already made — nothing here withdraws
    // what was paid for — but making a new one needs a live product.
    return (
      <Problem
        title="You need an active subscription to connect an application"
        detail="Once a package is active you can connect Claude, ChatGPT or your own tools to read your leads."
      />
    );
  }

  const nonce = mintNonce();
  cookies().set(CONSENT_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const redirectHost = new URL(verdict.redirectUri).host;
  const cancel = new URL(verdict.redirectUri);
  cancel.searchParams.set("error", "access_denied");
  cancel.searchParams.set("error_description", "The customer declined the request.");
  if (verdict.state !== null) cancel.searchParams.set("state", verdict.state);

  const hidden: Record<string, string> = {
    client_id: verdict.client.client_id,
    redirect_uri: verdict.redirectUri,
    response_type: "code",
    code_challenge: verdict.codeChallenge,
    code_challenge_method: "S256",
    scope: verdict.scopes.join(" "),
    resource: verdict.resource,
  };
  if (verdict.state !== null) hidden.state = verdict.state;

  return (
    <Shell>
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">
              {/* JSX escapes this. It is attacker-supplied text from an open
                  registration endpoint and must never be rendered as markup. */}
              Connect {verdict.client.client_name} to your leads?
            </h1>
            <p className="text-sm text-muted-foreground">
              Signed in as {customer.email}
            </p>
          </div>

          <div className="space-y-2 text-sm">
            <p className="font-medium">It will be able to:</p>
            <ul className="space-y-1 text-muted-foreground">
              {verdict.scopes.map((s) => (
                <li key={s}>· {SCOPE_LABELS[s as ApiScope]}</li>
              ))}
            </ul>
          </div>

          <div className="rounded-md border-[0.5px] border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">Read-only.</strong> It cannot
              change a lead, spend a credit, or touch your subscription or
              billing.
            </p>
            <p className="mt-2">
              We have not checked this application. Only continue if you started
              this yourself.
            </p>
            <p className="mt-2">
              It will return you to <strong className="text-foreground">{redirectHost}</strong>.
            </p>
          </div>

          <ConsentForm params={hidden} nonce={nonce} cancelUrl={cancel.toString()} />

          <p className="text-center text-xs text-muted-foreground">
            You can disconnect it at any time in{" "}
            <Link href="/dashboard/settings" className="hover:underline">
              Settings
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </Shell>
  );
}
