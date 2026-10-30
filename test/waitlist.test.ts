import { setSdkTransport } from "./paypalTransport";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio, demoDisruption } from "../lib/seed/seed";
import { replan } from "../lib/solver/replan";
import { executePlan } from "../lib/executor/executePlan";
import { bookingCatalog, captureCheckout, confirmOrder, createOrder, seatsLeft } from "../lib/checkout/service";
import { fillFreedSeats, ownerWaitlist, respondToWaitlistOffer, waitlistOfferView } from "../lib/waitlist/service";
import { customerChoice, ownerCustomerChoices, markCustomerContact, submitChoice } from "../lib/choices/service";
import { sendCustomerEmail } from "../lib/choices/email";
import { limits } from "../lib/api/limits";
import { GET as workspaceGet } from "../app/api/workspaces/[id]/route";
import { GET, POST } from "../app/api/waitlist/[token]/route";
import { POST as retryRefund } from "../app/api/workspaces/[id]/refunds/retry/route";
import { StateSchema } from "../lib/domain/schemas";

let directory: string, repository: Repository, workspaceId: string, sessionId: string;
type Order = { id: string; status: string; purchase_units: { reference_id: string; custom_id: string; amount: { currency_code: string; value: string }; payments?: { captures: { id: string; status: string; amount: { currency_code: string; value: string } }[] } }[] };
const orders = new Map<string, Order>();
const offers = () => repository.listWaitlistOffers(workspaceId);
const token = (index = 0) => repository.waitlistToken(offers()[index]);
function setup(pack = false, capacity = 1) {
  const state = seedStudio(); state.bookings = []; state.sessions = [state.sessions[0]]; state.sessions[0].capacity = capacity;
  state.waitlist = state.customers.slice(0, 3).map((customer, index) => ({ id: `entry-${index}`, sessionId: state.sessions[0].id, customerId: customer.id,
    joinedAt: new Date(Date.now() - (3 - index) * 60_000).toISOString(), ...(pack ? { entitlement: { kind: "pack" as const, name: "10 classes" } } : {}) }));
  workspaceId = repository.createWorkspace(state).id; sessionId = state.sessions[0].id;
  return state;
}
async function hero() {
  const state = seedStudio(); for (const booking of state.bookings) booking.payment!.simulated = true;
  workspaceId = repository.createWorkspace(state).id;
  for (const booking of state.bookings) repository.appendLedger({ workspaceId, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: booking.payment!.captureId, captureId: booking.payment!.captureId, requestId: `capture:${booking.id}`, status: "SIMULATED" });
  const plan = repository.createPlan(workspaceId, replan(state, demoDisruption));
  await executePlan(workspaceId, plan.id, repository); return plan;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-waitlist-")); vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID()); vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret"); vi.stubEnv("PAYPAL_ENV", "sandbox");
  repository = getRepository(); orders.clear(); limits.reset();
  setSdkTransport(async (url, init) => {
    if (url.endsWith("/token")) return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    if (url.endsWith("/refund")) return Response.json({ id: "WAITLIST-REFUND", status: "COMPLETED", amount: JSON.parse(init.body as string).amount });
    if (url.includes("/v2/payments/captures/") && init.method === "GET") return Response.json({ id: new URL(url).pathname.split("/").at(-1), status: "COMPLETED" });
    if (url.endsWith("/v2/checkout/orders")) {
      const id = `ORDER-${orders.size}`, order = { id, status: "CREATED", purchase_units: JSON.parse(init.body as string).purchase_units };
      orders.set(id, order); return Response.json(order, { status: 201 });
    }
    const id = new URL(url).pathname.split("/").at(init.method === "GET" ? -1 : -2)!;
    const order = orders.get(id)!;
    if (url.endsWith("/capture")) {
      order.status = "COMPLETED"; order.purchase_units[0].payments = { captures: [{ id: `CAP-${id}`, status: "COMPLETED", amount: order.purchase_units[0].amount }] };
    }
    return Response.json(order);
  });
});
afterEach(() => { closeRepository(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps legacy state valid and creates FIFO hero offers without changing totals", async () => {
  const plan = await hero();
  expect(plan.totals).toMatchObject({ kept: 9, moved: 16, refunded: 6, revenueKept: "577.00", refundAmount: "135.00" });
  const { state } = repository.requireWorkspace(workspaceId);
  // Both classes start full: Dance Flow's 3 refunds and Barre Flow's 1 go to the front of each line.
  expect(offers()).toHaveLength(4);
  for (const session of ownerWaitlist(workspaceId, repository)) {
    expect(offers().filter((offer) => offer.sessionId === session.sessionId).map((offer) => offer.entryId)).toEqual(state.waitlist!.filter((entry) => entry.sessionId === session.sessionId).map((entry) => entry.id).slice(0, offers().filter((offer) => offer.sessionId === session.sessionId).length));
    expect(offers().filter((offer) => offer.sessionId === session.sessionId)).toHaveLength(session.title === "Dance Flow" ? 3 : 1);
  }
  fillFreedSeats(workspaceId, repository); expect(offers()).toHaveLength(4);
  const legacy = { ...state }; delete legacy.waitlist; expect(StateSchema.parse(legacy).waitlist).toBeUndefined();
});
it("holds seats from public checkout and lets the cash holder pay exactly once", async () => {
  const state = setup(); fillFreedSeats(workspaceId, repository);
  expect(offers()).toHaveLength(1); expect(bookingCatalog(workspaceId, repository).sessions[0].seatsLeft).toBe(0);
  expect(seatsLeft(state, state.sessions[0], [], undefined, offers())).toBe(0);
  await expect(createOrder(workspaceId, { sessionId, customer: { name: "Other", email: "other@example.com" } }, randomUUID(), repository)).rejects.toMatchObject({ status: 409 });
  expect(await respondToWaitlistOffer(token(), "claim", repository)).toMatchObject({ status: "offered", entitlement: undefined });
  const customer = state.customers[0], input = { sessionId, customer: { name: customer.name, email: customer.email }, waitlistToken: token() };
  const order = await createOrder(workspaceId, input, randomUUID(), repository);
  expect(bookingCatalog(workspaceId, repository).sessions[0].seatsLeft).toBe(0);
  expect(await createOrder(workspaceId, input, randomUUID(), repository)).toEqual(order);
  await captureCheckout(workspaceId, order.orderId, repository);
  await captureCheckout(workspaceId, order.orderId, repository);
  expect(offers()[0]).toMatchObject({ status: "claimed", bookingId: repository.listCheckout(workspaceId)[0].id });
  expect(repository.requireWorkspace(workspaceId).state.bookings).toHaveLength(1);
});
it.each(["pack", "membership"] as const)("claims a %s instantly without money", async (kind) => {
  const state = setup(true); state.waitlist![0].entitlement!.kind = kind; repository.saveState(workspaceId, state);
  fillFreedSeats(workspaceId, repository); const privateToken = token();
  expect(await respondToWaitlistOffer(privateToken, "claim", repository)).toMatchObject({ status: "claimed" });
  expect(await respondToWaitlistOffer(privateToken, "claim", repository)).toMatchObject({ status: "claimed" });
  expect(repository.requireWorkspace(workspaceId).state.bookings).toEqual([expect.objectContaining({ amount: "0.00", status: "confirmed", entitlement: { kind, name: "10 classes" }, bookedAt: new Date().toISOString() })]);
  expect(repository.listLedger(workspaceId)).toEqual([]);
});
it("advances on decline and lazily on owner reads after expiry", async () => {
  setup(); fillFreedSeats(workspaceId, repository);
  await respondToWaitlistOffer(token(), "decline", repository);
  expect(offers().map((offer) => offer.entryId)).toEqual(["entry-0", "entry-1"]);
  vi.setSystemTime(Date.parse(offers()[1].expiresAt) + 1);
  const response = await workspaceGet(new Request("http://localhost"), { params: Promise.resolve({ id: workspaceId }) });
  expect(response.status).toBe(200);
  expect(offers().map((offer) => offer.status)).toEqual(["declined", "expired", "offered"]);
  expect(offers()[2].entryId).toBe("entry-2");
});
it("keeps a checkout hold beyond the offer deadline without double counting", async () => {
  const state = setup(), start = Date.parse(state.sessions[0].start);
  vi.setSystemTime(start - 2 * 3_600_000); fillFreedSeats(workspaceId, repository);
  vi.setSystemTime(start - 3_600_000 - 5 * 60_000);
  const customer = state.customers[0];
  const order = await createOrder(workspaceId, { sessionId, customer: { name: customer.name, email: customer.email }, waitlistToken: token() }, randomUUID(), repository);
  vi.setSystemTime(start - 3_600_000 + 1); fillFreedSeats(workspaceId, repository);
  expect(offers()).toHaveLength(1); expect(offers()[0].status).toBe("offered");
  expect(bookingCatalog(workspaceId, repository).sessions[0].seatsLeft).toBe(0);
  await captureCheckout(workspaceId, order.orderId, repository); expect(offers()[0].status).toBe("claimed");
});
it("serializes racing claims and expires a stale offer whose seat was taken", async () => {
  const state = setup(true); fillFreedSeats(workspaceId, repository);
  const results = await Promise.allSettled([respondToWaitlistOffer(token(), "claim", repository), respondToWaitlistOffer(token(), "claim", repository)]);
  expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThan(0);
  expect(repository.requireWorkspace(workspaceId).state.bookings).toHaveLength(1);
  const extra = repository.createWaitlistOffer({ workspaceId, entryId: "entry-1", customerId: state.customers[1].id, sessionId, expiresAt: offers()[0].expiresAt });
  await expect(respondToWaitlistOffer(repository.waitlistToken(extra), "claim", repository)).rejects.toThrow("Sorry, this spot was just taken.");
  expect(offers().find((offer) => offer.id === extra.id)?.status).toBe("expired");
});
it("a customer refund frees a seat and immediately offers it", async () => {
  await hero(); const link = repository.listCustomerLinks(workspaceId).find((item) => item.kind === "choice")!;
  const { state } = repository.requireWorkspace(workspaceId), booking = state.bookings.find((item) => item.id === link.bookingId)!;
  const session = state.sessions.find((item) => item.id === booking.sessionId)!;
  state.waitlist = [{ id: "refund-waiter", customerId: state.customers[119].id, sessionId: session.id, joinedAt: new Date().toISOString() }];
  session.capacity = state.bookings.filter((item) => item.sessionId === session.id && ["confirmed", "moved"].includes(item.status)).length;
  repository.saveState(workspaceId, state);
  await submitChoice(repository.customerToken(link), { action: "refund" }, repository);
  expect(offers()).toContainEqual(expect.objectContaining({ entryId: "refund-waiter", status: "offered" }));
});
it("withdraws old offers after a later approved class move or cancellation", async () => {
  await hero(); const initial = offers()[0], state = repository.requireWorkspace(workspaceId).state;
  const session = state.sessions.find((item) => item.id === initial.sessionId)!;
  const plan = repository.createPlan(workspaceId, replan(state, { kind: "instructor_unavailable", instructorId: session.instructorId, from: session.start, to: session.end }));
  await executePlan(workspaceId, plan.id, repository);
  expect(offers().find((offer) => offer.id === initial.id)?.status).toBe("withdrawn");
  expect(waitlistOfferView(repository.waitlistToken(initial), repository).status).toBe("withdrawn");
});
it("isolates customer, cover and waitlist token domains and guards the offer API", async () => {
  await hero();
  expect(() => waitlistOfferView(repository.customerToken(repository.listCustomerLinks(workspaceId)[0]), repository)).toThrow("no longer available");
  expect(() => waitlistOfferView(repository.coverToken({ id: offers()[0].id }), repository)).toThrow("no longer available");
  const ctx = { params: Promise.resolve({ token: token() }) };
  expect((await GET(new Request("http://localhost"), ctx)).headers.get("Referrer-Policy")).toBe("no-referrer");
  const response = await POST(new Request("http://localhost/api/waitlist", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ action: "claim" }) }), ctx);
  expect(response.status).toBe(403);
  const previous = token(); repository.clearPlans(workspaceId); expect(() => waitlistOfferView(previous, repository)).toThrow("no longer available");
});
it("reuses outbox share, email delivery and sent tracking only for checkout addresses", async () => {
  const state = setup(); state.customers[0].email = "member@studio.org"; repository.saveState(workspaceId, state);
  fillFreedSeats(workspaceId, repository); let outbox = ownerCustomerChoices(workspaceId, repository).outbox;
  expect(outbox[0]).toMatchObject({ waitlistOffer: true, emailDeliverable: false, changes: [{ subject: "A spot opened in Yoga Flow", path: `/s/${token()}` }] });
  const id = randomUUID(); repository.saveCheckout({ id, workspaceId, requestId: id, customer: { name: state.customers[0].name, email: state.customers[0].email }, sessionId, amount: "18.00", currency: "USD", session: state.sessions[0], expiresAt: Date.now(), status: "confirmed" });
  outbox = (await markCustomerContact(workspaceId, offers()[0].id, state.customers[0].id, true, repository)).outbox;
  expect(outbox[0].changes[0].sentAt).toBeDefined(); expect(outbox[0].emailDeliverable).toBe(true);
  vi.stubEnv("BREVO_API_KEY", "key"); vi.stubEnv("BREVO_SENDER_EMAIL", "owner@studio.org"); vi.stubEnv("PUBLIC_ORIGIN", "https://studio.org");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messageId: "waitlist-email" }, { status: 201 })));
  outbox = (await sendCustomerEmail(workspaceId, { planId: offers()[0].id, customerId: state.customers[0].id }, "https://studio.org", "ip", repository)).outbox;
  expect(outbox[0].delivery?.status).toBe("sent");
});
it("does not offer paused classes or classes less than one hour away", () => {
  const state = setup(); repository.createPlan(workspaceId, replan(state, demoDisruption));
  fillFreedSeats(workspaceId, repository); expect(offers()).toHaveLength(0);
  repository.clearPlans(workspaceId); vi.setSystemTime(Date.parse(state.sessions[0].start) - 30 * 60_000);
  fillFreedSeats(workspaceId, repository); expect(offers()).toHaveLength(0);
});
it("subtracts held offers from customer move alternatives", async () => {
  await hero(); const link = repository.listCustomerLinks(workspaceId).find((item) => item.kind === "choice")!;
  const privateToken = repository.customerToken(link), choice = await customerChoice(privateToken, repository);
  const target = choice.alternatives[0], state = repository.requireWorkspace(workspaceId).state;
  expect(target).toBeDefined();
  const session = state.sessions.find((item) => item.id === target.id)!;
  session.capacity = state.bookings.filter((item) => item.sessionId === session.id && ["confirmed", "moved"].includes(item.status)).length + 1;
  repository.saveState(workspaceId, state);
  repository.createWaitlistOffer({ workspaceId, sessionId: target.id, customerId: state.customers[119].id, entryId: "held-move", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  expect((await customerChoice(privateToken, repository)).alternatives.some((item) => item.id === target.id)).toBe(false);
  await expect(submitChoice(privateToken, { action: "move", sessionId: target.id }, repository)).rejects.toThrow("full or no longer eligible");
});
it("records a late paid race without taking a seat and lets the owner refund it once", async () => {
  const state = setup(); fillFreedSeats(workspaceId, repository);
  const customer = state.customers[0], order = await createOrder(workspaceId, { sessionId, customer: { name: customer.name, email: customer.email }, waitlistToken: token() }, randomUUID(), repository);
  state.bookings.push({ id: "other", customerId: state.customers[2].id, sessionId, amount: "0.00", status: "confirmed" });
  repository.saveState(workspaceId, state);
  const paid = orders.get(order.orderId)!; paid.status = "COMPLETED";
  paid.purchase_units[0].payments = { captures: [{ id: "LATE-CAPTURE", status: "COMPLETED", amount: paid.purchase_units[0].amount }] };
  const row = repository.listCheckout(workspaceId)[0];
  expect(confirmOrder(row, paid, repository)).toMatchObject({ spotTaken: true, current: { status: "refund_pending" } });
  expect(offers()[0].status).toBe("expired");
  expect(repository.requireWorkspace(workspaceId).state.bookings.filter((item) => ["confirmed", "moved"].includes(item.status))).toHaveLength(1);
  const request = () => new Request(`http://localhost/api/workspaces/${workspaceId}/refunds/retry`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ requestId: `waitlist:${row.id}` }) });
  const ctx = { params: Promise.resolve({ id: workspaceId }) };
  expect(await (await retryRefund(request(), ctx)).json()).toMatchObject({ status: "COMPLETED" });
  expect(await (await retryRefund(request(), ctx)).json()).toMatchObject({ status: "COMPLETED" });
  expect(repository.requireWorkspace(workspaceId).state.bookings.find((item) => item.id === row.id)?.status).toBe("refunded");
});
