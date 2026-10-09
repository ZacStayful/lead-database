import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * In-memory stand-ins for the slice of supabase-js and Stripe that the guarded
 * checkout and the webhook backstop use. No network, no database: the suite
 * stays a pure unit (vitest.config.mts), while still running the real
 * orchestration end to end.
 */

type Row = Record<string, unknown>;

export interface FakeDb {
  admin: SupabaseClient;
  tables: Record<string, Row[]>;
  /** Every write, in order: what the guards about ordering read. */
  writes: { table: string; op: "insert" | "update"; values: Row }[];
}

export function fakeDb(
  init: Record<string, Row[]>,
  opts: {
    primaryKeys?: Record<string, string>;
    failInsert?: Record<string, { code?: string; message: string }>;
    failSelect?: Record<string, { message: string }>;
    onWrite?: (table: string, op: string, values: Row) => void;
  } = {}
): FakeDb {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(init));
  const writes: FakeDb["writes"] = [];

  function from(table: string) {
    let op: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    let toInsert: Row | null = null;
    const filters: ((r: Row) => boolean)[] = [];
    let limit = Infinity;

    const run = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      const rows = (tables[table] ??= []);
      if (op === "insert" && toInsert) {
        const failure = opts.failInsert?.[table];
        if (failure) return { data: null, error: failure };
        const pk = opts.primaryKeys?.[table];
        if (pk && rows.some((r) => r[pk] === toInsert![pk])) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        // A real table defaults its id; so does this one, when the row brings none.
        const stored = { ...(toInsert.id === undefined ? { id: `${table}_${rows.length + 1}` } : {}), ...toInsert };
        rows.push(stored);
        writes.push({ table, op: "insert", values: { ...toInsert } });
        opts.onWrite?.(table, "insert", toInsert);
        return { data: [{ ...stored }], error: null };
      }
      if (op === "select" && opts.failSelect?.[table]) return { data: null, error: opts.failSelect[table] };
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of matched) Object.assign(r, patch);
        writes.push({ table, op: "update", values: { ...patch } });
        opts.onWrite?.(table, "update", patch);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      return { data: matched.slice(0, limit).map((r) => ({ ...r })), error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, v: unknown) => {
        filters.push((r) => r[col] === v);
        return builder;
      },
      is: (col: string, v: unknown) => {
        filters.push((r) => (r[col] ?? null) === v);
        return builder;
      },
      in: (col: string, vs: unknown[]) => {
        filters.push((r) => vs.includes(r[col]));
        return builder;
      },
      neq: (col: string, v: unknown) => {
        filters.push((r) => r[col] !== v);
        return builder;
      },
      lt: (col: string, v: string | number) => {
        filters.push((r) => r[col] != null && (r[col] as string | number) < v);
        return builder;
      },
      gt: (col: string, v: string | number) => {
        filters.push((r) => r[col] != null && (r[col] as string | number) > v);
        return builder;
      },
      // Row order is insertion order here; tests that care seed it that way.
      order: () => builder,
      limit: (n: number) => {
        limit = n;
        return builder;
      },
      update: (p: Row) => {
        op = "update";
        patch = p;
        return builder;
      },
      insert: (r: Row) => {
        op = "insert";
        toInsert = r;
        return builder;
      },
      maybeSingle: async () => {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  return { admin: { from } as unknown as SupabaseClient, tables, writes };
}

/* ------------------------------------------------------------------ */

export interface FakeStripeState {
  customers: { id: string; email: string | null; deleted?: boolean }[];
  sessions: {
    id: string;
    customer: string;
    status: "open" | "expired" | "complete";
    url: string;
    priceId: string;
    metadata: Record<string, string>;
    expires_at: number;
    params?: Stripe.Checkout.SessionCreateParams;
  }[];
  subscriptions: {
    id: string;
    customer: string;
    created: number;
    status: string;
    cancel_at_period_end?: boolean;
    priceId: string;
    latest_invoice?: string | null;
  }[];
  invoices: {
    id: string;
    status: string;
    amount_paid: number;
    payment_intent?: string | null;
  }[];
}

export interface FakeStripe {
  stripe: Stripe;
  state: FakeStripeState;
  /** Every call as "resource.method", with its idempotency key when given. */
  calls: { name: string; key?: string; args?: unknown }[];
}

