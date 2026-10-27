import { setSdkTransport } from "./paypalTransport";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerLinks, customerChoice, ownerCustomerChoices, submitChoice } from "../lib/choices/service";
import { executePlan } from "../lib/executor/executePlan";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { closeRepository, getRepository, Repository } from "../lib/store";
import { limits } from "../lib/api/limits";
import { processWebhook } from "../lib/paypal/webhook";
import { GET, POST } from "../app/api/choices/[token]/route";
import { GET as workspaceGET } from "../app/api/workspaces/[id]/route";
import { buildInsights } from "../lib/insights/data";
import { recoveryMetric } from "../lib/insights/metrics";
import type { Plan } from "../lib/domain/types";

let directory: string, repository: Repository;
let refundStatus: string, refundCalls: { url: string; init: RequestInit }[];
let loseResponse: boolean;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-choices-"));
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret"); vi.stubEnv("PAYPAL_ENV", "sandbox");
  repository = getRepository(); limits.reset(); refundStatus = "COMPLETED"; refundCalls = []; loseResponse = false;
  const requests = new Map<string, { fingerprint: string; id: string }>();
  setSdkTransport(async (url, init) => {
    if (url.endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    if (init.method === "GET") {
      const id = url.split("/").at(-1)!;
      const match = repository.latestMoneyEvents(lastWorkspace).find((event) => event.paypalId === id);
      if (match) return Response.json({ id, status: refundStatus, invoice_id: match.requestId, amount: { currency_code: "USD", value: match.amount } });
      throw new Error("Read unavailable");
    }
    refundCalls.push({ url, init });
    const requestId = new Headers(init.headers).get("PayPal-Request-Id")!;
    const fingerprint = JSON.stringify([init.method, url, JSON.parse(init.body as string)]);
    const previous = requests.get(requestId);
    if (previous && previous.fingerprint !== fingerprint) return Response.json({
      name: "DUPLICATE_REQUEST_ID", message: "Request ID already used for a different request",
    }, { status: 400 });
    const id = previous?.id ?? `7GD-${requests.size + 1}`;
    requests.set(requestId, { fingerprint, id });
    if (loseResponse) throw new Error("Response lost after submission");
    return Response.json({ id, status: refundStatus }, { status: 201 });
  });
});
let lastWorkspace = "";
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(simulated = false) {
  const state = seedStudio();
  const original = { ...state.sessions[0], price: "22.00" };
  state.sessions = [original,
    { ...original, id: "alternative", title: "Wednesday Yoga", start: "2026-11-11T15:00:00Z", end: "2026-11-11T16:00:00Z", capacity: 1 },
    { ...original, id: "cheaper", title: "Gentle Yoga", start: "2026-11-12T15:00:00Z", end: "2026-11-12T16:00:00Z", price: "18.00" },
    { ...original, id: "higher", start: "2026-11-12T17:00:00Z", end: "2026-11-12T18:00:00Z", price: "23.00" },
    { ...original, id: "other-type", classType: "pilates", start: "2026-11-10T15:00:00Z", end: "2026-11-10T16:00:00Z" },
    { ...original, id: "next-week", start: "2026-11-16T15:00:00Z", end: "2026-11-16T16:00:00Z" }];
  state.bookings = state.bookings.slice(0, 3).map((booking) => ({ ...booking, sessionId: original.id, amount: "22.00", payment: { ...booking.payment!, captureId: randomUUID(), simulated } }));
  const workspace = repository.createWorkspace(state); lastWorkspace = workspace.id;
  for (const booking of state.bookings) repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: "22.00",
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: simulated ? "SIMULATED" : "COMPLETED" });
  const next = structuredClone(state); next.sessions[0].start = "2026-11-09T14:00:00Z"; next.sessions[0].end = "2026-11-09T15:00:00Z";
  next.sessions[0].instructorId = state.instructors[1].id; next.bookings[2].status = "refund_pending";
  const plan: Plan = { now: new Date().toISOString(), disruption: { kind: "instructor_unavailable", instructorId: original.instructorId, from: original.start, to: original.end },
    sessionChanges: [{ sessionId: original.id, remedy: "move_time", before: original, after: next.sessions[0], reason: "Teacher unavailable" }],
    bookingActions: state.bookings.map((booking, index) => ({ bookingId: booking.id, customerId: booking.customerId, action: index === 2 ? "refund" : "move", amount: "22.00", reason: "Class changed" })),
    totals: { sessionsAffected: 1, kept: 0, moved: 2, refunded: 1, refundAmount: "22.00", revenueKept: "44.00" }, warnings: [] };
  const stored = { ...repository.createPlan(workspace.id, plan), status: "executed" as const, basis: state };
  repository.savePlan(stored); repository.saveState(workspace.id, next); createCustomerLinks(stored, state, next, repository);
  const links = repository.listCustomerLinks(workspace.id);
  return { workspaceId: workspace.id, plan: stored, links, token: repository.customerToken(links[0]), otherToken: repository.customerToken(links[1]),
    bookingId: state.bookings[0].id, otherBookingId: state.bookings[1].id };
}

