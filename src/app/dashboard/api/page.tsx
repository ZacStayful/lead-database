/**
 * /dashboard/api — the customer-facing reference.
 *
 * Deliberately states the two things that would otherwise be discovered the
 * hard way: that a discarded lead vanishes with no tombstone, and that `status`
 * is self-reported. Both are the kind of thing a sync quietly gets wrong for
 * weeks.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentCustomer } from "@/lib/auth";
import { holdsProduct } from "@/lib/products";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ASSIGNMENT_FIELDS, LEAD_FIELDS } from "@/lib/api/schema";
import { SCOPE_LABELS, API_SCOPES, type ApiScope } from "@/lib/api/scopes";
import {
  MAX_NOTES,
  MAX_PAGE_SIZE,
  RATE_LIMIT_PER_DAY,
  RATE_LIMIT_PER_MINUTE,
} from "@/lib/api/limits";
import { APP_URL } from "@/lib/env";

export const dynamic = "force-dynamic";

const ENDPOINTS = [
  { method: "GET", path: "/v1/me", what: "Your account, and your plan and pacing for each product you hold." },
  { method: "GET", path: "/v1/leads", what: "Your leads, newest first. Filter and paginate — see below." },
  { method: "GET", path: "/v1/leads/{id}", what: "One lead. {id} is the assignment id from the list." },
  { method: "GET", path: "/v1/leads/{id}/notes", what: `Your notes on one lead, newest first, up to ${MAX_NOTES}.` },
  { method: "GET", path: "/v1/leads/{id}/report", what: "The full property-analysis PDF, if one is stored." },
];

const ERRORS = [
  ["invalid_api_key", "401", "The key is wrong, malformed, or no longer belongs to an account."],
  ["revoked_api_key", "401", "You revoked this key."],
  ["expired_api_key", "401", "The key passed its expiry date."],
  ["insufficient_scope", "403", "The key was not given the scope this endpoint needs."],
  ["not_found", "404", "No such lead, or it is not one of yours. The two are deliberately indistinguishable."],
  ["invalid_request", "400", "A filter, cursor or parameter was not valid. The message names which."],
  ["rate_limited", "429", "Too many requests. Retry-After tells you how long to wait."],
  ["service_unavailable", "503", "The API is temporarily switched off."],
];

/**
 * How to connect each assistant.
 *
 * ⚠️ THE OLD VERSION OF THIS TABLE IS WHY OAUTH EXISTS. It said claude.ai
 * connectors were "Limited" and ChatGPT "Not yet", because both need OAuth and
 * an API key is all we had. Both now work by pasting one URL.
 *
 * The steps are the product here. A URL on its own is a support ticket.
 */
const CONNECT_STEPS: { client: string; steps: string[] }[] = [
  {
    client: "Claude — web, desktop or mobile",
    steps: [
      "Settings, then Connectors, then Add custom connector.",
      "Paste the MCP URL below and press Connect.",
      "Sign in with this Stayful account and press Allow.",
    ],
  },
  {
    client: "Claude Code",
    steps: [
      "Run: claude mcp add --transport http stayful <MCP URL>",
      "Then type /mcp and follow the sign-in prompt.",
    ],
  },
  {
    client: "ChatGPT",
    steps: [
      "Settings, then Connectors, then create a new connector.",
      "Paste the MCP URL below. Sign in and press Allow.",
    ],
  },
  {
    client: "Cursor, VS Code and other MCP clients",
    steps: [
      "Add the MCP URL to your mcp.json as an http server.",
      "Sign in when prompted, or set an Authorization header with an API key instead.",
    ],
  },
  {
    client: "n8n",
    steps: [
      "Point the MCP Client node at the MCP URL.",
      "Or use an HTTP Request node against the REST base URL with an API key.",
    ],
  },
];

