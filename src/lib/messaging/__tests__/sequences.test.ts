/**
 * The idempotency key, and the enrolment tally.
 *
 * ⚠️ THE KEY IS THE WHOLE ANSWER TO THE CODEBASE'S OBJECTION. §40.12 and the
 * send route both record that TimelinesAI has no idempotency key of its own, so
 * "a stale queued WhatsApp can never be safely auto-retried" and "a queue whose
 * entries cannot be safely retried is not worth inventing". The sending phase
 * runs every five minutes, so one step being considered twice is the ORDINARY
 * case — and what makes that safe is that `lead_messages` is unique on
 * (customer_id, idempotency_key) and this key is derived rather than generated.
 * Make it random and the second consideration messages the landlord again.
 */
import { describe, it, expect } from "vitest";
import {
  sequenceIdempotencyKey,
  enrolAssignments,
  enrolOnAssignment,
  DUE_DRAFT_COLUMNS,
  REVIEW_QUEUE_COLUMNS,
} from "../sequences";

/**
 * §27.8's trap, pinned on the two queries that would suffer from it worst.
 *
 * In PostgREST a filter on a NON-inner embedded resource filters the EMBEDDED
 * RESOURCE, not the parent rows — so every draft comes back with its run nulled
 * rather than being excluded. That is a 200 that paginates normally and is
 * wrong, and here it would have the sending phase walk drafts belonging to
 * STOPPED runs: messaging landlords who have already replied.
 */
describe("the embedded run is an INNER join", () => {
  it("on the sending phase's query", () => {
    expect(DUE_DRAFT_COLUMNS).toContain("message_sequence_runs!inner(");
  });

  it("on the review queue's query", () => {
    expect(REVIEW_QUEUE_COLUMNS).toContain("message_sequence_runs!inner(");
  });

  it("and the sending phase reads the run status it filters on", () => {
    // .eq("message_sequence_runs.status", "active") is meaningless if the
    // column is not selected.
    expect(DUE_DRAFT_COLUMNS).toMatch(/message_sequence_runs!inner\([^)]*status/);
  });
});

describe("sequenceIdempotencyKey", () => {
  it("is stable for the same run and step", () => {
    expect(sequenceIdempotencyKey("run-1", 2)).toBe(sequenceIdempotencyKey("run-1", 2));
  });

  it("differs per step, so a ladder is not one message", () => {
    expect(sequenceIdempotencyKey("run-1", 1)).not.toBe(sequenceIdempotencyKey("run-1", 2));
  });

  it("differs per run, so two leads on one sequence both get messaged", () => {
    expect(sequenceIdempotencyKey("run-1", 1)).not.toBe(sequenceIdempotencyKey("run-2", 1));
  });

  it("is keyed on the RUN and the STEP, never on the draft row", () => {
    // A draft that is cancelled and somehow re-created must not get a second
    // chance to send the same step.
    expect(sequenceIdempotencyKey("run-1", 1)).toBe("seq:run-1:1");
  });
});

/**
 * A fake that answers the three reads enrolment makes and records the inserts.
 * `insertOutcomes` is dealt out in order, so a 23505 can be placed exactly where
 * the test wants it — which is how the "already enrolled" tally is pinned
 * without a database.
 */
function fakeAdmin(state: {
  steps: { step_number: number; delay_days: number; brief: string | null }[];
  assignments: {
    id: string;
    lead_id: string;
    status: string | null;
    closed_at: string | null;
    closed_reason: string | null;
  }[];
  insertOutcomes?: (null | { code: string })[];
}) {
  const inserts: Record<string, unknown>[] = [];
  let outcomeIndex = 0;

  function builder(table: string) {
    const self: Record<string, unknown> = {};
    Object.assign(self, {
      select: () => self,
      eq: () => self,
      in: () => self,
      order: () => self,
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row);
        const outcome = state.insertOutcomes?.[outcomeIndex] ?? null;
        outcomeIndex += 1;
        return { error: outcome };
      },
      update: () => self,
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "message_sequence_steps") {
          return Promise.resolve({ data: state.steps, error: null }).then(resolve);
        }
        if (table === "lead_assignments") {
          return Promise.resolve({ data: state.assignments, error: null }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    });
    return self;
  }
  return { admin: { from: (t: string) => builder(t) } as never, inserts };
}

