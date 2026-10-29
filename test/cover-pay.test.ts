import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { askNextCover, coverView, ownerCovers, payCover, refreshCoverPayouts, respondToCover } from "../lib/recovery/cover-pay";
import { POST as nextPost } from "../app/api/workspaces/[id]/covers/next/route";
import { DatabaseSync } from "node:sqlite";
import { POST as instructorPost } from "../app/api/instructor/[token]/route";
import { POST as payPost } from "../app/api/workspaces/[id]/covers/pay/route";
import { limits } from "../lib/api/limits";
import { pausedSessionIds } from "../lib/checkout/service";

let repository: Repository, directory: string, workspaceId: string, planId: string, sessionId: string, token: string;
let payouts: (init: RequestInit) => Response | Promise<Response>;
const calls: { url: string; init: RequestInit }[] = [];
const created = (batch = "BATCH-1") => Response.json({ batch_header: { payout_batch_id: batch, batch_status: "PENDING" } }, { status: 201 });
const payoutRows = () => repository.listCoverPayouts(workspaceId);

async function approved(confirm = false) {
  const state = seedStudio(); for (const booking of state.bookings) booking.payment!.simulated = true;
  const workspace = repository.createWorkspace(state); workspaceId = workspace.id;
  for (const booking of state.bookings) repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  const plan = repository.createPlan(workspaceId, replan(state, demoDisruption)); planId = plan.id;
  const cover = plan.sessionChanges.find((change) => change.after && change.after.instructorId !== change.before.instructorId)!;
  sessionId = cover.sessionId;
  await executePlan(workspaceId, plan.id, repository, undefined, confirm ? [sessionId] : []);
  token = ownerCovers(workspaceId, repository)[0].path.slice(3);
  return plan;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-cover-pay-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID()); vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
  vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_PAYOUT_RECEIVER", "sandbox-payee@example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
  repository = getRepository(); limits.reset(); calls.length = 0; payouts = () => created();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "token", expires_in: 3600 });
    if (String(url).includes("/v1/payments/payouts")) return payouts(init);
    throw new Error(`Unexpected fetch ${url}`);
  }));
  const timers = globalThis as typeof globalThis & { rebookCoverRefresh?: Map<string, number> }; timers.rebookCoverRefresh?.clear();
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const posts = () => calls.filter((call) => call.url.endsWith("/v1/payments/payouts") && call.init.method === "POST");
const requestId = (call: { init: RequestInit }) => new Headers(call.init.headers).get("PayPal-Request-Id");

it("asks the substitute on a private link after approval, without touching the hero totals", async () => {
  const plan = await approved();
  expect(plan.totals).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: "577.00", refundAmount: "135.00" });
  const [cover] = ownerCovers(workspaceId, repository);
  expect(cover).toMatchObject({ instructor: "Alex Rivera", original: "Maya Chen", status: "asked", fee: "35.00", payee: true });
  expect(coverView(token, repository)).toMatchObject({ status: "asked", canRespond: true, class: { title: "Yoga Flow" } });
  expect(JSON.stringify(coverView(token, repository))).not.toMatch(/@|customer/i);
  // A customer token cannot open a cover link, and an unknown token is rejected.
  const customer = repository.listCustomerLinks(workspaceId)[0];
  expect(() => coverView(repository.customerToken(customer), repository)).toThrow("not valid");
});

it("starts accepted when the owner confirmed the cover at approval", async () => {
  await approved(true);
  expect(ownerCovers(workspaceId, repository)[0]).toMatchObject({ status: "accepted", respondedBy: "owner" });
});

it("lets the substitute accept or decline until the class starts, and pays only an accepted cover", async () => {
  await approved();
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 409 });
  expect(await respondToCover(token, "decline", repository)).toMatchObject({ status: "declined" });
  expect(await respondToCover(token, "accept", repository)).toMatchObject({ status: "accepted" });
  const start = Date.parse(coverView(token, repository).class.start);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start + 60_000);
  await expect(respondToCover(token, "decline", repository)).rejects.toMatchObject({ status: 409 });
});

it("records REQUESTED before PayPal, then PENDING with the batch id, and refuses a second payout", async () => {
  await approved(true);
  const money = repository.ledgerSummary(workspaceId), outcomes = repository.latestMoneyEvents(workspaceId).length;
  payouts = () => { expect(payoutRows()[0]).toMatchObject({ status: "REQUESTED", amount: "35.00" }); return created(); };
  await payCover(workspaceId, planId, sessionId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "PENDING", batchId: "BATCH-1", attempt: 1 });
  const body = JSON.parse(posts()[0].init.body as string);
  expect(body.sender_batch_header.sender_batch_id).toBe(requestId(posts()[0]));
  expect(body.items[0]).toMatchObject({ receiver: "sandbox-payee@example.com", amount: { value: "35.00", currency: "USD" } });
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 409 });
  expect(posts()).toHaveLength(1);
  expect(coverView(token, repository).canRespond).toBe(false);
  // Cover pay is staffing cost: customer money totals and the ledger are untouched.
  expect(repository.ledgerSummary(workspaceId)).toEqual(money); expect(repository.latestMoneyEvents(workspaceId)).toHaveLength(outcomes);
});