export function fakeStripe(
  init: Partial<FakeStripeState> = {},
  opts: { fail?: Partial<Record<string, Error>>; onCall?: (name: string) => void } = {}
): FakeStripe {
  const state: FakeStripeState = {
    customers: [],
    sessions: [],
    subscriptions: [],
    invoices: [],
    ...JSON.parse(JSON.stringify(init)),
  };
  const calls: FakeStripe["calls"] = [];
  let seq = 0;

  function call(name: string, key?: string, args?: unknown) {
    calls.push({ name, key, args });
    opts.onCall?.(name);
    const failure = opts.fail?.[name];
    if (failure) throw failure;
  }

  const subView = (s: FakeStripeState["subscriptions"][number]) => ({
    id: s.id,
    customer: s.customer,
    created: s.created,
    status: s.status,
    cancel_at_period_end: Boolean(s.cancel_at_period_end),
    latest_invoice: s.latest_invoice ?? null,
    items: { data: [{ price: { id: s.priceId } }] },
  });

  const stripe = {
    customers: {
      list: async (p: { email: string }) => {
        call("customers.list", undefined, p);
        return { data: state.customers.filter((c) => c.email === p.email) };
      },
      create: async (p: { email: string }, o?: { idempotencyKey?: string }) => {
        call("customers.create", o?.idempotencyKey, p);
        const c = { id: `cus_new${++seq}`, email: p.email };
        state.customers.push(c);
        return c;
      },
      retrieve: async (id: string) => {
        call("customers.retrieve", undefined, id);
        const c = state.customers.find((x) => x.id === id);
        if (!c) throw new Error("No such customer");
        return c;
      },
    },
    checkout: {
      sessions: {
        list: async (p: { customer: string; status: string }) => {
          call("checkout.sessions.list", undefined, p);
          return {
            data: state.sessions
              .filter((s) => s.customer === p.customer && s.status === p.status)
              .map((s) => ({
                id: s.id,
                url: s.url,
                expires_at: s.expires_at,
                metadata: s.metadata,
                line_items: { data: [{ price: { id: s.priceId } }] },
              })),
          };
        },
        expire: async (id: string) => {
          call("checkout.sessions.expire", undefined, id);
          const s = state.sessions.find((x) => x.id === id);
          if (s) s.status = "expired";
          return s;
        },
        create: async (p: Stripe.Checkout.SessionCreateParams) => {
          call("checkout.sessions.create", undefined, p);
          const id = `cs_new${++seq}`;
          const s = {
            id,
            customer: p.customer as string,
            status: "open" as const,
            url: `https://checkout.stripe.com/c/${id}`,
            priceId: (p.line_items?.[0]?.price as string) ?? "",
            metadata: (p.metadata ?? {}) as Record<string, string>,
            expires_at: Math.floor(Date.now() / 1000) + 86400,
            params: p,
          };
          state.sessions.push(s);
          return { id, url: s.url };
        },
      },
    },
    subscriptions: {
      list: async (p: { customer: string }) => {
        call("subscriptions.list", undefined, p);
        return { data: state.subscriptions.filter((s) => s.customer === p.customer).map(subView) };
      },
      retrieve: async (id: string) => {
        call("subscriptions.retrieve", undefined, id);
        const s = state.subscriptions.find((x) => x.id === id);
        if (!s) throw new Error("No such subscription");
        return subView(s);
      },
      cancel: async (id: string, _p: unknown, o?: { idempotencyKey?: string }) => {
        call("subscriptions.cancel", o?.idempotencyKey, id);
        const s = state.subscriptions.find((x) => x.id === id);
        if (!s) throw new Error("No such subscription");
        s.status = "canceled";
        return subView(s);
      },
    },
    invoices: {
      retrieve: async (id: string) => {
        call("invoices.retrieve", undefined, id);
        const i = state.invoices.find((x) => x.id === id);
        if (!i) throw new Error("No such invoice");
        return { ...i };
      },
    },
    refunds: {
      create: async (p: { payment_intent?: string; charge?: string }, o?: { idempotencyKey?: string }) => {
        call("refunds.create", o?.idempotencyKey, p);
        return { id: `re_${o?.idempotencyKey ?? ++seq}` };
      },
    },
  };

  return { stripe: stripe as unknown as Stripe, state, calls };
}
