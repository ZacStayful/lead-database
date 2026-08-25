import { describe, it, expect, vi } from "vitest";
import { settleDueRefunds } from "../leadAnalysisRefund";

/**
 * The refund path inverts the charge path's doctrine, and these are the cases
 * that say so. A charge whose outcome is unknown releases so it can be retried;
 * a refund whose outcome is unknown is LEFT DUE, because marking one done that
 * never happened means nothing ever looks at it again.
 */

type Row = Record<string, unknown>;

function admin(opts: {
  jobs?: Row[];
  token?: Row | null;
  payment?: Row | null;
  rpcError?: { message: string } | null;
  onUpdate?: (table: string, patch: Row) => void;
  onRpc?: (name: string, args: Row) => void;
}) {
  const jobs = opts.jobs ?? [];
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        in: chain,
        limit: async () => ({ data: jobs, error: null }),
        maybeSingle: async () => ({
          data: table === "lead_analysis_tokens" ? opts.token ?? null : opts.payment ?? null,
          error: null,
        }),
        update(patch: Row) {
          opts.onUpdate?.(table, patch);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
      });
      return builder;
    },
    async rpc(name: string, args: Row) {
      opts.onRpc?.(name, args);
      return { data: true, error: opts.rpcError ?? null };
    },
  } as never;
}

function stripe(refunds: { create: (...a: never[]) => unknown }) {
  return { refunds } as never;
}

const JOB = { id: "job-1", customer_id: "cus-1", refund_pence: 900, refund_status: "due" };
const TOKEN = { payment_id: "pay-1" };
const PAYMENT = { stripe_payment_intent_id: "pi_1" };

describe("settleDueRefunds", () => {
  it("refunds the whole amount once, keyed off the job", async () => {
    // Three failed rows in a batch of twelve is one £9 line on the statement,
    // not three £3 ones.
    let seen: { args: Row; opts: Row } | null = null;
    const rpcCalls: Array<{ name: string; args: Row }> = [];
    const out = await settleDueRefunds(
      admin({ jobs: [JOB], token: TOKEN, payment: PAYMENT, onRpc: (name, args) => rpcCalls.push({ name, args }) }),
      stripe({
        create: async (args: never, o: never) => {
          seen = { args: args as Row, opts: o as Row };
          return { id: "re_1" };
        },
      })
    );
    expect(out).toEqual([{ jobId: "job-1", status: "refunded", amountPence: 900 }]);
    expect(seen!.args).toEqual({ payment_intent: "pi_1", amount: 900 });
    // Keyed off the job, so a re-run is handed the ORIGINAL refund rather than
    // issuing a second one.
    expect(seen!.opts.idempotencyKey).toBe("lead_analysis_refund_job-1");
    expect(rpcCalls[0]).toEqual({
      name: "record_lead_analysis_refund",
      args: { p_job_id: "job-1", p_refund_id: "re_1", p_amount_pence: 900 },
    });
  });

  it("LEAVES a failed refund due rather than marking it done", async () => {
    const rpcCalls: string[] = [];
    const out = await settleDueRefunds(
      admin({ jobs: [JOB], token: TOKEN, payment: PAYMENT, onRpc: (n) => rpcCalls.push(n) }),
      stripe({ create: async () => { throw new Error("stripe is down"); } })
    );
    expect(out[0].status).toBe("deferred");
    // Nothing recorded: the next run tries again, and the idempotency key stops
    // a double refund if the first one did in fact land.
    expect(rpcCalls).toEqual([]);
  });

  it("shouts when the money went back but our record of it did not", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await settleDueRefunds(
      admin({ jobs: [JOB], token: TOKEN, payment: PAYMENT, rpcError: { message: "db down" } }),
      stripe({ create: async () => ({ id: "re_2" }) })
    );
    expect(out[0].status).toBe("deferred");
    expect(err.mock.calls.some((c) => String(c[0]).includes("REFUNDED BUT NOT RECORDED"))).toBe(true);
    err.mockRestore();
  });

  it("closes out a job that was never charged instead of retrying it forever", async () => {
    const updates: Array<{ table: string; patch: Row }> = [];
    const out = await settleDueRefunds(
      admin({ jobs: [JOB], token: null, onUpdate: (table, patch) => updates.push({ table, patch }) }),
      stripe({ create: async () => { throw new Error("must not be called"); } })
    );
    expect(out[0]).toMatchObject({ status: "skipped" });
    expect(updates[0].patch).toEqual({ refund_status: "none", refund_pence: 0 });
  });

  it("does nothing when nothing is owed", async () => {
    const out = await settleDueRefunds(
      admin({ jobs: [{ ...JOB, refund_pence: 0 }] }),
      stripe({ create: async () => { throw new Error("must not be called"); } })
    );
    expect(out[0]).toMatchObject({ status: "skipped", reason: "nothing owed" });
  });

  it("defers when the charge left no payment intent to refund against", async () => {
    const out = await settleDueRefunds(
      admin({ jobs: [JOB], token: TOKEN, payment: { stripe_payment_intent_id: null } }),
      stripe({ create: async () => { throw new Error("must not be called"); } })
    );
    expect(out[0].status).toBe("deferred");
  });
});
