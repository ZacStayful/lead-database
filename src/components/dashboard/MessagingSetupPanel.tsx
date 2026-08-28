"use client";

/**
 * The messaging setup wizard (§28).
 *
 * Seven DNS records is a lot to ask of a property operator, so this screen has
 * to do real work: the correct subdomain is pre-filled and CONSTRUCTED rather
 * than typed, records are grouped by what they are FOR with copy buttons, and
 * the MX warning gets its own bordered block rather than a footnote.
 *
 * Copy is part of the mechanism here, the same argument §19.7 makes for the
 * pool's scarcity line.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle, Check, Copy, Loader2, RefreshCw, ArrowLeft, Mail, MessageCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type {
  DnsRecord, EmailDomainPublic, WhatsappConnectionPublic,
} from "@/lib/messaging/types";

const PURPOSE_LABEL: Record<string, string> = {
  sending: "Sending — proves the mail is really from you",
  tracking: "Tracking — so you can see opens and clicks",
  receiving: "Receiving — so landlord replies come back here",
};

export function MessagingSetupPanel({
  initialDomain,
  initialWhatsapp,
  companyDomainGuess,
}: {
  initialDomain: EmailDomainPublic | null;
  initialWhatsapp: WhatsappConnectionPublic | null;
  companyDomainGuess: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("channel");
  const returnTo = params.get("return");

  const [tab, setTab] = useState<"email" | "whatsapp">(
    requested === "whatsapp" ? "whatsapp" : "email"
  );

  return (
    <div className="space-y-6">
      {returnTo && (
        <Button variant="ghost" size="sm" onClick={() => router.push(returnTo)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to the lead
        </Button>
      )}

      <div className="flex gap-2">
        <Button
          variant={tab === "email" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("email")}
        >
          <Mail className="mr-2 h-4 w-4" /> Email
        </Button>
        <Button
          variant={tab === "whatsapp" ? "default" : "outline"}
          size="sm"
          onClick={() => setTab("whatsapp")}
        >
          <MessageCircle className="mr-2 h-4 w-4" /> WhatsApp
        </Button>
      </div>

      {tab === "email" ? (
        <EmailSetup initial={initialDomain} domainGuess={companyDomainGuess} returnTo={returnTo} />
      ) : (
        <WhatsappSetup initial={initialWhatsapp} returnTo={returnTo} />
      )}
    </div>
  );
}

function EmailSetup({
  initial,
  domainGuess,
  returnTo,
}: {
  initial: EmailDomainPublic | null;
  domainGuess: string | null;
  returnTo: string | null;
}) {
  const router = useRouter();
  const [domain, setDomain] = useState<EmailDomainPublic | null>(initial);
  const [website, setWebsite] = useState(domainGuess ?? "");
  const [prefix, setPrefix] = useState("leads");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const preview = useMemo(() => {
    const site = website.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return site ? `${prefix || "leads"}.${site.split(".").slice(-3).join(".")}` : "";
  }, [website, prefix]);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/messaging/email-domain/verify", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.domain) setDomain(data.domain);
      if (!res.ok) setError(data.error ?? "Could not check just now.");
    } finally {
      setChecking(false);
    }
  }, []);

  // Poll while verifying, then STOP. A tab left open overnight must not sit
  // hammering Resend; the server throttles too, but this is the polite half.
  useEffect(() => {
    if (!domain || domain.status === "verified" || pollCount > 40) return;
    const t = setTimeout(() => {
      setPollCount((n) => n + 1);
      void check();
    }, 15_000);
    return () => clearTimeout(t);
  }, [domain, pollCount, check]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/messaging/email-domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website_domain: website, prefix, api_key: apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not connect.");
        return;
      }
      setDomain(data.domain);
      setApiKey("");
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    await fetch("/api/customer/messaging/email-domain", { method: "DELETE" }).catch(() => {});
    setDomain(null);
    setBusy(false);
    router.refresh();
  }

  if (!domain) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Send email from your own domain</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Landlords see your address, not ours. Replies, opens and clicks come
              back into the lead automatically.
            </p>
            <p className="font-medium text-foreground">Before you start, you&apos;ll need:</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                A <strong>Resend account used only for Stayful</strong> — sign up free at{" "}
                <a href="https://resend.com/signup" target="_blank" rel="noreferrer" className="underline">
                  resend.com
                </a>
                . The free plan covers 100 emails a day.
              </li>
              <li>
                In that account, go to <strong>API Keys → Create API Key</strong> and choose{" "}
                <strong>Full access</strong>, then copy it.
              </li>
              <li>Access to your domain&apos;s DNS settings.</li>
            </ol>
            <p className="rounded-md border bg-muted/40 p-3">
              <strong>Why a dedicated Resend account?</strong> A full-access key can
              manage everything in the account it belongs to. Using a fresh account
              just for this means the key we hold can only ever touch this
              integration — nothing else of yours.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="website" className="text-sm font-medium">Your website domain</label>
              <input
                id="website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="youragency.co.uk"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="prefix" className="text-sm font-medium">Subdomain prefix</label>
              <input
                id="prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>

          {preview && (
            <p className="text-sm">
              We&apos;ll set up <strong>{preview}</strong> — a dedicated subdomain, so
              your normal email is untouched.
            </p>
          )}

          <div className="space-y-1">
            <label htmlFor="apikey" className="text-sm font-medium">Resend API key</label>
            <input
              id="apikey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="re_..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </div>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button onClick={connect} disabled={busy || !website || !apiKey}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Connect and get my DNS records
          </Button>
        </CardContent>
      </Card>
    );
  }

  const verified = domain.status === "verified";
  const groups: Record<string, DnsRecord[]> = {};
  for (const r of domain.dns_records ?? []) {
    (groups[r.purpose ?? "sending"] ||= []).push(r);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <span>{domain.domain}</span>
          <Badge className={verified ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}>
            {verified ? "Verified" : "Waiting for DNS"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {verified ? (
          <p className="text-sm">
            You&apos;re ready. Emails will go out from{" "}
            <strong>{domain.from_local_part}@{domain.domain}</strong> and replies will
            come back into the lead.
          </p>
        ) : (
          <>
            {/* ⚠️ Its own block, not a footnote. This is the one mistake that
                would break a customer's real email. */}
            <div className="rounded-md border-2 border-destructive/50 bg-destructive/5 p-4">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <div className="text-sm">
                  <p className="font-semibold text-destructive">
                    Add these to {domain.domain} only
                  </p>
                  <p className="mt-1">
                    Do <strong>not</strong> add them to {domain.parent_domain}. The MX
                    record in particular would stop your normal email arriving.
                  </p>
                </div>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              Add each record in your DNS provider. It usually takes a few minutes,
              occasionally a few hours. We check automatically.
            </p>

            {Object.entries(groups).map(([purpose, records]) => (
              <div key={purpose} className="space-y-2">
                <p className="text-sm font-medium">{PURPOSE_LABEL[purpose] ?? purpose}</p>
                {records.map((r, i) => (
                  <RecordRow key={`${purpose}-${i}`} record={r} />
                ))}
              </div>
            ))}

            <div className="flex items-center gap-3">
              <Button onClick={check} disabled={checking} variant="outline">
                {checking ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Check now
              </Button>
              <span className="text-xs text-muted-foreground">
                {pollCount > 40 ? "Automatic checking paused — use Check now." : "Checking every 15 seconds."}
              </span>
            </div>
          </>
        )}

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          {verified && returnTo && (
            <Button onClick={() => router.push(returnTo)}>Back to the lead</Button>
          )}
          <Button variant="outline" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RecordRow({ record }: { record: DnsRecord }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <div className="grid gap-2 sm:grid-cols-[80px_1fr_auto] sm:items-center">
        <span className="font-mono font-semibold">{record.type}</span>
        <div className="min-w-0 space-y-1">
          <p className="truncate font-mono">
            <span className="text-muted-foreground">Name: </span>
            {record.name || "@"}
          </p>
          <p className="break-all font-mono">
            <span className="text-muted-foreground">Value: </span>
            {record.value}
            {record.priority != null && (
              <span className="text-muted-foreground"> (priority {record.priority})</span>
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(record.value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

function WhatsappSetup({
  initial,
  returnTo,
}: {
  initial: WhatsappConnectionPublic | null;
  returnTo: string | null;
}) {
  const router = useRouter();
  const [conn, setConn] = useState<WhatsappConnectionPublic | null>(initial);
  const [token, setToken] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = conn?.status === "connected";

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/messaging/whatsapp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, risk_acknowledged: ack }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not connect.");
        return;
      }
      setConn(data.connection);
      setToken("");
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    await fetch("/api/customer/messaging/whatsapp", { method: "DELETE" }).catch(() => {});
    setConn(null);
    setBusy(false);
    router.refresh();
  }

  if (connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span>WhatsApp connected</span>
            <Badge className="bg-green-100 text-green-800">Connected</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            Messages go out from <strong>{conn?.whatsapp_account_phone}</strong>
            {conn?.workspace_label ? ` (${conn.workspace_label})` : ""}.
          </p>
          {conn?.messaging_quota_total != null && (
            <p className="text-muted-foreground">
              {Math.max(0, conn.messaging_quota_total - (conn.messaging_quota_used ?? 0))} of{" "}
              {conn.messaging_quota_total} messages left in your TimelinesAI plan this month.
            </p>
          )}
          <p className="text-muted-foreground">
            Sending is limited to {conn?.daily_send_cap} a day to protect your number.
          </p>
          <div className="flex gap-2">
            {returnTo && <Button onClick={() => router.push(returnTo)}>Back to the lead</Button>}
            <Button variant="outline" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Message landlords on WhatsApp</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Before you start, you&apos;ll need:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              A{" "}
              <a href="https://timelines.ai" target="_blank" rel="noreferrer" className="underline">
                TimelinesAI
              </a>{" "}
              account — from $25 a month, per WhatsApp number.
            </li>
            <li>Scan the QR code there to link your WhatsApp, as you would WhatsApp Web.</li>
            <li>
              Go to <strong>Integrations → Public API</strong> and copy your token.
            </li>
          </ol>
        </div>

        {/* ⚠️ Blocking, not a footnote. The number at risk is theirs. */}
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Please read this before connecting</p>
              <p className="mt-1">
                WhatsApp does not officially support automation on a personal or
                Business-app number. Sending at volume, or to people who have not
                messaged you first, risks WhatsApp <strong>restricting or banning
                that number</strong>. Use a number you could afford to lose, keep
                volumes low, and write messages personally.
              </p>
              <label className="mt-3 flex items-start gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  className="mt-1"
                />
                <span>I understand the risk to the connected number.</span>
              </label>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="watoken" className="text-sm font-medium">
            TimelinesAI Public API token
          </label>
          <input
            id="watoken"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          />
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button onClick={connect} disabled={busy || !token || !ack}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Connect WhatsApp
        </Button>
      </CardContent>
    </Card>
  );
}
