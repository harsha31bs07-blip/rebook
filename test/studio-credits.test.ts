import { setSdkTransport } from "./paypalTransport";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCustomerLinks, customerChoice, ownerCustomerChoices, submitChoice } from "../lib/choices/service";
import { createOrder, redeemCredit, seatsLeft, studioCredit } from "../lib/checkout/service";
import { seedStudio } from "../lib/seed/seed";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import type { Plan } from "../lib/domain/types";
import { buildInsights } from "../lib/insights/data";
import { getRecoverySummary } from "../lib/insights/analyst-tools";
import { buildStudioData } from "../lib/insights/studio-data";
import { initialReport } from "../lib/insights/report";
import { POST } from "../app/api/bookings/[bookingId]/checkout/credit/route";
import { GET as insights } from "../app/api/workspaces/[id]/insights/route";
import { limits } from "../lib/api/limits";
import { activateConstraint } from "../lib/solver/constraints";
import { executePlan } from "../lib/executor/executePlan";
import { executeRefund } from "../lib/executor/refund";
import { checkRefund } from "../lib/executor/refund-sweep";
import { withWorkspaceLock } from "../lib/store";

let directory: string, repository: Repository, calls: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-credits-")); vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID()); vi.stubEnv("PAYPAL_CLIENT_SECRET", "test"); vi.stubEnv("PAYPAL_ENV", "sandbox");
  repository = getRepository(); calls = []; limits.reset();
  setSdkTransport(async (url) => {
    calls.push(url);
    if (url.endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    return Response.json({ id: "REFUND", status: "PENDING" }, { status: 201 });
  });
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const state = seedStudio(), original = { ...state.sessions[0], price: "22.00" };
  state.sessions = [original, { ...original, id: "cheap", price: "10.00", start: "2026-11-11T15:00:00Z", end: "2026-11-11T16:00:00Z" },
    { ...original, id: "equal", start: "2026-11-12T15:00:00Z", end: "2026-11-12T16:00:00Z" },
    { ...original, id: "expensive", price: "23.00", start: "2026-11-13T15:00:00Z", end: "2026-11-13T16:00:00Z" }];
  state.bookings = [{ ...state.bookings[0], sessionId: original.id, amount: "22.00", payment: { orderId: "ORIGINAL", captureId: randomUUID(), simulated: false } }];
  const workspace = repository.createWorkspace(state), booking = state.bookings[0];
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: "capture", status: "COMPLETED" });
  const next = structuredClone(state); next.sessions[0].start = "2026-11-09T14:00:00Z"; next.sessions[0].end = "2026-11-09T15:00:00Z";
  const plan: Plan = { now: new Date().toISOString(), disruption: { kind: "instructor_unavailable", instructorId: original.instructorId, from: original.start, to: original.end },
    sessionChanges: [{ sessionId: original.id, remedy: "move_time", before: original, after: next.sessions[0], reason: "Changed" }],
    bookingActions: [{ bookingId: booking.id, customerId: booking.customerId, action: "move", amount: "22.00", reason: "Changed" }],
    totals: { sessionsAffected: 1, kept: 0, moved: 1, refunded: 0, refundAmount: "0.00", revenueKept: "22.00" }, warnings: [] };
  const stored = { ...repository.createPlan(workspace.id, plan), status: "executed" as const, basis: state };
  repository.savePlan(stored); repository.saveState(workspace.id, next); createCustomerLinks(stored, state, next, repository);
  const link = repository.listCustomerLinks(workspace.id)[0];
  return { workspace, booking, link, token: repository.customerToken(link), original: next.sessions[0], plan: stored };
}
const input = (creditToken: string, sessionId = "equal") => ({ creditToken, sessionId, customer: { name: "Credit buyer", email: "buyer@example.com" } });
function laterPlan(workspaceId: string, bookingId: string, action: "move" | "refund") {
  const { state } = repository.requireWorkspace(workspaceId);
  const booking = state.bookings.find((item) => item.id === bookingId)!;
  const before = state.sessions.find((item) => item.id === booking.sessionId)!;
  const after = { ...before, start: "2026-11-12T17:00:00Z", end: "2026-11-12T18:00:00Z" };
  return repository.createPlan(workspaceId, { now: new Date().toISOString(),
    disruption: { kind: "closure", from: before.start, to: before.end },
    sessionChanges: [{ sessionId: before.id, before, ...(action === "move" ? { after } : {}), remedy: action === "move" ? "move_time" : "cancel", reason: "Later disruption" }],
    bookingActions: [{ bookingId, customerId: booking.customerId, action, amount: booking.amount, reason: "Later disruption" }],
    totals: { sessionsAffected: 1, kept: 0, moved: action === "move" ? 1 : 0, refunded: action === "refund" ? 1 : 0,
      refundAmount: action === "refund" ? booking.amount : "0.00", revenueKept: action === "move" ? booking.amount : "0.00" }, warnings: [] });
}
async function issue() {
  const fixtureData = fixture();
  const choice = await submitChoice(fixtureData.token, { action: "credit" }, repository);
  return { ...fixtureData, choice, creditToken: new URLSearchParams(new URL(choice.credit!.path, "http://localhost").hash.slice(1)).get("credit")! };
}
function post(bookingId: string, body: unknown, key = randomUUID(), origin = "http://localhost") {
  return POST(new Request(`http://localhost/api/bookings/${bookingId}/checkout/credit`, { method: "POST", headers: { origin, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), { params: Promise.resolve({ bookingId }) });
}

it("issues exactly one durable credit, releases the seat, makes the choice final and never calls PayPal", async () => {
  const { workspace, token, link, booking, original, creditToken, choice } = await issue();
  expect(choice).toMatchObject({ canChoose: false, reply: { action: "credit" }, credit: { amount: "22.00", remaining: "22.00", status: "available" } });
  expect(choice.receipt).toBeUndefined(); expect(calls).toEqual([]);
  const state = repository.requireWorkspace(workspace.id).state;
  expect(state.bookings[0].status).toBe("cancelled"); expect(seatsLeft(state, original, [])).toBe(original.capacity);
  const credit = repository.listCredits(workspace.id)[0];
  expect(credit).toMatchObject({ linkId: link.id, bookingId: booking.id, customerId: booking.customerId, amount: "22.00", remaining: "22.00", redemptions: [] });
  expect(creditToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(credit.tokenHash).toBe(createHash("sha256").update(creditToken).digest("hex"));
  expect(repository.customerToken({ ...link, id: credit.id })).not.toBe(creditToken);
  expect(repository.coverToken(credit)).not.toBe(creditToken);
  expect(readFileSync(join(directory, "rebook.sqlite")).includes(Buffer.from(creditToken))).toBe(false);
  await submitChoice(token, { action: "credit" }, repository);
  expect(repository.listCredits(workspace.id)).toHaveLength(1);
  for (const action of ["keep", "refund"] as const) await expect(submitChoice(token, { action }, repository)).rejects.toMatchObject({ status: 409 });
  closeRepository(); repository = getRepository();
  expect((await customerChoice(token, repository)).credit?.path).toBe(choice.credit?.path);
  expect(repository.creditByToken(creditToken)?.id).toBe(credit.id);
});

it("rejects credit after a refund request, even while it is pending", async () => {
  const { workspace, token } = fixture();
  await submitChoice(token, { action: "refund" }, repository);
  await expect(submitChoice(token, { action: "credit" }, repository)).rejects.toMatchObject({ status: 409 });
  expect(repository.listCredits(workspace.id)).toEqual([]);
  expect(repository.latestMoneyEvents(workspace.id).filter((row) => row.kind === "refund")).toHaveLength(1);
});

it.each(["credit", "refund"] as const)("serializes concurrent %s versus the other choice", async (first) => {
  const { workspace, token } = fixture();
  const results = await Promise.allSettled([submitChoice(token, { action: first }, repository), submitChoice(token, { action: first === "credit" ? "refund" : "credit" }, repository)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  expect(repository.listCredits(workspace.id)).toHaveLength(first === "credit" ? 1 : 0);
  expect(repository.latestMoneyEvents(workspace.id).filter((row) => row.kind === "refund")).toHaveLength(first === "refund" ? 1 : 0);
});

it("rejects credit choices without a refundable capture, after deadlines and on receipt-only links", async () => {
  const { workspace, token, booking, link } = fixture();
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: "22.00", paypalId: "prior", captureId: booking.payment!.captureId, requestId: "prior", status: "PENDING" });
  await expect(submitChoice(token, { action: "credit" }, repository)).rejects.toMatchObject({ status: 409 });
  repository.saveCustomerLink({ ...link, expiresAt: Date.now() - 1 });
  await expect(submitChoice(token, { action: "credit" }, repository)).rejects.toMatchObject({ status: 410 });
  repository.saveCustomerLink({ ...link, kind: "receipt" });
  await expect(submitChoice(token, { action: "credit" }, repository)).rejects.toMatchObject({ status: 409 });
  expect(repository.listCredits(workspace.id)).toEqual([]); expect(calls).toEqual([]);
});

it("atomically books without PayPal, returns a receipt, preserves preferences and supports safe retries", async () => {
  const { workspace, creditToken } = await issue(), key = randomUUID();
  const body = { ...input(creditToken, "cheap"), availability: { times: ["mornings" as const], acceptsSubstitute: false } };
  const result = await redeemCredit(workspace.id, body, key, repository);
  expect(result).toMatchObject({ status: "confirmed", paidWith: "credit", amount: "10.00", currency: "USD", current: { status: "confirmed" }, webhookConfigured: false });
  expect(result.orderId).toBeUndefined(); expect(result.captureId).toBeUndefined();
  const state = repository.requireWorkspace(workspace.id).state, booking = state.bookings.find((row) => row.id === result.bookingId)!;
  expect(booking.payment).toBeUndefined();
  expect(state.customers.find((row) => row.id === booking.customerId)?.prefs).toMatchObject({ acceptsSubstitute: false, availabilityKnown: true });
  expect(repository.listCredits(workspace.id)[0]).toMatchObject({ remaining: "12.00", status: "available", redemptions: [{ bookingId: result.bookingId, amount: "10.00" }] });
  expect(await redeemCredit(workspace.id, body, key, repository)).toEqual(result);
  expect(repository.listCheckout(workspace.id)).toHaveLength(1); expect(calls).toEqual([]);
  await expect(redeemCredit(workspace.id, input(creditToken), key, repository)).rejects.toMatchObject({ status: 409 });
  await expect(createOrder(workspace.id, { sessionId: body.sessionId, customer: body.customer, availability: body.availability }, key, repository)).rejects.toMatchObject({ status: 409 });
  expect(calls).toEqual([]);
});

it("rejects insufficient balances and exhausted credits without changing money or bookings", async () => {
  const { workspace, creditToken } = await issue();
  await expect(redeemCredit(workspace.id, input(creditToken, "expensive"), randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
  expect(repository.listCredits(workspace.id)[0].remaining).toBe("22.00"); expect(repository.listCheckout(workspace.id)).toEqual([]);
  await redeemCredit(workspace.id, input(creditToken), randomUUID(), repository);
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "0.00", status: "redeemed" });
  await expect(redeemCredit(workspace.id, input(creditToken), randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
  expect(repository.listCredits(workspace.id)[0].redemptions).toHaveLength(1); expect(calls).toEqual([]);
});

it("does not overspend when two concurrent requests use different idempotency keys", async () => {
  const { workspace, creditToken } = await issue();
  const results = await Promise.allSettled([redeemCredit(workspace.id, input(creditToken), randomUUID(), repository), redeemCredit(workspace.id, input(creditToken), randomUUID(), repository)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  expect(repository.listCredits(workspace.id)[0]).toMatchObject({ remaining: "0.00", redemptions: [expect.objectContaining({ amount: "22.00" })] });
  expect(repository.listCheckout(workspace.id)).toHaveLength(1);
});

it.each(["paused", "full", "held", "past", "unavailable"])("rejects %s classes through the same availability rules", async (reason) => {
  const { workspace, creditToken, plan } = await issue();
  const { state } = repository.requireWorkspace(workspace.id), session = state.sessions.find((item) => item.id === "equal")!;
  if (reason === "paused") repository.createPlan(workspace.id, { ...plan, sessionChanges: [{ ...plan.sessionChanges[0], sessionId: session.id, before: session, after: session }] });
  if (reason === "full") { session.capacity = 1; state.bookings.push({ ...state.bookings[0], id: "occupant", sessionId: session.id, status: "confirmed" }); }
  if (reason === "held") {
    session.capacity = 1;
    repository.saveCheckout({ id: "hold", workspaceId: workspace.id, requestId: "hold", sessionId: session.id, session, amount: session.price, currency: "USD",
      customer: { name: "Other buyer", email: "other@example.com" }, status: "capturing", expiresAt: Date.now() - 1 });
  }
  if (reason === "past") { session.start = "2026-11-01T15:00:00Z"; session.end = "2026-11-01T16:00:00Z"; }
  repository.saveState(workspace.id, reason === "unavailable" ? activateConstraint(state, { kind: "closure", from: session.start, to: session.end }) : state);
  await expect(redeemCredit(workspace.id, input(creditToken), randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
  expect(repository.listCredits(workspace.id)[0].remaining).toBe("22.00"); expect(repository.listCheckout(workspace.id)).toHaveLength(reason === "held" ? 1 : 0); expect(calls).toEqual([]);
});

it("preserves available studio credits after private choice links age out of demo pruning", async () => {
  const { workspace, creditToken } = await issue();
  vi.setSystemTime(new Date("2026-12-10T12:00:00Z")); repository.pruneOlderThan();
  expect(repository.requireWorkspace(workspace.id)).toBeDefined();
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "22.00", status: "available" });
});

it("rolls back credit issuance and the seat release together if choice persistence fails", async () => {
  const { workspace, token } = fixture();
  vi.spyOn(repository, "saveCustomerLink").mockImplementationOnce(() => { throw new Error("disk failed"); });
  await expect(submitChoice(token, { action: "credit" }, repository)).rejects.toThrow("disk failed");
  expect(repository.listCredits(workspace.id)).toEqual([]); expect(repository.customerLinkByToken(token)?.reply).toBeUndefined();
  expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("confirmed");
});

it("requires the token in a same-origin POST body, never email or a foreign-workspace token", async () => {
  const { workspace, creditToken, token } = await issue(), foreign = repository.createWorkspace(seedStudio());
  expect((await post(workspace.bookingId, { creditToken })).status).toBe(200);
  expect((await post(foreign.bookingId, { creditToken })).status).toBe(404);
  expect((await post(foreign.bookingId, input(creditToken))).status).toBe(404);
  expect((await post(workspace.bookingId, { ...input(creditToken), creditToken: token })).status).toBe(404);
  const { creditToken: ignored, ...emailOnly } = input(creditToken); void ignored;
  expect((await post(workspace.bookingId, emailOnly)).status).toBe(400);
  expect((await post(workspace.bookingId, input(creditToken), randomUUID(), "http://evil.test")).status).toBe(403);
  expect(repository.listCredits(workspace.id)[0].remaining).toBe("22.00"); expect(calls).toEqual([]);
  const result = await post(workspace.bookingId, input(creditToken));
  expect(result.status).toBe(200); expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect(await result.json()).toMatchObject({ paidWith: "credit", amount: "22.00" });
});

it("rolls back the booking, receipt and credit balance together if persistence fails", async () => {
  const { workspace, creditToken } = await issue();
  vi.spyOn(repository, "saveCredit").mockImplementationOnce(() => { throw new Error("disk failed"); });
  await expect(redeemCredit(workspace.id, input(creditToken), randomUUID(), repository)).rejects.toThrow("disk failed");
  expect(repository.listCredits(workspace.id)[0]).toMatchObject({ remaining: "22.00", redemptions: [] });
  expect(repository.requireWorkspace(workspace.id).state.bookings).toHaveLength(1); expect(repository.listCheckout(workspace.id)).toEqual([]);
});

it("reports retained credits separately from refunds, without counting redemption as new revenue", async () => {
  const { workspace, creditToken } = await issue();
  const data = () => buildInsights(repository.requireWorkspace(workspace.id).state, repository.listPlans(workspace.id), repository.listLedger(workspace.id), repository.listCustomerLinks(workspace.id), repository.listCredits(workspace.id));
  expect(data().recovery_outcomes[0]).toMatchObject({ outcome: "credit", kept: 0, moved: 0, credited: 1, kept_as_credit: 22, revenue_kept: 22, refunded: 0, pending: 0, final: true });
  expect(data().disruptions[0]).toMatchObject({ kept_as_credit: 22, revenue_kept: 22, completed_refund_amount: 0 });
  expect(ownerCustomerChoices(workspace.id, repository).replies[0].text).toContain("kept a $22 studio credit");
  expect(ownerCustomerChoices(workspace.id, repository).outbox[0].changes[0].reply?.status).toBe("kept a $22 studio credit");
  const creditReceipt = await redeemCredit(workspace.id, input(creditToken, "cheap"), randomUUID(), repository);
  expect(getRecoverySummary(data())).toMatchObject({ keptAsCredit: 22, creditsIssuedUSD: 22, creditsRedeemedUSD: 10, creditsRemainingUSD: 12 });
  expect(data().bookings.find((row) => row.id === creditReceipt.bookingId)).toMatchObject({ payment_mode: "credit", revenue_kept: 0 });
  expect(data().money_events.filter((row) => row.kind === "capture")).toHaveLength(1);
  expect(JSON.stringify(data())).not.toContain(creditToken);
  expect(buildStudioData(data()).expressions).toContainEqual(expect.objectContaining({ id: "studio_credit_kpi", name: "Kept as studio credit" }));
  expect(initialReport.pages?.find((page) => page.id === "money")?.widgets?.credits).toMatchObject({ format: { title: { text: "Kept as studio credit" } } });
  const apiData = await (await insights(new Request("http://localhost"), { params: Promise.resolve({ id: workspace.id }) })).json();
  expect(apiData.credits[0]).toMatchObject({ amount: 22, redeemed: 10, remaining: 12 });
});

it.each(["COMPLETED", "PENDING", "REQUESTED", "NEEDS_REVIEW"])("blocks credit backed by an original capture with a %s refund", async (status) => {
  const { workspace, booking, creditToken, token } = await issue();
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: "22.00", paypalId: "external-refund",
    captureId: booking.payment!.captureId, requestId: "external-refund", status });
  const ledger = repository.listLedger(workspace.id);
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "0.00", status: "unavailable" });
  expect((await customerChoice(token, repository)).credit).toMatchObject({ remaining: "0.00", status: "unavailable" });
  await expect(redeemCredit(workspace.id, input(creditToken), randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
  expect(repository.listLedger(workspace.id)).toEqual(ledger);
  expect(repository.listCredits(workspace.id)[0].remaining).toBe("22.00");
  expect(calls).toEqual([]);
});

it("limits partially refunded backing by net redemptions without discarding the stored balance", async () => {
  const { workspace, booking, creditToken, token } = await issue();
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: "2.00", paypalId: "partial",
    captureId: booking.payment!.captureId, requestId: "partial", status: "COMPLETED", partial: true });
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "20.00", status: "available" });
  await expect(redeemCredit(workspace.id, input(creditToken), randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
  await redeemCredit(workspace.id, input(creditToken, "cheap"), randomUUID(), repository);
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "10.00", status: "available" });
  expect((await customerChoice(token, repository)).credit?.remaining).toBe("10.00");
  expect(repository.listCredits(workspace.id)[0].remaining).toBe("12.00");
});

it.each(["capture", "external-reversal"])("makes reversed capture backing unavailable for request %s", async (requestId) => {
  const { workspace, booking, creditToken } = await issue();
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: "22.00", paypalId: booking.payment!.captureId,
    captureId: booking.payment!.captureId, requestId, status: "REVERSED" });
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "0.00", status: "unavailable" });
  await expect(redeemCredit(workspace.id, input(creditToken), randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
});

