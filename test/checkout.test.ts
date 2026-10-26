import { setSdkTransport } from "./paypalTransport";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingCatalog, cancelCheckout, captureCheckout, CheckoutInputSchema, confirmOrder, createOrder, receipt, seatsLeft } from "../lib/checkout/service";
import { Repository, closeRepository, getRepository } from "../lib/store";
import { limits } from "../lib/api/limits";
import { seedStudio } from "../lib/seed/seed";
import { executePlan } from "../lib/executor/executePlan";
import { replan } from "../lib/solver/replan";
import { processWebhook } from "../lib/paypal/webhook";
import { eligibleCheckoutMethods, calendarFile, payLaterButtonTag } from "../lib/client/paypal-v6";
import { POST as postOrder } from "../app/api/workspaces/[id]/checkout/orders/route";
import { POST as postCapture } from "../app/api/workspaces/[id]/checkout/orders/[orderId]/capture/route";
import { DELETE as cancel } from "../app/api/workspaces/[id]/checkout/orders/[orderId]/route";

let directory: string;
let repository: Repository;
let workspaceId: string;
let sessionId: string;
type Unit = { reference_id: string; custom_id: string; amount: { currency_code: string; value: string }; description?: string; payments?: { captures: { id: string; status: string; amount: { currency_code: string; value: string } }[] } };
const orders = new Map<string, { id: string; status: string; purchase_units: Unit[] }>();
const createdRequests = new Map<string, string>();
let loseCreationResponse = false;
let calls: { url: string; init: RequestInit }[];
let captureBehavior: ((orderId: string) => Response | Promise<Response>) | undefined;
let readUnavailable = false;
const input = () => ({ sessionId, customer: { name: "Jamie Rivera", email: "jamie@example.com" } });
const body = (init: RequestInit) => JSON.parse(init.body as string);
const complete = (id: string) => {
  const order = structuredClone(orders.get(id)!);
  order.status = "COMPLETED";
  order.purchase_units[0].payments = { captures: [{ id: `capture-${id}`, status: "COMPLETED", amount: { ...order.purchase_units[0].amount } }] };
  orders.set(id, order);
  return order;
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "rebook-checkout-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID()); vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret"); vi.stubEnv("PAYPAL_ENV", "sandbox");
  repository = getRepository();
  const state = seedStudio(); state.bookings = []; state.customers = [];
  workspaceId = repository.createWorkspace(state).id; sessionId = state.sessions[0].id;
  orders.clear(); createdRequests.clear(); loseCreationResponse = false;
  calls = []; captureBehavior = undefined; readUnavailable = false; limits.reset();
  setSdkTransport(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/token")) return Response.json({ access_token: "mock-token", token_type: "Bearer", expires_in: 3600 });
    if (url.endsWith("/v2/checkout/orders") && init.method === "POST") {
      const key = new Headers(init.headers).get("PayPal-Request-Id")!;
      const previous = createdRequests.get(key);
      if (previous) return Response.json(orders.get(previous), { status: 201 });
      const id = `ORDER-${orders.size + 1}`;
      const order = { id, status: "CREATED", purchase_units: body(init).purchase_units as Unit[] }; orders.set(id, order);
      createdRequests.set(key, id);
      if (loseCreationResponse) { loseCreationResponse = false; throw new Error("Lost creation response"); }
      return Response.json(order, { status: 201 });
    }
    const id = new URL(url).pathname.split("/").at(init.method === "GET" ? -1 : -2)!;
    if (url.endsWith("/capture")) return captureBehavior ? captureBehavior(id) : Response.json(complete(id));
    if (url.includes("/v2/checkout/orders/") && init.method === "GET") {
      if (readUnavailable) throw new Error("Order read unavailable");
      return Response.json(orders.get(id));
    }
    if (url.includes("/v2/payments/captures/") && url.endsWith("/refund")) return Response.json({ id: "REAL-REFUND", status: "COMPLETED", amount: body(init).amount });
    throw new Error(`Unexpected SDK request ${init.method} ${url}`);
  });
});
afterEach(() => {
  closeRepository(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("customer checkout", () => {
  it("uses the server price, durable reference IDs and description; replays order creation", async () => {
    const key = randomUUID();
    const first = await createOrder(workspaceId, input(), key, repository);
    expect(await createOrder(workspaceId, input(), key, repository)).toEqual(first);
    const row = repository.listCheckout(workspaceId)[0];
    const posted = calls.find((call) => call.url.endsWith("/v2/checkout/orders"))!;
    expect(body(posted.init)).toMatchObject({ intent: "CAPTURE", purchase_units: [{ reference_id: row.id,
      custom_id: `${workspaceId}:${row.id}`, amount: { currency_code: "USD", value: row.amount }, description: expect.stringContaining("Yoga Flow") }] });
    expect(body(posted.init).payment_source).toBeUndefined();
    expect(new Headers(posted.init.headers).get("PayPal-Request-Id")).toBe(row.id);
    expect(calls.filter((call) => call.url.endsWith("/v2/checkout/orders"))).toHaveLength(1);
    expect(CheckoutInputSchema.safeParse({ ...input(), amount: "0.01" }).success).toBe(false);
    await expect(createOrder(workspaceId, { ...input(), customer: { name: "Other", email: "other@example.com" } }, key, repository)).rejects.toThrow("another booking");
  });
  it("expires seat holds after ten minutes and refuses to capture an expired order", async () => {
    const { state } = repository.requireWorkspace(workspaceId);
    state.sessions[0].capacity = 1; repository.saveState(workspaceId, state);
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    expect(bookingCatalog(workspaceId, repository).sessions[0].seatsLeft).toBe(0);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(bookingCatalog(workspaceId, repository).sessions[0].seatsLeft).toBe(1);
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ status: 410, code: "RESTART_CHECKOUT" });
    expect(calls.some((call) => call.url.endsWith("/capture"))).toBe(false);
    await createOrder(workspaceId, input(), randomUUID(), repository);
  });
  it("replays a lost order creation response with the same PayPal key and seat reservation", async () => {
    const key = randomUUID(); loseCreationResponse = true;
    await expect(createOrder(workspaceId, input(), key, repository)).rejects.toThrow("Lost creation response");
    expect(repository.listCheckout(workspaceId)).toHaveLength(1);
    expect(await createOrder(workspaceId, input(), key, repository)).toEqual({ orderId: "ORDER-1" });
    expect(orders.size).toBe(1);
    const requests = calls.filter((call) => call.url.endsWith("/v2/checkout/orders"));
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[0].init.headers).get("PayPal-Request-Id")).toBe(new Headers(requests[1].init.headers).get("PayPal-Request-Id"));
  });
  it("allows only one buyer to reserve the last seat across SQLite connections", async () => {
    const { state } = repository.requireWorkspace(workspaceId);
    state.sessions[0].capacity = 1; repository.saveState(workspaceId, state);
    const second = new Repository(directory);
    try {
      const results = await Promise.allSettled([createOrder(workspaceId, input(), randomUUID(), repository), createOrder(workspaceId, input(), randomUUID(), second)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await expect(createOrder(workspaceId, input(), randomUUID(), second)).rejects.toMatchObject({ status: 409 });
      expect(repository.listCheckout(workspaceId)).toHaveLength(1);
    } finally { second.close(); }
  });
  it.each(["amount", "currency", "custom_id", "reference_id", "status"])("rejects a capture with a mismatched %s", async (field) => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = (id) => {
      const order = complete(id); const unit = order.purchase_units[0];
      if (field === "amount") unit.payments!.captures[0].amount.value = "0.01";
      if (field === "currency") unit.payments!.captures[0].amount.currency_code = "EUR";
      if (field === "custom_id") unit.custom_id = "another-workspace:another-booking";
      if (field === "reference_id") unit.reference_id = "another-booking";
      if (field === "status") order.status = "APPROVED";
      orders.set(id, order); return Response.json(order);
    };
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ code: "CAPTURE_MISMATCH" });
    expect(repository.requireWorkspace(workspaceId).state.bookings).toHaveLength(0);
    expect(repository.listLedger(workspaceId)).toHaveLength(0);
  });
  it("confirms once, survives a reopened repository, and makes the real capture refundable", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    const first = await captureCheckout(workspaceId, orderId, repository);
    expect(first.status).toBe("confirmed");
    closeRepository(); repository = getRepository();
    expect(await captureCheckout(workspaceId, orderId, repository)).toEqual(first);
    expect(calls.filter((call) => call.url.endsWith("/capture"))).toHaveLength(1);
    const captureRequest = calls.find((call) => call.url.endsWith("/capture"))!;
    expect(new Headers(captureRequest.init.headers).get("PayPal-Request-Id")).toBe(`capture:${first.bookingId}`);
    const { state } = repository.requireWorkspace(workspaceId);
    expect(state.bookings[0].payment).toEqual({ orderId, captureId: first.captureId, simulated: false });
    expect(state.customers[0].prefs.windows).toHaveLength(7);
    expect(repository.listLedger(workspaceId)).toHaveLength(1);
    const plan = repository.createPlan(workspaceId, replan(state, { kind: "closure", from: state.studio.weekStart, to: "2026-11-23T05:00:00Z" }));
    const result = await executePlan(workspaceId, plan.id, repository);
    expect(result.results).toContainEqual(expect.objectContaining({ bookingId: first.bookingId, status: "COMPLETED", paypalId: "REAL-REFUND" }));
    expect(calls.find((call) => call.url.endsWith(`/captures/${first.captureId}/refund`))).toBeDefined();
    expect(repository.requireWorkspace(workspaceId).state.bookings[0].status).toBe("refunded");
  });
  it("releases declined instruments and permits a fresh checkout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = () => Response.json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }], message: "Declined" }, { status: 422 });
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ status: 422, code: "INSTRUMENT_DECLINED" });
    expect(repository.listCheckout(workspaceId)[0].status).toBe("failed");
    expect((await createOrder(workspaceId, input(), randomUUID(), repository)).orderId).not.toBe(orderId);
  });
  it("preserves PayPal error handling when an upstream error has a null body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = () => Response.json(null, { status: 422 });
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ status: 422, name: "PAYPAL_ERROR" });
    expect(repository.listCheckout(workspaceId)[0].status).toBe("capturing");
  });
  it("recovers a lost capture response without capturing twice", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = (id) => { complete(id); throw new Error("Connection closed after capture"); };
    expect((await captureCheckout(workspaceId, orderId, repository)).status).toBe("confirmed");
    expect(repository.listLedger(workspaceId)).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/capture"))).toHaveLength(1);
  });
  it("retains unknown capture outcomes, then reconciles after the original hold expires", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = (id) => { complete(id); throw new Error("lost"); };
    readUnavailable = true;
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toThrow();
    expect(repository.listCheckout(workspaceId)[0].status).toBe("capturing");
    await expect(cancelCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ code: "CHECK_PAYMENT_STATUS" });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    readUnavailable = false;
    expect((await captureCheckout(workspaceId, orderId, repository)).status).toBe("confirmed");
    expect(calls.filter((call) => call.url.endsWith("/capture"))).toHaveLength(1);
    expect(await cancelCheckout(workspaceId, orderId, repository)).toMatchObject({ cancelled: false, receipt: { status: "confirmed" } });
  });
  it("retains an inconclusive empty capture snapshot and recovers a late completion webhook", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = () => { throw new Error("Timeout before capture"); };
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toThrow();
    expect(repository.listCheckout(workspaceId)[0].status).toBe("capturing");
    const retryKey = randomUUID();
    expect(await createOrder(workspaceId, input(), retryKey, repository)).toEqual({ orderId });
    await expect(createOrder(workspaceId, { ...input(), customer: { ...input().customer, name: "Changed name" } }, retryKey, repository)).rejects.toMatchObject({ status: 409 });
    await expect(createOrder(workspaceId, { ...input(), customer: { ...input().customer, name: "Changed name" } }, randomUUID(), repository)).rejects.toMatchObject({ code: "CHECK_PAYMENT_STATUS" });
    expect(orders.size).toBe(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ code: "CHECK_PAYMENT_STATUS" });
    expect(repository.listCheckout(workspaceId)[0].status).toBe("capturing");
    expect(calls.filter((call) => call.url.endsWith("/capture"))).toHaveLength(1);
    const unit = complete(orderId).purchase_units[0];
    expect(processWebhook(JSON.stringify({ id: "delayed-completion", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {
      ...unit.payments!.captures[0], custom_id: unit.custom_id, supplementary_data: { related_ids: { order_id: orderId } },
    } }), repository).matched).toBe(true);
    expect(receipt(workspaceId, orderId, repository).status).toBe("confirmed");
    closeRepository(); repository = getRepository();
    expect(await createOrder(workspaceId, input(), retryKey, repository)).toEqual({ orderId });
    expect(orders.size).toBe(1);
    expect(repository.requireWorkspace(workspaceId).state.bookings).toHaveLength(1);
    expect(repository.listLedger(workspaceId)).toHaveLength(1);
  });
  it("blocks a second pre-created order while the same customer's class payment is unresolved", async () => {
    const first = await createOrder(workspaceId, input(), randomUUID(), repository);
    const second = await createOrder(workspaceId, { ...input(), customer: { ...input().customer, email: "JAMIE@example.com" } }, randomUUID(), repository);
    captureBehavior = () => { throw new Error("Unknown capture outcome"); };
    await expect(captureCheckout(workspaceId, first.orderId, repository)).rejects.toThrow("Unknown capture outcome");
    closeRepository(); repository = getRepository();
    await expect(captureCheckout(workspaceId, second.orderId, repository)).rejects.toMatchObject({ status: 409, code: "CHECK_PAYMENT_STATUS" });
    expect(repository.checkoutByOrder(workspaceId, first.orderId)?.status).toBe("capturing");
    expect(repository.checkoutByOrder(workspaceId, second.orderId)?.status).toBe("pending");
    expect(calls.filter((call) => call.url.endsWith("/capture"))).toHaveLength(1);
    complete(first.orderId);
    expect((await captureCheckout(workspaceId, first.orderId, repository)).status).toBe("confirmed");
    expect(repository.requireWorkspace(workspaceId).state.bookings).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/capture"))).toHaveLength(1);
  });
  it("releases an unresolved hold only when PayPal authoritatively voids the order", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = () => { throw new Error("unknown capture"); };
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toThrow();
    orders.get(orderId)!.status = "VOIDED";
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ code: "RESTART_CHECKOUT" });
    expect(repository.listCheckout(workspaceId)[0].status).toBe("failed");
  });
  it("blocks recovery application while a capture is unresolved, then requires a fresh plan after reconciliation", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = () => { throw new Error("unknown capture"); };
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toThrow();
    const before = repository.requireWorkspace(workspaceId).state;
    const disruption = { kind: "closure" as const, from: before.studio.weekStart, to: "2026-11-23T05:00:00Z" };
    const plan = repository.createPlan(workspaceId, replan(before, disruption));
    await expect(executePlan(workspaceId, plan.id, repository)).rejects.toMatchObject({ code: "CHECK_PAYMENT_STATUS" });
    expect(repository.requireWorkspace(workspaceId).state).toEqual(before);
    expect(repository.getPlan(workspaceId, plan.id)?.status).toBe("proposed");
    complete(orderId);
    await captureCheckout(workspaceId, orderId, repository);
    await expect(executePlan(workspaceId, plan.id, repository)).rejects.toThrow("Missing booking action");
    const fresh = repository.createPlan(workspaceId, replan(repository.requireWorkspace(workspaceId).state, disruption));
    expect((await executePlan(workspaceId, fresh.id, repository)).results[0]).toMatchObject({ status: "COMPLETED" });
  });
  it("refuses checkout for a changed or cancelled class and releases its seat", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    const { state } = repository.requireWorkspace(workspaceId); state.sessions = state.sessions.filter((session) => session.id !== sessionId); repository.saveState(workspaceId, state);
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toMatchObject({ code: "RESTART_CHECKOUT" });
    expect(repository.listCheckout(workspaceId)[0].status).toBe("failed");
    expect(calls.some((call) => call.url.endsWith("/capture"))).toBe(false);
  });
  it("reconciles a signed completion webhook that beats the capture response", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "mock-hook");
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = (id) => {
      const order = complete(id); const unit = order.purchase_units[0];
      const event = { id: "early-webhook", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { ...unit.payments!.captures[0], custom_id: unit.custom_id, supplementary_data: { related_ids: { order_id: id } } } };
      expect(processWebhook(JSON.stringify(event), repository).matched).toBe(true);
      expect(processWebhook(JSON.stringify(event), repository).duplicate).toBe(true);
      return Response.json(order);
    };
    const result = await captureCheckout(workspaceId, orderId, repository);
    expect(result.webhookConfirmed).toBe(true);
    expect(repository.requireWorkspace(workspaceId).state.bookings).toHaveLength(1);
    expect(repository.listLedger(workspaceId)).toHaveLength(1);
    expect(receipt(workspaceId, orderId, repository).webhookConfirmed).toBe(true);
  });
  it("persists validated webhook confirmation after raw webhook bodies expire", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    const result = await captureCheckout(workspaceId, orderId, repository);
    const event = { id: "late-webhook", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {
      id: result.captureId, status: "COMPLETED", amount: { currency_code: "USD", value: result.amount },
    } };
    expect(processWebhook(JSON.stringify({ ...event, id: "wrong-amount", resource: { ...event.resource, amount: { currency_code: "USD", value: "0.01" } } }), repository).matched).toBe(false);
    expect(receipt(workspaceId, orderId, repository).webhookConfirmed).toBe(false);
    expect(processWebhook(JSON.stringify(event), repository).matched).toBe(true);
    // Keep the workspace through pruning while exercising seven-day webhook payload scrubbing.
    const row = repository.checkoutByOrder(workspaceId, orderId)!;
    repository.saveCheckout({ ...row, id: "unresolved", requestId: "unresolved", orderId: "unresolved", status: "capturing" });
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    repository.pruneOlderThan();
    expect(repository.getWebhook(event.id)).toBe("");
    expect(receipt(workspaceId, orderId, repository).webhookConfirmed).toBe(true);
  });
  it("does not let a duplicate capture response undo a reversal received after confirmation", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    const stale = repository.checkoutByOrder(workspaceId, orderId)!;
    const result = await captureCheckout(workspaceId, orderId, repository);
    processWebhook(JSON.stringify({ id: "reversal", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: result.captureId, status: "REVERSED" } }), repository);
    confirmOrder(stale, orders.get(orderId)!, repository);
    expect(repository.requireWorkspace(workspaceId).state.bookings[0].status).toBe("cancelled");
    expect(repository.latestMoneyEvents(workspaceId).find((event) => event.kind === "capture")?.status).toBe("REVERSED");
  });
  it("preserves an unresolved capture through pruning so a webhook can recover it", async () => {
    const { orderId } = await createOrder(workspaceId, input(), randomUUID(), repository);
    captureBehavior = (id) => { complete(id); throw new Error("lost"); }; readUnavailable = true;
    await expect(captureCheckout(workspaceId, orderId, repository)).rejects.toThrow();
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    repository.pruneOlderThan();
    expect(repository.checkoutByOrder(workspaceId, orderId)?.status).toBe("capturing");
    const unit = orders.get(orderId)!.purchase_units[0];
    expect(processWebhook(JSON.stringify({ id: "recovered-after-prune", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {
      ...unit.payments!.captures[0], custom_id: unit.custom_id, supplementary_data: { related_ids: { order_id: orderId } },
    } }), repository).matched).toBe(true);
    expect(receipt(workspaceId, orderId, repository).status).toBe("confirmed");
  });
  it("counts active bookings and unexpired reservations only", () => {
    const { state } = repository.requireWorkspace(workspaceId); const session = state.sessions[0];
    state.bookings.push({ id: "one", sessionId, customerId: "customer", amount: "22.00", status: "confirmed" }, { id: "two", sessionId, customerId: "customer", amount: "22.00", status: "refunded" });
    expect(seatsLeft(state, session, [])).toBe(session.capacity - 1);
  });
});