const STEPS = [
  { step_number: 1, delay_days: 0, brief: null },
  { step_number: 2, delay_days: 3, brief: null },
];

const WORKABLE = {
  id: "a1",
  lead_id: "l1",
  status: "new",
  closed_at: null,
  closed_reason: null,
};

describe("enrolAssignments", () => {
  it("enrols a workable lead and stamps the first step's due time", async () => {
    const { admin, inserts } = fakeAdmin({ steps: STEPS, assignments: [WORKABLE] });
    const now = new Date("2026-09-02T09:00:00Z");
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: ["a1"],
      now,
    });
    expect(r).toEqual({ enrolled: 1, alreadyEnrolled: 0, skipped: 0 });
    // delay_days 0 on step 1 — "message them as soon as they are assigned".
    expect(inserts[0].next_due_at).toBe(now.toISOString());
    expect(inserts[0].current_step).toBe(0);
  });

  it("counts a unique violation as ALREADY ENROLLED, never as an error", async () => {
    // The database is the real guard against two ladders on one landlord; the
    // tally exists so the operator sees a truthful number instead of a failure.
    const { admin } = fakeAdmin({
      steps: STEPS,
      assignments: [WORKABLE],
      insertOutcomes: [{ code: "23505" }],
    });
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: ["a1"],
    });
    expect(r).toEqual({ enrolled: 0, alreadyEnrolled: 1, skipped: 0 });
  });

  it("keeps going after a collision rather than abandoning the batch", async () => {
    // One lead already in a sequence must not refuse the other hundred and
    // ninety-nine — which is what a single batch insert would have done.
    const { admin } = fakeAdmin({
      steps: STEPS,
      assignments: [
        WORKABLE,
        { ...WORKABLE, id: "a2", lead_id: "l2" },
        { ...WORKABLE, id: "a3", lead_id: "l3" },
      ],
      insertOutcomes: [{ code: "23505" }, null, null],
    });
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: ["a1", "a2", "a3"],
    });
    expect(r).toEqual({ enrolled: 2, alreadyEnrolled: 1, skipped: 0 });
  });

  it("skips a rejected lead — settled and chargeable, never messaged again", async () => {
    const { admin } = fakeAdmin({
      steps: STEPS,
      assignments: [{ ...WORKABLE, status: "rejected" }],
    });
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: ["a1"],
    });
    expect(r).toEqual({ enrolled: 0, alreadyEnrolled: 0, skipped: 1 });
  });

  it("skips a closed lead — the landlord said no", async () => {
    const { admin } = fakeAdmin({
      steps: STEPS,
      assignments: [{ ...WORKABLE, closed_reason: "not_interested" }],
    });
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: ["a1"],
    });
    expect(r.skipped).toBe(1);
  });

  it("counts an id the customer does not own as skipped, and never enrols it", async () => {
    // The read is scoped by customer_id, so somebody else's assignment simply is
    // not returned — a hand-rolled POST cannot enrol another operator's leads.
    const { admin, inserts } = fakeAdmin({ steps: STEPS, assignments: [] });
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: ["someone-elses"],
    });
    expect(r).toEqual({ enrolled: 0, alreadyEnrolled: 0, skipped: 1 });
    expect(inserts).toHaveLength(0);
  });

  it("does nothing for a sequence with no steps", async () => {
    const { admin, inserts } = fakeAdmin({ steps: [], assignments: [WORKABLE] });
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: ["a1"],
    });
    expect(r.enrolled).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("does nothing for an empty selection", async () => {
    const { admin, inserts } = fakeAdmin({ steps: STEPS, assignments: [] });
    const r = await enrolAssignments(admin, {
      customerId: "c1",
      sequenceId: "s1",
      assignmentIds: [],
    });
    expect(r).toEqual({ enrolled: 0, alreadyEnrolled: 0, skipped: 0 });
    expect(inserts).toHaveLength(0);
  });
});