it("restores cancelled credit bookings once across approval, replay and a different request id without PayPal", async () => {
  const { workspace, creditToken } = await issue();
  const receipt = await redeemCredit(workspace.id, input(creditToken), randomUUID(), repository);
  const plan = laterPlan(workspace.id, receipt.bookingId, "refund");
  const result = await executePlan(workspace.id, plan.id, repository);
  expect(result).toMatchObject({ plan: { status: "executed" }, results: [{ bookingId: receipt.bookingId, status: "CREDIT_RESTORED" }] });
  await executePlan(workspace.id, plan.id, repository);
  expect(await checkRefund(workspace.id, `${plan.id}:${receipt.bookingId}`, repository)).toEqual({ kind: "settled" });
  await withWorkspaceLock(repository, workspace.id, (owner) => executeRefund(workspace.id, plan.bookingActions[0], "another-retry", repository, () => repository.renewLock(workspace.id, owner)));
  expect(repository.requireWorkspace(workspace.id).state.bookings.find((item) => item.id === receipt.bookingId)?.status).toBe("refunded");
  expect(repository.listCredits(workspace.id)[0]).toMatchObject({ remaining: "22.00", status: "available", restorations: [{ bookingId: receipt.bookingId, amount: "22.00" }] });
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "22.00", status: "available" });
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.planId === plan.id)!;
  expect((await customerChoice(repository.customerToken(link), repository)).receipt).toMatchObject({ status: "CREDIT_RESTORED", amount: "22.00", paypalId: "" });
  const outcomes = ownerCustomerChoices(workspace.id, repository).outcomes;
  expect(outcomes.find((item) => item.booking_id === receipt.bookingId)).toMatchObject({ pending: 0, final: true, revenue_kept: 0, completed_refund_amount: 0, simulated_refund_amount: 0 });
  expect(ownerCustomerChoices(workspace.id, repository).outbox.find((row) => row.planId === plan.id)?.changes[0].body).toContain("returned to your studio credit");
  const data = await (await insights(new Request("http://localhost"), { params: Promise.resolve({ id: workspace.id }) })).json();
  expect(data.disruptions.find((item: { id: string }) => item.id === plan.id)).toMatchObject({ refund_amount: 0, planned_refund_amount: 0, completed_refund_amount: 0, pending_refund_amount: 0, simulated_refund_amount: 0 });
  expect(data.money_events.filter((item: { status: string }) => item.status === "CREDIT_RESTORED").every((item: { issued_refund: number; net: number; payment_mode: string }) => item.issued_refund === 0 && item.net === 0 && item.payment_mode === "credit")).toBe(true);
  expect(getRecoverySummary(data)).toMatchObject({ creditsRedeemedUSD: 0, creditsRemainingUSD: 22 });
  await redeemCredit(workspace.id, input(creditToken, "cheap"), randomUUID(), repository);
  expect(studioCredit(workspace.id, creditToken, repository).remaining).toBe("12.00");
  expect(repository.ledgerSummary(workspace.id).refunded).toBe("0.00");
  expect(calls).toEqual([]);
});

