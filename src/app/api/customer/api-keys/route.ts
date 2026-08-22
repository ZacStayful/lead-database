/**
 * Managing the caller's own API keys.
 *
 * SESSION-ONLY, AND AN API KEY MUST NEVER REACH THESE ROUTES. They call
 * getCurrentCustomer() directly rather than resolveCaller(), because a key that
 * can mint keys is a key that can grant itself scopes it was not given and
 * outlive its own revocation. That is the whole reason the resolver is not used
 * here, and it should not be "tidied up" into one.
 *
 * These also deliberately ignore the `api_enabled` kill switch: a customer must
 * be able to revoke a key while the API itself is switched off, which is
 * precisely when they are most likely to want to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateApiKey } from "@/lib/api/keys";
import { DEFAULT_SCOPES, isApiScope, type ApiScope } from "@/lib/api/scopes";
import { MAX_KEYS_PER_CUSTOMER } from "@/lib/api/limits";
import { holdsProduct } from "@/lib/products";
import { sendApiKeyCreatedEmail } from "@/lib/emails/apiKeyCreated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never selects key_hash. There is no caller who should ever receive it. */
const LIST_COLUMNS =
  "id, name, key_prefix, scopes, expires_at, created_at, last_used_at, revoked_at";

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customer_api_keys")
    .select(LIST_COLUMNS)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[api-keys] list failed", error);
    return NextResponse.json({ error: "Could not load your API keys" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, keys: data ?? [] });
}

export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Holding a product is the gate on CREATING a key. It is deliberately not the
  // gate on USING one — a customer who later cancels keeps a working
  // integration, in the same way they keep their unused credits.
  const holdsAny =
    holdsProduct(customer, "management") || holdsProduct(customer, "guaranteed_rent");
  if (!holdsAny) {
    return NextResponse.json(
      { error: "API access is available once you hold a lead package." },
      { status: 403 }
    );
  }

  let body: { name?: unknown; scopes?: unknown; expires_in_days?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 60) {
    return NextResponse.json(
      { error: "Give the key a name between 1 and 60 characters." },
      { status: 400 }
    );
  }

  let scopes: ApiScope[] = [...DEFAULT_SCOPES];
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return NextResponse.json({ error: "scopes must be a non-empty array." }, { status: 400 });
    }
    const bad = body.scopes.find((s) => !isApiScope(s));
    if (bad !== undefined) {
      return NextResponse.json({ error: `Unknown scope: ${String(bad)}` }, { status: 400 });
    }
    scopes = body.scopes as ApiScope[];
  }

  let expiresAt: string | null = null;
  if (body.expires_in_days !== undefined && body.expires_in_days !== null) {
    const days = Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return NextResponse.json(
        { error: "expires_in_days must be a whole number of days, or omitted for no expiry." },
        { status: 400 }
      );
    }
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const admin = createAdminClient();

  const { count, error: countError } = await admin
    .from("customer_api_keys")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customer.id)
    .is("revoked_at", null);

  if (countError) {
    console.error("[api-keys] count failed", countError);
    return NextResponse.json({ error: "Could not create the key" }, { status: 500 });
  }
  if ((count ?? 0) >= MAX_KEYS_PER_CUSTOMER) {
    return NextResponse.json(
      {
        error: `You can hold at most ${MAX_KEYS_PER_CUSTOMER} active keys. Revoke one you are not using first.`,
      },
      { status: 409 }
    );
  }

  const { raw, prefix, hash } = generateApiKey();

  const { data, error } = await admin
    .from("customer_api_keys")
    .insert({
      customer_id: customer.id,
      name,
      key_prefix: prefix,
      key_hash: hash,
      scopes,
      expires_at: expiresAt,
      created_by: user.id,
    })
    .select(LIST_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    console.error("[api-keys] insert failed", error);
    return NextResponse.json({ error: "Could not create the key" }, { status: 500 });
  }

  // Sent AFTER the key exists and best-effort: the customer already has a
  // working key by this point, so failing the request over an email would
  // destroy something real to report something that isn't.
  try {
    await sendApiKeyCreatedEmail({
      to: customer.email,
      contactName: customer.contact_name,
      keyName: name,
      keyPrefix: prefix,
    });
  } catch (err) {
    console.error("[api-keys] creation email failed", err);
  }

  // The ONLY response that will ever contain the raw key.
  return NextResponse.json({ ok: true, key: data, secret: raw });
}