/**
 * The standing rule, and the two things it must never do.
 *
 * It hangs off `completeAssignment`, which is downstream of the single money
 * path and where every existing follow-through — the new-lead email, the SMS,
 * the top-up offer — is logged and swallowed rather than thrown. A messaging
 * feature must not become the first thing there able to break an assignment.
 */
function standingFake(state: {
  sequence?: { id: string } | null;
  throwOnRead?: boolean;
}) {
  const inserts: Record<string, unknown>[] = [];
  function builder(table: string) {
    const self: Record<string, unknown> = {};
    Object.assign(self, {
      select: () => self,
      eq: () => self,
      in: () => self,
      is: () => self,
      order: () => self,
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row);
        return { error: null };
      },
      maybeSingle: async () => {
        if (state.throwOnRead) throw new Error("postgrest exploded");
        return { data: state.sequence ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "message_sequence_steps") {
          return Promise.resolve({
            data: [{ step_number: 1, delay_days: 0, brief: null }],
            error: null,
          }).then(resolve);
        }
        if (table === "lead_assignments") {
          return Promise.resolve({
            data: [{ id: "a1", lead_id: "l1", status: "new", closed_at: null, closed_reason: null }],
            error: null,
          }).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    });
    return self;
  }
  return { admin: { from: (t: string) => builder(t) } as never, inserts };
}

describe("enrolOnAssignment", () => {
  it("enrols when the customer has a standing rule for that product", async () => {
    const { admin, inserts } = standingFake({ sequence: { id: "s1" } });
    await enrolOnAssignment(admin, {
      customerId: "c1",
      assignmentId: "a1",
      leadType: "management",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sequence_id).toBe("s1");
  });

  it("PROVISIONS the standard contact plan when they have no standing rule (§42)", async () => {
    // This used to assert that nothing happened, and that was the whole defect:
    // §40.13 required the operator to build a sequence before anything could
    // follow a lead up, and production carried ZERO sequences — so no lead has
    // ever been enrolled. The standard five-attempt plan is now created for
    // them on the first assignment, and the enrolment goes ahead against it.
    const { admin, inserts } = standingFake({ sequence: null });
    await enrolOnAssignment(admin, {
      customerId: "c1",
      assignmentId: "a1",
      leadType: "management",
    });
    // This fake cannot return an id from an insert, so the run insert does not
    // follow here — what it CAN show is that a standing plan is now created
    // where the old behaviour wrote nothing at all.
    const plan = inserts.find((r) => r.name === "Standard follow-up");
    expect(plan).toBeDefined();
    expect(plan).toMatchObject({
      customer_id: "c1",
      lead_type: "management",
      trigger: "on_assignment",
      delivery: "manual",
      channel: "mixed",
    });
  });

  it("NEVER THROWS, whatever the database does", async () => {
    // completeAssignment swallows every follow-through failure because the lead
    // has already been paid for and delivered. This must not be the exception.
    const { admin } = standingFake({ throwOnRead: true });
    await expect(
      enrolOnAssignment(admin, {
        customerId: "c1",
        assignmentId: "a1",
        leadType: "management",
      })
    ).resolves.toBeUndefined();
  });

  it("treats an unknown lead_type as management rather than refusing", async () => {
    // lead_type is nullable in places, and a lead nobody enrols because of a
    // null column is a silent failure of the whole standing rule.
    const { admin, inserts } = standingFake({ sequence: { id: "s1" } });
    await enrolOnAssignment(admin, {
      customerId: "c1",
      assignmentId: "a1",
      leadType: "",
    });
    expect(inserts).toHaveLength(1);
  });
});
