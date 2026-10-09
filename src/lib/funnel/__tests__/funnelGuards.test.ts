/**
 * Guards on the REAL funnel route files (batch 02 Phases 2 and 3).
 *
 * vitest.config.mts is PURE UNITS ONLY, so a route handler is never run here.
 * These read the files themselves (§42.8: a test that writes its own copy of a
 * query is not testing the query), with comments stripped, because every file
 * here explains its own rules and a naive substring check would pass on the
 * explanation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FUNNEL_STEPS } from "@/lib/funnel/session";

function source(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\{\s*\}/g, "{}");
}

const SESSION = source("src/app/api/funnel/session/route.ts");
const PREVIEW = source("src/app/api/funnel/[token]/preview/route.ts");
const ANSWERS = source("src/app/api/funnel/[token]/answers/route.ts");
const SERVER = source("src/lib/funnel/server.ts");
const START = source("src/app/start/[token]/page.tsx");
const SUMMARY = source("src/app/start/[token]/summary/page.tsx");
const FLOW = source("src/components/funnel/FunnelFlow.tsx");
const EXITS = source("src/components/funnel/FunnelExits.tsx");
const LOGIN = source("src/app/login/page.tsx");
const MIGRATION = readFileSync("supabase/migrations/0165_funnel.sql", "utf8");
const ROUTES_MIGRATION = readFileSync("supabase/migrations/0166_funnel_routes.sql", "utf8");

const at = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("POST /api/funnel/session", () => {
  it("is n8n's bearer, failing closed when the secret is unset", () => {
    expect(SESSION).toContain("!process.env.N8N_WEBHOOK_SECRET || auth !== expected");
  });

  it("refuses with no token secret rather than minting a link it cannot reopen", () => {
    expect(at(SESSION, "funnelTokenSecret()")).toBeLessThan(at(SESSION, '.from("funnel_sessions").insert'));
    expect(SESSION).toContain('"not_configured" }, { status: 503 }');
  });

  it("checks the switch and 'already a customer' BEFORE creating anything", () => {
    const insert = at(SESSION, '.from("funnel_sessions").insert');
    expect(at(SESSION, "readFunnelEnabled(admin)")).toBeLessThan(insert);
    expect(at(SESSION, "customers.customers.some(isAlreadySetUp)")).toBeLessThan(insert);
    expect(at(SESSION, "openSessionFor(admin, req.email)")).toBeLessThan(insert);
  });

  it("an unreadable customer list is a refusal, never a link", () => {
    const block = SESSION.slice(at(SESSION, "if (!customers.ok)"), at(SESSION, "customers.customers.some"));
    expect(block).toContain("status: 503");
  });

  it("stores the hash of the token, never the token", () => {
    const insert = SESSION.slice(at(SESSION, '.from("funnel_sessions").insert'), at(SESSION, "if (error)"));
    expect(insert).toContain("token_hash: hashFunnelToken(token)");
    expect(insert).not.toMatch(/\btoken:/);
  });

  it("returns the existing row's link on a 23505 race", () => {
    expect(SESSION).toContain('error.code === "23505"');
  });

  it("fills blanks on an existing session and never overwrites a stored value", () => {
    expect(SESSION).toContain("if (!session.monday_item_id && req.mondayItemId)");
    expect(SESSION).toContain("if (!session.phone && req.phone)");
  });
});

describe("POST /api/funnel/session — batch 03's route fields (0166)", () => {
  const insert = () => SESSION.slice(at(SESSION, '.from("funnel_sessions").insert'), at(SESSION, "if (error)"));
  const record = () =>
    SESSION.slice(at(SESSION, "async function recordEntryPoint"), at(SESSION, "function linkResponse"));

  it("a new session stores the entry point and the offer order n8n sent", () => {
    expect(insert()).toContain("entry_point: req.entryPoint");
    expect(insert()).toContain("offer_order: req.offerOrder");
  });

  it("an existing session's entry point moves only through recordEntryPoint", () => {
    const existing = SESSION.slice(at(SESSION, "if (existing.session)"), at(SESSION, "const id = randomUUID()"));
    expect(existing).toContain("await recordEntryPoint(admin, existing.session, req);");
    // Two writes name the column: the insert and recordEntryPoint's update.
    // (The third mention is the OpenSession type, `entry_point: string | null`.)
    expect(SESSION.match(/entry_point: (?!string)/g)).toEqual(["entry_point: ", "entry_point: "]);
  });

  it("E1: the entry point is frozen at the first answer, and the write repeats the test", () => {
    const fn = record();
    expect(fn).toContain("entryPointToWrite(session, req.entryPoint)");
    expect(fn).toContain('.is("first_answered_at", null)');
    expect(fn).toContain('.neq("step", "paid")');
    expect(fn).toContain(".update({ entry_point: next })");
  });

  it("the offer order is set once, by the insert, and never updated", () => {
    expect(SESSION.match(/offer_order:/g)?.length).toBe(1);
    expect(record()).not.toContain("offer_order");
  });

  it("the open-session read carries what entryPointToWrite needs", () => {
    expect(SESSION).toContain('.select("id, phone, monday_item_id, entry_point, first_answered_at, answers")');
  });
});

describe("POST /api/funnel/[token]/answers — the first-answer stamp (0166)", () => {
  it("stamps only after the answers are saved, and only while the stamp is null", () => {
    const save = at(ANSWERS, ".update(update)");
    const stamp = at(ANSWERS, ".update({ first_answered_at: new Date().toISOString() })");
    expect(stamp).toBeGreaterThan(save);
    const block = ANSWERS.slice(stamp, at(ANSWERS, "return NextResponse.json({ ok: true }"));
    expect(block).toContain('.is("first_answered_at", null)');
  });

  it("asks isFirstAnswer, so a save carrying only the plan never stamps it", () => {
    expect(ANSWERS).toContain("isFirstAnswer(session.first_answered_at, patch.answers");
  });

  it("the stamp is best effort: a failed stamp never fails a saved answer", () => {
    const block = ANSWERS.slice(at(ANSWERS, "stampError"), at(ANSWERS, "return NextResponse.json({ ok: true }"));
    expect(block).not.toContain("return ");
  });

  it("the session row read by the token routes carries the stamp", () => {
    const columns = SERVER.match(/FUNNEL_SESSION_COLUMNS =\s*"([^"]+)"/);
    expect(columns).not.toBeNull();
    expect(columns![1].split(",").map((c) => c.trim())).toContain("first_answered_at");
  });
});

describe("0166 keeps the Monday claims off funnel_sessions (E3)", () => {
  it("adds exactly the three route columns to funnel_sessions, and no claim column", () => {
    const added = Array.from(ROUTES_MIGRATION.matchAll(/add column if not exists (\w+)/g), (m) => m[1]);
    expect(added).toEqual(["entry_point", "offer_order", "first_answered_at"]);
  });

  it("gives funnel_monday_writes no trigger, so a claim moves nothing", () => {
    expect(ROUTES_MIGRATION).not.toMatch(/create trigger/i);
  });
});

describe("POST /api/funnel/[token]/preview", () => {
  it("answers with funnelPreviewBody and nothing else (02 locked decision 7)", () => {
    expect(PREVIEW).toContain("const response = funnelPreviewBody(result);");
    expect(PREVIEW).toContain("NextResponse.json(response, { headers: NO_STORE })");
    // The server preview never reaches a response.
    expect(PREVIEW).not.toMatch(/NextResponse\.json\(\s*result/);
    expect(PREVIEW).not.toMatch(/previews\[(10|20)\]\s*[,}]/);
  });

  it("passes funnelGate (switch, token, already set up) before anything else", () => {
    const gate = at(PREVIEW, 'funnelGate(admin, params.token, "preview")');
    expect(gate).toBeLessThan(at(PREVIEW, "request.json()"));
    expect(gate).toBeLessThan(at(PREVIEW, 'admin.rpc("consume_funnel_preview"'));
    expect(PREVIEW).toContain("if (!gate.ok) return gate.response;");
  });

  it("judges the input and the postcode lock BEFORE spending a preview", () => {
    const limiter = at(PREVIEW, 'admin.rpc("consume_funnel_preview"');
    expect(at(PREVIEW, "normaliseBriefInput(parsed.input)")).toBeLessThan(limiter);
    expect(at(PREVIEW, "lockPostcode(admin, session, postcode)")).toBeLessThan(limiter);
  });

  it("spends the limit BEFORE loading the supply it exists to protect", () => {
    expect(at(PREVIEW, 'admin.rpc("consume_funnel_preview"')).toBeLessThan(at(PREVIEW, "loadBriefSupply("));
    expect(PREVIEW).toContain("if (!previewAllowed(count))");
    expect(PREVIEW).toContain('"rate_limited" }, { status: 429');
  });

  it("the limiter fails closed", () => {
    const block = PREVIEW.slice(at(PREVIEW, "if (budgetError)"), at(PREVIEW, "const count"));
    expect(block).toContain("status: 503");
  });

  it("reads supply with no customer to exclude: nobody has paid yet", () => {
    expect(PREVIEW).toContain("loadBriefSupply(admin, { excludeCustomerId: null })");
  });

  it("refuses a second postcode on the same token", () => {
    expect(PREVIEW).toContain('"postcode_locked"');
    expect(PREVIEW).toContain('.is("base_postcode_locked", null)');
  });

  it("refuses Guaranteed Rent", () => {
    expect(PREVIEW).toContain("if (namesOtherProduct(body))");
  });

  it("saves the answers through funnelAnswers, never the body, and never moves a paid session", () => {
    expect(PREVIEW).toContain("answers: funnelAnswers(result.previews[10].brief)");
    expect(PREVIEW).toContain('step: advanceStep(session.step, "previewed")');
    expect(PREVIEW).toContain('.neq("step", "paid")');
  });

  it("is never cached", () => {
    expect(PREVIEW.match(/NextResponse\.json\(/g)?.length).toBe(PREVIEW.match(/headers: NO_STORE/g)?.length);
  });
});

describe("funnelGate — the checks every token route shares", () => {
  it("checks the switch, then the token, then 'already set up', in that order", () => {
    const sw = at(SERVER, "readFunnelEnabled(admin)");
    const tok = at(SERVER, "loadSessionByToken(admin, rawToken)");
    const paid = at(SERVER, 'if (session.step === "paid") return alreadySetUp();');
    const cust = at(SERVER, "customers.customers.some(isAlreadySetUp)) return alreadySetUp();");
    expect(sw).toBeLessThan(tok);
    expect(tok).toBeLessThan(paid);
    expect(paid).toBeLessThan(cust);
  });

  it("fails closed: an unreadable customer list refuses rather than letting the visitor through", () => {
    const block = SERVER.slice(at(SERVER, "if (!customers.ok)"), at(SERVER, "customers.customers.some(isAlreadySetUp))"));
    expect(block).toContain("503");
  });

  it("every response it makes is uncacheable", () => {
    const fn = SERVER.slice(at(SERVER, "export async function funnelGate"));
    expect(fn).toContain("headers: FUNNEL_NO_STORE");
  });
});

describe("POST /api/funnel/[token]/answers", () => {
  it("passes funnelGate before reading anything", () => {
    expect(at(ANSWERS, 'funnelGate(admin, params.token, "answers")')).toBeLessThan(at(ANSWERS, "request.json()"));
    expect(ANSWERS).toContain("if (!gate.ok) return gate.response;");
  });

  it("saves only the parsed patch, merged over the stored answers read field by field", () => {
    expect(ANSWERS).toContain("parseAnswersPatch(body)");
    expect(ANSWERS).toContain("answers: mergeAnswers(readStoredAnswers(session.answers), patch.answers)");
    // The body itself never reaches the row.
    expect(ANSWERS).not.toMatch(/update\(\s*body/);
    expect(ANSWERS).not.toMatch(/\.\.\.body/);
  });

  it("holds the postcode lock, before the write", () => {
    const lock = at(ANSWERS, "answersLockRefuses(session.base_postcode_locked, patch.answers.basePostcode)");
    expect(lock).toBeLessThan(at(ANSWERS, '.from("funnel_sessions")'));
    expect(ANSWERS).toContain('"postcode_locked"');
  });

  it("refuses Guaranteed Rent, never moves a paid session, and only moves the step forward", () => {
    expect(ANSWERS).toContain("if (namesOtherProduct(body))");
    expect(ANSWERS).toContain('.neq("step", "paid")');
    expect(ANSWERS).toContain('advanceStep(session.step, "questions_done")');
  });

  it("never reads the supply or spends a preview", () => {
    expect(ANSWERS).not.toContain("loadBriefSupply");
    expect(ANSWERS).not.toContain("consume_funnel_preview");
  });

  it("is never cached", () => {
    expect(ANSWERS.match(/NextResponse\.json\(/g)?.length).toBe(ANSWERS.match(/headers: NO_STORE/g)?.length);
  });
});

describe("GET /start/[token]/summary — the page a partner is sent", () => {
  it("is opened by the summary token, never the funnel token", () => {
    expect(SUMMARY).toContain("verifyFunnelSummaryToken(params.token, funnelTokenSecret())");
    expect(SUMMARY).not.toContain("loadSessionByToken");
    expect(SUMMARY).not.toContain("hashFunnelToken");
  });

  it("never reads the visitor's name, email or phone", () => {
    const cols = SUMMARY.match(/SUMMARY_COLUMNS = "([^"]+)"/);
    expect(cols).not.toBeNull();
    const list = cols![1].split(",").map((c) => c.trim());
    expect(list).toEqual(["id", "answers", "preview_snapshot", "plan_selected"]);
    expect(SUMMARY).toContain(".select(SUMMARY_COLUMNS)");
    expect(SUMMARY).not.toMatch(/\.select\("\*"\)/);
    expect(SUMMARY).not.toMatch(/session\.(email|phone|name)\b/);
  });

  it("has no payment and no way into the funnel", () => {
    expect(SUMMARY).not.toMatch(/checkout/i);
    expect(SUMMARY).not.toContain("FunnelFlow");
    expect(SUMMARY).not.toContain("continueToPayment");
    // The exits carry no summary link here: the page is the summary.
    expect(SUMMARY).toContain("<FunnelExits summaryPath={null} />");
  });

  it("is a 404 for anything that is not one of ours, and sends no referrer", () => {
    expect(SUMMARY).toContain("if (!sessionId) notFound();");
    expect(SUMMARY).toContain('referrer: "no-referrer"');
  });

  it("is switched off with the funnel", () => {
    expect(SUMMARY).toContain("readFunnelEnabled(admin)");
    expect(SUMMARY).toContain("if (!enabled || read.error || !read.data)");
  });
});

describe("the funnel screens", () => {
  it("never say 'Step x of 6' (02 Phase 3)", () => {
    expect(FLOW).not.toMatch(/step \d+ of/i);
    expect(FLOW).not.toContain("stepOf");
  });

  it("put both exits on every screen, through one Frame", () => {
    expect(FLOW).toContain("<FunnelExits summaryPath={summaryPath} />");
    // Every screen FunnelFlow returns is a Frame; none returns bare markup.
    // (Screen-level returns sit at two or four spaces; a .map()'s are deeper.)
    const body = FLOW.slice(at(FLOW, "export function FunnelFlow"), at(FLOW, "function Frame("));
    const returns = body.match(/^ {2,4}return \(\s*<(\w+)/gm) ?? [];
    expect(returns.length).toBe(5);
    for (const r of returns) expect(r).toMatch(/<Frame$/);
  });

  it("the partner link is the summary path, and both exits leave without a referrer", () => {
    expect(EXITS).toContain("href={summaryPath}");
    expect(EXITS).toContain("href={BRIEF_BOOKING_URL}");
    expect(EXITS.match(/rel="noopener noreferrer"/g)?.length).toBe(2);
    expect(START).toContain("funnelSummaryPath(summaryToken)");
    expect(START).toContain("deriveFunnelSummaryToken(session.id, funnelTokenSecret())");
  });

  it("render the preview without the switch-plan offer, and say what happens next in the funnel's words", () => {
    expect(FLOW).toContain("allowSwitch={false}");
    expect(FLOW).toContain("anywayLine={FUNNEL_COPY.previewAnyway}");
  });

  it("treats the checkout's answers like every other route's, and names each refusal", () => {
    // Phase 4 built the route, so its 404 means an unknown link again.
    expect(FLOW).not.toContain("res.status !== 404");
    const pay = FLOW.slice(FLOW.indexOf("async function startPayment"), FLOW.indexOf("function choosePlan"));
    expect(pay).toContain("if (handleTerminal(res.status, data)) return;");
    expect(pay).toContain('data.code === "payment_not_open"');
    expect(pay).toContain("FUNNEL_COPY.paymentNotReady");
    expect(pay).toContain("FUNNEL_COPY.paymentFailed");
  });
});

describe("GET /start/[token]", () => {
  it("sends a paid session and an existing customer to log in", () => {
    expect(START).toContain('if (session.step === "paid") redirect(ALREADY_SET_UP_LOGIN_PATH);');
    expect(START).toContain("customers.customers.some(isAlreadySetUp)) redirect(ALREADY_SET_UP_LOGIN_PATH)");
  });

  it("an unknown token is a 404", () => {
    expect(START).toContain("if (!session) notFound();");
  });

  it("sends no referrer, because the token is in the path", () => {
    expect(START).toContain('referrer: "no-referrer"');
  });

  it("resumes where the visitor stopped, from what is saved", () => {
    expect(START).toContain("readStoredAnswers(session.answers)");
    expect(START).toContain("readPreviewSnapshot(session.preview_snapshot)");
    expect(START).toContain("resumeScreen({ draft, step: session.step, hasPreview: snapshot !== null })");
  });

  it("hands the browser no contact details", () => {
    const flow = START.slice(at(START, "<FunnelFlow"), at(START, "/>"));
    expect(flow).not.toMatch(/session\.(email|phone|name)/);
  });

  it("shows a discount only while it can be used", () => {
    expect(START).toContain("validDiscount(data as DiscountRow | null, new Date())");
  });

  it("the login page shows the notice the redirect names", () => {
    expect(LOGIN).toContain('params.get("notice") === "already_set_up"');
    expect(LOGIN).toContain("FUNNEL_COPY.alreadySetUp");
  });
});

describe("0165 agrees with the code", () => {
  it("the step list is the CHECK's, in order", () => {
    const check = MIGRATION.match(/step in \(([^)]+)\)/);
    expect(check).not.toBeNull();
    const steps = check![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(steps).toEqual([...FUNNEL_STEPS]);
  });
});