it("replays the same PayPal-Request-Id after a lost response instead of paying twice", async () => {
  await approved(true);
  payouts = () => { throw new Error("socket hang up"); };
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 502 });
  expect(payoutRows()[0]).toMatchObject({ status: "REQUESTED", attempt: 1 });
  payouts = () => created("BATCH-ORIGINAL");
  await payCover(workspaceId, planId, sessionId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "PENDING", batchId: "BATCH-ORIGINAL", attempt: 1 });
  expect(new Set(posts().map(requestId)).size).toBe(1);
});

it("marks a definitive PayPal rejection failed and pays again with a new request id", async () => {
  await approved(true);
  payouts = () => Response.json({ name: "INSUFFICIENT_FUNDS", message: "No funds" }, { status: 422 });
  await payCover(workspaceId, planId, sessionId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("INSUFFICIENT_FUNDS") });
  payouts = () => created("BATCH-2");
  await payCover(workspaceId, planId, sessionId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "PENDING", attempt: 2 });
  expect(new Set(posts().map(requestId)).size).toBe(2);
});

it("records PayPal's item status read-only", async () => {
  await approved(true);
  await payCover(workspaceId, planId, sessionId, repository);
  payouts = (init) => { expect(init.method).toBe("GET"); return Response.json({ batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "ITEM-9", transaction_status: "SUCCESS" }] }); };
  const timers = globalThis as typeof globalThis & { rebookCoverRefresh?: Map<string, number> }; timers.rebookCoverRefresh?.clear();
  await refreshCoverPayouts(workspaceId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "SUCCESS", itemId: "ITEM-9" });
  expect(coverView(token, repository).payout).toMatchObject({ status: "SUCCESS", itemId: "ITEM-9" });
});

it("never opens a second payout when PayPal answers a replay with a duplicate batch", async () => {
  await approved(true);
  payouts = () => { throw new Error("socket hang up"); };
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 502 });
  payouts = () => Response.json({ name: "USER_BUSINESS_ERROR", message: "Batch with given sender_batch_id already exists" }, { status: 400 });
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 502 });
  expect(payoutRows()[0]).toMatchObject({ status: "REQUESTED", attempt: 1, error: expect.stringContaining("already have this payout") });
  payouts = () => Response.json({ name: "VALIDATION_ERROR", message: "Invalid request" }, { status: 422 });
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 502 });
  expect(payoutRows()[0]).toMatchObject({ status: "REQUESTED", attempt: 1 });
  expect(new Set(posts().map(requestId)).size).toBe(1);
});

it("stops replaying an unconfirmed payout before PayPal's 30-day duplicate check lapses, and keeps its workspace", async () => {
  await approved(true);
  payouts = () => { throw new Error("socket hang up"); };
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 502 });
  repository.saveCoverPayout({ ...payoutRows()[0], createdAt: new Date(Date.now() - 29 * 86_400_000).toISOString() });
  payouts = () => created("BATCH-TOO-LATE");
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("too old to resend safely") });
  expect(posts()).toHaveLength(1);
  expect(payoutRows()[0]).toMatchObject({ status: "REQUESTED", attempt: 1 });

  // Pruning keeps a studio whose payout is unresolved, whatever else has expired.
  const other = repository.createWorkspace(seedStudio()).id, otherPlan = repository.createPlan(other, replan(seedStudio(), demoDisruption)).id;
  repository.saveCoverPayout({ ...payoutRows()[0], workspaceId: other, planId: otherPlan });
  repository.pruneOlderThan(-1);
  expect(repository.getWorkspace(other)).toBeTruthy();
  repository.saveCoverPayout({ ...repository.listCoverPayouts(other)[0], status: "FAILED" });
  repository.pruneOlderThan(-1);
  expect(repository.getWorkspace(other)).toBeFalsy();
});

it("keeps a payout unresolved when PayPal's success response has no batch id", async () => {
  await approved(true);
  payouts = () => new Response('{"batch_header":', { status: 201, headers: { "content-type": "application/json" } });
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 502 });
  expect(payoutRows()[0]).toMatchObject({ status: "REQUESTED", attempt: 1 });
  payouts = () => created("BATCH-LATE");
  await payCover(workspaceId, planId, sessionId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "PENDING", batchId: "BATCH-LATE" });
  expect(new Set(posts().map(requestId)).size).toBe(1);
});