it("keeps credit-funded choices usable and restores a customer refund without issuing credit of credit", async () => {
  const { workspace, creditToken } = await issue();
  const receipt = await redeemCredit(workspace.id, input(creditToken), randomUUID(), repository);
  const plan = laterPlan(workspace.id, receipt.bookingId, "move");
  await executePlan(workspace.id, plan.id, repository);
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.planId === plan.id)!;
  const token = repository.customerToken(link);
  const choice = await customerChoice(token, repository);
  expect(choice).toMatchObject({ canChoose: true, refundable: "0.00", paidWith: "credit" });
  expect(choice.alternatives.some((item) => item.id === "cheap")).toBe(true);
  await expect(submitChoice(token, { action: "credit" }, repository)).rejects.toMatchObject({ status: 409 });
  await submitChoice(token, { action: "keep" }, repository);
  const result = await submitChoice(token, { action: "refund" }, repository);
  expect(result.receipt).toMatchObject({ status: "CREDIT_RESTORED", amount: "22.00" });
  await submitChoice(token, { action: "refund" }, repository);
  expect(repository.listCredits(workspace.id)).toHaveLength(1);
  expect(repository.listCredits(workspace.id)[0].restorations).toHaveLength(1);
  expect(studioCredit(workspace.id, creditToken, repository).remaining).toBe("22.00");
  expect(calls).toEqual([]);
});