describe("checkout routes and client helpers", () => {
  const ctx = () => ({ params: Promise.resolve({ id: workspaceId }) });
  const post = (value: unknown, key = randomUUID()) => new Request(`http://localhost/api/workspaces/${workspaceId}/checkout/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value) });
  it("rejects client prices, invalid customer lengths, cross-origin writes, and global budget exhaustion", async () => {
    expect((await postOrder(post({ ...input(), amount: "0.01" }), ctx())).status).toBe(400);
    expect((await postOrder(post({ ...input(), customer: { name: "x".repeat(101), email: "jamie@example.com" } }), ctx())).status).toBe(400);
    const foreign = post(input()); foreign.headers.set("Origin", "https://other.example");
    expect((await postOrder(foreign, ctx())).status).toBe(403);
    vi.stubEnv("MAX_REAL_CAPTURES_PER_HOUR", "0");
    expect((await postOrder(post(input()), ctx())).status).toBe(429);
    expect(orders.size).toBe(0);
    expect(repository.listCheckout(workspaceId)).toHaveLength(0);
  });
  it("creates, cancels, captures idempotently and scopes orders to the workspace", async () => {
    const response = await postOrder(post(input()), ctx()); expect(response.status).toBe(200);
    const { orderId } = await response.json();
    const context = { params: Promise.resolve({ id: workspaceId, orderId }) };
    const captureRequest = new Request("http://localhost/capture", { method: "POST" });
    expect((await postCapture(captureRequest, context)).status).toBe(200);
    const otherId = repository.createWorkspace(seedStudio()).id;
    expect((await postCapture(new Request("http://localhost/capture", { method: "POST" }), { params: Promise.resolve({ id: otherId, orderId }) })).status).toBe(404);
    const second = await (await postOrder(post(input()), ctx())).json();
    expect((await cancel(new Request("http://localhost/order", { method: "DELETE" }), { params: Promise.resolve({ id: workspaceId, orderId: second.orderId }) })).status).toBe(200);
    expect(repository.checkoutByOrder(workspaceId, second.orderId)?.status).toBe("failed");
  });
  it("maps only eligible v6 funding methods, and generates a UTC calendar download", () => {
    const methods = { isEligible: (method: string) => ["paypal", "advanced_cards"].includes(method), getDetails: () => ({}) };
    expect(eligibleCheckoutMethods(methods)).toEqual({ paypal: true, paylater: false, cards: true });
    expect(payLaterButtonTag({ get: () => undefined })).toBe("paylater-button");
    expect(payLaterButtonTag({ get: (tag) => tag === "paypal-pay-later-button" ? class {} as CustomElementConstructor : undefined })).toBe("paypal-pay-later-button");
    const ics = calendarFile({ bookingId: "booking", class: "Yoga, Flow", start: "2026-11-09T07:00:00-05:00", end: "2026-11-09T08:00:00-05:00" }, "Northstar");
    expect(ics).toContain("DTSTART:20261109T120000Z\r\n"); expect(ics).toContain("SUMMARY:Yoga\\, Flow");
  });
});