it("refuses to pay or accept a cover that a later recovery reassigned", async () => {
  await approved();
  await respondToCover(token, "accept", repository);
  const state = repository.requireWorkspace(workspaceId).state;
  state.sessions.find((session) => session.id === sessionId)!.instructorId = "instructor-04";
  repository.saveState(workspaceId, state);
  expect(ownerCovers(workspaceId, repository)[0].status).toBe("replaced");
  expect(coverView(token, repository)).toMatchObject({ status: "replaced", canRespond: false });
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 409 });
  await expect(respondToCover(token, "decline", repository)).rejects.toMatchObject({ status: 409 });
  expect(posts()).toHaveLength(0);
});

it("does not let an older status response overwrite a newer one, and keeps checking unclaimed payouts for weeks", async () => {
  await approved(true);
  await payCover(workspaceId, planId, sessionId, repository);
  const timers = globalThis as typeof globalThis & { rebookCoverRefresh?: Map<string, number> };
  // A concurrent check records SUCCESS while this one is still waiting on an older PENDING answer.
  payouts = () => { const row = payoutRows()[0]; repository.saveCoverPayout({ ...row, status: "SUCCESS", itemId: "ITEM-NEW", updatedAt: new Date(Date.now() + 1000).toISOString() });
    return Response.json({ batch_header: { batch_status: "PROCESSING" }, items: [{ payout_item_id: "ITEM-OLD", transaction_status: "PENDING" }] }); };
  timers.rebookCoverRefresh?.clear(); await refreshCoverPayouts(workspaceId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "SUCCESS", itemId: "ITEM-NEW" });
  repository.saveCoverPayout({ ...payoutRows()[0], status: "UNCLAIMED", createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });
  payouts = () => Response.json({ batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "ITEM-NEW", transaction_status: "SUCCESS" }] });
  timers.rebookCoverRefresh?.clear(); await refreshCoverPayouts(workspaceId, repository);
  expect(payoutRows()[0]).toMatchObject({ status: "SUCCESS" });
});

it("needs a configured sandbox payee", async () => {
  await approved(true); vi.stubEnv("PAYPAL_PAYOUT_RECEIVER", "");
  await expect(payCover(workspaceId, planId, sessionId, repository)).rejects.toMatchObject({ status: 503 });
  expect(posts()).toHaveLength(0);
});