it("counts later moved credit bookings as saved without counting their retained revenue again", async () => {
  const { workspace, creditToken } = await issue();
  const receipt = await redeemCredit(workspace.id, input(creditToken), randomUUID(), repository);
  const plan = laterPlan(workspace.id, receipt.bookingId, "move");
  await executePlan(workspace.id, plan.id, repository);
  expect(ownerCustomerChoices(workspace.id, repository).outcomes.find((item) => item.booking_id === receipt.bookingId)).toMatchObject({ moved: 1, saved: 1, revenue_kept: 0, pending: 0 });
  const data = await (await insights(new Request("http://localhost"), { params: Promise.resolve({ id: workspace.id }) })).json();
  expect(data.disruptions.find((item: { id: string }) => item.id === plan.id)).toMatchObject({ moved: 1, applied_saved: 1, revenue_kept: 0 });
  expect(getRecoverySummary(data).revenueKept).toBe(22);
});

it("returns a credit-funded move's price difference and then only the outstanding value on cancellation", async () => {
  const { workspace, creditToken } = await issue();
  const receipt = await redeemCredit(workspace.id, input(creditToken), randomUUID(), repository);
  const plan = laterPlan(workspace.id, receipt.bookingId, "move");
  await executePlan(workspace.id, plan.id, repository);
  const link = repository.listCustomerLinks(workspace.id).find((item) => item.planId === plan.id)!;
  const token = repository.customerToken(link);
  const moved = await submitChoice(token, { action: "move", sessionId: "cheap" }, repository);
  expect(moved.receipt).toMatchObject({ amount: "12.00", status: "CREDIT_RESTORED" });
  await submitChoice(token, { action: "move", sessionId: "cheap" }, repository);
  expect(studioCredit(workspace.id, creditToken, repository).remaining).toBe("12.00");
  expect(ownerCustomerChoices(workspace.id, repository).outcomes.find((item) => item.booking_id === receipt.bookingId)).toMatchObject({ moved: 1, saved: 1, pending: 0, revenue_kept: 0, completed_refund_amount: 0 });
  const cancelled = laterPlan(workspace.id, receipt.bookingId, "refund");
  expect((await executePlan(workspace.id, cancelled.id, repository)).plan.status).toBe("executed");
  await executePlan(workspace.id, cancelled.id, repository);
  expect(repository.listCredits(workspace.id)[0]).toMatchObject({ remaining: "22.00", restorations: [{ bookingId: receipt.bookingId, amount: "22.00" }] });
  expect(studioCredit(workspace.id, creditToken, repository).remaining).toBe("22.00");
  expect(calls).toEqual([]);
});