export default async function ApiDocsPage() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) redirect("/login");
  if (!customer) redirect("/dashboard");
  if (
    !holdsProduct(customer, "management") &&
    !holdsProduct(customer, "guaranteed_rent")
  ) {
    redirect("/dashboard");
  }

  const base = `${APP_URL}/api/v1`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">API reference</h1>
        <p className="text-sm text-muted-foreground">
          Read your leads from your own tools. Connect an AI assistant by
          signing in — see below — or{" "}
          <Link href="/dashboard/settings" className="text-brand hover:underline">
            create an API key in Settings
          </Link>{" "}
          for anything that runs unattended.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Authenticating</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Send your key as a bearer token on every request. Everything is
            read-only — a key cannot change anything, spend credits or touch your
            subscription.
          </p>
          <pre className="overflow-x-auto rounded-md border-[0.5px] border-border bg-muted/40 p-3 text-xs">
{`Authorization: Bearer sfl_live_...`}
          </pre>
          <p className="text-muted-foreground">
            Base URL: <code>{base}</code> · MCP: <code>{APP_URL}/api/mcp</code>
          </p>
          <p className="text-muted-foreground">
            Limits are {RATE_LIMIT_PER_MINUTE} requests a minute per key and{" "}
            {RATE_LIMIT_PER_DAY.toLocaleString("en-GB")} a day per account. Every
            response carries <code>X-RateLimit-Remaining</code> and an{" "}
            <code>X-Request-Id</code> worth quoting if you contact support.
          </p>
          <div>
            <p className="font-medium">Scopes</p>
            <ul className="mt-1 list-inside list-disc text-muted-foreground">
              {API_SCOPES.map((s) => (
                <li key={s}>
                  <code>{s}</code> — {SCOPE_LABELS[s as ApiScope]}
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={e.path} className="border-b-[0.5px] border-border align-top">
                  <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                    {e.method} {e.path}
                  </td>
                  <td className="py-2 text-muted-foreground">{e.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            <strong>Every id is an assignment id</strong> — the <code>id</code> on
            a row from <code>/v1/leads</code>, not the lead&apos;s own id. One lead can
            be held by several operators, each with their own status and notes,
            so the assignment is what identifies yours.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Listing and paging leads</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Filters: <code>product</code>, <code>status</code>,{" "}
            <code>pipeline_stage</code>, <code>assigned_since</code>,{" "}
            <code>updated_since</code>, <code>limit</code> (max {MAX_PAGE_SIZE}),{" "}
            <code>sort</code>, <code>cursor</code>.
          </p>
          <p>
            Paging is by cursor: pass the <code>next_cursor</code> from the
            previous response. A <code>null</code> cursor means you have reached
            the end.
          </p>
          <p>
            <strong>For an incremental sync</strong>, use{" "}
            <code>sort=last_status_change_at</code> with{" "}
            <code>updated_since</code>, which pages by when something changed
            rather than when it arrived. A cursor belongs to the sort it was
            issued under and is refused under the other.
          </p>
          <div className="rounded-md border-[0.5px] border-border bg-muted/30 p-3">
            <p className="font-medium">Two things worth knowing before you build on this</p>
            <ul className="mt-1 list-inside list-disc text-muted-foreground">
              <li>
                A <strong>discarded</strong> lead disappears from this endpoint
                with no tombstone, so an incremental sync will never learn it
                went. Do a full walk occasionally to reconcile.
              </li>
              <li>
                <code>status</code> is <strong>self-reported</strong> — it moves
                when you or your team set it, so it reflects record-keeping
                rather than work done. Notes are better evidence.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fields</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <p className="font-medium">On each assignment</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {ASSIGNMENT_FIELDS.map((f) => (
                <li key={f.field}>
                  <code>{f.field}</code> — {f.description}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium">On the nested lead</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {LEAD_FIELDS.map((f) => (
                <li key={f.field}>
                  <code>{f.field}</code> — {f.description}
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Errors</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="mb-3 overflow-x-auto rounded-md border-[0.5px] border-border bg-muted/40 p-3 text-xs">
{`{ "error": { "code": "not_found", "message": "Not found." } }`}
          </pre>
          <table className="w-full text-sm">
            <tbody>
              {ERRORS.map(([code, status, what]) => (
                <tr key={code} className="border-b-[0.5px] border-border align-top">
                  <td className="py-2 pr-3 font-mono text-xs">{code}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{status}</td>
                  <td className="py-2 text-muted-foreground">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connect an AI assistant</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Give an assistant the address below and sign in. It can then read
            your leads, your notes and your property analyses — and nothing else.
            <strong className="text-foreground"> No API key is needed</strong>,
            and everything stays read-only: it cannot change a lead, spend a
            credit or touch your billing.
          </p>

          <pre className="overflow-x-auto rounded-md border-[0.5px] border-border bg-muted/40 p-3 text-xs">
{`${APP_URL}/api/mcp`}
          </pre>

          <div className="space-y-4">
            {CONNECT_STEPS.map((c) => (
              <div key={c.client}>
                <p className="font-medium">{c.client}</p>
                <ol className="mt-1 list-inside list-decimal space-y-0.5 text-muted-foreground">
                  {c.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>

          <div className="rounded-md border-[0.5px] border-border bg-muted/30 p-3">
            <p className="font-medium">Which should you use, a sign-in or a key?</p>
            <p className="mt-1 text-muted-foreground">
              <strong className="text-foreground">Sign in</strong> for an
              assistant you use yourself — it is two clicks and there is no
              secret to look after.{" "}
              <strong className="text-foreground">Use an API key</strong> for
              anything that runs unattended, such as a scheduled n8n workflow: a
              key needs no browser and does not expire.
            </p>
            <p className="mt-2 text-muted-foreground">
              Whatever you connect appears in{" "}
              <Link href="/dashboard/settings" className="text-brand hover:underline">
                Settings
              </Link>
              , where you can disconnect it at any time.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
