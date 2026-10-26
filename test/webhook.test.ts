import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/paypal/webhook/route";
import { closeRepository, getRepository, type Repository } from "../lib/store";
import { seedStudio } from "../lib/seed/seed";
import { processWebhook } from "../lib/paypal/webhook";
import { confirmOrder, receipt } from "../lib/checkout/service";
import { sandboxWebhook } from "./fixtures/paypal-sandbox-webhook";

let directory: string;
let repository: Repository;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rebook-webhook-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", randomUUID());
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "mock-secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "webhook-id");
  vi.spyOn(console, "info").mockImplementation(() => {});
  repository = getRepository();
});
afterEach(() => {
  closeRepository(); rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const signatureHeaders = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/cert", "paypal-transmission-id": "transmission", "paypal-transmission-sig": "signature", "paypal-transmission-time": "2026-10-23T12:00:00Z" };
function eventRequest(body: unknown) {
  return new Request("http://localhost/api/paypal/webhook", { method: "POST", headers: signatureHeaders, body: JSON.stringify(body) });
}
function verification(verified: boolean) {
  const fetch = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (url) => String(url).endsWith("/token")
    ? Response.json({ access_token: "token", expires_in: 3600 })
    : Response.json({ verification_status: verified ? "SUCCESS" : "FAILURE" }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function prepared() {
  const state = seedStudio();
  const booking = state.bookings[0];
  booking.payment = { orderId: "order", captureId: "capture", simulated: false };
  booking.status = "refund_pending";
  const workspace = repository.createWorkspace(state);
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "capture", amount: booking.amount,
    paypalId: "capture", captureId: "capture", requestId: "capture-request", status: "COMPLETED" });
  repository.appendLedger({ workspaceId: workspace.id, bookingId: booking.id, kind: "refund", amount: booking.amount,
    paypalId: "refund", captureId: "capture", requestId: "plan:booking", status: "PENDING" });
  return { workspace, booking };
}
function deliveryLogs() {
  return vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(line as string));
}
function preparedCheckout(confirmed: boolean) {
  const state = seedStudio(); state.bookings = []; state.customers = [];
  const workspace = repository.createWorkspace(state);
  const session = state.sessions[0];
  const orderId = sandboxWebhook.body.resource.supplementary_data.related_ids.order_id;
  const row = { id: randomUUID(), workspaceId: workspace.id, requestId: randomUUID(), sessionId: session.id,
    customer: { name: "Test member", email: "member@example.com" }, amount: sandboxWebhook.body.resource.amount.value,
    currency: "USD" as const, session, expiresAt: Date.now() + 600_000, status: "capturing" as const, orderId };
  repository.saveCheckout(row);
  if (confirmed) confirmOrder(row, { id: orderId, status: "COMPLETED", purchase_units: [{ reference_id: row.id,
    custom_id: `${workspace.id}:${row.id}`, amount: sandboxWebhook.body.resource.amount,
    payments: { captures: [sandboxWebhook.body.resource] } }] }, repository);
  return row;
}
describe("PayPal webhook", () => {
  it.each([false, true])("confirms a checkout from a sandbox-shaped delivery (capture response already saved: %s)", async (confirmed) => {
    const row = preparedCheckout(confirmed);
    const event = confirmed ? sandboxWebhook.body : { ...sandboxWebhook.body, resource: { ...sandboxWebhook.body.resource, custom_id: `${row.workspaceId}:${row.id}` } };
    const fetch = verification(true);
    const rawBody = JSON.stringify(event, null, 2);
    const request = () => new Request("http://localhost/api/paypal/webhook", { method: "POST", headers: sandboxWebhook.headers, body: rawBody });
    expect(receipt(row.workspaceId, row.orderId, repository).webhookConfirmed).toBe(false);
    expect(await (await POST(request())).json()).toMatchObject({ received: true, matched: true, outcome: "matched_capture" });
    expect(receipt(row.workspaceId, row.orderId, repository)).toMatchObject({ status: "confirmed", webhookConfirmed: true, captureId: event.resource.id });
    expect(repository.requireWorkspace(row.workspaceId).state.bookings).toHaveLength(1);
    expect(repository.getWebhook(event.id)).toBe(rawBody);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
    ]);
    const tokenInit = fetch.mock.calls[0][1]!;
    expect(tokenInit.method).toBe("POST");
    expect(new Headers(tokenInit.headers).get("Authorization")).toBe(`Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:mock-secret`).toString("base64")}`);
    const verificationInit = fetch.mock.calls[1][1]!;
    expect(verificationInit.method).toBe("POST");
    expect(new Headers(verificationInit.headers).get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(verificationInit.body as string)).toEqual({
      auth_algo: sandboxWebhook.headers["paypal-auth-algo"], cert_url: sandboxWebhook.headers["paypal-cert-url"],
      transmission_id: sandboxWebhook.headers["paypal-transmission-id"], transmission_sig: sandboxWebhook.headers["paypal-transmission-sig"],
      transmission_time: sandboxWebhook.headers["paypal-transmission-time"], webhook_id: "webhook-id", webhook_event: event,
    });
    const count = repository.listLedger(row.workspaceId).length;
    expect(await (await POST(request())).json()).toMatchObject({ duplicate: true, outcome: "duplicate" });
    // A new notification ID for the same resource is also safe to process.
    expect(await (await POST(new Request("http://localhost/api/paypal/webhook", { method: "POST", headers: sandboxWebhook.headers,
      body: JSON.stringify({ ...event, id: "another-notification" }) }))).json()).toMatchObject({ matched: true });
    expect(repository.listLedger(row.workspaceId)).toHaveLength(count);
    expect(deliveryLogs()).toEqual([
      { message: "paypal_webhook_delivery", environment: "sandbox", eventId: event.id, eventType: event.event_type, resourceId: event.resource.id, verification: "VERIFIED", outcome: "matched_capture" },
      { message: "paypal_webhook_delivery", environment: "sandbox", eventId: event.id, eventType: event.event_type, resourceId: event.resource.id, verification: "VERIFIED", outcome: "duplicate" },
      { message: "paypal_webhook_delivery", environment: "sandbox", eventId: "another-notification", eventType: event.event_type, resourceId: event.resource.id, verification: "VERIFIED", outcome: "matched_capture" },
    ]);
    const logs = JSON.stringify(deliveryLogs());
    for (const secret of [sandboxWebhook.headers["paypal-transmission-sig"], "receivingbusiness@example.com", "member@example.com", "mock-secret", "Bearer token", "seller_receivable_breakdown"]) expect(logs).not.toContain(secret);
  });
  it("rejects missing configuration and invalid signatures without changing state", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    expect((await POST(eventRequest({}))).status).toBe(503);
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "webhook-id");
    const { workspace } = prepared();
    verification(false);
    const event = { id: "bad-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "refund" } };
    expect((await POST(eventRequest(event))).status).toBe(401);
    expect(repository.getWebhook(event.id)).toBeUndefined();
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refund_pending");
    expect(deliveryLogs()).toMatchObject([
      { verification: "NOT_ATTEMPTED", outcome: "rejected", reason: "webhook_not_configured" },
      { eventId: event.id, eventType: event.event_type, resourceId: "refund", verification: "FAILURE", outcome: "rejected" },
    ]);
  });
  it.each(Object.keys(signatureHeaders))("rejects a delivery missing %s without contacting PayPal", async (missing) => {
    const fetch = verification(true);
    const headers = new Headers(signatureHeaders); headers.delete(missing);
    expect((await POST(new Request("http://localhost/api/paypal/webhook", { method: "POST", headers, body: JSON.stringify(sandboxWebhook.body) }))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.getWebhook(sandboxWebhook.body.id)).toBeUndefined();
    expect(deliveryLogs()).toMatchObject([{ eventId: sandboxWebhook.body.id, verification: "FAILURE", outcome: "rejected" }]);
  });
  it.each(["token", "verification"])("logs the error class when the %s request fails, without storing the event", async (stage) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (stage === "verification" && String(url).endsWith("/token")) return Response.json({ access_token: "token", expires_in: 3600 });
      throw new TypeError("sensitive error detail must not be logged");
    }));
    expect((await POST(eventRequest(sandboxWebhook.body))).status).toBe(500);
    expect(repository.getWebhook(sandboxWebhook.body.id)).toBeUndefined();
    expect(deliveryLogs()).toMatchObject([{ eventId: sandboxWebhook.body.id, verification: "TypeError", outcome: "error", reason: "verification_error", errorClass: "TypeError" }]);
    expect(JSON.stringify([vi.mocked(console.info).mock.calls, vi.mocked(console.error).mock.calls])).not.toContain("sensitive error detail");
  });
  it("logs PayPal API rejection as a verification error rather than a signature FAILURE", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/token")
      ? Response.json({ access_token: "token", expires_in: 3600 })
      : Response.json({ name: "INVALID_REQUEST", message: "sensitive upstream message" }, { status: 400 })));
    expect((await POST(eventRequest(sandboxWebhook.body))).status).toBe(502);
    expect(repository.getWebhook(sandboxWebhook.body.id)).toBeUndefined();
    expect(deliveryLogs()).toMatchObject([{ verification: "PayPalError", outcome: "error", reason: "verification_error", errorClass: "PayPalError" }]);
    expect(JSON.stringify(deliveryLogs())).not.toContain("sensitive upstream message");
  });
  it("logs verified processing failures and lets PayPal retry the rolled-back transaction", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const row = preparedCheckout(true);
    verification(true);
    const save = vi.spyOn(repository, "saveCheckout").mockImplementation(() => { throw new Error("sensitive storage detail"); });
    expect((await POST(eventRequest(sandboxWebhook.body))).status).toBe(500);
    expect(repository.getWebhook(sandboxWebhook.body.id)).toBeUndefined();
    expect(receipt(row.workspaceId, row.orderId, repository).webhookConfirmed).toBe(false);
    expect(deliveryLogs()).toMatchObject([{ verification: "VERIFIED", outcome: "error", reason: "processing_error", errorClass: "Error" }]);
    save.mockRestore();
    expect((await POST(eventRequest(sandboxWebhook.body))).status).toBe(200);
    expect(receipt(row.workspaceId, row.orderId, repository).webhookConfirmed).toBe(true);
  });
  it.each([
    { rawBody: "{", verification: "NOT_ATTEMPTED", reason: "invalid_json" },
    { rawBody: JSON.stringify({ ...sandboxWebhook.body, resource: {} }), verification: "NOT_ATTEMPTED", reason: "invalid_body" },
    { rawBody: JSON.stringify({ resource: { id: "x".repeat(65_536) } }), verification: "NOT_ATTEMPTED", reason: "invalid_body" },
  ])("logs malformed or oversized deliveries ($reason)", async ({ rawBody, verification: result, reason }) => {
    const fetch = verification(true);
    const response = await POST(new Request("http://localhost/api/paypal/webhook", { method: "POST", body: rawBody }));
    expect([400, 413]).toContain(response.status);
    expect(fetch).not.toHaveBeenCalled();
    expect(deliveryLogs()).toMatchObject([{ verification: result, reason }]);
  });
  it.each(["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.COMPLETED"])("logs an ignored %s delivery", async (eventType) => {
    verification(true);
    const response = await POST(eventRequest({ ...sandboxWebhook.body, event_type: eventType }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ matched: false, outcome: "ignored" });
    expect(deliveryLogs()).toMatchObject([{ verification: "VERIFIED", outcome: "ignored", reason: eventType === "PAYMENT.CAPTURE.COMPLETED" ? "unmatched_payment" : "unsupported_event_type" }]);
  });
  it("verifies the exact event, completes refunds, stores raw events and ignores duplicates", async () => {
    const { workspace, booking } = prepared();
    const fetch = verification(true);
    const event = { id: "refund-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "refund", amount: { currency_code: "USD", value: booking.amount }, supplementary_data: { related_ids: { capture_id: "capture" } },
    } };
    const response = await POST(eventRequest(event));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, matched: true });
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refunded");
    expect(repository.ledgerSummary(workspace.id).refunded).toBe(booking.amount);
    expect(repository.getWebhook(event.id)).toBe(JSON.stringify(event));
    const verificationInit = (fetch.mock.calls[1] as unknown[])[1] as RequestInit;
    expect(JSON.parse(verificationInit.body as string)).toMatchObject({ webhook_id: "webhook-id", webhook_event: event });
    const count = repository.listLedger(workspace.id).length;
    expect(await (await POST(eventRequest(event))).json()).toMatchObject({ duplicate: true });
    expect(repository.listLedger(workspace.id)).toHaveLength(count);
    expect(await (await POST(eventRequest({ ...event, id: "refund-redelivery" }))).json()).toMatchObject({ matched: true, outcome: "matched_refund" });
    expect(repository.listLedger(workspace.id)).toHaveLength(count);
    expect(deliveryLogs()).toMatchObject([
      { verification: "VERIFIED", outcome: "matched_refund" },
      { verification: "VERIFIED", outcome: "duplicate" },
      { verification: "VERIFIED", outcome: "matched_refund" },
    ]);
  });
  it("finds a refund by its capture link when the webhook beats the refund HTTP response", async () => {
    const { workspace, booking } = prepared();
    const pending = repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")!;
    repository.appendLedger({ ...pending, paypalId: "", status: "REQUESTED" });
    verification(true);
    const event = { id: "early-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "early-refund", invoice_id: pending.requestId, amount: { currency_code: "USD", value: booking.amount }, links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/capture" }],
    } };
    expect((await POST(eventRequest(event))).status).toBe(200);
    expect(repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")).toMatchObject({ requestId: "plan:booking", paypalId: "early-refund", status: "COMPLETED" });
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refunded");
  });
  it.each(["REQUESTED", "PENDING"])("keeps a %s full refund unresolved when a different partial refund completes", (status) => {
    const { workspace, booking } = prepared();
    const original = repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")!;
    repository.appendLedger({ ...original, status, paypalId: status === "REQUESTED" ? "" : "refund" });
    const event = { id: `external-${status}`, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "external-partial", invoice_id: "merchant-operation", amount: { currency_code: "USD", value: "4.00" }, capture_id: "capture",
    } };
    expect(processWebhook(JSON.stringify(event), repository).matched).toBe(true);
    const latest = repository.latestMoneyEvents(workspace.id).filter((item) => item.kind === "refund");
    expect(latest.find((item) => item.requestId === original.requestId)).toMatchObject({ status, amount: booking.amount, paypalId: status === "REQUESTED" ? "" : "refund" });
    expect(latest.find((item) => item.paypalId === "external-partial")).toMatchObject({ requestId: "webhook:external-partial", amount: "4.00", status: "COMPLETED" });
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("refund_pending");
    expect(processWebhook(JSON.stringify({ ...event, id: "redelivery" }), repository).matched).toBe(true);
    expect(repository.ledgerSummary(workspace.id).refunded).toBe("4.00");
  });
  it.each(["missing invoice", "different known ID", "wrong amount"])("does not infer refund identity from a capture alone: %s", (variant) => {
    const { workspace, booking } = prepared();
    const original = repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "refund")!;
    if (variant !== "different known ID") repository.appendLedger({ ...original, paypalId: "", status: "REQUESTED" });
    processWebhook(JSON.stringify({ id: variant, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
      id: "another-refund", invoice_id: variant === "missing invoice" ? undefined : original.requestId,
      amount: { currency_code: "USD", value: variant === "wrong amount" ? "4.00" : booking.amount }, capture_id: "capture",
    } }), repository);
    expect(repository.latestMoneyEvents(workspace.id).find((item) => item.requestId === original.requestId)?.status).toBe(variant === "different known ID" ? "PENDING" : "REQUESTED");
  });
  it("records capture reversals and does not undo them on late completion", async () => {
    const { workspace } = prepared();
    verification(true);
    expect((await POST(eventRequest({ id: "reverse", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "capture" } }))).status).toBe(200);
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("cancelled");
    expect((await POST(eventRequest({ id: "late", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "capture" } }))).status).toBe(200);
    expect(repository.latestMoneyEvents(workspace.id).find((item) => item.kind === "capture")?.status).toBe("REVERSED");
    expect(repository.requireWorkspace(workspace.id).state.bookings[0].status).toBe("cancelled");
  });
});