it("rolls back restoration, booking status and its receipt together, and respects backing after restoration", async () => {
  const { workspace, booking, creditToken } = await issue();
  const receipt = await redeemCredit(workspace.id, input(creditToken), randomUUID(), repository);
  const plan = laterPlan(workspace.id, receipt.bookingId, "refund");
  vi.spyOn(repository, "appendLedger").mockImplementationOnce(() => { throw new Error("disk failed"); });
  await expect(executePlan(workspace.id, plan.id, repository)).rejects.toThrow("disk failed");
  expect(repository.listCredits(workspace.id)[0]).toMatchObject({ remaining: "0.00", restorations: [] });
  expect(repository.latestMoneyEvents(workspace.id).filter((item) => item.kind === "refund")).toEqual([]);
  expect(repository.requireWorkspace(workspace.id).state.bookings.find((item) => item.id === receipt.bookingId)?.status).toBe("refund_pending");
  await executePlan(workspace.id, plan.id, repository);
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: "22.00", paypalId: "backing-return",
    captureId: booking.payment!.captureId, requestId: "backing-return", status: "COMPLETED" });
  expect(studioCredit(workspace.id, creditToken, repository)).toMatchObject({ remaining: "0.00", status: "unavailable" });
  await expect(redeemCredit(workspace.id, input(creditToken, "cheap"), randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
  expect(calls).toEqual([]);
});