describe("private customer links", () => {
  it("creates unique 256-bit URL-safe tokens, stores digests, looks up by hash, and survives a restart", async () => {
    const { token, otherToken, workspaceId, plan } = fixture();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(token).not.toBe(otherToken);
    const link = repository.customerLinkByToken(token)!;
    expect(link.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(repository.listCustomerLinks(workspaceId))).not.toContain(token);
    expect(readFileSync(join(directory, "rebook.sqlite")).includes(Buffer.from(token))).toBe(false);
    createCustomerLinks(plan, plan.basis!, repository.requireWorkspace(workspaceId).state, repository);
    expect(repository.listCustomerLinks(workspaceId)).toHaveLength(3);
    closeRepository(); repository = getRepository();
    expect(repository.customerToken(repository.customerLinkByToken(token)!)).toBe(token);
    expect((await customerChoice(token, repository)).message.body).toContain("Choose below");
    const customerLinks = ownerCustomerChoices(workspaceId, repository).links;
    expect(customerLinks.every((item) => /^\/c\/[A-Za-z0-9_-]{43}$/.test(item.path))).toBe(true);
    expect(JSON.stringify(customerLinks)).not.toContain(workspaceId);
    expect(JSON.stringify(await customerChoice(token, repository))).not.toContain(workspaceId);
    await expect(customerChoice("x".repeat(43), repository)).rejects.toMatchObject({ status: 404 });
  });
  it("expires choices at the earlier of class start and seven days", async () => {
    const { token, links } = fixture();
    expect(links[0].expiresAt).toBe(Date.parse("2026-11-09T14:00:00Z"));
    vi.setSystemTime(links[0].expiresAt);
    expect((await customerChoice(token, repository)).canChoose).toBe(false);
    await expect(submitChoice(token, { action: "keep" }, repository)).rejects.toMatchObject({ status: 410 });
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const second = fixture();
    expect(second.links[0].expiresAt).toBe(Date.now() + 7 * 86_400_000);
  });
  it("retains a workspace for the private links' 30-day readable lifetime", () => {
    const { workspaceId } = fixture();
    vi.setSystemTime(Date.now() + 25 * 3_600_000); repository.pruneOlderThan();
    expect(repository.getWorkspace(workspaceId)).toBeDefined();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z")); repository.pruneOlderThan();
    expect(repository.getWorkspace(workspaceId)).toBeDefined();
    vi.setSystemTime(new Date("2026-12-05T12:00:00Z")); repository.pruneOlderThan();
    expect(repository.getWorkspace(workspaceId)).toBeUndefined();
  });
  it("keeps refund receipts and choice outcomes readable after class start, with choices closed", async () => {
    const { token, otherToken, links } = fixture();
    await submitChoice(token, { action: "keep" }, repository);
    const refunded = await submitChoice(otherToken, { action: "refund" }, repository);
    const receiptToken = repository.customerToken(links.find((link) => link.kind === "receipt")!);
    const originalReceipt = await customerChoice(receiptToken, repository);
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    closeRepository(); repository = getRepository();
    const get = async (value: string) => GET(new Request("http://localhost"), { params: Promise.resolve({ token: value }) });
    const kept = await get(token); expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ canChoose: false, reply: { action: "keep" }, alternatives: [] });
    const paid = await get(otherToken); expect(paid.status).toBe(200);
    expect((await paid.json()).receipt).toEqual(refunded.receipt);
    expect((await customerChoice(receiptToken, repository)).receipt).toEqual(originalReceipt.receipt);
    await expect(submitChoice(token, { action: "refund" }, repository)).rejects.toMatchObject({ status: 410 });
    vi.setSystemTime(new Date("2026-12-05T11:59:59Z"));
    expect((await get(receiptToken)).status).toBe(200);
    vi.setSystemTime(new Date("2026-12-05T12:00:00Z"));
    expect((await get(receiptToken)).status).toBe(410);
  });
  it("does not offer a class awaiting recovery approval as an alternative booking", async () => {
    const { token, workspaceId } = fixture();
    const state = repository.requireWorkspace(workspaceId).state;
    const target = state.sessions.find((session) => session.id === "alternative")!;
    const plan = repository.createPlan(workspaceId, { ...repository.listPlans(workspaceId)[0],
      sessionChanges: [{ sessionId: target.id, remedy: "cancel", before: target, reason: "Recovery pending" }] });
    expect((await customerChoice(token, repository)).alternatives.some((session) => session.id === target.id)).toBe(false);
    await expect(submitChoice(token, { action: "move", sessionId: target.id }, repository)).rejects.toMatchObject({ status: 409 });
    repository.discardPlan(workspaceId, plan.id);
    expect((await customerChoice(token, repository)).alternatives.some((session) => session.id === target.id)).toBe(true);
  });
  it("gives refunded bookings receipt-only links and no choice tokens", async () => {
    const { links, workspaceId } = fixture();
    expect(links.filter((link) => link.kind === "choice")).toHaveLength(2);
    const receipt = links.find((link) => link.kind === "receipt")!;
    const token = repository.customerToken(receipt);
    expect((await customerChoice(token, repository)).canChoose).toBe(false);
    await expect(submitChoice(token, { action: "keep" }, repository)).rejects.toMatchObject({ status: 409 });
    expect(ownerCustomerChoices(workspaceId, repository).links.find((link) => link.kind === "receipt")).toBeDefined();
  });
  it("polls a plan refund receipt to completion without offering choices", async () => {
    const { links } = fixture();
    const token = repository.customerToken(links.find((link) => link.kind === "receipt")!);
    refundStatus = "PENDING";
    expect((await customerChoice(token, repository)).receipt?.status).toBe("PENDING");
    refundStatus = "COMPLETED";
    const result = await customerChoice(token, repository);
    expect(result.receipt?.status).toBe("COMPLETED"); expect(result.canChoose).toBe(false); expect(refundCalls).toHaveLength(1);
  });
  it("issues links during actual executor approval exactly once", async () => {
    const state = seedStudio();
    for (const booking of state.bookings) booking.payment!.simulated = true;
    const { id } = repository.createWorkspace(state);
    for (const booking of state.bookings) repository.appendLedger({ workspaceId: id, bookingId: booking.id, kind: "capture", amount: booking.amount,
      paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: booking.id, status: "SIMULATED" });
    const plan = repository.createPlan(id, replan(state, demoDisruption));
    await executePlan(id, plan.id, repository); const links = repository.listCustomerLinks(id);
    expect(links).toHaveLength(plan.bookingActions.length);
    expect(links.filter((link) => link.kind === "choice")).toHaveLength(plan.bookingActions.filter((action) => action.action !== "refund").length);
    await executePlan(id, plan.id, repository);
    expect(repository.listCustomerLinks(id)).toEqual(links);
  });
});