it("checks origin and input on the public and owner routes", async () => {
  await approved();
  const respond = (origin: string, body: unknown) => instructorPost(new Request(`http://localhost/api/instructor/${token}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ token }) });
  expect((await respond("https://evil.example", { action: "accept" })).status).toBe(403);
  expect((await respond("http://localhost", { action: "pay" })).status).toBe(400);
  expect((await respond("http://localhost", { action: "accept" })).status).toBe(200);
  const pay = (origin: string) => payPost(new Request(`http://localhost/api/workspaces/${workspaceId}/covers/pay`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ planId, sessionId }) }), { params: Promise.resolve({ id: workspaceId }) });
  expect((await pay("https://evil.example")).status).toBe(403);
  expect((await pay("http://localhost")).status).toBe(200);
  expect(payoutRows()[0]).toMatchObject({ status: "PENDING" });
});

it("passes a declined cover to the next qualified, free instructor in one step, keeps the history, and pays only who teaches", async () => {
  await approved();
  await respondToCover(token, "decline", repository);
  const [declined] = ownerCovers(workspaceId, repository);
  expect(declined).toMatchObject({ instructor: "Alex Rivera", status: "declined", current: true });
  // Nobody has agreed to teach it, so new bookings pause until the owner asks someone else.
  expect(pausedSessionIds(workspaceId, repository).has(sessionId)).toBe(true);
  const next = declined.next!;
  expect(["Jordan Lee", "Priya Shah"]).toContain(next);
  // Customers still booked must all accept the new instructor; the class keeps its time, room and bookings.
  const before = repository.requireWorkspace(workspaceId).state;
  const kept = before.bookings.filter((booking) => booking.sessionId === sessionId && ["confirmed", "moved"].includes(booking.status)).map((booking) => booking.id);
  const response = await nextPost(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId, sessionId }) }),
    { params: Promise.resolve({ id: workspaceId }) });
  expect(response.status).toBe(200);
  const covers = await response.json();
  expect(covers.map((cover: { instructor: string; status: string; current: boolean }) => [cover.instructor, cover.status, cover.current]))
    .toEqual([["Alex Rivera", "declined", false], [next, "asked", true]]);
  const after = repository.requireWorkspace(workspaceId).state, session = after.sessions.find((item) => item.id === sessionId)!;
  expect(after.instructors.find((item) => item.id === session.instructorId)!.name).toBe(next);
  expect(pausedSessionIds(workspaceId, repository).has(sessionId)).toBe(false);
  // Customers still booked get the new instructor's name, and the outbox asks the owner to send the update again.
  const revised = repository.listCustomerLinks(workspaceId).filter((link) => link.planId === planId && kept.includes(link.bookingId));
  expect(revised).toHaveLength(kept.length);
  for (const link of revised) {
    expect(link.sentAt).toBeUndefined();
    expect(link).toMatchObject({ revisedAt: expect.any(String), after: expect.objectContaining({ instructorId: session.instructorId }),
      message: { subject: expect.stringContaining("New instructor"), body: expect.stringContaining(`Update: ${next} is now teaching this class instead of Alex Rivera.`) } });
    expect(link.message.body).not.toContain("Alex Rivera will be teaching");
  }
  expect(session.start).toBe(before.sessions.find((item) => item.id === sessionId)!.start);
  expect(after.bookings.filter((booking) => booking.sessionId === sessionId && ["confirmed", "moved"].includes(booking.status)).map((booking) => booking.id)).toEqual(kept);
  // Alex's old link now says someone else has the class; the new instructor answers on their own link and is the one paid.
  expect(coverView(token, repository)).toMatchObject({ status: "replaced", canRespond: false });
  const nextToken = covers[1].path.slice(3);
  await respondToCover(nextToken, "accept", repository);
  await payCover(workspaceId, planId, sessionId, repository);
  expect(payoutRows()).toEqual([expect.objectContaining({ instructorId: session.instructorId, amount: "35.00" })]);
  expect(ownerCovers(workspaceId, repository).map((cover) => [cover.instructor, cover.payout?.status ?? "-"])).toEqual([["Alex Rivera", "-"], [next, "PENDING"]]);
  // Only a current decline can be passed on; repeating the click does nothing new.
  await expect(askNextCover(workspaceId, planId, sessionId, repository)).rejects.toThrow("Only a declined cover");
});

it("lets the owner email a revised message even after the first version was emailed", async () => {
  await approved();
  const key = { workspaceId, planId, customerId: "customer-01", kind: "message" as const };
  const first = repository.queueDelivery(key);
  repository.saveDelivery({ ...first, status: "sent" });
  expect(() => repository.queueDelivery(key)).toThrow(/already has a send attempt/);
  expect(() => repository.queueDelivery(key, false, () => {}, new Date(Date.parse(first.createdAt) + 1000).toISOString())).not.toThrow();
});

it("never asks the same instructor twice and says so when nobody else qualifies", async () => {
  await approved();
  await respondToCover(token, "decline", repository);
  const names: string[] = ["Alex Rivera"];
  for (;;) {
    const current = ownerCovers(workspaceId, repository).find((cover) => cover.current)!;
    if (!current.next) { expect(current.next).toBeNull(); break; }
    expect(names).not.toContain(current.next);
    const covers = await askNextCover(workspaceId, planId, sessionId, repository);
    const asked = covers.find((cover) => cover.current)!;
    names.push(asked.instructor);
    await respondToCover(asked.path.slice(3), "decline", repository);
  }
  expect(names.length).toBeGreaterThan(1);
  await expect(askNextCover(workspaceId, planId, sessionId, repository)).rejects.toThrow("No other qualified instructor is free");
  expect(ownerCovers(workspaceId, repository).find((cover) => cover.current)!.status).toBe("declined");
});

it("migrates an older database that allowed one cover link per class, keeping every link", () => {
  closeRepository();
  const file = join(directory, "rebook.sqlite"); rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE plans (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE cover_links (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, session_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(plan_id, session_id));
    INSERT INTO workspaces VALUES ('w', 0, '{}'); INSERT INTO plans VALUES ('p', 'w', 0, '{}');
    INSERT INTO cover_links VALUES ('old', 'hash', 'w', 'p', 's', '{"id":"old"}');`);
  db.close();
  let migrated: Repository;
  try { migrated = getRepository(); } catch (error) { throw new Error(`migration failed: ${error}`); }
  const sql = (migrated as unknown as { db: DatabaseSync }).db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cover_links'").get() as { sql: string };
  expect(sql.sql).not.toContain("UNIQUE(plan_id, session_id)");
  expect((migrated as unknown as { db: DatabaseSync }).db.prepare("SELECT id FROM cover_links").all()).toEqual([{ id: "old" }]);
});