it("emails the lasting credit link when the customer chooses credit on the private page, and a failed send never undoes the choice", async () => {
  const { POST: choicePOST } = await import("../app/api/choices/[token]/route");
  vi.stubEnv("BREVO_API_KEY", "test-key"); vi.stubEnv("BREVO_SENDER_EMAIL", "sender@studio.org"); vi.stubEnv("PUBLIC_ORIGIN", "https://studio.org");
  const { workspace, booking, token } = fixture();
  const { state } = repository.requireWorkspace(workspace.id), customer = state.customers.find((item) => item.id === booking.customerId)!;
  customer.email = "member@studio.org"; repository.saveState(workspace.id, state);
  repository.saveCheckout({ id: booking.id, workspaceId: workspace.id, requestId: "original-checkout", sessionId: booking.sessionId, customer: { name: customer.name, email: customer.email },
    amount: booking.amount, currency: "USD", session: state.sessions[0], status: "confirmed", expiresAt: Date.now() });
  const brevo = vi.fn().mockRejectedValue(new Error("network"));
  vi.stubGlobal("fetch", brevo);
  const choose = () => choicePOST(new Request(`http://localhost/api/choices/${token}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "credit" }) }), { params: Promise.resolve({ token }) });
  const first = await choose();
  expect(first.status).toBe(200);
  const view = await first.json();
  expect(view.reply.action).toBe("credit"); expect(view.credit.emailed).toBe("unknown");
  expect(brevo).toHaveBeenCalledOnce(); expect(brevo.mock.calls[0][0]).toBe("https://api.brevo.com/v3/smtp/email");
  expect(JSON.parse(brevo.mock.calls[0][1].body).textContent).toContain(`https://studio.org${view.credit.path}`);
  expect((await choose()).status).toBe(200); expect(brevo).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
