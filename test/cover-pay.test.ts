import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { coverView, ownerCovers, payCover, refreshCoverPayouts, respondToCover } from "../lib/recovery/cover-pay";
import { POST as instructorPost } from "../app/api/instructor/[token]/route";
import { POST as payPost } from "../app/api/workspaces/[id]/covers/pay/route";
import { limits } from "../lib/api/limits";

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