describe("one tap choices and money", () => {
  it.each([false, true])("keeps choice refund identities distinct across workspaces with the same booking ID (partial: %s)", async (partial) => {
    const input = partial ? { action: "move" as const, sessionId: "cheaper" } : { action: "refund" as const };
    const first = fixture();
    // Approval refunds have their own plan-scoped identity.
    const receipt = first.links.find((link) => link.kind === "receipt")!;
    expect((await customerChoice(repository.customerToken(receipt), repository)).receipt?.status).toBe("COMPLETED");
    expect((await submitChoice(first.token, input, repository)).receipt?.status).toBe("COMPLETED");
    const second = fixture();
    expect(second.bookingId).toBe(first.bookingId);
    expect(second.workspaceId).not.toBe(first.workspaceId);
    const captureId = repository.requireWorkspace(second.workspaceId).state.bookings.find((booking) => booking.id === second.bookingId)!.payment!.captureId;
    // A previous partial refund also makes the second request's amount/body different.
    repository.appendLedger({ workspaceId: second.workspaceId, bookingId: second.bookingId, kind: "refund", amount: "1.00",
      captureId, requestId: "earlier-partial", paypalId: "earlier-refund", status: "COMPLETED", partial: true });
    const result = await POST(new Request(`http://localhost/api/choices/${second.token}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    }), { params: Promise.resolve({ token: second.token }) });
    expect(result.status).toBe(200);
    expect((await result.json()).receipt).toMatchObject({ status: "COMPLETED", amount: partial ? "3.00" : "21.00" });
    const ids = refundCalls.map((call) => new Headers(call.init.headers).get("PayPal-Request-Id"));
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe(`${first.plan.id}:${receipt.bookingId}`);
    for (const [index, item] of [first, second].entries()) {
      const requestId = ids[index + 1]!;
      expect(requestId).toBe(`choice:${item.links[0].id}`);
      expect(JSON.parse(refundCalls[index + 1].init.body as string).invoice_id).toBe(requestId);
      expect(repository.customerLinkByToken(item.token)?.reply?.requestId).toBe(requestId);
      expect(repository.latestMoneyEvents(item.workspaceId).find((event) => event.requestId === requestId)).toMatchObject({
        kind: "refund", status: "COMPLETED", bookingId: item.bookingId,
      });
    }
    await submitChoice(second.token, input, repository);
    expect(refundCalls).toHaveLength(3);
  });
  it("keeps the new time and projects the reply without a payment call", async () => {
    const { token, bookingId, workspaceId } = fixture();
    const before = repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId);
    const result = await submitChoice(token, { action: "keep" }, repository);
    expect(result.reply?.action).toBe("keep"); expect(refundCalls).toHaveLength(0);
    expect(repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)).toEqual(before);
    expect(ownerCustomerChoices(workspaceId, repository).replies[0].text).toContain("kept Monday");
    expect(result.before.start).not.toBe(result.after?.start); expect(result.before.instructor).not.toBe(result.after?.instructor);
    // No money has moved, so a customer who changes their mind can still take a refund.
    expect((await submitChoice(token, { action: "refund" }, repository)).receipt?.status).toBe("COMPLETED");
  });
  it("offers available classes in the studio week, same type first, with no higher prices", async () => {
    const { token } = fixture();
    const result = await customerChoice(token, repository);
    expect(result.alternatives.map((item) => item.id)).toEqual(["alternative", "cheaper", "other-type"]);
    await expect(submitChoice(token, { action: "move", sessionId: "higher" }, repository)).rejects.toMatchObject({ status: 409 });
    await expect(submitChoice(token, { action: "move", sessionId: "next-week" }, repository)).rejects.toMatchObject({ status: 409 });
    expect(refundCalls).toHaveLength(0);
  });
  it("checks last-seat races across database connections and updates the schedule projection", async () => {
    const { token, otherToken, workspaceId } = fixture();
    const second = new Repository(directory);
    try {
      const results = await Promise.allSettled([submitChoice(token, { action: "move", sessionId: "alternative" }, repository), submitChoice(otherToken, { action: "move", sessionId: "alternative" }, second)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await expect(submitChoice(otherToken, { action: "move", sessionId: "alternative" }, second)).rejects.toMatchObject({ status: 409 });
      expect(repository.requireWorkspace(workspaceId).state.bookings.filter((item) => item.sessionId === "alternative")).toHaveLength(1);
      const response = await workspaceGET(new Request("http://localhost"), { params: Promise.resolve({ id: workspaceId }) });
      const data = await response.json();
      expect(data.state.bookings.some((item: { sessionId: string }) => item.sessionId === "alternative")).toBe(true);
      expect(data.customerChoices.replies[0].text).toContain("picked Wednesday Yoga");
    } finally { second.close(); }
  });
  it("respects checkout seat holds", async () => {
    const { token, workspaceId } = fixture();
    const session = repository.requireWorkspace(workspaceId).state.sessions.find((item) => item.id === "alternative")!;
    repository.saveCheckout({ id: "held", workspaceId, sessionId: session.id, session, requestId: "held", status: "capturing", expiresAt: Date.now() + 60_000,
      customer: { name: "Another buyer", email: "buyer@example.com" }, amount: session.price, currency: "USD" });
    expect((await customerChoice(token, repository)).alternatives.map((item) => item.id)).not.toContain("alternative");
    await expect(submitChoice(token, { action: "move", sessionId: "alternative" }, repository)).rejects.toMatchObject({ status: 409 });
  });
  it("shortens token expiry when a customer selects an earlier class", async () => {
    const { token, workspaceId } = fixture();
    const { state } = repository.requireWorkspace(workspaceId);
    const session = state.sessions.find((item) => item.id === "alternative")!;
    session.start = "2026-11-09T13:00:00Z"; session.end = "2026-11-09T14:00:00Z"; repository.saveState(workspaceId, state);
    const result = await submitChoice(token, { action: "move", sessionId: "alternative" }, repository);
    expect(result.expiresAt).toBe(Date.parse(session.start));
  });
  it("refunds a price difference through the original capture and keeps the chosen seat", async () => {
    const { token, workspaceId, bookingId } = fixture();
    const result = await submitChoice(token, { action: "move", sessionId: "cheaper" }, repository);
    expect(result.receipt).toMatchObject({ amount: "4.00", status: "COMPLETED", paypalId: "7GD-1" });
    expect(JSON.parse(refundCalls[0].init.body as string).amount.value).toBe("4.00");
    expect(repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)).toMatchObject({ sessionId: "cheaper", amount: "18.00", status: "moved" });
    await submitChoice(token, { action: "move", sessionId: "cheaper" }, repository);
    expect(refundCalls).toHaveLength(1);
    await expect(submitChoice(token, { action: "refund" }, repository)).rejects.toMatchObject({ status: 409 });
    expect(ownerCustomerChoices(workspaceId, repository).replies[0].text).toContain("$4.00, PayPal 7GD-1");
  });
  it("makes one idempotent refund on double tap and rejects subsequent changes", async () => {
    const { token, bookingId, workspaceId, links } = fixture();
    const result = await Promise.allSettled([submitChoice(token, { action: "refund" }, repository), submitChoice(token, { action: "refund" }, repository)]);
    expect(result.filter((item) => item.status === "fulfilled").length).toBeGreaterThan(0);
    const again = await submitChoice(token, { action: "refund" }, repository);
    expect(refundCalls).toHaveLength(1);
    expect(new Headers(refundCalls[0].init.headers).get("PayPal-Request-Id")).toBe(`choice:${links[0].id}`);
    expect(again.receipt).toMatchObject({ amount: "22.00", status: "COMPLETED", paypalId: "7GD-1" });
    expect(repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)?.status).toBe("refunded");
    await expect(submitChoice(token, { action: "keep" }, repository)).rejects.toMatchObject({ status: 409 });
    expect(ownerCustomerChoices(workspaceId, repository).replies[0].text).toContain("took a refund ($22.00, PayPal 7GD-1");
  });
  it("only refunds the remaining capture after a previous completed partial refund", async () => {
    const { token, bookingId, workspaceId } = fixture();
    const captureId = repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)!.payment!.captureId;
    repository.appendLedger({ workspaceId, bookingId, kind: "refund", amount: "3.00", captureId, requestId: "prior-partial", paypalId: "prior", status: "COMPLETED", partial: true });
    expect((await submitChoice(token, { action: "refund" }, repository)).receipt?.amount).toBe("19.00");
    expect(JSON.parse(refundCalls[0].init.body as string).amount.value).toBe("19.00");
  });
  it.each([false, true])("polls pending refunds to completed without losing a partial seat (%s)", async (partial) => {
    const { token, bookingId, workspaceId } = fixture(); refundStatus = "PENDING";
    const result = await submitChoice(token, partial ? { action: "move", sessionId: "cheaper" } : { action: "refund" }, repository);
    expect(result.receipt?.status).toBe("PENDING"); refundStatus = "COMPLETED";
    expect((await customerChoice(token, repository)).receipt?.status).toBe("COMPLETED");
    expect(repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)?.status).toBe(partial ? "moved" : "refunded");
    expect(refundCalls).toHaveLength(1);
  });
  it("webhooks complete a price difference without cancelling the booking, including repeated notifications", async () => {
    const { token, bookingId, workspaceId } = fixture(); refundStatus = "PENDING";
    const result = await submitChoice(token, { action: "move", sessionId: "cheaper" }, repository);
    const captureId = repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)!.payment!.captureId;
    for (const id of ["event-1", "event-2"]) expect(processWebhook(JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: result.receipt!.paypalId, capture_id: captureId, amount: { currency_code: "USD", value: "4.00" } } }), repository).matched).toBe(true);
    expect((await customerChoice(token, repository)).receipt?.status).toBe("COMPLETED");
    expect(repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)?.status).toBe("moved");
  });
  it.each([false, true])("matches webhook invoice evidence to a lost choice refund response (partial: %s)", async (partial) => {
    const { token, bookingId, workspaceId, links } = fixture(); loseResponse = true;
    expect((await submitChoice(token, partial ? { action: "move", sessionId: "cheaper" } : { action: "refund" }, repository)).receipt?.status).toBe("REQUESTED");
    const requestId = `choice:${links[0].id}`;
    const captureId = repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)!.payment!.captureId;
    const amount = partial ? "4.00" : "22.00";
    for (const id of ["invoice-event-1", "invoice-event-2"]) expect(processWebhook(JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: "7GD-1", capture_id: captureId, invoice_id: requestId, amount: { currency_code: "USD", value: amount } } }), repository).matched).toBe(true);
    expect(repository.latestMoneyEvents(workspaceId).filter((event) => event.kind === "refund")).toEqual([
      expect.objectContaining({ requestId, paypalId: "7GD-1", amount, status: "COMPLETED", ...(partial ? { partial: true } : {}) }),
    ]);
    expect((await customerChoice(token, repository)).receipt?.status).toBe("COMPLETED");
    expect(repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === bookingId)?.status).toBe(partial ? "moved" : "refunded");
    expect(refundCalls).toHaveLength(1);
  });
  it.each([false, true])("replays a lost response with the original request ID after restart (partial: %s)", async (partial) => {
    const { token, links } = fixture(); loseResponse = true;
    expect((await submitChoice(token, partial ? { action: "move", sessionId: "cheaper" } : { action: "refund" }, repository)).receipt?.status).toBe("REQUESTED");
    closeRepository(); repository = getRepository(); loseResponse = false;
    expect((await customerChoice(token, repository)).receipt?.status).toBe("COMPLETED");
    expect(refundCalls.map((call) => new Headers(call.init.headers).get("PayPal-Request-Id"))).toEqual([`choice:${links[0].id}`, `choice:${links[0].id}`]);
  });
  it("labels simulated refunds and never calls PayPal", async () => {
    const { token, workspaceId } = fixture(true);
    const result = await submitChoice(token, { action: "refund" }, repository);
    expect(result.simulated).toBe(true); expect(result.receipt?.status).toBe("SIMULATED"); expect(refundCalls).toHaveLength(0);
    expect(ownerCustomerChoices(workspaceId, repository).replies[0].text).toContain("simulated");
  });
});

describe("token-only API", () => {
  it("validates input, blocks foreign origins, returns private no-store responses without workspace/customer identifiers", async () => {
    const { token, workspaceId } = fixture();
    const context = { params: Promise.resolve({ token }) };
    const get = await GET(new Request(`http://localhost/api/choices/${token}`), context);
    expect(get.status).toBe(200); expect(get.headers.get("Cache-Control")).toBe("no-store"); expect(get.headers.get("Referrer-Policy")).toBe("no-referrer");
    const text = await get.text(); expect(text).not.toContain(workspaceId); expect(text).not.toContain("@example.com"); expect(text).not.toContain("tokenHash");
    const post = (body: object, origin = "http://localhost") => POST(new Request(`http://localhost/api/choices/${token}`, { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body) }), context);
    expect((await post({ action: "refund", amount: "999.00" })).status).toBe(400);
    expect((await post({ action: "refund" }, "http://other.test")).status).toBe(403);
    expect((await post({ action: "keep" })).status).toBe(200);
    expect((await GET(new Request("http://localhost"), { params: Promise.resolve({ token: "bad" }) })).status).toBe(400);
  });
  it("rate limits repeated submissions", async () => {
    const { token } = fixture();
    for (let index = 0; index < 20; index++) expect((await POST(new Request(`http://localhost/api/choices/${token}`, { method: "POST", body: '{"action":"keep"}' }), { params: Promise.resolve({ token }) })).status).toBe(200);
    const limited = await POST(new Request(`http://localhost/api/choices/${token}`, { method: "POST", body: '{"action":"keep"}' }), { params: Promise.resolve({ token }) });
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBeTruthy();
  });
});


it("updates recovery KPIs after a private-link refund settles", async () => {
  const { token, workspaceId } = fixture();
  const data = () => buildInsights(repository.requireWorkspace(workspaceId).state, repository.listPlans(workspaceId), repository.listLedger(workspaceId), repository.listCustomerLinks(workspaceId));
  expect(data().disruptions[0]).toMatchObject({ applied_saved: 2, applied_revenue_kept: 44, refunded: 0, pending: 1 });
  expect(recoveryMetric(data().disruptions, "saved").value).toBe("67%");
  refundStatus = "PENDING";
  await submitChoice(token, { action: "refund" }, repository);
  expect(data().disruptions[0]).toMatchObject({ applied_saved: 1, applied_revenue_kept: 22, refunded: 0, pending: 2, completed_refund_amount: 0, pending_refund_amount: 22 });
  refundStatus = "COMPLETED";
  await customerChoice(token, repository);
  expect(data().disruptions[0]).toMatchObject({ applied_saved: 1, applied_revenue_kept: 22, refunded: 1, pending: 1, completed_refund_amount: 22, pending_refund_amount: 0 });
  expect(recoveryMetric(data().disruptions, "saved").value).toBe("33%");
});
